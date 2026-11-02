/**
 * Boot recovery's reads over the SQLite ledger: which Sessions the sweep could
 * act on, and when the prior process was last alive, without folding every
 * Session the machine ever had (VC-1095).
 *
 * The sweep used to list every project's whole roster, folded, before
 * readiness. On a long-lived profile that is thousands of folds and hundreds
 * of megabytes to find the handful of Sessions a relaunch actually touches.
 * Here the ledger's indexed facts pick the candidates and only those are
 * folded, through the engine's ordinary `getSession`, which still decides.
 * It is the same pattern as `listAttachedSessions` (VC-403) and
 * `listPossiblyLiveProjectRunsForAutomation` (VC-816): the query decides
 * nothing except which Sessions skip the fold, and every test in it is wider
 * than the fold, never narrower.
 */
import type Database from "better-sqlite3";
import type { SessionEngine } from "@volli/session-engine";
import {
  decodeSessionEventPayload,
  movesSessionActivity,
  UnknownSessionEventKindError,
} from "@volli/shared";

import { prepared } from "../db/prepared";
import type { BootRecoveryEngine } from "./boot-recovery";
import { STRUCTURED_ADAPTER_ID } from "./sessions";

/**
 * A project's Sessions the sweep could act on, newest first like a listing.
 *
 * The sweep acts on a Session only through one of its attachments or its
 * Interactions, and each clause below keeps every Session the fold could put
 * in one of those states:
 *
 *  - **An open attachment that is not the structured adapter's** is closed as
 *    not rebuildable. `session_attachments` records every opened attachment
 *    with the adapter its `attachment.opened` named, and `closed_sequence`
 *    (migration 051) is set by the `attachment.closed` that the fold reads as
 *    the close, so an attachment the fold calls open always has a row here
 *    with `closed_sequence IS NULL` — the partial `session_attachments_open`
 *    index.
 *  - **An open structured attachment under an active turn** is reconciled.
 *    The fold sets `turnActive` on `turn.started` and clears it on
 *    `turn.completed`, `turn.interrupted`, `attachment.closed` and
 *    `attachment.failed`, so it can be set only when the latest `turn.started`
 *    follows every one of those. Each is an index-only MAX on
 *    `session_event_sequence_match (session_id, kind, sequence)`. That
 *    sequence is the fleet's append order, and within one Session it is the
 *    Session's own order: the ledger appends a Session's event only as its
 *    head plus one, and the trigger numbers the row as it is inserted.
 *  - **An active Interaction** is cancelled, on any structured attachment,
 *    open or not. The fold opens one only on `interaction.opened` and ends it
 *    only on an `interaction.resolved` or `interaction.cancelled` for the same
 *    id that comes later. JSON is read only from those few rows.
 *
 * The venue and adapter of a turn's attachment are left to the fold: a
 * Session another runner holds is kept and then left alone by the sweep.
 */
const CANDIDATES_SQL = `
SELECT s.id FROM sessions s
 WHERE s.project_id = @projectId
   AND (
     EXISTS (
       SELECT 1 FROM session_attachments attachment
        WHERE attachment.session_id = s.id
          AND attachment.closed_sequence IS NULL
          AND attachment.observed_kind = 'opened'
          AND (
            attachment.adapter_id <> @structured
            OR COALESCE((
              SELECT MAX(started.sequence) FROM session_event_sequence started
               WHERE started.session_id = s.id AND started.kind = 'turn.started'
            ), 0) > MAX(
              COALESCE((SELECT MAX(ended.sequence) FROM session_event_sequence ended
                         WHERE ended.session_id = s.id AND ended.kind = 'turn.completed'), 0),
              COALESCE((SELECT MAX(ended.sequence) FROM session_event_sequence ended
                         WHERE ended.session_id = s.id AND ended.kind = 'turn.interrupted'), 0),
              COALESCE((SELECT MAX(ended.sequence) FROM session_event_sequence ended
                         WHERE ended.session_id = s.id AND ended.kind = 'attachment.closed'), 0),
              COALESCE((SELECT MAX(ended.sequence) FROM session_event_sequence ended
                         WHERE ended.session_id = s.id AND ended.kind = 'attachment.failed'), 0)
            )
          )
     )
     OR EXISTS (
       SELECT 1 FROM session_event_sequence opened_order
         JOIN session_events opened ON opened.id = opened_order.event_id
        WHERE opened_order.session_id = s.id AND opened_order.kind = 'interaction.opened'
          AND NOT EXISTS (
            SELECT 1 FROM session_event_sequence ended_order
              JOIN session_events ended ON ended.id = ended_order.event_id
             WHERE ended_order.session_id = s.id
               AND ended_order.kind IN ('interaction.resolved', 'interaction.cancelled')
               AND ended.sequence > opened.sequence
               AND json_extract(ended.payload, '$.interactionId')
                   = json_extract(opened.payload, '$.interaction.id')
          )
     )
   )
 ORDER BY s.created_at DESC, s.id COLLATE BINARY DESC`;

/** The ledger's reads boot recovery needs, over the engine that still folds. */
export function createBootRecoveryEngine(input: {
  db: Database.Database;
  engine: Pick<SessionEngine, "getSession" | "observe">;
  /**
   * The launch's Session scope (a cloud owner's, or the frozen local one):
   * a Session outside it is neither swept nor counted. Absent, every Session.
   */
  owns?(sessionId: string): boolean;
}): BootRecoveryEngine {
  const { db, engine } = input;
  const owns = input.owns ?? (() => true);
  return {
    async listRecoveryCandidates({ projectId }) {
      const rows = prepared<[{ projectId: string; structured: string }], { id: string }>(
        db,
        CANDIDATES_SQL,
      ).all({ projectId, structured: STRUCTURED_ADAPTER_ID });
      const sessions = [];
      for (const { id } of rows) {
        if (!owns(id)) continue;
        const projection = await engine.getSession({ sessionId: id });
        if (projection !== null) sessions.push(projection);
      }
      return sessions;
    },
    async latestActivityAt({ projectIds, excluding }) {
      return latestActivityAt(db, projectIds, excluding, owns);
    },
    getSession: (query) => engine.getSession(query),
    observe: (observation) => engine.observe(observation),
  };
}

/**
 * The newest `lastActivityAt` among these projects' Sessions, by the fold's
 * rule without the fold.
 *
 * The fold seeds a Session's activity from its creation and moves it to the
 * `occurredAt` of each later fact that {@link movesSessionActivity} counts, so
 * its answer is the `occurredAt` of the LAST counted fact by sequence — not
 * the newest one, since a source's clock can run backwards — or the creation
 * time when none counts. That is read from the log's tail, newest first,
 * through the same payload decode the fold's reads use: a retired kind decodes
 * as the inert fact the fold sees, and a kind this build does not know is
 * dropped here as the fold's read drops it. A projection checkpoint changes
 * nothing, because it holds what the same fold made of the same prefix.
 *
 * Ownership is asked only of a Session that would raise the answer, so a
 * scope check is paid by a handful of Sessions, not the roster.
 */
function latestActivityAt(
  db: Database.Database,
  projectIds: readonly string[],
  excluding: ReadonlySet<string>,
  owns: (sessionId: string) => boolean,
): number | null {
  const sessions = prepared<[string], { id: string; created_at: number }>(
    db,
    "SELECT id, created_at FROM sessions WHERE project_id = ?",
  );
  const tail = prepared<[string], { occurred_at: number; payload: string }>(
    db,
    "SELECT occurred_at, payload FROM session_events WHERE session_id = ? ORDER BY sequence DESC",
  );
  let latest: number | null = null;
  for (const projectId of projectIds) {
    for (const session of sessions.all(projectId)) {
      if (excluding.has(session.id)) continue;
      let activity = session.created_at;
      for (const event of tail.iterate(session.id)) {
        const context = `session_events row of ${session.id}`;
        let kind;
        try {
          kind = decodeSessionEventPayload(JSON.parse(event.payload), context).kind;
        } catch (error) {
          if (error instanceof UnknownSessionEventKindError) continue;
          throw error;
        }
        if (!movesSessionActivity(kind)) continue;
        activity = event.occurred_at;
        break;
      }
      if ((latest === null || activity > latest) && owns(session.id)) latest = activity;
    }
  }
  return latest;
}
