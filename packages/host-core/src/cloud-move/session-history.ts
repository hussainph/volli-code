/**
 * The move engine's Session-history port (`MoveSessionHistory`) in
 * production: the pieces the moved-history work built, composed for a move.
 *
 * - Every moved event goes as `sessionEventImportRecord`: classified the way
 *   the backend's intake classifies a drained fact, its payload and
 *   provenance as the JSON text the backend stores, so nothing is spilled.
 * - Each moved Session's transcript bodies and Pi logs are packed and
 *   committed by the runner's own spool over the import's doors
 *   (`createMoveHistoryUploader`), under the claim the import gave it: the
 *   runner the import named (`move.runnerId`), never a later driver's.
 *   Every upload URL the spool asks for is reported (`onSigned`) as it is
 *   issued, so the engine can check, once the last one has expired, that
 *   the store holds what was last signed for each key.
 * - Drain cursors are seeded by `seedMovedSessionCursors`, the runner's own
 *   store. The engine takes them back with every other cursor on the project
 *   (`releaseProjectCursors`).
 *
 * Local events are read the way the exporter read them (the stored rows, as
 * JSON, not through the codec: a fact this build cannot decode moved too and
 * is packed like any other), and so are its attachments. A frozen project's
 * ledger no longer changes under either.
 */
import type Database from "better-sqlite3";
import type { SessionAttachment, TranscriptReference } from "@volli/shared";

import { seedMovedSessionCursors } from "../cloud-runner/sqlite-stores";
import { createMoveHistoryUploader } from "../cloud-store/move-history";
import { piLogFilesOf } from "../cloud-store/pi-log-files";
import { prepared } from "../db/prepared";
import { sessionEventImportRecord } from "../migration-export/session-event-record";
import type {
  SpoolEvent,
  SpoolRedaction,
  TranscriptSpoolLimits,
} from "../transcript-spool/transcript-spool";
import { MOVE_RETRY, withRetry } from "./backend";
import type { MoveBackend, MoveSessionHistory } from "./ports";

export interface MoveSessionHistoryOptions {
  /** The live profile: drain cursors are runner-local rows in it. */
  db: Database.Database;
  backend: MoveBackend;
  /** The profile's transcript bodies. */
  artifacts: { readCanonicalBytes(reference: TranscriptReference): Promise<Buffer> };
  redaction: SpoolRedaction;
  /** Pi's runner-owned session directory. */
  piDirectory: string;
  fetch?: typeof globalThis.fetch;
  /** Backoff between a lost call's retries. Default: a timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Smaller cuts, for tests. */
  limits?: Partial<TranscriptSpoolLimits>;
}

const SIGN = "projectImportHistory:presignPut";

/**
 * A Session's attachments as stored, as far as finding its Pi files needs
 * them (adapter, venue, native binding): read without folding the Session,
 * so a fact this build cannot decode never hides its Pi log.
 */
function storedAttachments(db: Database.Database, sessionId: string): SessionAttachment[] {
  return prepared<
    [string],
    {
      id: string;
      adapter_id: string;
      venue_id: string;
      venue_kind: string;
      native_id: string | null;
      native_detail: string | null;
    }
  >(
    db,
    `SELECT id, adapter_id, venue_id, venue_kind, native_id, native_detail
       FROM session_attachments WHERE session_id = ? ORDER BY created_sequence, id`,
  )
    .all(sessionId)
    .map(
      (row) =>
        ({
          id: row.id,
          sessionId,
          adapterId: row.adapter_id,
          venue: { id: row.venue_id, kind: row.venue_kind },
          native:
            row.native_id === null
              ? null
              : {
                  id: row.native_id,
                  detail:
                    row.native_detail === null ? null : (JSON.parse(row.native_detail) as unknown),
                },
        }) as unknown as SessionAttachment,
    );
}

/** A Session's stored events after `afterSequence`, ascending, as the export carried them. */
function storedEvents(
  db: Database.Database,
  sessionId: string,
  afterSequence: number,
  limit: number,
): SpoolEvent[] {
  return prepared<
    [string, number, number],
    { sequence: number; recorded_at: number; payload: string }
  >(
    db,
    `SELECT sequence, recorded_at, payload FROM session_events
      WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
  )
    .all(sessionId, afterSequence, limit)
    .map((row) => ({
      sequence: row.sequence,
      recordedAt: row.recorded_at,
      payload: JSON.parse(row.payload) as SpoolEvent["payload"],
    }));
}

export function createMoveSessionHistory(options: MoveSessionHistoryOptions): MoveSessionHistory {
  const sleep =
    options.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", aborted);
          resolve();
        }, ms);
        signal.addEventListener("abort", aborted, { once: true });
      }));
  return {
    eventRecord: sessionEventImportRecord,

    async upload(move, session, signal, onSigned) {
      // Each call the network loses is sent again on its own (every history
      // door is idempotent), so one dropped request never restarts a whole
      // Session's upload; every URL the spool is given is reported before the
      // spool can use it.
      const retried = (call: () => Promise<unknown>) =>
        withRetry(call, { ...MOVE_RETRY, sleep, signal });
      const backend: MoveBackend = {
        query: (path, args) => retried(() => options.backend.query(path, args)),
        mutation: (path, args) => retried(() => options.backend.mutation(path, args)),
        async action(path, args) {
          const answer = await retried(() => options.backend.action(path, args));
          if (path === SIGN && (answer as { status?: unknown }).status === "sign") {
            onSigned?.({
              key: args.key as string,
              bytes: args.bytes as number,
              sha256: args.sha256 as string,
            });
          }
          return answer;
        },
      };
      const uploader = createMoveHistoryUploader({
        moveId: move.moveId,
        runnerId: move.runnerId,
        backend,
        artifacts: options.artifacts,
        redaction: options.redaction,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });
      const piFiles = await piLogFilesOf(storedAttachments(options.db, session.sessionId), {
        runnerId: move.runnerId,
        piDirectory: options.piDirectory,
        signal,
      });
      const report = await uploader.upload({
        sessionId: session.sessionId,
        projectId: session.projectId,
        lastSequence: session.lastSequence,
        // The claim the import gave every moved Session.
        generation: 1,
        eventsAfter: (afterSequence, limit) =>
          storedEvents(options.db, session.sessionId, afterSequence, limit),
        piFiles,
      });
      return {
        missing: report.missing,
        piFilesLeftBehind:
          report.piLogs.missing.length +
          report.piLogs.truncated.length +
          report.piLogs.oversized.length,
        packs: report.transcript.length,
        piSegments: report.piLogs.segments.length,
      };
    },

    seedCursors(ownerUserId, sessions) {
      seedMovedSessionCursors(options.db, ownerUserId, sessions);
    },
  };
}
