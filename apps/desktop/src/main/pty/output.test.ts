import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BATCH_MAX_CHARS,
  BATCH_WINDOW_MS,
  FLOW_CONTROL_HIGH_WATERMARK,
  FLOW_CONTROL_LOW_WATERMARK,
  OBSERVATION_TAIL_MAX_CHARS,
  createOutputPipeline,
} from "./output";

/**
 * A fake sink recording every send payload and pause/resume call. `send`
 * returns true (window alive) by default; a test can flip `alive` to model the
 * owning window being gone so the batch is dropped.
 */
function makeSink() {
  const sent: string[] = [];
  const sink = {
    alive: true,
    send: vi.fn((data: string): boolean => {
      if (!sink.alive) return false;
      sent.push(data);
      return true;
    }),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return { sink, sent };
}

/** Drives the batch window so a pending timer flushes (fake timers required). */
const runBatchWindow = () => vi.advanceTimersByTime(BATCH_WINDOW_MS);

afterEach(() => {
  vi.useRealTimers();
});

describe("output pipeline constants", () => {
  it("exposes the flow/batch/tail contract at its settled values", () => {
    expect(FLOW_CONTROL_HIGH_WATERMARK).toBe(100_000);
    expect(FLOW_CONTROL_LOW_WATERMARK).toBe(5_000);
    expect(BATCH_WINDOW_MS).toBe(8);
    expect(BATCH_MAX_CHARS).toBe(256_000);
    expect(OBSERVATION_TAIL_MAX_CHARS).toBe(256_000);
  });
});

describe("output batching", () => {
  it("coalesces chunks within the batch window into one send with the joined payload", () => {
    vi.useFakeTimers();
    const { sink, sent } = makeSink();
    const pipeline = createOutputPipeline(sink);

    pipeline.enqueue("foo");
    pipeline.enqueue("bar");
    pipeline.enqueue("baz");
    // Nothing leaves until the window fires — the whole point of batching.
    expect(sink.send).not.toHaveBeenCalled();

    runBatchWindow();
    expect(sink.send).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["foobarbaz"]);
  });

  it("flushes immediately at BATCH_MAX_CHARS with no stale second flush when the window later fires", () => {
    vi.useFakeTimers();
    const { sink, sent } = makeSink();
    const pipeline = createOutputPipeline(sink);

    pipeline.enqueue("x".repeat(BATCH_MAX_CHARS - 1));
    expect(sink.send).not.toHaveBeenCalled();
    // Crossing the size threshold flushes synchronously inside enqueue.
    pipeline.enqueue("yz");
    expect(sink.send).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([`${"x".repeat(BATCH_MAX_CHARS - 1)}yz`]);

    // The size-triggered flush cleared the pending window timer: no encore.
    vi.advanceTimersByTime(1000);
    expect(sink.send).toHaveBeenCalledTimes(1);
  });

  it("no-ops a flush on an empty buffer", () => {
    vi.useFakeTimers();
    const { sink } = makeSink();
    const pipeline = createOutputPipeline(sink);

    pipeline.flush();
    expect(sink.send).not.toHaveBeenCalled();
  });
});

describe("flow control", () => {
  it("drops a false-returning send's batch with zero unacked accounting and no pause", () => {
    vi.useFakeTimers();
    const { sink } = makeSink();
    sink.alive = false; // owning window gone
    const pipeline = createOutputPipeline(sink);

    // Well past the high watermark — a live window would pause here.
    pipeline.enqueue("x".repeat(FLOW_CONTROL_HIGH_WATERMARK + 1));
    runBatchWindow();

    // The batch reached the sink but it reported the window gone.
    expect(sink.send).toHaveBeenCalledTimes(1);
    // No accounting, no backpressure on a dropped batch.
    expect(sink.pause).not.toHaveBeenCalled();

    // And because nothing was ever counted as in flight, a later live batch
    // right at the boundary must not trip pause on stale accounting.
    sink.alive = true;
    pipeline.enqueue("y".repeat(FLOW_CONTROL_HIGH_WATERMARK));
    runBatchWindow();
    expect(sink.pause).not.toHaveBeenCalled();
  });

  it("pauses exactly once when unacked crosses the high watermark and not again while paused", () => {
    vi.useFakeTimers();
    const { sink } = makeSink();
    const pipeline = createOutputPipeline(sink);

    // Exactly at the watermark: not yet over it.
    pipeline.enqueue("x".repeat(FLOW_CONTROL_HIGH_WATERMARK));
    runBatchWindow();
    expect(sink.pause).not.toHaveBeenCalled();

    // One char over — pause fires.
    pipeline.enqueue("y");
    runBatchWindow();
    expect(sink.pause).toHaveBeenCalledTimes(1);

    // Still buffering while paused must not pause again.
    pipeline.enqueue("z".repeat(50_000));
    runBatchWindow();
    expect(sink.pause).toHaveBeenCalledTimes(1);
  });

  it("resumes only once unacked drains to the low watermark; an intermediate ack above it does nothing", () => {
    vi.useFakeTimers();
    const { sink } = makeSink();
    const pipeline = createOutputPipeline(sink);

    pipeline.enqueue("x".repeat(FLOW_CONTROL_HIGH_WATERMARK + 1));
    runBatchWindow();
    expect(sink.pause).toHaveBeenCalledTimes(1);

    pipeline.ack(50_000); // 50_001 unacked — still above low water.
    expect(sink.resume).not.toHaveBeenCalled();
    pipeline.ack(46_000); // 4_001 unacked — below low water.
    expect(sink.resume).toHaveBeenCalledTimes(1);
  });

  it("floors unacked at zero so over-acking cannot bank negative credit", () => {
    vi.useFakeTimers();
    const { sink } = makeSink();
    const pipeline = createOutputPipeline(sink);

    pipeline.enqueue("x".repeat(FLOW_CONTROL_HIGH_WATERMARK + 1));
    runBatchWindow();
    expect(sink.pause).toHaveBeenCalledTimes(1);

    // Ack far more than is in flight: unacked floors at 0 (not negative) and
    // the drain resumes the pty.
    pipeline.ack(FLOW_CONTROL_HIGH_WATERMARK * 2);
    expect(sink.resume).toHaveBeenCalledTimes(1);

    // A fresh over-watermark batch must pause again — which only holds if the
    // count restarted from 0, not from a banked negative that would swallow it.
    pipeline.enqueue("y".repeat(FLOW_CONTROL_HIGH_WATERMARK + 1));
    runBatchWindow();
    expect(sink.pause).toHaveBeenCalledTimes(2);
  });
});

describe("observation tail", () => {
  it("normalizes CR and CRLF and returns the last N lines", () => {
    const { sink } = makeSink();
    const pipeline = createOutputPipeline(sink);

    pipeline.enqueue("line one\r\nline two\nline three");
    expect(pipeline.peekTail(2)).toBe("line two\nline three");
  });

  it("stays byte-identical to a last-cap-chars window once accumulated chunks exceed the cap", () => {
    const { sink } = makeSink();
    const pipeline = createOutputPipeline(sink);

    // The front chunk is dropped only once the remainder still covers the cap
    // (total − first ≥ cap): 500k − 200k = 300k, so `a` gets trimmed while
    // `b`+`c` (300k) still exceed the cap and the exact window is intact.
    const a = "a".repeat(200_000);
    const b = "b".repeat(200_000);
    const c = "c".repeat(100_000);
    pipeline.enqueue(a);
    pipeline.enqueue(b);
    pipeline.enqueue(c);

    const expected = (a + b + c).slice(-OBSERVATION_TAIL_MAX_CHARS);
    const peeked = pipeline.peekTail(1); // no newlines → whole normalized tail
    expect(peeked.length).toBe(OBSERVATION_TAIL_MAX_CHARS);
    expect(peeked).toBe(expected);
  });
});

describe("dispose", () => {
  it("cancels a pending flush timer so nothing sends afterwards", () => {
    vi.useFakeTimers();
    const { sink } = makeSink();
    const pipeline = createOutputPipeline(sink);

    pipeline.enqueue("never delivered"); // schedules the window timer
    pipeline.dispose();
    vi.advanceTimersByTime(1000);
    expect(sink.send).not.toHaveBeenCalled();
  });

  it("is idempotent", () => {
    vi.useFakeTimers();
    const { sink } = makeSink();
    const pipeline = createOutputPipeline(sink);

    pipeline.enqueue("pending");
    pipeline.dispose();
    expect(() => pipeline.dispose()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(sink.send).not.toHaveBeenCalled();
  });
});
