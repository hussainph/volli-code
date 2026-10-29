/**
 * The drain's cursor rows and the job journal in the runner's local SQLite
 * (migration 65). Each write is one statement, so it is durable when it
 * returns (WAL, the host's own synchronous setting).
 */
import type Database from "better-sqlite3";

import type { JobOutcome } from "@volli/shared/cloud";

import { prepared } from "../db/prepared";
import { withTransaction } from "../db/transaction-gate";
import type { DrainCursor, DrainCursorStore } from "./drain";
import type { JobJournalEntry, JobJournalStore } from "./inbox";

interface CursorRow {
  session_id: string;
  owner_user_id: string;
  claim_generation: number;
  accepted_through: number;
  blocked_code: string | null;
  blocked_message: string | null;
  blocked_at: number | null;
}

function cursorOf(row: CursorRow): DrainCursor {
  return {
    sessionId: row.session_id,
    ownerUserId: row.owner_user_id,
    generation: row.claim_generation,
    acceptedThrough: row.accepted_through,
    blocked:
      row.blocked_code === null
        ? null
        : {
            code: row.blocked_code,
            message: row.blocked_message ?? row.blocked_code,
            at: row.blocked_at ?? 0,
          },
  };
}

export function sqliteDrainCursorStore(
  db: Database.Database,
  now: () => number = Date.now,
): DrainCursorStore {
  return {
    list: () =>
      (
        prepared(db, "SELECT * FROM session_drain_cursors ORDER BY session_id").all() as CursorRow[]
      ).map(cursorOf),
    get(sessionId) {
      const row = prepared(db, "SELECT * FROM session_drain_cursors WHERE session_id = ?").get(
        sessionId,
      ) as CursorRow | undefined;
      return row === undefined ? null : cursorOf(row);
    },
    save(cursor) {
      prepared(
        db,
        `INSERT INTO session_drain_cursors
           (session_id, owner_user_id, claim_generation, accepted_through,
            blocked_code, blocked_message, blocked_at, updated_at)
         VALUES (@sessionId, @ownerUserId, @generation, @acceptedThrough, @code, @message, @at, @updatedAt)
         ON CONFLICT (session_id) DO UPDATE SET
           owner_user_id = excluded.owner_user_id,
           claim_generation = excluded.claim_generation,
           accepted_through = excluded.accepted_through,
           blocked_code = excluded.blocked_code,
           blocked_message = excluded.blocked_message,
           blocked_at = excluded.blocked_at,
           updated_at = excluded.updated_at`,
      ).run({
        sessionId: cursor.sessionId,
        ownerUserId: cursor.ownerUserId,
        generation: cursor.generation,
        acceptedThrough: cursor.acceptedThrough,
        code: cursor.blocked?.code ?? null,
        message: cursor.blocked?.message ?? null,
        at: cursor.blocked?.at ?? null,
        updatedAt: now(),
      });
    },
    update(cursor, expected) {
      return (
        prepared(
          db,
          `UPDATE session_drain_cursors SET
             claim_generation = @generation, accepted_through = @acceptedThrough,
             blocked_code = @code, blocked_message = @message, blocked_at = @at,
             updated_at = @updatedAt
           WHERE session_id = @sessionId AND owner_user_id = @ownerUserId
             AND claim_generation = @expectedGeneration
             AND accepted_through = @expectedAcceptedThrough`,
        ).run({
          sessionId: cursor.sessionId,
          ownerUserId: cursor.ownerUserId,
          expectedGeneration: expected.generation,
          expectedAcceptedThrough: expected.acceptedThrough,
          generation: cursor.generation,
          acceptedThrough: cursor.acceptedThrough,
          code: cursor.blocked?.code ?? null,
          message: cursor.blocked?.message ?? null,
          at: cursor.blocked?.at ?? null,
          updatedAt: now(),
        }).changes > 0
      );
    },
  };
}

/** A Session a project move carried, and the last event its imported intake holds. */
export interface MovedSessionHead {
  sessionId: string;
  acceptedThrough: number;
}

/** A moved Session whose cursor this machine already holds otherwise. */
export class MovedSessionCursorConflictError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Session ${sessionId} already drains to Volli Cloud under another claim.`);
    this.name = "MovedSessionCursorConflictError";
    this.sessionId = sessionId;
  }
}

/**
 * Hands the Sessions of a moved project to this runner: one drain cursor
 * each, for the signed-in owner, at the claim the import gave it
 * (generation 1) and at the head its imported intake holds. That is what a
 * cloud launch's engine sees a Session by (`createCloudSessionOwner`), so a
 * moved Session can be resumed and steered here, and its drain owes the
 * backend only what happens after the move: a cursor adopted at 0 would send
 * the whole history again. A Session that has a cursor stops being one of
 * the signed-out local listing's.
 *
 * All or nothing, and idempotent: a cursor already seeded the same way is
 * left as it is; any other cursor for one of these Sessions refuses the lot
 * ({@link MovedSessionCursorConflictError}).
 *
 * Receiving wiring (MOVE-5, the move engine's handover step): call it with
 * every moved Session's `sessionIntake.acceptedThrough` once the move is
 * committed, and {@link releaseMovedSessionCursors} when it is rolled back.
 */
export function seedMovedSessionCursors(
  db: Database.Database,
  ownerUserId: string,
  sessions: readonly MovedSessionHead[],
  now: () => number = Date.now,
): { seeded: number; unchanged: number } {
  if (ownerUserId.length === 0) throw new Error("A moved Session needs an owner");
  const store = sqliteDrainCursorStore(db, now);
  return withTransaction(db, () => {
    let seeded = 0;
    let unchanged = 0;
    for (const { sessionId, acceptedThrough } of sessions) {
      if (!Number.isSafeInteger(acceptedThrough) || acceptedThrough < 0) {
        throw new Error(`Session ${sessionId} has no valid imported head`);
      }
      const existing = store.get(sessionId);
      if (existing === null) {
        store.save({ sessionId, ownerUserId, generation: 1, acceptedThrough, blocked: null });
        seeded += 1;
      } else if (
        existing.ownerUserId === ownerUserId &&
        existing.generation === 1 &&
        existing.acceptedThrough === acceptedThrough &&
        existing.blocked === null
      ) {
        unchanged += 1;
      } else {
        throw new MovedSessionCursorConflictError(sessionId);
      }
    }
    return { seeded, unchanged };
  });
}

/**
 * Takes back what {@link seedMovedSessionCursors} handed over, for a move
 * rolled back: each Session's cursor goes if it is still exactly as seeded
 * (this owner, generation 1, the imported head). A Session whose cursor moved
 * on (it took new facts in Volli Cloud) keeps it and is returned, so the
 * caller can say so rather than hide that history.
 */
export function releaseMovedSessionCursors(
  db: Database.Database,
  ownerUserId: string,
  sessions: readonly MovedSessionHead[],
): { released: number; kept: string[] } {
  return withTransaction(db, () => {
    let released = 0;
    const kept: string[] = [];
    for (const { sessionId, acceptedThrough } of sessions) {
      const removed = prepared(
        db,
        `DELETE FROM session_drain_cursors
          WHERE session_id = @sessionId AND owner_user_id = @ownerUserId
            AND claim_generation = 1 AND accepted_through = @acceptedThrough
            AND blocked_code IS NULL`,
      ).run({ sessionId, ownerUserId, acceptedThrough });
      if (removed.changes > 0) released += 1;
      else if (sqliteDrainCursorStore(db).get(sessionId) !== null) kept.push(sessionId);
    }
    return { released, kept };
  });
}

interface JournalRow {
  job_id: string;
  kind: string;
  lease_boot_id: string;
  lease_attempt: number;
  state: JobJournalEntry["state"];
  outcome_json: string | null;
  received_at: number;
}

function entryOf(row: JournalRow): JobJournalEntry {
  return {
    jobId: row.job_id,
    kind: row.kind,
    lease: { bootId: row.lease_boot_id, attempt: row.lease_attempt },
    state: row.state,
    outcome: row.outcome_json === null ? null : (JSON.parse(row.outcome_json) as JobOutcome),
    receivedAt: row.received_at,
  };
}

export function sqliteJobJournalStore(
  db: Database.Database,
  ownerUserId?: string,
): JobJournalStore {
  const ownerClause = ownerUserId === undefined ? "" : " AND owner_user_id = @ownerUserId";
  const ownerArgs = ownerUserId === undefined ? {} : { ownerUserId };
  return {
    get(jobId) {
      const row = prepared(db, `SELECT * FROM job_journal WHERE job_id = @jobId${ownerClause}`).get(
        { jobId, ...ownerArgs },
      ) as JournalRow | undefined;
      return row === undefined ? null : entryOf(row);
    },
    save(entry) {
      const saved = prepared(
        db,
        `INSERT INTO job_journal (job_id, kind, lease_boot_id, lease_attempt, state, outcome_json, received_at, owner_user_id)
         VALUES (@jobId, @kind, @bootId, @attempt, @state, @outcome, @receivedAt, @ownerUserId)
         ON CONFLICT (job_id) DO UPDATE SET
           kind = excluded.kind,
           lease_boot_id = excluded.lease_boot_id,
           lease_attempt = excluded.lease_attempt,
           state = excluded.state,
           outcome_json = excluded.outcome_json
         WHERE job_journal.owner_user_id IS excluded.owner_user_id`,
      ).run({
        jobId: entry.jobId,
        kind: entry.kind,
        bootId: entry.lease.bootId,
        attempt: entry.lease.attempt,
        state: entry.state,
        outcome: entry.outcome === null ? null : JSON.stringify(entry.outcome),
        receivedAt: entry.receivedAt,
        ownerUserId: ownerUserId ?? null,
      });
      if (saved.changes === 0) throw new Error("This job journal belongs to another runner owner.");
    },
    unreported: () =>
      (
        prepared(
          db,
          `SELECT * FROM job_journal WHERE outcome_json IS NOT NULL${ownerClause} ORDER BY received_at`,
        ).all(ownerArgs) as JournalRow[]
      ).map(entryOf),
    remove(jobId, attempt) {
      prepared(
        db,
        `DELETE FROM job_journal WHERE job_id = @jobId AND lease_attempt = @attempt${ownerClause}`,
      ).run({ jobId, attempt, ...ownerArgs });
    },
  };
}
