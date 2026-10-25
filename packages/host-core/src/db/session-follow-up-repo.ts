import type Database from "better-sqlite3";
import {
  canonicalJson,
  emptySessionFollowUpState,
  pruneSessionFollowUpState,
  sessionFollowUpDeliveryEvidence,
  type SessionFollowUpLedger,
  type SessionFollowUpState,
} from "@volli/session-engine";
import type { CommandReceipt, Synchronous } from "@volli/shared";
import { logContext, withRootLogContext } from "../log/context";
import { commandTrace, rememberCommandTrace } from "../log/correlation";
import { hostLogger } from "../log/root";
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

/** The launch scope is registered only after boot consumption commits. */
const cleanCloseScopes = new WeakMap<Database.Database, (sessionId: string) => boolean>();

function cleanCloseStamp(encoded: string | undefined): {
  sessions: Record<string, unknown>;
  consumedSessionIds: readonly string[];
} {
  let stamp: unknown;
  try {
    if (encoded !== undefined) stamp = JSON.parse(encoded);
  } catch {
    /* An unreadable marker holds every unconsumed queue, never guesses. */
  }
  if (!record(stamp) || stamp.v !== 1 || !record(stamp.sessions)) {
    return { sessions: {}, consumedSessionIds: [] };
  }
  return {
    sessions: stamp.sessions,
    consumedSessionIds:
      Array.isArray(stamp.consumedSessionIds) &&
      stamp.consumedSessionIds.every((id: unknown) => typeof id === "string")
        ? stamp.consumedSessionIds
        : [],
  };
}

/** Called only after a clean lifecycle drain, while SQLite is still open. */
export function stampFollowUpCleanClose(db: Database.Database, now: number): void {
  withTransaction(db, () => {
    const encoded = getAppState(db, FOLLOW_UP_CLEAN_CLOSE_KEY);
    const ownsSession = cleanCloseScopes.get(db);
    // A quit before readiness (or failed consumption) must not overwrite the
    // prior process's still-unchecked watermark with this process's history.
    if (ownsSession === undefined && encoded !== undefined) return;
    const pending = pendingWatermarks(db);
    if (ownsSession === undefined) {
      const sessions = Object.fromEntries(
        pending.map(({ session_id, sequence }) => [session_id, sequence]),
      );
      setAppState(db, FOLLOW_UP_CLEAN_CLOSE_KEY, JSON.stringify({ v: 1, sessions }), now);
      return;
    }
    const previous = cleanCloseStamp(encoded);
    const sessions = new Map(Object.entries(previous.sessions));
    const consumed = new Set(previous.consumedSessionIds);
    for (const id of sessions.keys()) if (ownsSession(id)) sessions.delete(id);
    for (const id of consumed) if (ownsSession(id)) consumed.delete(id);
    for (const { session_id, sequence } of pending) {
      if (ownsSession(session_id)) sessions.set(session_id, sequence);
      // There was no downgrade sentinel at all. Do not invent one for a
      // different owner's queue just because this launch closes cleanly.
      else if (encoded === undefined) consumed.add(session_id);
    }
    setAppState(
      db,
      FOLLOW_UP_CLEAN_CLOSE_KEY,
      JSON.stringify({
        v: 1,
        sessions: Object.fromEntries(sessions),
        ...(consumed.size === 0 ? {} : { consumedSessionIds: [...consumed] }),
      }),
      now,
    );
  });
}

/** Before ANY boot event writes; consume and hold atomically, or roll both back. */
export function consumeFollowUpCleanClose(
  db: Database.Database,
  onUnreadable?: (sessionId: string, error: unknown) => void,
  ownsSession?: (sessionId: string) => boolean,
): string[] {
  const heldSessions = withTransaction(db, () => {
    const encoded = getAppState(db, FOLLOW_UP_CLEAN_CLOSE_KEY);
    const { sessions, consumedSessionIds } = cleanCloseStamp(encoded);
    const consumed = new Set(consumedSessionIds);
    const pending = pendingWatermarks(db).filter(
      ({ session_id }) => ownsSession?.(session_id) ?? true,
    );
    const held: string[] = [];
    for (const { session_id, sequence } of pending) {
      const previous = Object.hasOwn(sessions, session_id) ? sessions[session_id] : undefined;
      const stale =
        encoded !== undefined &&
        !consumed.has(session_id) &&
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
        pruneSessionFollowUpState(state, Date.now());
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
    if (ownsSession === undefined) deleteAppState(db, FOLLOW_UP_CLEAN_CLOSE_KEY);
    else if (encoded !== undefined) {
      // Additive to the v1 marker. A consumed owner has no active watermark
      // until clean close; foreign owners keep their original sentinel. This
      // also preserves the old crash-without-a-watermark behavior per owner.
      for (const { session_id } of pending) consumed.add(session_id);
      setAppState(
        db,
        FOLLOW_UP_CLEAN_CLOSE_KEY,
        JSON.stringify({
          v: 1,
          sessions,
          ...(consumed.size === 0 ? {} : { consumedSessionIds: [...consumed] }),
        }),
        Date.now(),
      );
    }
    return held;
  });
  if (ownsSession === undefined) cleanCloseScopes.delete(db);
  else cleanCloseScopes.set(db, ownsSession);
  return heldSessions;
}

const log = hostLogger("follow-up");

/** No async work inside the atomic queue command/claim/settlement boundary. */
export function createSqliteSessionFollowUpLedger(
  db: Database.Database,
  ownsSession?: (sessionId: string) => boolean,
): SessionFollowUpLedger {
  return {
    transaction(sessionId, work, options) {
      let before: ReadonlyMap<string, FollowUpRow> = new Map();
      let after: SessionFollowUpState | null = null;
      const delivered = new Map<string, CommandReceipt>();
      const readOnly = options?.mode === "read";
      const settle = readOnly ? readTransaction : settleTransaction;
      const settled = settle(db, () => {
        if (ownsSession !== undefined && !ownsSession(sessionId)) {
          throw new Error("The follow-up queue is outside this launch's Session scope");
        }
        const stored = prepared<[string], { state: string }>(
          db,
          "SELECT state FROM session_follow_up_queue WHERE session_id = ?",
        ).get(sessionId);
        const state = stored ? readState(stored.state) : emptySessionFollowUpState();
        if (!readOnly) before = rowsOf(state);
        const evidence = (deliveryCommandId: string): CommandReceipt | null => {
          const { command, receipts, events } = readSqliteSessionCommandEvidence(
            db,
            sessionId,
            deliveryCommandId,
          );
          return command === null
            ? null
            : sessionFollowUpDeliveryEvidence(sessionId, command, receipts, events);
        };
        const result = work(state, (deliveryCommandId) => evidence(deliveryCommandId) !== null);
        if (result && typeof result === "object" && "then" in result) {
          throw new Error("Follow-up ledger transaction must be synchronous");
        }
        // Snapshot reads neither serialize/prune state nor acquire a writer lock.
        // Even accidental callback mutations are discarded, as the port promises.
        if (readOnly) return result;
        pruneSessionFollowUpState(state, Date.now());
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
          const remaining = new Set(state.entries.map(({ id }) => id));
          for (const [messageId, row] of before) {
            if (remaining.has(messageId)) continue;
            const receipt = evidence(row.deliveryCommandId);
            if (receipt !== null) delivered.set(row.deliveryCommandId, receipt);
          }
        }
        return result;
      });
      // Each committed queue transition, with why, inside the operation that made it (VC-699).
      return settled.then((result) => {
        if (after !== null) logQueueChanges(sessionId, before, after, delivered);
        return result;
      });
    },
    pendingSessionIds() {
      return readTransaction(db, () =>
        prepared<[], { session_id: string }>(
          db,
          "SELECT session_id FROM session_follow_up_queue WHERE pending_count > 0 ORDER BY session_id",
        )
          .all()
          .map(({ session_id }) => session_id)
          .filter((sessionId) => ownsSession?.(sessionId) ?? true),
      );
    },
  };
}

/** Native deferred transactions participate in the existing ownership guard. */
function readTransaction<T>(db: Database.Database, work: () => Synchronous<T>): Promise<T> {
  try {
    return Promise.resolve(db.transaction(work).deferred());
  } catch (error) {
    return Promise.reject(error);
  }
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
 *
 * A queued message's trace is the request that queued it, and it stays the
 * message's (VC-699): its release happens later, when some other turn ends,
 * so every later line about it, and its delivery command, is joined to that
 * trace by id (`log/correlation`), never to whichever operation happened to
 * release it.
 */
export function logQueueChanges(
  sessionId: string,
  before: ReadonlyMap<string, FollowUpRow>,
  after: SessionFollowUpState,
  delivered: ReadonlyMap<string, CommandReceipt>,
): void {
  const now = rowsOf(after);
  const base = { sessionId, revision: after.revision, pending: after.entries.length };
  const ambient = logContext()["traceId"];
  const underTrace = (commandId: string, write: () => void): void => {
    const owner = commandTrace(commandId);
    if (owner === undefined || owner === ambient) write();
    else withRootLogContext({ traceId: owner }, write);
  };
  for (const [messageId, row] of now) {
    const was = before.get(messageId);
    const ids = { ...base, messageId, commandId: row.commandId };
    if (was === undefined) {
      if (typeof ambient === "string") {
        rememberCommandTrace(row.commandId, ambient);
        rememberCommandTrace(row.deliveryCommandId, commandTrace(row.commandId) ?? ambient);
      }
      underTrace(row.commandId, () => log.info("follow-up queued", ids));
    } else if (was.state === "queued" && row.state === "releasing") {
      underTrace(row.commandId, () =>
        log.info("follow-up release claimed", {
          ...ids,
          deliveryCommandId: row.deliveryCommandId,
          reason: "idle-boundary",
          boundary: after.releasedBoundary,
        }),
      );
    } else if (was.state === "releasing" && row.state === "queued") {
      underTrace(row.commandId, () =>
        log.info("follow-up claim returned", { ...ids, reason: "not-sent" }),
      );
    }
  }
  for (const [messageId, row] of before) {
    if (now.has(messageId)) continue;
    const receipt = delivered.get(row.deliveryCommandId);
    const ids = { ...base, messageId, commandId: row.commandId };
    if (receipt === undefined) {
      underTrace(row.commandId, () =>
        log.info("follow-up withdrawn", { ...ids, reason: "cancelled" }),
      );
    } else {
      underTrace(row.commandId, () =>
        log.info("follow-up delivered", {
          ...ids,
          deliveryCommandId: row.deliveryCommandId,
          status: receipt.status,
        }),
      );
    }
  }
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
