import type Database from "better-sqlite3";
import {
  canonicalJson,
  emptySessionFollowUpState,
  type SessionFollowUpLedger,
  type SessionFollowUpState,
} from "@volli/session-engine";
import { prepared } from "./prepared";
import { settleTransaction } from "./transaction-gate";

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
        const result = work(state);
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

const record = (value: unknown) =>
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
  return state;
}
