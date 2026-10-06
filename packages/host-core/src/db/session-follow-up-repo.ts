import type Database from "better-sqlite3";
import {
  canonicalJson,
  emptySessionFollowUpState,
  type SessionFollowUpLedger,
  type SessionFollowUpState,
} from "@volli/session-engine";
import { hostLogger } from "../log/root";
import { prepared } from "./prepared";
import { settleTransaction } from "./transaction-gate";

const log = hostLogger("follow-up");

/** No async work inside the atomic queue command/claim/settlement boundary. */
export function createSqliteSessionFollowUpLedger(db: Database.Database): SessionFollowUpLedger {
  return {
    transaction(sessionId, work) {
      let before: ReadonlyMap<string, FollowUpRow> = new Map();
      let after: SessionFollowUpState | null = null;
      const settled = settleTransaction(db, () => {
        const stored = prepared<[string], { state: string }>(
          db,
          "SELECT state FROM session_follow_up_queue WHERE session_id = ?",
        ).get(sessionId);
        const state = stored ? readState(stored.state) : emptySessionFollowUpState();
        before = rowsOf(state);
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
          after = state;
        }
        return result;
      });
      // Each committed queue transition, with why, inside the operation that made it (VC-699).
      return settled.then((result) => {
        if (after !== null) logQueueChanges(sessionId, before, after);
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

interface FollowUpRow {
  readonly state: "queued" | "releasing";
  readonly commandId: string;
  readonly deliveryCommandId: string;
}

function rowsOf(state: SessionFollowUpState): ReadonlyMap<string, FollowUpRow> {
  return new Map(
    state.entries.map((entry) => [
      entry.id,
      {
        state: entry.state,
        commandId: entry.commandId,
        deliveryCommandId: entry.deliveryCommandId,
      },
    ]),
  );
}

/**
 * One line per queue transition: queued, claimed for release (and on which
 * idle boundary), a claim returned, delivered (with its receipt) or withdrawn.
 * Identifiers only; the message itself is never logged.
 */
export function logQueueChanges(
  sessionId: string,
  before: ReadonlyMap<string, FollowUpRow>,
  after: SessionFollowUpState,
): void {
  const now = rowsOf(after);
  const base = { sessionId, revision: after.revision, pending: after.entries.length };
  for (const [messageId, row] of now) {
    const was = before.get(messageId);
    const ids = { ...base, messageId, commandId: row.commandId };
    if (was === undefined) log.info("follow-up queued", ids);
    else if (was.state === "queued" && row.state === "releasing") {
      log.info("follow-up release claimed", {
        ...ids,
        deliveryCommandId: row.deliveryCommandId,
        reason: "idle-boundary",
        boundary: after.releasedBoundary,
      });
    } else if (was.state === "releasing" && row.state === "queued") {
      log.info("follow-up claim returned", { ...ids, reason: "not-sent" });
    }
  }
  for (const [messageId, row] of before) {
    if (now.has(messageId)) continue;
    const release = after.releases[row.deliveryCommandId];
    const ids = { ...base, messageId, commandId: row.commandId };
    if (release === undefined) log.info("follow-up withdrawn", { ...ids, reason: "cancelled" });
    else {
      log.info("follow-up delivered", {
        ...ids,
        deliveryCommandId: row.deliveryCommandId,
        status: release.receipt.status,
      });
    }
  }
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
  // Release is serialized per Session: recovery resumes the one in-flight claim.
  // Two claims mean a bug wrote this row, so fail loudly instead of guessing.
  if (state.entries.filter((entry) => entry.state === "releasing").length > 1) {
    throw new Error("More than one releasing follow-up ledger entry");
  }
  return state;
}
