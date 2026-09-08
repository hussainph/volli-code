/**
 * The Session wake bus (VC-324 item 3): main's one post-commit stream of
 * Session Events.
 *
 * `ticket-wake.ts`'s twin, one ledger over. The await tool (`session.await`)
 * needs an in-process wake on a Session's own durable facts, and until this
 * module nothing in main could observe one as an EVENT: the renderer fan-out
 * carries listing rows, and `session-control/activity-watch.ts` — the only
 * other observer on this write path — coalesces on a 60ms timer and
 * re-publishes a re-derived {@link SessionListingRow}. A row draws liveness; a
 * waiter must decide whether THIS is the fact it parked on. So this bus
 * carries the durable {@link SessionEvent} itself, un-coalesced, with its
 * cursor. Both observers stay: a UI refresh and an agent wake are different
 * needs that only look alike.
 *
 * ## Why a decorator, and why over the same five methods
 *
 * `activity-watch.ts`'s header carries the argument and it holds unchanged
 * here: main constructs exactly ONE {@link SessionEngine}, every durable write
 * in the process goes through one of its five mutating methods, and wrapping
 * it once therefore sees every write with no per-Session bookkeeping. The
 * exhaustiveness is the property a subscription could never offer — every read
 * method is forwarded by hand, so a method added to the interface fails to
 * compile here until it has been given an answer.
 *
 * ## Why the events are read back rather than taken from the return value
 *
 * The obvious seam is what the mutating methods return, and it does not reach.
 * `observe` returns its `SessionEvent` and `createSession` returns three, but
 * `submit` returns only the command and receipt events — the `session.signaled`
 * / `session.stopped` event it appends in the same transaction
 * (`session-engine.ts`, the `sessionEvent` local) is never handed back. Two of
 * the four Phase-1 wake facts ride exactly that method, so a bus built on
 * return values would silently never wake on a verdict or a stop.
 *
 * So the drain reads migration 042's trigger-backed sequence table instead:
 * after each mutating call returns — which is after `db.transaction(...)`
 * committed — everything above the bus's high-water mark is fanned out in
 * ledger order. This is still PUSHED, not polled: every drain is caused by a
 * write, and nothing here runs on a timer.
 *
 * ## Exactly once, under interleaving
 *
 * The high-water mark lives on the bus rather than per call, and that is what
 * makes the drain exactly-once. Two decorated calls can overlap at an `await`
 * boundary; whichever drains first claims the rows, advances the mark, and the
 * other finds nothing. A per-call mark would announce the same event twice.
 *
 * ## Post-commit, never inside
 *
 * A wake for a fact SQLite may yet roll back is a wake for something that did
 * not happen. The drain runs after the engine's promise settles — including
 * when it REJECTS, deliberately: a command that failed part way can still have
 * committed an earlier transaction, and a waiter must be told about a fact
 * that is durably in the log regardless of what the caller was told.
 *
 * ## Listeners cannot break a write
 *
 * The mutation's caller has already been answered by the time the fan-out
 * runs, so a throwing listener must not unwind a write that committed honest
 * work. Errors are reported and swallowed — the isolation every fan-out in
 * this process practises.
 */

import type Database from "better-sqlite3";
import type { SessionEngine } from "@volli/session-engine";
import type { SessionEvent } from "@volli/shared";

import {
  currentSessionEventSequence,
  decodeSessionEventCursor,
  listSessionEventsAfter,
} from "./db/session-events-cursor-repo";

/** One committed Session fact and its opaque durable cursor. */
export interface SessionWake {
  event: SessionEvent;
  cursor: string;
}

export type SessionWakeListener = (wake: SessionWake) => void;

/** Subscribe to every post-commit Session Event; returns unsubscribe. */
export type SubscribeSessionWake = (listener: SessionWakeListener) => () => void;

export interface SessionWakePorts {
  /** The one handle the Session ledger writes through; the drain reads its sidecar. */
  db: Database.Database;
  /** Diagnostics seam. Defaults to `console.error`. */
  onError?: (error: unknown) => void;
}

export interface SessionWakeBus {
  /**
   * The engine every caller must use from here on. It is behaviourally the one
   * that was handed in — same results, same errors, same timing — plus a
   * post-commit fan-out of whatever each call appended.
   */
  engine: SessionEngine;
  subscribe: SubscribeSessionWake;
}

/**
 * Wrap `engine` so every durable Session Event it commits is announced.
 *
 * The wrapper delegates by construction: every method is forwarded, and only
 * the five that can write are decorated. Read methods are passed through
 * explicitly rather than spread from the original object so that a new method
 * on {@link SessionEngine} is a compile error here, not a silently missing
 * forward — the same rule `activity-watch.ts` holds.
 */
export function createSessionWakeBus(
  engine: SessionEngine,
  ports: SessionWakePorts,
): SessionWakeBus {
  const onError = ports.onError ?? ((error: unknown) => console.error(error));
  const listeners = new Set<SessionWakeListener>();
  // Where this process has already announced up to. Seeded at construction so
  // a launch never replays the whole ledger as fresh wakes.
  let announced = currentSessionEventSequence(ports.db);

  function drain(): void {
    let wakes: readonly SessionWake[];
    try {
      wakes = listSessionEventsAfter(ports.db, announced);
    } catch (error) {
      // A read that failed must not fail the write it followed. The mark does
      // not move, so the next write's drain announces these events too.
      onError(error);
      return;
    }
    if (wakes.length === 0) return;
    // The mark advances BEFORE the fan-out: a listener that writes (nothing
    // does today) must not be able to make a re-entrant drain announce the
    // same event twice. Read back out of the cursor the repo just minted, so
    // the bus and the tool agree on one encoding; a cursor this build could
    // not read leaves the mark where it was rather than moving it backwards.
    announced = decodeSessionEventCursor(wakes[wakes.length - 1]!.cursor) ?? announced;
    for (const wake of wakes) {
      // A snapshot, not the live Set: the listener a wake settles is the
      // listener that unsubscribes on it, and every waiter does exactly that.
      const settled = [...listeners];
      for (const listener of settled) {
        try {
          listener(wake);
        } catch (error) {
          onError(error);
        }
      }
    }
  }

  /** Announce after the call settles, whether it resolved or threw. */
  async function afterCommit<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } finally {
      drain();
    }
  }

  const watched: SessionEngine = {
    createSession: (request) => afterCommit(() => engine.createSession(request)),
    getOrRecordSessionInput: (request) =>
      afterCommit(() => engine.getOrRecordSessionInput(request)),
    observe: (observation) => afterCommit(() => engine.observe(observation)),
    submit: (request) => afterCommit(() => engine.submit(request)),
    completeModelSelection: (request) => afterCommit(() => engine.completeModelSelection(request)),
    getSession: (query) => engine.getSession(query),
    getBaseSession: (query) => engine.getBaseSession(query),
    listSessions: (query) => engine.listSessions(query),
    countSessions: (query) => engine.countSessions(query),
    listSessionStarts: (query) => engine.listSessionStarts(query),
    listLatestTicketSignals: (query) => engine.listLatestTicketSignals(query),
    listEvents: (query) => engine.listEvents(query),
    reportUsage: (query) => engine.reportUsage(query),
  };

  return {
    engine: watched,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
