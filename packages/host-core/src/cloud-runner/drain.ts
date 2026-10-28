/**
 * The fact drain: a runner's Session facts on their way into the backend.
 *
 * The runner's own Session ledger is the retry buffer. Nothing is copied into
 * an outbox: for each Session this runner has claimed there is one cursor row
 * (`acceptedThrough`, persisted runner-locally), and every ledger event above
 * it is still owed to the backend. The drain reads them in order and sends
 * them to `sessions.accept`:
 *
 * - one event per mutation while a Session is live, a batch (≤ 100 events,
 *   ≤ 128 KB) while it catches up;
 * - in order per Session: live facts pipelined, at most
 *   {@link DRAIN_LIMITS.perSession} in flight, a catch-up one batch at a time;
 *   all of it through the backend link, whose one gate keeps everything the
 *   runner sends at or under 32 mutations in flight. A Session's lane (live
 *   or backlog) changes only while nothing of it is queued or in flight, so
 *   the gate's priorities can never put a Session's facts out of order;
 * - idempotently: a resend of an accepted event is a duplicate, and the cursor
 *   only moves forward on the backend's word;
 * - `out_of_order` carries the backend's head, and the drain resends from
 *   there; a transient failure (the network, a restart, a function error)
 *   resends from the cursor after a backoff of 250 ms doubling to 5 s;
 * - `fenced`, `not_your_runner`, `conflict`, an unknown Session or a fact the
 *   backend can never take stop that Session's drain with a recorded,
 *   visible fault. Nothing is dropped, and nothing retries for ever into a
 *   refusal (AGENTS.md: auth and config failures need explicit recovery).
 *
 * The agent never waits on any of this: {@link FactDrain.nudge} only schedules
 * a pass. A crash loses nothing either: the cursor is written after each
 * accept, and a restart resends from it.
 */
import { encodeSessionJson, type SessionEvent } from "@volli/shared";

import type { MutationPriority } from "./flow";

export const DRAIN_LIMITS = {
  /** Mutations in flight for one Session, so one backlog cannot starve live Sessions. */
  perSession: 8,
  /** A catch-up batch: what `sessions.accept` takes at most. */
  batchEvents: 100,
  batchBytes: 128 * 1024,
  /** A Session more than this many events behind drains in batches, at backlog priority. */
  liveWindow: 8,
  retryBaseMs: 250,
  retryMaxMs: 5_000,
} as const;

/** A drain stopped for a reason retrying cannot fix. */
export interface DrainBlock {
  code: string;
  message: string;
  at: number;
}

/** One Session this runner drains: the row the runner-local store keeps. */
export interface DrainCursor {
  sessionId: string;
  /** The Session's owner: a runner drains its owner's Sessions only. */
  ownerUserId: string;
  /** The claim generation this runner holds. */
  generation: number;
  /** The last sequence the backend has accepted. */
  acceptedThrough: number;
  blocked: DrainBlock | null;
}

export interface DrainCursorStore {
  list(): readonly DrainCursor[];
  get(sessionId: string): DrainCursor | null;
  /** Durable before it returns. */
  save(cursor: DrainCursor): void;
}

/** The two ledger reads the drain needs: events after a sequence, in order, and the head. */
export interface DrainLedger {
  listEvents(query: {
    sessionId: string;
    afterSequence: number;
    limit: number;
  }): readonly SessionEvent[];
  latestEventSequence(sessionId: string): number;
}

export interface AcceptReply {
  acceptedThrough: number;
  duplicates: number;
  quarantined: number;
  unknownKinds?: number;
}

/** `sessions.accept`, as the backend link sends it. */
export type AcceptCall = (
  args: { sessionId: string; generation: number; events: string[] },
  options: { priority: MutationPriority; bytes: number },
) => Promise<AcceptReply>;

/** Refusals that stop a Session's drain until someone acts. */
const DRAIN_STOP_CODES = [
  "fenced",
  "not_your_runner",
  "conflict",
  "unknown_session",
  "not_found",
  "revoked",
  "not_a_runner",
  "preview_access_required",
  "parent_not_found",
  "corrupt_history",
  "corrupt_state",
  "corrupt_board",
  "invalid_job",
  "id_taken",
] as const;

/** A refusal from the backend, read off a ConvexError-shaped error, or `null` for a transient failure. */
function readAcceptRefusal(
  error: unknown,
): { code: string; acceptedThrough: number | null; message: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, acceptedThrough, message } = data as Record<string, unknown>;
  if (typeof code !== "string") return null;
  return {
    code,
    acceptedThrough: typeof acceptedThrough === "number" ? acceptedThrough : null,
    message: typeof message === "string" ? message : code,
  };
}

/** One event as `sessions.accept` reads it: the ledger codec's JSON text. */
function encodeDrainEvent(event: SessionEvent): string {
  return encodeSessionJson({
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    attachmentId: event.attachmentId ?? null,
    commandId: event.commandId ?? null,
    provenance: event.provenance,
    payload: event.payload,
  });
}

const utf8 = new TextEncoder();
const bytesOf = (text: string) => utf8.encode(text).length;

export interface FactDrainOptions {
  ledger: DrainLedger;
  cursors: DrainCursorStore;
  /** `sessions.accept` over the backend link (`acceptOverLink`), which gates it. */
  accept: AcceptCall;
  /** Only this owner's cursor rows drain (one runner, one owner). */
  ownerUserId: string;
  now?(): number;
  /** Timers for the retry backoff. */
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  random?(): number;
  /** A Session's drain stopped; the host shows it (attention, status). */
  onBlocked?(sessionId: string, block: DrainBlock): void;
  /** A transient failure, worth a log line. */
  onRetry?(sessionId: string, error: unknown, delayMs: number): void;
  /** The backend accepted through this sequence (the transcript spool packs settled turns from here). */
  onAccepted?(sessionId: string, acceptedThrough: number): void;
}

export interface FactDrainStatus {
  sessions: number;
  /** Events in the ledger the backend has not accepted yet, across every Session. */
  waiting: number;
  blocked: number;
}

export interface FactDrain {
  /** Drains every cursor row this owner has. */
  start(): void;
  /** Stops sending and retrying. Nothing is lost: a restart resends from each cursor. */
  stop(): void;
  /**
   * A Session this runner holds the claim for, at `generation`: its cursor
   * row at birth, or a newer claim on a known row (which ends a `fenced`
   * stop, since the old generation's refusal no longer applies).
   */
  adopt(sessionId: string, generation?: number): void;
  /** The ledger gained events for this Session. Never blocks the caller. */
  nudge(sessionId: string): void;
  /** Explicit recovery: clear a stopped Session's fault and try again. */
  retry(sessionId: string): void;
  /** Resend everything now (the link came back). */
  resumeAll(): void;
  /** Resolves when nothing this drain can send is still unsent or in flight. */
  idle(): Promise<void>;
  status(): FactDrainStatus;
}

interface Stream {
  cursor: DrainCursor;
  next: number;
  inFlight: number;
  /** The lane this stream's queued and in-flight sends are in. */
  lane: MutationPriority;
  /** After a refused batch: one fact at a time through this sequence. */
  singlyThrough: number;
  /** Bumped when everything in flight should be disregarded and resent. */
  epoch: number;
  failures: number;
  timer: unknown;
}

/** Refusals a single fact can earn that no resend fixes; as a batch, they mean "send it singly". */
const BATCH_REFUSALS = new Set(["batch_too_large", "event_too_large", "invalid_request"]);

export function createFactDrain(options: FactDrainOptions): FactDrain {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const streams = new Map<string, Stream>();
  let running = false;
  let idleWaiters: (() => void)[] = [];

  function streamOf(cursor: DrainCursor): Stream {
    let stream = streams.get(cursor.sessionId);
    if (stream === undefined) {
      stream = {
        cursor,
        next: cursor.acceptedThrough + 1,
        inFlight: 0,
        lane: "live",
        singlyThrough: 0,
        epoch: 0,
        failures: 0,
        timer: null,
      };
      streams.set(cursor.sessionId, stream);
    }
    return stream;
  }

  function persist(stream: Stream, patch: Partial<DrainCursor>) {
    stream.cursor = { ...stream.cursor, ...patch };
    options.cursors.save(stream.cursor);
  }

  function block(stream: Stream, code: string, message: string) {
    stream.epoch += 1;
    const blocked = { code, message, at: now() };
    persist(stream, { blocked });
    options.onBlocked?.(stream.cursor.sessionId, blocked);
  }

  function retryLater(stream: Stream, error: unknown) {
    stream.epoch += 1;
    stream.next = stream.cursor.acceptedThrough + 1;
    // Stopped: `start` resends from the cursor; no timer outlives `stop`.
    if (!running) return;
    stream.failures += 1;
    const ceiling = Math.min(
      DRAIN_LIMITS.retryMaxMs,
      DRAIN_LIMITS.retryBaseMs * 2 ** (stream.failures - 1),
    );
    // Jitter: between half and all of the ceiling.
    const delay = Math.round(ceiling / 2 + (random() * ceiling) / 2);
    options.onRetry?.(stream.cursor.sessionId, error, delay);
    // No timer is pending here: one is set only with an epoch bump, which
    // turns every later failure of that epoch into a stale one.
    stream.timer = setTimer(() => {
      stream.timer = null;
      pump(stream);
    }, delay);
  }

  function batchFrom(
    stream: Stream,
    limit: number,
  ): { events: string[]; bytes: number; last: number } | null {
    const read = options.ledger.listEvents({
      sessionId: stream.cursor.sessionId,
      afterSequence: stream.next - 1,
      limit,
    });
    const events: string[] = [];
    let bytes = 0;
    let last = stream.next - 1;
    for (const event of read) {
      // The ledger is contiguous; a gap would be a bug, and the backend would refuse it anyway.
      if (event.sequence !== last + 1) break;
      const text = encodeDrainEvent(event);
      const size = bytesOf(text);
      if (events.length > 0 && bytes + size > DRAIN_LIMITS.batchBytes) break;
      events.push(text);
      bytes += size;
      last = event.sequence;
    }
    return events.length === 0 ? null : { events, bytes, last };
  }

  function pump(stream: Stream) {
    try {
      pumpOnce(stream);
    } catch (error) {
      // A ledger or store read failed: transient, like the network.
      retryLater(stream, error);
    }
    settleIdle();
  }

  function pumpOnce(stream: Stream) {
    if (!running || stream.cursor.blocked !== null || stream.timer !== null) return;
    const head = options.ledger.latestEventSequence(stream.cursor.sessionId);
    if (stream.inFlight === 0) {
      // Only with nothing queued or in flight may the lane change.
      stream.lane = head - stream.next + 1 > DRAIN_LIMITS.liveWindow ? "backlog" : "live";
    }
    while (stream.next <= head) {
      const singly = stream.next <= stream.singlyThrough;
      if (stream.lane === "backlog" || singly) {
        // A catch-up goes one batch at a time, read only when it can be sent.
        if (stream.inFlight > 0) return;
      } else if (stream.inFlight >= DRAIN_LIMITS.perSession) {
        return;
      }
      const batch = batchFrom(
        stream,
        stream.lane === "backlog" && !singly ? DRAIN_LIMITS.batchEvents : 1,
      );
      if (batch === null) return;
      stream.next = batch.last + 1;
      send(stream, batch);
    }
  }

  function send(stream: Stream, batch: { events: string[]; bytes: number; last: number }) {
    const epoch = stream.epoch;
    const first = stream.next - batch.events.length;
    const { sessionId, generation } = stream.cursor;
    stream.inFlight += 1;
    options
      .accept(
        { sessionId, generation, events: batch.events },
        { priority: stream.lane, bytes: batch.bytes },
      )
      .then(
        (reply) => {
          stream.inFlight -= 1;
          stream.failures = 0;
          if (reply.acceptedThrough > stream.cursor.acceptedThrough) {
            persist(stream, { acceptedThrough: reply.acceptedThrough });
            options.onAccepted?.(sessionId, reply.acceptedThrough);
          }
        },
        (error: unknown) => {
          stream.inFlight -= 1;
          // A reply to a send already disregarded changes nothing.
          if (epoch === stream.epoch) refused(stream, batch, first, error);
        },
      )
      .catch((error: unknown) => retryLater(stream, error))
      .finally(() => pump(stream));
  }

  function refused(
    stream: Stream,
    batch: { events: string[]; last: number },
    first: number,
    error: unknown,
  ) {
    const refusal = readAcceptRefusal(error);
    if (refusal === null) return retryLater(stream, error);
    // A new Session's first fact arrived after a later one (a resend raced it): not a fault.
    const reordered =
      refusal.code === "unknown_session" && stream.cursor.acceptedThrough === 0 && first !== 1;
    if ((refusal.code === "out_of_order" && refusal.acceptedThrough !== null) || reordered) {
      stream.epoch += 1;
      const head = reordered ? 0 : refusal.acceptedThrough!;
      if (head !== stream.cursor.acceptedThrough) persist(stream, { acceptedThrough: head });
      stream.next = head + 1;
      return;
    }
    if ((DRAIN_STOP_CODES as readonly string[]).includes(refusal.code)) {
      return block(stream, refusal.code, refusal.message);
    }
    if (BATCH_REFUSALS.has(refusal.code)) {
      if (batch.events.length === 1) return block(stream, refusal.code, refusal.message);
      // The backend will not take this stretch as a batch: one fact at a time through it.
      stream.epoch += 1;
      stream.singlyThrough = batch.last;
      stream.next = stream.cursor.acceptedThrough + 1;
      return;
    }
    // `accept_failed` and `fold_failed` sanitize unexpected exceptions. Like a
    // transient bare Server Error (and an unknown future code), it backs off
    // without acknowledging or discarding any local fact.
    return retryLater(stream, error);
  }

  function waiting(): number {
    let total = 0;
    for (const stream of streams.values()) {
      total += Math.max(
        0,
        options.ledger.latestEventSequence(stream.cursor.sessionId) - stream.cursor.acceptedThrough,
      );
    }
    return total;
  }

  function settleIdle() {
    if (idleWaiters.length === 0) return;
    for (const stream of streams.values()) {
      if (stream.inFlight > 0) return;
      if (stream.cursor.blocked === null && running) {
        const head = options.ledger.latestEventSequence(stream.cursor.sessionId);
        if (stream.cursor.acceptedThrough < head) return;
      }
    }
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const done of waiters) done();
  }

  function scheduled(sessionId: string) {
    queueMicrotask(() => {
      const stream = streams.get(sessionId);
      if (stream !== undefined) pump(stream);
    });
  }

  return {
    start() {
      running = true;
      for (const cursor of options.cursors.list()) {
        if (cursor.ownerUserId !== options.ownerUserId) continue;
        const stream = streamOf(cursor);
        // A fault survives the restart, and is said again.
        if (stream.cursor.blocked !== null)
          options.onBlocked?.(cursor.sessionId, stream.cursor.blocked);
        pump(stream);
      }
    },
    stop() {
      running = false;
      for (const stream of streams.values()) {
        if (stream.timer !== null) clearTimer(stream.timer);
        stream.timer = null;
      }
      settleIdle();
    },
    adopt(sessionId, generation = 1) {
      const stored = options.cursors.get(sessionId);
      if (stored === null) {
        options.cursors.save({
          sessionId,
          ownerUserId: options.ownerUserId,
          generation,
          acceptedThrough: 0,
          blocked: null,
        });
        streamOf(options.cursors.get(sessionId)!);
        return scheduled(sessionId);
      }
      // Another owner's row is left alone.
      if (stored.ownerUserId !== options.ownerUserId) return;
      const stream = streamOf(stored);
      if (generation > stream.cursor.generation) {
        stream.epoch += 1;
        stream.next = stream.cursor.acceptedThrough + 1;
        persist(stream, {
          generation,
          blocked: stream.cursor.blocked?.code === "fenced" ? null : stream.cursor.blocked,
        });
      }
      scheduled(sessionId);
    },
    nudge(sessionId) {
      scheduled(sessionId);
    },
    retry(sessionId) {
      const stream = streams.get(sessionId);
      if (stream === undefined || stream.cursor.blocked === null) return;
      stream.failures = 0;
      stream.next = stream.cursor.acceptedThrough + 1;
      persist(stream, { blocked: null });
      pump(stream);
    },
    resumeAll() {
      for (const stream of streams.values()) {
        if (stream.timer !== null) {
          clearTimer(stream.timer);
          stream.timer = null;
        }
        stream.failures = 0;
        pump(stream);
      }
    },
    idle() {
      return new Promise((done) => {
        idleWaiters.push(done);
        settleIdle();
      });
    },
    status() {
      let blocked = 0;
      for (const stream of streams.values()) if (stream.cursor.blocked !== null) blocked += 1;
      return { sessions: streams.size, waiting: waiting(), blocked };
    },
  };
}
