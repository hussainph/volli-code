/**
 * The drain's cursor rows and the job journal in the runner's local SQLite
 * (migration 65). Each write is one statement, so it is durable when it
 * returns (WAL, the host's own synchronous setting).
 */
import type Database from "better-sqlite3";

import type { JobOutcome } from "@volli/shared/cloud";

import { prepared } from "../db/prepared";
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
  };
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

export function sqliteJobJournalStore(db: Database.Database): JobJournalStore {
  return {
    get(jobId) {
      const row = prepared(db, "SELECT * FROM job_journal WHERE job_id = ?").get(jobId) as
        | JournalRow
        | undefined;
      return row === undefined ? null : entryOf(row);
    },
    save(entry) {
      prepared(
        db,
        `INSERT INTO job_journal (job_id, kind, lease_boot_id, lease_attempt, state, outcome_json, received_at)
         VALUES (@jobId, @kind, @bootId, @attempt, @state, @outcome, @receivedAt)
         ON CONFLICT (job_id) DO UPDATE SET
           kind = excluded.kind,
           lease_boot_id = excluded.lease_boot_id,
           lease_attempt = excluded.lease_attempt,
           state = excluded.state,
           outcome_json = excluded.outcome_json`,
      ).run({
        jobId: entry.jobId,
        kind: entry.kind,
        bootId: entry.lease.bootId,
        attempt: entry.lease.attempt,
        state: entry.state,
        outcome: entry.outcome === null ? null : JSON.stringify(entry.outcome),
        receivedAt: entry.receivedAt,
      });
    },
    unreported: () =>
      (
        prepared(
          db,
          "SELECT * FROM job_journal WHERE outcome_json IS NOT NULL ORDER BY received_at",
        ).all() as JournalRow[]
      ).map(entryOf),
    remove(jobId, attempt) {
      prepared(db, "DELETE FROM job_journal WHERE job_id = ? AND lease_attempt = ?").run(
        jobId,
        attempt,
      );
    },
  };
}
