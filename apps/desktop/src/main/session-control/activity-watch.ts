/**
 * The push channel for Session state — a decorator over the Session Engine that
 * notices when a Session's durable history moved and re-derives its listing row.
 *
 * ── WHY A DECORATOR AND NOT A SUBSCRIPTION ────────────────────────────────
 * `SessionRuntime.subscribe` already streams one Session's frames, and that is
 * exactly why it cannot serve here: it is per-Session, and a listing is a
 * question about a PROJECT — every Session in it, including the ones nobody has
 * opened a view onto. Subscribing to each would mean holding a subscription per
 * Session for as long as the app is running, replaying every transcript delta
 * into main, to answer a question whose whole content is "did anything change".
 *
 * The Engine, by contrast, is a single choke point. Main constructs exactly one
 * (`index.ts`), the runtime holds it as a port, the agent socket and the IPC
 * handlers submit through it, and every durable write in the process goes
 * through one of its five mutating methods. Wrapping it once therefore sees
 * every change with no per-Session bookkeeping at all — and a mutating method
 * added to the interface fails to compile here until it has been given an
 * answer, which is the property a subscription could never have offered.
 *
 * ── WHAT IT PUBLISHES ─────────────────────────────────────────────────────
 * The whole {@link SessionListingRow}, built by the same `sessionListingRow`
 * the fetch uses, and only when it differs from what was last published for
 * that Session. Renderer listings hold these rows already, so applying one is
 * an upsert; and because publication is gated on the row actually differing,
 * a turn that writes forty durable facts without changing anything a listing
 * shows produces no traffic at all.
 *
 * ── COALESCING ────────────────────────────────────────────────────────────
 * Re-deriving a row means folding the Session's whole log, so writes are
 * coalesced on a short trailing timer rather than folded per event. The window
 * is deliberately tiny ({@link DEFAULT_COALESCE_MS}) — this exists because a
 * ten-second poll made the app feel laggy, and a fix that traded ten seconds
 * for one would have missed the point. At this width a burst of facts inside
 * one turn folds once, and a fact that arrives alone is on screen within a
 * frame or two.
 *
 * Failures are swallowed with a diagnostic and never propagated: this is an
 * observer bolted onto the write path, and a fold that throws must not be able
 * to fail the command that triggered it.
 */
import type { SessionEngine } from "@volli/session-engine";
import { PERSON_STARTED } from "@volli/shared";
import type { SessionListingRow, SessionProjection, SessionProvenance } from "@volli/shared";

import { sessionListingRow } from "./listing-row";

/**
 * How long writes are gathered before the dirty Sessions are re-folded.
 *
 * 60ms is under a handful of frames — below the threshold where a person can
 * tell a push from an instant update — while still collapsing the burst of
 * durable facts a single turn boundary writes into one fold.
 */
const DEFAULT_COALESCE_MS = 60;

export interface SessionActivityWatchPorts {
  /** Called once per Session whose listing row actually changed. */
  publish(notice: { projectId: string; ticketId: string | null; row: SessionListingRow }): void;
  /**
   * Who started a Session (VC-131), so a pushed row carries the same mark the
   * fetch gave it. A push that dropped it would take the bolt off a Run's row
   * the first time that Run did anything — the renderer upserts the whole row,
   * so a missing field is an erasure rather than an omission.
   *
   * Optional for the same reason `onError` is: a test that only asks whether a
   * write was noticed has no database to read provenance out of. Absent means
   * every row reads as person-started, which is the quiet answer.
   */
  provenanceOf?: (session: { sessionId: string; ticketId: string | null }) => SessionProvenance;
  /**
   * Every folded Session's projection, handed over BEFORE the row-difference
   * gate below (VC-133).
   *
   * This watch is the process's one choke point on durable Session writes, so
   * an observer that needs to notice a state CHANGE belongs here rather than
   * holding its own subscription per Session. `automations/run-attention.ts` is
   * the caller: it decides whether an unattended Run has just entered `waiting`
   * or `error`.
   *
   * **Before the gate, and given the projection rather than the row**, for two
   * independent reasons. The listing row cannot spell `error` at all —
   * `ChatSessionRecord.activity` has no such arm, because a listing draws that
   * state from transport facts the renderer holds — so a row-shaped observer
   * could not see half the rule. And the gate asks whether a LISTING changed,
   * which is a different question from whether this Session changed: a fold
   * that leaves the row byte-identical must still be able to move the rule.
   *
   * Failures inside it are the observer's own to swallow; this watch calls it
   * without a guard because {@link RunAttentionWatch.observe} is total.
   */
  observe?: (projection: SessionProjection) => void;
  /**
   * A Session this process just minted, announced from the create itself
   * rather than from a fold (VC-133).
   *
   * The observer above measures CHANGES, and a change needs a baseline. Every
   * other Session it meets was already alive when this process started, so its
   * first fold can only teach a baseline; a Session created here is the one
   * case where the baseline is known outright, because a Session that did not
   * exist a moment ago needs nobody.
   *
   * It cannot be folded out of the create instead: `getSession` is async and
   * this decoration sits on the optimistic-open path VC-16 exists to keep
   * fast, and the coalescing timer may well merge the create with the very
   * write that puts the Session in `error` — which is exactly the Automation
   * Run whose pinned model went away. The id alone, synchronously, says all
   * the observer needs.
   */
  observeBirth?: (sessionId: string) => void;
  /** Overridable for tests; defaults to {@link DEFAULT_COALESCE_MS}. */
  coalesceMs?: number;
  /** Diagnostics seam. Defaults to `console.warn`. */
  onError?: (error: unknown) => void;
}

export interface SessionActivityWatch {
  /**
   * The engine every caller must use from here on. It is behaviourally the one
   * that was handed in — same results, same errors, same timing — plus a note
   * taken after each mutating call.
   */
  engine: SessionEngine;
  /** Cancels the pending flush. Used at shutdown and by tests. */
  stop(): void;
  /** Flushes now rather than on the timer. Exposed for tests; nothing in the app calls it. */
  flush(): Promise<void>;
}

/**
 * Wraps `engine` so every durable write it accepts eventually re-publishes the
 * affected Session's listing row.
 *
 * The wrapper delegates by construction — every method is forwarded, and only
 * the five that can write are decorated. The read methods are passed through
 * untouched rather than spread from the original object so that a new method on
 * {@link SessionEngine} is a compile error here, not a silently missing
 * forward.
 */
export function watchSessionActivity(
  engine: SessionEngine,
  ports: SessionActivityWatchPorts,
): SessionActivityWatch {
  const coalesceMs = ports.coalesceMs ?? DEFAULT_COALESCE_MS;
  const onError =
    ports.onError ?? ((error: unknown) => console.warn("[volli] session activity watch:", error));
  const provenanceOf = ports.provenanceOf ?? (() => PERSON_STARTED);

  const dirty = new Set<string>();
  /**
   * The last row published per Session, serialized. Rows are built by our own
   * code from a fixed set of literals, so key order is stable and `JSON.stringify`
   * is a sound identity — this is not a general structural compare and must not
   * be reused as one.
   *
   * It grows with the number of Sessions touched in one run of the app, which is
   * bounded by the project's Session count; entries are never evicted because a
   * dropped one costs a duplicate publish, and a duplicate publish is a renderer
   * upsert that changes nothing.
   */
  const published = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let draining: Promise<void> = Promise.resolve();
  let stopped = false;

  function mark(sessionId: string): void {
    if (stopped) return;
    dirty.add(sessionId);
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      draining = draining.then(flush).catch(onError);
    }, coalesceMs);
    // Never hold the event loop open for a diagnostic timer: an app that has
    // finished its work must be allowed to quit with this pending.
    timer.unref?.();
  }

  async function flush(): Promise<void> {
    const ids = [...dirty];
    dirty.clear();
    for (const sessionId of ids) {
      try {
        const projection = await engine.getSession({ sessionId });
        // A Session the ledger no longer has is not an error worth reporting:
        // nothing can be said about it, and the listing that held it will drop
        // it on its own next read.
        if (projection === null) continue;
        // Before the row is built, and before the difference gate: see
        // `SessionActivityWatchPorts.observe` for why neither may stand
        // between a durable write and this rule.
        ports.observe?.(projection);
        const row = sessionListingRow(
          projection,
          provenanceOf({
            sessionId: projection.session.id,
            ticketId: projection.session.ticketId,
          }),
        );
        const signature = JSON.stringify(row);
        if (published.get(sessionId) === signature) continue;
        published.set(sessionId, signature);
        ports.publish({
          projectId: projection.session.projectId,
          ticketId: projection.session.ticketId,
          row,
        });
      } catch (error) {
        onError(error);
      }
    }
  }

  const watched: SessionEngine = {
    async createSession(request) {
      const result = await engine.createSession(request);
      // Before `mark`, so the baseline exists before any fold can read it.
      ports.observeBirth?.(result.session.id);
      mark(result.session.id);
      return result;
    },
    async getOrRecordSessionInput(request) {
      const result = await engine.getOrRecordSessionInput(request);
      mark(request.sessionId);
      return result;
    },
    async observe(observation) {
      const event = await engine.observe(observation);
      mark(event.sessionId);
      return event;
    },
    async submit(request) {
      const result = await engine.submit(request);
      mark(request.sessionId);
      return result;
    },
    async completeModelSelection(request) {
      const result = await engine.completeModelSelection(request);
      mark(request.sessionId);
      return result;
    },
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
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      dirty.clear();
    },
    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      draining = draining.then(flush).catch(onError);
      await draining;
    },
  };
}
