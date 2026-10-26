/**
 * The runner's half of streamed text on Volli Cloud: a message still being
 * written, sent as ~500 ms chunk rows to the Sessions someone is watching.
 *
 * The source is the Session runtime's own overlay emission — the transient
 * `TranscriptDelta`s a local subscriber folds with `transcript-overlay.ts` —
 * so a viewer folds chunks with that same fold. A chunk is the coalesced
 * deltas of one stream (one message of one Session) since its previous
 * chunk. The rules (`@volli/shared/cloud` stream-chunks):
 *
 * - **Gated.** Only the Sessions in {@link StreamChunker.setWatched} (the
 *   runner's `sessionViewers.watched` subscription) are subscribed to at all.
 *   An unwatched Session sends facts only.
 * - **500 ms, one in flight per stream.** A tick that finds a stream's last
 *   chunk unacknowledged leaves its deltas pending, and they merge into the
 *   next chunk: natural backpressure, with nothing queued behind it.
 * - **Never buffered.** A chunk that fails is not retried. Its seq is skipped
 *   and the stream's next chunk is a baseline (a `reset` of the whole message
 *   from this chunker's own fold), which is how a reader heals the gap. The
 *   backend link refuses at once while offline, so what accumulates is the
 *   fold of the message, never a queue of chunks.
 * - **A baseline at least every 10 s** while a stream is active, so a late
 *   joiner (who starts at the latest baseline) catches up in one read.
 * - **Settled, then deleted.** When the message's durable fact appears in the
 *   runtime's stream, its pending deltas are dropped (the fact carries the
 *   whole message) and, if it ever sent a chunk, the backend is told the
 *   fact's sequence; it deletes the rows once it has accepted that fact. A
 *   streamed text message settles under a different id (its executor's entry
 *   id) and is removed just before, so a removed stream settles with the next
 *   transcript fact, or with the turn's end.
 *
 * Wiring: {@link startStreamChunks} is the whole of it — one chunker per
 * runner over the backend link and the Session runtime, fed by the link's
 * `sessionViewers:watched` subscription. `cloud-store/index.ts` starts it
 * beside `startRunnerSync` once both the runtime and connection are bound,
 * and stops it before closing that connection.
 */
import {
  applyTranscriptDelta,
  isSessionStreamFrame,
  isSessionStreamOverlay,
  type KeyedTranscriptMessage,
  type SessionRuntime,
  type SessionStreamEmission,
  type SessionStreamFrame,
  type TranscriptDelta,
} from "@volli/session-engine";
import {
  STREAM_CHUNK_BASELINE_INTERVAL_MS,
  STREAM_CHUNK_BASELINE_MAX_BYTES,
  STREAM_CHUNK_CADENCE_MS,
  STREAM_CHUNK_MAX_BYTES,
  STREAM_CHUNK_TTL_MS,
  utf8Length,
  type StreamChunkAppend,
  type StreamChunkSettle,
} from "@volli/shared/cloud";

import type { BackendLink } from "./backend-link";

/** The backend calls a chunker makes. */
export interface StreamChunkBackend {
  /** One append. Must reject at once while the link is offline: chunks are never buffered. */
  append(chunk: StreamChunkAppend): Promise<unknown>;
  settle(settle: StreamChunkSettle): Promise<unknown>;
}

/** The backend functions streamed text uses, by name. */
export const STREAM_CHUNK_FUNCTIONS = {
  append: "streamChunks:append",
  settle: "streamChunks:settle",
  /** The runner's one viewer subscription; it feeds {@link StreamChunker.setWatched}. */
  watched: "sessionViewers:watched",
} as const;

/** A chunk call made while the backend link is down: refused at once, never queued. */
export class StreamLinkOfflineError extends Error {
  readonly code = "offline";
  constructor() {
    super("The backend link is not connected; chunks are not buffered.");
    this.name = "StreamLinkOfflineError";
  }
}

/**
 * The chunk mutations over the backend link, in its `live` lane (after
 * control calls, ahead of the fact backlog). While the link is not connected
 * they are refused at once: the Convex client would otherwise hold them and
 * replay them on reconnect, which is buffering by another name.
 */
export function streamChunksOverLink(
  link: Pick<BackendLink, "mutate" | "status">,
): StreamChunkBackend {
  const send = (name: string, args: Record<string, unknown>) =>
    link.status.state === "connected"
      ? link.mutate(name, args, { priority: "live" })
      : Promise.reject(new StreamLinkOfflineError());
  return {
    append: (chunk) => send(STREAM_CHUNK_FUNCTIONS.append, { ...chunk }),
    settle: (settle) => send(STREAM_CHUNK_FUNCTIONS.settle, { ...settle }),
  };
}

/** A live subscription to one Session's emissions, from now on. */
export interface StreamSubscription {
  /** The Session's latest turn when the subscription opened. */
  turnId: string | null;
  close(): void;
}

/** Where a chunker hears a Session's transient overlays and durable frames. */
export interface StreamSource {
  open(
    sessionId: string,
    listener: (emission: SessionStreamEmission) => void,
    onFailure: (error: unknown) => void,
  ): Promise<StreamSubscription>;
}

/**
 * The Session runtime as a stream source: subscribed from its current head,
 * so nothing durable is replayed, and the runtime hands a fresh subscriber
 * one `reset` per message already in flight.
 */
export function runtimeStreamSource(
  runtime: Pick<SessionRuntime, "projection" | "subscribe">,
): StreamSource {
  return {
    async open(sessionId, listener, onFailure) {
      const { projection, throughSequence } = await runtime.projection({ sessionId });
      const close = await runtime.subscribe(
        { sessionId, afterSequence: throughSequence },
        listener,
        onFailure,
      );
      return { turnId: projection.latestTurnId, close };
    },
  };
}

export interface StreamChunkerTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface StreamChunkerOptions {
  source: StreamSource;
  backend: StreamChunkBackend;
  cadenceMs?: number;
  baselineIntervalMs?: number;
  /** How long a failed subscription waits before it is opened again. */
  reopenAfterMs?: number;
  timers?: StreamChunkerTimers;
  now?(): number;
  /** A failure worth a log line. Chunks are best-effort, so none is a fault on its own. */
  onError?(error: unknown, sessionId: string): void;
}

export interface StreamChunker {
  /** The Sessions someone watches now. Streams start and stop to match. */
  setWatched(sessionIds: Iterable<string>): void;
  /** Stops streaming and waits for the chunks in flight. */
  close(): Promise<void>;
}

const DEFAULT_TIMERS: StreamChunkerTimers = {
  setInterval: (run, ms) => {
    const handle = setInterval(run, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * How long a stream's seq counter outlives its last chunk. A row lives up to
 * the TTL plus one sweep interval; twice the TTL is past both, so a seq is
 * never reused while a row that holds it can still exist.
 */
const SEQ_RETENTION_MS = 2 * STREAM_CHUNK_TTL_MS;

/** One message of one watched Session. */
interface Stream {
  readonly messageId: string;
  /** This chunker's fold of the message: what a baseline sends. `null` once removed. */
  message: KeyedTranscriptMessage | null;
  pending: TranscriptDelta[];
  pendingBytes: number;
  /** The next chunk must be a baseline: one was lost, or the pending deltas outgrew a chunk. */
  needsBaseline: boolean;
  inFlight: Promise<void> | null;
  lastBaselineAt: number;
  throughSequence: number;
  /** A chunk of this stream was sent, so rows may exist that need deleting on settle. */
  sent: boolean;
  /** The message is larger than a baseline may be: it streams again only after a new `reset`. */
  suspended: boolean;
  /** Appends that failed in a row, and when the next may be tried: failures back off. */
  failures: number;
  retryAt: number;
}

interface Watch {
  readonly sessionId: string;
  subscription: StreamSubscription | null;
  /** When an open failed: the next attempt waits until then. */
  retryAt: number | null;
  opening: boolean;
  turnId: string | null;
  /** A `turn.started` frame set `turnId`, so the subscription's older answer must not replace it. */
  turnFromFrame: boolean;
  readonly streams: Map<string, Stream>;
  /**
   * The sequence each message of the current turn settled at: an overlay
   * emitted before its settle (`throughSequence` below it) is stale and must
   * not start a stream no settle will ever end.
   */
  readonly settledAt: Map<string, number>;
  /**
   * Streams whose message was removed after a chunk was sent. A streamed
   * text message is removed just before the settled message that replaces it
   * is recorded under its own id, so these settle with the next transcript
   * fact (or the turn's end).
   */
  readonly removed: Map<string, Stream>;
  closed: boolean;
}

/** The frames after which nothing of the turn is still streaming. */
const TURN_ENDS = new Set([
  "turn.completed",
  "turn.interrupted",
  "attachment.closed",
  "attachment.failed",
]);

function fold(
  message: KeyedTranscriptMessage | null,
  messageId: string,
  delta: TranscriptDelta,
): KeyedTranscriptMessage | null {
  const overlay = new Map(message === null ? [] : [[messageId, message] as const]);
  return applyTranscriptDelta(overlay, messageId, delta).get(messageId) ?? null;
}

function opBytes(delta: TranscriptDelta): number {
  return utf8Length(JSON.stringify(delta));
}

/**
 * Adds a delta to a stream's pending ones, merging it into the op before it
 * where the fold cannot tell the difference: text growth onto the same part's
 * append or into the text of the upsert that created it, and an upsert of the
 * part the previous op upserted (an upsert removes the key and re-inserts it,
 * so the later one alone folds to the same message). Tool progress re-sends
 * the whole part on every update, which is what the second rule is for.
 */
function enqueue(stream: Stream, delta: TranscriptDelta): void {
  const last = stream.pending.at(-1);
  const index = stream.pending.length - 1;
  if (last?.op === "part.upsert" && delta.op === "part.upsert" && last.key === delta.key) {
    stream.pendingBytes += opBytes(delta) - opBytes(last);
    stream.pending[index] = delta;
    return;
  }
  if (delta.op === "part.append" && last !== undefined) {
    if (last.op === "part.append" && last.key === delta.key) {
      stream.pending[index] = { ...last, text: `${last.text}${delta.text}` };
      stream.pendingBytes += utf8Length(delta.text);
      return;
    }
    if (
      last.op === "part.upsert" &&
      last.key === delta.key &&
      (last.part.type === "text" || last.part.type === "reasoning")
    ) {
      stream.pending[index] = {
        ...last,
        part: { ...last.part, text: `${last.part.text}${delta.text}` },
      };
      stream.pendingBytes += utf8Length(delta.text);
      return;
    }
  }
  stream.pending.push(delta);
  stream.pendingBytes += opBytes(delta);
}

export function createStreamChunker(options: StreamChunkerOptions): StreamChunker {
  const timers = options.timers ?? DEFAULT_TIMERS;
  const now = options.now ?? Date.now;
  const cadenceMs = options.cadenceMs ?? STREAM_CHUNK_CADENCE_MS;
  const baselineIntervalMs = options.baselineIntervalMs ?? STREAM_CHUNK_BASELINE_INTERVAL_MS;
  const reopenAfterMs = options.reopenAfterMs ?? 5_000;
  const watches = new Map<string, Watch>();
  /**
   * The next seq per stream, kept after a Session stops being watched: a
   * stream watched again continues its seqs rather than reusing ones whose
   * rows still exist. Forgotten after {@link SEQ_RETENTION_MS}.
   */
  const seqs = new Map<string, { next: number; at: number }>();
  const inFlight = new Set<Promise<void>>();
  let interval: unknown = null;
  let closed = false;

  const report = (error: unknown, sessionId: string) => options.onError?.(error, sessionId);

  function nextSeq(sessionId: string, messageId: string): number {
    const key = `${sessionId}\u0000${messageId}`;
    const seq = seqs.get(key)?.next ?? 0;
    seqs.set(key, { next: seq + 1, at: now() });
    return seq;
  }

  function track(promise: Promise<void>): Promise<void> {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
    return promise;
  }

  function settle(watch: Watch, stream: Stream, sequence: number): void {
    watch.streams.delete(stream.messageId);
    // A chunk still in flight could land after the delete, so the settle follows it.
    const after = stream.inFlight ?? Promise.resolve();
    track(
      after.then(async () => {
        if (!stream.sent) return;
        try {
          await options.backend.settle({
            sessionId: watch.sessionId,
            messageId: stream.messageId,
            sequence,
          });
        } catch (error) {
          report(error, watch.sessionId);
        }
      }),
    );
  }

  function onFrame(watch: Watch, frame: SessionStreamFrame): void {
    const { payload } = frame.event;
    if (payload.kind === "turn.started") {
      watch.turnId = payload.turnId;
      watch.turnFromFrame = true;
    }
    const messageId = frame.transcript?.message.id;
    const turnEnds = TURN_ENDS.has(payload.kind);
    if (payload.kind === "transcript.referenced" && messageId !== undefined) {
      watch.settledAt.set(messageId, frame.sequence);
      const stream = watch.streams.get(messageId);
      if (stream !== undefined) settle(watch, stream, frame.sequence);
    }
    if (payload.kind === "transcript.referenced" || turnEnds) {
      // The removed streams this fact replaced, sent or still pending.
      for (const stream of watch.removed.values()) settle(watch, stream, frame.sequence);
      watch.removed.clear();
      for (const stream of watch.streams.values()) {
        if (stream.message === null) settle(watch, stream, frame.sequence);
      }
    }
    if (turnEnds) {
      // Whatever is still open was never settled (a closed attachment drops
      // its overlay without a removal); its rows go with the turn's cleanup.
      watch.streams.clear();
      watch.settledAt.clear();
    }
  }

  function onEmission(watch: Watch, emission: SessionStreamEmission): void {
    if (watch.closed) return;
    if (isSessionStreamFrame(emission)) {
      onFrame(watch, emission);
      return;
    }
    if (!isSessionStreamOverlay(emission)) return;
    const { messageId, delta } = emission;
    let stream = watch.streams.get(messageId);
    if (stream === undefined) {
      // A delta for a message with no baseline is one every fold ignores, and
      // a baseline older than the message's settle is one a reader drops.
      if (delta.op !== "reset") return;
      if (emission.throughSequence < (watch.settledAt.get(messageId) ?? 0)) return;
      stream = {
        messageId,
        message: null,
        pending: [],
        pendingBytes: 0,
        needsBaseline: false,
        inFlight: null,
        lastBaselineAt: Number.NEGATIVE_INFINITY,
        throughSequence: emission.throughSequence,
        sent: false,
        suspended: false,
        failures: 0,
        retryAt: 0,
      };
      watch.streams.set(messageId, stream);
    }
    if (delta.op !== "reset" && stream.message === null) return;
    stream.message = fold(stream.message, messageId, delta);
    stream.throughSequence = Math.max(stream.throughSequence, emission.throughSequence);
    if (delta.op === "reset") {
      // A reset supersedes whatever was pending, and re-arms a suspended stream.
      stream.pending = [delta];
      stream.pendingBytes = opBytes(delta);
      stream.suspended = false;
    } else enqueue(stream, delta);
    if (stream.pendingBytes > STREAM_CHUNK_MAX_BYTES && stream.message !== null) {
      // Too much for one chunk: the fold already holds it, so a reset says it all.
      stream.pending = [];
      stream.pendingBytes = 0;
      stream.needsBaseline = true;
    }
  }

  /** The next chunk of a stream, or `null` when it has nothing to send (or may not). */
  function nextChunk(stream: Stream, at: number): { baseline: boolean; ops: string } | null {
    if (stream.message === null) {
      // Removed: whatever was pending is moot. A reader that missed rows has
      // already dropped the message, so the removal needs no baseline.
      return { baseline: false, ops: JSON.stringify([{ op: "message.remove" }]) };
    }
    if (stream.suspended) return null;
    if (stream.pending.length === 0 && !stream.needsBaseline) return null;
    let baseline =
      stream.needsBaseline ||
      at - stream.lastBaselineAt >= baselineIntervalMs ||
      stream.pending[0]?.op === "reset";
    let ops = baseline ? null : JSON.stringify(stream.pending);
    if (ops !== null && utf8Length(ops) > STREAM_CHUNK_MAX_BYTES) {
      baseline = true;
      ops = null;
    }
    if (ops === null) {
      ops = JSON.stringify([{ op: "reset", message: stream.message } satisfies TranscriptDelta]);
      if (utf8Length(ops) > STREAM_CHUNK_BASELINE_MAX_BYTES) {
        // Larger than any chunk may be: it shows whole when it settles.
        stream.suspended = true;
        stream.pending = [];
        stream.pendingBytes = 0;
        return null;
      }
    }
    return { baseline, ops };
  }

  function send(watch: Watch, stream: Stream, at: number): void {
    const removed = stream.message === null;
    // A removed message ends its stream; a reader needs the removal only if it
    // saw a chunk, and its rows go when the fact that replaced it is recorded.
    if (removed) {
      watch.streams.delete(stream.messageId);
      if (stream.sent) watch.removed.set(stream.messageId, stream);
    }
    const chunk = removed && !stream.sent ? null : nextChunk(stream, at);
    if (chunk === null) return;
    const seq = nextSeq(watch.sessionId, stream.messageId);
    stream.pending = [];
    stream.pendingBytes = 0;
    stream.needsBaseline = false;
    // Counted as sent before the reply: a chunk whose reply is lost may still
    // have been written, and its row needs the settle's delete all the same.
    stream.sent = true;
    let request: Promise<unknown>;
    try {
      request = options.backend.append({
        sessionId: watch.sessionId,
        messageId: stream.messageId,
        turnId: watch.turnId,
        seq,
        baseline: chunk.baseline,
        throughSequence: stream.throughSequence,
        ops: chunk.ops,
      });
    } catch (error) {
      request = Promise.reject(error);
    }
    stream.inFlight = track(
      request
        .then(
          () => {
            stream.failures = 0;
            if (chunk.baseline) stream.lastBaselineAt = at;
          },
          (error: unknown) => {
            // Not retried: the seq stays skipped and a baseline heals the gap,
            // after a backoff so a backend that keeps refusing is not sent a
            // whole message twice a second.
            stream.needsBaseline = true;
            stream.failures += 1;
            stream.retryAt = now() + Math.min(cadenceMs * 2 ** stream.failures, baselineIntervalMs);
            report(error, watch.sessionId);
          },
        )
        .finally(() => {
          stream.inFlight = null;
        }),
    );
  }

  /** Drops a watch's live state and opens it again after a pause. */
  function reopenLater(watch: Watch): void {
    watch.subscription?.close();
    watch.subscription = null;
    watch.streams.clear();
    watch.settledAt.clear();
    watch.removed.clear();
    watch.retryAt = now() + reopenAfterMs;
  }

  function open(watch: Watch): void {
    watch.opening = true;
    watch.retryAt = null;
    watch.turnFromFrame = false;
    let subscription: StreamSubscription | null = null;
    options.source
      .open(
        watch.sessionId,
        (emission) => {
          try {
            onEmission(watch, emission);
          } catch (error) {
            // An overlay this chunker cannot serialize ends its stream (it
            // shows whole when it settles) and never stops the others.
            if (isSessionStreamOverlay(emission)) watch.streams.delete(emission.messageId);
            report(error, watch.sessionId);
          }
        },
        (error) => {
          report(error, watch.sessionId);
          // A subscription that failed delivers nothing more: open a new one.
          if (!watch.closed && watch.subscription === subscription) reopenLater(watch);
        },
      )
      .then(
        (opened) => {
          watch.opening = false;
          if (watch.closed) {
            opened.close();
            return;
          }
          subscription = opened;
          watch.subscription = opened;
          if (!watch.turnFromFrame) watch.turnId = opened.turnId;
        },
        (error: unknown) => {
          watch.opening = false;
          watch.retryAt = now() + reopenAfterMs;
          report(error, watch.sessionId);
        },
      );
  }

  function tick(): void {
    const at = now();
    for (const watch of watches.values()) {
      if (watch.subscription === null) {
        if (!watch.opening && watch.retryAt !== null && at >= watch.retryAt) open(watch);
        continue;
      }
      for (const stream of watch.streams.values()) {
        // One in flight: this tick's deltas merge into the next chunk.
        if (stream.inFlight === null && at >= stream.retryAt) send(watch, stream, at);
      }
    }
    for (const [key, entry] of seqs) {
      if (at - entry.at > SEQ_RETENTION_MS) seqs.delete(key);
    }
  }

  function stop(watch: Watch): void {
    watch.closed = true;
    watches.delete(watch.sessionId);
    watch.subscription?.close();
    watch.subscription = null;
  }

  function syncInterval(): void {
    if (watches.size > 0 && interval === null) interval = timers.setInterval(tick, cadenceMs);
    if (watches.size === 0 && interval !== null) {
      timers.clearInterval(interval);
      interval = null;
    }
  }

  return {
    setWatched(sessionIds) {
      if (closed) return;
      const next = new Set(sessionIds);
      // Deleting the entry being visited is safe in a Map iteration.
      for (const watch of watches.values()) {
        if (!next.has(watch.sessionId)) stop(watch);
      }
      for (const sessionId of next) {
        if (watches.has(sessionId)) continue;
        const watch: Watch = {
          sessionId,
          subscription: null,
          retryAt: null,
          opening: false,
          turnId: null,
          turnFromFrame: false,
          streams: new Map(),
          settledAt: new Map(),
          removed: new Map(),
          closed: false,
        };
        watches.set(sessionId, watch);
        open(watch);
      }
      syncInterval();
    },
    async close() {
      closed = true;
      for (const watch of watches.values()) stop(watch);
      syncInterval();
      await Promise.all(inFlight);
    },
  };
}

/** The Session ids a `sessionViewers:watched` result names; anything else names none. */
function watchedSessionIds(value: unknown): string[] {
  const ids = (value as { sessionIds?: unknown } | null)?.sessionIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export interface StreamChunks {
  stop(): Promise<void>;
}

/**
 * Streamed text for one runner: a chunker over the Session runtime and the
 * backend link, watching what the runner's `sessionViewers:watched`
 * subscription names. The subscription survives the link's reconnects.
 */
export function startStreamChunks(parts: {
  link: Pick<BackendLink, "mutate" | "status" | "subscribe">;
  runtime: Pick<SessionRuntime, "projection" | "subscribe">;
  onError?(error: unknown, sessionId: string): void;
  timers?: StreamChunkerTimers;
  now?(): number;
}): StreamChunks {
  const chunker = createStreamChunker({
    source: runtimeStreamSource(parts.runtime),
    backend: streamChunksOverLink(parts.link),
    ...(parts.onError ? { onError: parts.onError } : {}),
    ...(parts.timers ? { timers: parts.timers } : {}),
    ...(parts.now ? { now: parts.now } : {}),
  });
  const off = parts.link.subscribe(STREAM_CHUNK_FUNCTIONS.watched, {}, (value) =>
    chunker.setWatched(watchedSessionIds(value)),
  );
  return {
    async stop() {
      off();
      await chunker.close();
    },
  };
}
