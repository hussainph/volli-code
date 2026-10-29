/**
 * A moved Session's history objects, uploaded the runner's way while its
 * project is still hidden: what makes a moved Session readable in Volli
 * Cloud, not only stored ("Move to Volli Cloud", the importer's side).
 *
 * The runner's own spool ({@link TranscriptSpool}) packs the bodies a
 * Session's events reference into `volli.transcript-pack/1` objects, and
 * tails its Pi session files into log ranges, exactly as it does for a live
 * Session: same cut rules, same credential redaction, same bytes. Only the
 * doors differ. A hidden project's Sessions take nothing through the
 * runner's `transcripts.*`, so this spool talks to the import's own:
 *
 * - objects are PUT through `projectImportHistory.presignPut`, signed as the
 *   runner's are: an object no row commits yet may be replaced (an upload
 *   resumed after a crash writes its new bytes, and the commit records
 *   exactly those), a committed one is never signed again;
 * - the head and the commits go to `projectImportHistory.uploadHead`,
 *   `commitSegment` and `commitPiLogSegment`, under the person's sign-in,
 *   presenting the claim the import gave the Session (the move's runner,
 *   generation 1).
 *
 * Resumable from the backend's head alone, like the runner's: a re-run packs
 * only what no committed segment covers yet, and a commit of the same
 * object is a `duplicate`. A body this machine no longer has is left out of
 * its pack and named in the report (`missing`), never dropped silently.
 *
 * Receiving wiring (MOVE-5, the move engine): after a move's `sessionIntake`
 * rows are imported and before `projectImports.commit`, call
 * {@link MoveHistoryUploader.upload} for every moved Session, with its local
 * events, its Pi files (`piLogFilesOf` over its attachments) and the
 * profile's transcript store, and refuse to commit while any report names a
 * missing body or a Pi file left behind.
 */
import type { TranscriptReference } from "@volli/shared";
import type {
  SessionUploadGrant,
  SessionUploadHead,
  SegmentCommitResult,
} from "@volli/shared/cloud";

import { SpooledArtifactUnreadableError } from "../transcript-spool/artifact-spool";
import { PresignedObjectStore } from "../transcript-spool/object-store";
import {
  TranscriptSpool,
  type PackedSegment,
  type PiLogFile,
  type PiLogReport,
  type SpoolEvent,
  type SpoolRedaction,
  type TranscriptSpoolLimits,
} from "../transcript-spool/transcript-spool";

/**
 * The backend as the moving person calls it: Convex function paths
 * (`module:function`) with JSON arguments, under their own sign-in.
 */
export interface MoveBackend {
  query(path: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(path: string, args: Record<string, unknown>): Promise<unknown>;
  action(path: string, args: Record<string, unknown>): Promise<unknown>;
}

/** One moved Session's history, as this machine holds it. */
export interface MovedSessionHistory {
  sessionId: string;
  /** The moved project: the Session's object keys are under it. */
  projectId: string;
  /** The Session's last event, as its imported intake records it. */
  lastSequence: number;
  /** The claim generation the import gave it (its intake's). */
  generation: number;
  /** Its events after `afterSequence`, ascending, at most `limit`. */
  eventsAfter(
    afterSequence: number,
    limit: number,
  ): readonly SpoolEvent[] | Promise<readonly SpoolEvent[]>;
  /** The Pi session files its attachments wrote (`piLogFilesOf`). */
  piFiles: readonly PiLogFile[];
}

export interface MovedSessionUpload {
  transcript: PackedSegment[];
  piLogs: PiLogReport;
  /** Bodies its events reference that this machine could not read: in no pack. */
  missing: string[];
}

export interface MoveHistoryUploader {
  upload(session: MovedSessionHistory): Promise<MovedSessionUpload>;
}

export interface MoveHistoryUploaderOptions {
  moveId: string;
  /**
   * The runner the import named (`projectImports.status().importTarget.runnerId`),
   * whose claim every moved Session carries, even after the move was handed to
   * another driver.
   */
  runnerId: string;
  backend: MoveBackend;
  /** The profile's transcript bodies, verified canonical bytes by reference. */
  artifacts: { readCanonicalBytes(reference: TranscriptReference): Promise<Buffer> };
  redaction: SpoolRedaction;
  fetch?: typeof globalThis.fetch;
  /** Smaller cuts, for tests. */
  limits?: Partial<TranscriptSpoolLimits>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** The uploader for one move. Sessions may upload one after another or side by side. */
export function createMoveHistoryUploader(
  options: MoveHistoryUploaderOptions,
): MoveHistoryUploader {
  const { backend, moveId } = options;
  const sessions = new Map<string, MovedSessionHistory>();
  const known = (sessionId: string): MovedSessionHistory => {
    const session = sessions.get(sessionId);
    if (session === undefined) throw new Error(`Session ${sessionId} is not uploading`);
    return session;
  };

  const spool = new TranscriptSpool({
    artifacts: {
      async readCanonicalBytes(reference) {
        try {
          return await options.artifacts.readCanonicalBytes(reference);
        } catch (error) {
          if (!isMissing(error)) throw error;
          throw new SpooledArtifactUnreadableError(reference.id, "missing", { cause: error });
        }
      },
      flush: async () => {},
    },
    objects: new PresignedObjectStore({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      presignPut: async (request) =>
        (await backend.action("projectImportHistory:presignPut", {
          moveId,
          sessionId: request.sessionId,
          claim: { ...request.claim },
          key: request.key,
          bytes: request.bytes,
          sha256: request.sha256,
        })) as SessionUploadGrant,
    }),
    backend: {
      head: async (input) =>
        (await backend.query("projectImportHistory:uploadHead", {
          moveId,
          sessionId: input.sessionId,
          claim: { ...input.claim },
          piFileIds: [...input.piFileIds],
        })) as SessionUploadHead,
      // The import carries whole histories: nothing is staged ahead of its events.
      stageArtifacts: () => Promise.reject(new Error("A move stages no transcript bodies")),
      commitSegment: async (input) =>
        (await backend.mutation("projectImportHistory:commitSegment", {
          moveId,
          ...input,
          claim: { ...input.claim },
          turnIds: [...input.turnIds],
          digests: [...input.digests],
        })) as SegmentCommitResult,
      commitPiLogSegment: async (input) =>
        (await backend.mutation("projectImportHistory:commitPiLogSegment", {
          moveId,
          ...input,
          claim: { ...input.claim },
        })) as SegmentCommitResult,
    },
    events: {
      acceptedThrough: (sessionId) => known(sessionId).lastSequence,
      eventsAfter: (sessionId, afterSequence, limit) =>
        known(sessionId).eventsAfter(afterSequence, limit),
    },
    redaction: options.redaction,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });

  return {
    async upload(session) {
      if (sessions.has(session.sessionId)) {
        throw new Error(`Session ${session.sessionId} is already uploading`);
      }
      sessions.set(session.sessionId, session);
      try {
        const scope = {
          sessionId: session.sessionId,
          projectId: session.projectId,
          claim: { runnerId: options.runnerId, generation: session.generation },
        };
        const transcript = await spool.packTranscript(scope);
        const piLogs = await spool.packPiLogs(scope, session.piFiles);
        return {
          transcript,
          piLogs,
          missing: [...new Set(transcript.flatMap((segment) => segment.missing))],
        };
      } finally {
        sessions.delete(session.sessionId);
      }
    },
  };
}
