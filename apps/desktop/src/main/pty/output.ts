// Flow control (the VS Code ack pattern): the renderer acks every data event
// it consumes; once the chars in flight exceed the high watermark the pty is
// paused, and it resumes only after acks drain the count below the low one.
// Without this, `yes` or `cat bigfile` queues unbounded IPC in the main
// process faster than the renderer can render.
export const FLOW_CONTROL_HIGH_WATERMARK = 100_000;
export const FLOW_CONTROL_LOW_WATERMARK = 5_000;

// Output batching: raw pty chunks are tiny (often <1 KiB), so a big `cat` is
// thousands of IPC messages. Chunks coalesce for a frame's worth of time —
// or until the buffer is large enough that waiting just adds latency.
export const BATCH_WINDOW_MS = 8;
export const BATCH_MAX_CHARS = 256_000;
export const OBSERVATION_TAIL_MAX_CHARS = 256_000;

/** Where the pipeline delivers output and applies backpressure — the manager
 *  adapts this onto the session's webContents + pty. `send` returns false when
 *  the owning window is gone: the batch is dropped and never enters the
 *  flow-control accounting. */
export interface OutputSink {
  send(data: string): boolean;
  pause(): void;
  resume(): void;
}

/** One session's output pipeline: coalesces raw pty chunks into batched sends,
 *  applies the ack-based flow control, and keeps the bounded observation tail
 *  the read-only session peek reads. The manager owns lifecycle (create per
 *  session, {@link OutputPipeline.dispose} on forget) and the activity/setup-run
 *  side effects that ride the same onData chunk. */
export interface OutputPipeline {
  /** Buffers a pty chunk toward the next coalesced send and the observation tail. */
  enqueue(data: string): void;
  /** Sends the buffered output as ONE batch and applies flow-control accounting. */
  flush(): void;
  /** Renderer flow-control ack: `chars` of output were consumed. */
  ack(chars: number): void;
  /** Read-only, byte-identical tail of the last N lines of retained output. */
  peekTail(lines: number): string;
  /** Drops the pending buffer + its timer. Idempotent. */
  dispose(): void;
}

/**
 * Builds the output pipeline for one session over `sink`. All per-session
 * batching/flow/tail state lives in this closure — nothing leaks onto the
 * manager's Session record beyond the returned handle.
 */
export function createOutputPipeline(sink: OutputSink): OutputPipeline {
  /** Output chunks coalescing toward the next flush. */
  let pendingChunks: string[] = [];
  let pendingChars = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  /** Chars sent to the renderer and not yet acked; drives pause/resume. */
  let unackedChars = 0;
  let paused = false;
  /**
   * Recent raw output retained independently of renderer batching for the
   * read-only session peek — kept as chunks (not one growing string) so the hot
   * output path appends in O(chunk) instead of rebuilding a ~256KB string every
   * event. Whole chunks are trimmed off the front once dropping one still leaves
   * {@link OBSERVATION_TAIL_MAX_CHARS} behind; `tailChars` tracks the joined
   * length so the trim never re-sums. `peekTail` joins + slices to the exact cap
   * on demand.
   */
  let tailChunks: string[] = [];
  /** Running total of `tailChunks` char lengths — the trim bound, kept incrementally. */
  let tailChars = 0;

  /**
   * Sends the buffered output as ONE batch and applies the flow-control
   * accounting to the joined payload. No-ops (dropping the buffer) once the
   * owning window is destroyed — `sink.send` returns false. Note a paused pty
   * stops producing new onData chunks, but anything already buffered still
   * flushes.
   */
  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingChunks.length === 0) return;
    const data = pendingChunks.join("");
    pendingChunks = [];
    pendingChars = 0;
    // Clear the buffer BEFORE consulting the sink: a dead window drops the
    // batch, which then never enters the flow-control accounting below.
    if (!sink.send(data)) return;
    unackedChars += data.length;
    if (!paused && unackedChars > FLOW_CONTROL_HIGH_WATERMARK) {
      paused = true;
      sink.pause();
    }
  };

  return {
    enqueue(data: string): void {
      // Append to the observation tail as a chunk, then drop whole chunks off
      // the front while doing so still leaves at least the cap behind (peekTail
      // slices to the exact cap on demand). Keeps this hot path O(chunk), not
      // O(cap).
      tailChunks.push(data);
      tailChars += data.length;
      let firstChunk = tailChunks[0];
      while (
        firstChunk !== undefined &&
        tailChars - firstChunk.length >= OBSERVATION_TAIL_MAX_CHARS
      ) {
        tailChunks.shift();
        tailChars -= firstChunk.length;
        firstChunk = tailChunks[0];
      }
      pendingChunks.push(data);
      pendingChars += data.length;
      if (pendingChars >= BATCH_MAX_CHARS) {
        flush();
        return;
      }
      if (flushTimer === null) {
        flushTimer = setTimeout(() => {
          flush();
        }, BATCH_WINDOW_MS);
      }
    },

    flush,

    ack(chars: number): void {
      unackedChars = Math.max(0, unackedChars - chars);
      if (paused && unackedChars <= FLOW_CONTROL_LOW_WATERMARK) {
        paused = false;
        sink.resume();
      }
    },

    peekTail(lines: number): string {
      // Join the retained chunks and slice to the exact cap — the front chunk
      // may be over-retained (kept because dropping it would breach the cap), so
      // the slice is what makes the peeked tail byte-identical to the old string
      // form.
      const normalized = tailChunks
        .join("")
        .slice(-OBSERVATION_TAIL_MAX_CHARS)
        .replace(/\r\n?/g, "\n");
      return normalized.split("\n").slice(-lines).join("\n");
    },

    dispose(): void {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingChunks = [];
      pendingChars = 0;
    },
  };
}
