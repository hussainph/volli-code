import type Database from "better-sqlite3";
import {
  canonicalJson,
  emptySessionFollowUpState,
  sessionFollowUpDeliveryEvidence,
  type SessionFollowUpLedger,
  type SessionFollowUpState,
} from "@volli/session-engine";
import { prepared } from "./prepared";
import { settleTransaction, withTransaction } from "./transaction-gate";
import { deleteAppState, getAppState, setAppState } from "./app-state-repo";
import { readSqliteSessionCommandEvidence } from "../session-control/sqlite-ledger";

export const FOLLOW_UP_CLEAN_CLOSE_KEY = "volli:follow-up-clean-close";
export const FOLLOW_UP_DOWNGRADE_HOLD_DETAIL =
  "Held: an older Volli version ran since this was queued — edit or remove it";

function pendingWatermarks(db: Database.Database): Array<{ session_id: string; sequence: number }> {
  return prepared<[], { session_id: string; sequence: number }>(
    db,
    `SELECT q.session_id, COALESCE(MAX(e.sequence), 0) AS sequence
     FROM session_follow_up_queue q LEFT JOIN session_events e ON e.session_id = q.session_id
     WHERE q.pending_count > 0 GROUP BY q.session_id`,
  ).all();
}

/** Called only after a clean lifecycle drain, while SQLite is still open. */
export function stampFollowUpCleanClose(db: Database.Database, now: number): void {
  withTransaction(db, () => {
    // A quit before readiness (or failed consumption) must not overwrite the
    // prior process's still-unchecked watermark with this process's history.
    if (getAppState(db, FOLLOW_UP_CLEAN_CLOSE_KEY) !== undefined) return;
    const sessions = Object.fromEntries(
      pendingWatermarks(db).map(({ session_id, sequence }) => [session_id, sequence]),
    );
    setAppState(db, FOLLOW_UP_CLEAN_CLOSE_KEY, JSON.stringify({ v: 1, sessions }), now);
  });
}

/** Before ANY boot event writes; consume and hold atomically, or roll both back. */
export function consumeFollowUpCleanClose(
  db: Database.Database,
  onUnreadable?: (sessionId: string, error: unknown) => void,
): string[] {
  return withTransaction(db, () => {
    const encoded = getAppState(db, FOLLOW_UP_CLEAN_CLOSE_KEY);
    let stamp: unknown;
    if (encoded !== undefined) {
      try {
        stamp = JSON.parse(encoded);
      } catch {
        /* Unreadable stamp: hold, never guess. */
      }
    }
    const sessions = record(stamp) && stamp.v === 1 && record(stamp.sessions) ? stamp.sessions : {};
    const held: string[] = [];
    for (const { session_id, sequence } of pendingWatermarks(db)) {
      const previous = Object.hasOwn(sessions, session_id) ? sessions[session_id] : undefined;
      const stale =
        encoded !== undefined &&
        !(typeof previous === "number" && Number.isSafeInteger(previous) && previous >= sequence);
      const stored = prepared<[string], { state: string }>(
        db,
        "SELECT state FROM session_follow_up_queue WHERE session_id = ?",
      ).get(session_id)!;
      let state: SessionFollowUpState;
      try {
        state = readState(stored.state);
      } catch (error) {
        // The drain uses the same validator, so this row cannot send. Do not
        // let one corrupt Session's queue deny readiness to every Session.
        onUnreadable?.(session_id, error);
        continue;
      }
      let changed = false;
      for (const entry of state.entries) {
        if (!stale) continue;
        // A recorded send is only reconciled, never resubmitted. An orphaned
        // claim with NO recorded intent can still send and must be held too.
        if (
          entry.state === "releasing" &&
          prepared<[string, string]>(
            db,
            "SELECT 1 FROM session_commands WHERE session_id = ? AND id = ?",
          ).get(session_id, entry.deliveryCommandId)
        )
          continue;
        entry.state = "queued";
        entry.refused = true;
        entry.refusedDetail = FOLLOW_UP_DOWNGRADE_HOLD_DETAIL;
        changed = true;
      }
      if (changed) {
        state.revision += 1;
        prepared<[string, string]>(
          db,
          "UPDATE session_follow_up_queue SET state = ? WHERE session_id = ?",
        ).run(canonicalJson(state), session_id);
      }
      if (
        state.entries.some(
          (entry) => entry.refused && entry.refusedDetail === FOLLOW_UP_DOWNGRADE_HOLD_DETAIL,
        )
      )
        held.push(session_id);
    }
    deleteAppState(db, FOLLOW_UP_CLEAN_CLOSE_KEY);
    return held;
  });
}

/** No async work inside the atomic queue command/claim/settlement boundary. */
export function createSqliteSessionFollowUpLedger(db: Database.Database): SessionFollowUpLedger {
  return {
    transaction(sessionId, work) {
      return settleTransaction(db, () => {
        const stored = prepared<[string], { state: string }>(
          db,
          "SELECT state FROM session_follow_up_queue WHERE session_id = ?",
        ).get(sessionId);
        const state = stored ? readState(stored.state) : emptySessionFollowUpState();
        const result = work(state, (deliveryCommandId) => {
          const { command, receipts, events } = readSqliteSessionCommandEvidence(
            db,
            sessionId,
            deliveryCommandId,
          );
          return (
            command !== null &&
            sessionFollowUpDeliveryEvidence(sessionId, command, receipts, events) !== null
          );
        });
        if (result && typeof result === "object" && "then" in result) {
          throw new Error("Follow-up ledger transaction must be synchronous");
        }
        const encoded = canonicalJson(state);
        // Ordinary projections do not create rows or rewrite unchanged state.
        if (encoded !== stored?.state && (stored || state.revision > 0)) {
          prepared<[string, string, number]>(
            db,
            `
            INSERT INTO session_follow_up_queue(session_id, state, pending_count) VALUES (?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, pending_count = excluded.pending_count
          `,
          ).run(sessionId, encoded, state.entries.length);
        }
        return result;
      });
    },
    pendingSessionIds() {
      return settleTransaction(db, () =>
        prepared<[], { session_id: string }>(
          db,
          "SELECT session_id FROM session_follow_up_queue WHERE pending_count > 0 ORDER BY session_id",
        )
          .all()
          .map(({ session_id }) => session_id),
      );
    },
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readState(encoded: string): SessionFollowUpState {
  const value: unknown = JSON.parse(encoded);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid follow-up ledger state");
  const state = value as SessionFollowUpState;
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Array.isArray(state.entries) ||
    !record(state.commands) ||
    !record(state.releases) ||
    (state.releasedBoundary !== null && typeof state.releasedBoundary !== "string") ||
    state.entries.some(
      (entry) =>
        !record(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.commandId !== "string" ||
        typeof entry.deliveryCommandId !== "string" ||
        (entry.state !== "queued" && entry.state !== "releasing") ||
        !record(entry.message) ||
        entry.message.id !== entry.id ||
        entry.message.role !== "user" ||
        !Array.isArray(entry.message.parts),
    )
  ) {
    throw new Error("Invalid or unsupported follow-up ledger state");
  }
  // Recovery settles entries by these identities; duplicates could discard another payload.
  for (const field of ["id", "commandId", "deliveryCommandId"] as const) {
    if (new Set(state.entries.map((entry) => entry[field])).size !== state.entries.length) {
      throw new Error(`Duplicate follow-up ledger ${field}`);
    }
  }
  // Release is serialized per Session: recovery resumes the one in-flight claim.
  // Two claims mean a bug wrote this row, so fail loudly instead of guessing.
  if (state.entries.filter((entry) => entry.state === "releasing").length > 1) {
    throw new Error("More than one releasing follow-up ledger entry");
  }
  return state;
}
