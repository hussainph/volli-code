import {
  applyTranscriptDelta,
  projectKeyedTranscriptMessage,
  type KeyedTranscriptMessage,
  type SessionStreamEmission,
  type SessionStreamFrame,
  type TranscriptDelta,
  type TranscriptOverlay,
} from "@volli/session-engine";
import {
  STREAM_CHUNK_BASELINE_MAX_BYTES,
  STREAM_CHUNK_MAX_BYTES,
  STREAM_CHUNK_TTL_MS,
  parseStreamChunkOps,
  type StreamChunkAppend,
  type StreamChunkSettle,
} from "@volli/shared/cloud";
import { describe, expect, test } from "vite-plus/test";

import {
  STREAM_CHUNK_FUNCTIONS,
  createStreamChunker,
  runtimeStreamSource,
  startStreamChunks,
  StreamLinkOfflineError,
  streamChunksOverLink,
  type StreamChunkBackend,
  type StreamSource,
} from "./stream-chunker";

const SESSION = "session-1";

/** Manual time: `advance` runs the interval once per elapsed cadence. */
function clock() {
  let at = 0;
  let tick: (() => void) | null = null;
  let cadence = 0;
  let nextAt = 0;
  let sets = 0;
  return {
    now: () => at,
    timers: {
      setInterval(run: () => void, ms: number) {
        tick = run;
        cadence = ms;
        nextAt = at + ms;
        sets += 1;
        return sets;
      },
      clearInterval() {
        tick = null;
      },
    },
    get running() {
      return tick !== null;
    },
    get sets() {
      return sets;
    },
    async advance(ms: number) {
      const end = at + ms;
      await settled();
      for (let run = tick; run !== null && nextAt <= end; run = tick) {
        at = nextAt;
        nextAt += cadence;
        run();
        await settled();
      }
      at = end;
      await settled();
    },
  };
}

async function settled() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

interface Deferred {
  resolve(): void;
  reject(error: unknown): void;
}

/** A backend that records every call; `hold` keeps appends pending until released. */
function backend() {
  const appends: StreamChunkAppend[] = [];
  const committed: StreamChunkAppend[] = [];
  const settles: StreamChunkSettle[] = [];
  const pending: Deferred[] = [];
  let hold = false;
  let failNext = 0;
  const port: StreamChunkBackend = {
    append(chunk) {
      appends.push(chunk);
      if (failNext > 0) {
        failNext -= 1;
        return Promise.reject(new Error("offline"));
      }
      if (!hold) {
        committed.push(chunk);
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        pending.push({
          resolve: () => {
            committed.push(chunk);
            resolve();
          },
          reject,
        });
      });
    },
    async settle(settle) {
      settles.push(settle);
    },
  };
  return {
    port,
    appends,
    committed,
    settles,
    pending,
    hold(value: boolean) {
      hold = value;
    },
    failNext(count: number) {
      failNext = count;
    },
  };
}

/** A stream source the test drives, recording opens and closes. */
function source(turnId: string | null = "turn-1") {
  const listeners = new Map<string, (emission: SessionStreamEmission) => void>();
  const failures = new Map<string, ((error: unknown) => void)[]>();
  const opens: string[] = [];
  const closes: string[] = [];
  let failOpens = 0;
  const port: StreamSource = {
    async open(sessionId, listener, onFailure) {
      opens.push(sessionId);
      if (failOpens > 0) {
        failOpens -= 1;
        throw new Error("no runtime");
      }
      listeners.set(sessionId, listener);
      failures.set(sessionId, [...(failures.get(sessionId) ?? []), onFailure]);
      return {
        turnId,
        // The listener stays: an emission already on its way may still arrive.
        close: () => {
          closes.push(sessionId);
        },
      };
    },
  };
  return {
    port,
    opens,
    closes,
    failOpens(count: number) {
      failOpens = count;
    },
    /** Fails the Session's latest subscription, or the `index`th one it opened. */
    fail(sessionId: string, error: unknown, index = -1) {
      failures.get(sessionId)?.at(index)?.(error);
    },
    emit(emission: SessionStreamEmission, sessionId = SESSION) {
      listeners.get(sessionId)?.(emission);
    },
    delta(messageId: string, delta: TranscriptDelta, throughSequence = 5, sessionId = SESSION) {
      listeners.get(sessionId)?.({ kind: "overlay", sessionId, throughSequence, messageId, delta });
    },
  };
}

function message(id: string, text: string): KeyedTranscriptMessage {
  return { id, role: "assistant", parts: [{ key: "t", part: { type: "text", text } }] };
}

const reset = (id: string, text: string): TranscriptDelta => ({
  op: "reset",
  message: message(id, text),
});
const append = (text: string, key = "t"): TranscriptDelta => ({ op: "part.append", key, text });

function frame(
  sequence: number,
  payload: object,
  transcriptMessageId?: string,
): SessionStreamFrame {
  return {
    sessionId: SESSION,
    sequence,
    event: {
      id: `e${sequence}`,
      sessionId: SESSION,
      sequence,
      payload,
    } as unknown as SessionStreamFrame["event"],
    transcript:
      transcriptMessageId === undefined
        ? null
        : ({
            version: 1,
            threadId: "th",
            branchId: "br",
            attemptId: "at",
            turnId: "turn-1",
            message: { id: transcriptMessageId, role: "assistant", parts: [] },
          } as SessionStreamFrame["transcript"]),
  };
}

function ops(chunk: StreamChunkAppend): TranscriptDelta[] {
  const parsed = parseStreamChunkOps(chunk.ops, chunk.baseline);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.ops as unknown as TranscriptDelta[];
}

/**
 * A viewer's fold over the rows the backend holds, in seq order per stream:
 * the transcript-overlay fold, plus the gap rule (after a missing seq, ignore
 * the stream until a baseline).
 */
function readerFold(rows: readonly StreamChunkAppend[]): TranscriptOverlay {
  let overlay: TranscriptOverlay = new Map();
  const last = new Map<string, number>();
  const sorted = rows.toSorted((a, b) =>
    a.messageId === b.messageId ? a.seq - b.seq : a.messageId < b.messageId ? -1 : 1,
  );
  for (const row of sorted) {
    const chunk = row;
    const previous = last.get(row.messageId);
    if (previous !== undefined && chunk.seq !== previous + 1 && !chunk.baseline) {
      const next = new Map(overlay);
      next.delete(row.messageId);
      overlay = next;
    }
    last.set(row.messageId, chunk.seq);
    for (const delta of ops(row)) overlay = applyTranscriptDelta(overlay, row.messageId, delta);
  }
  return overlay;
}

/** A tool part's progress: the whole part, re-sent on every update. */
function progress(output: string): TranscriptDelta {
  return {
    op: "part.upsert",
    key: "tool",
    index: 1,
    part: {
      type: "dynamic-tool",
      toolName: "run",
      toolCallId: "c",
      state: "input-available",
      input: { output },
    },
  };
}

function setup(options: { turnId?: string | null } = {}) {
  const time = clock();
  const link = backend();
  const runtime = source(options.turnId === undefined ? "turn-1" : options.turnId);
  const errors: unknown[] = [];
  const chunker = createStreamChunker({
    source: runtime.port,
    backend: link.port,
    timers: time.timers,
    now: time.now,
    onError: (error) => errors.push(error),
  });
  return { time, link, runtime, chunker, errors };
}

describe("gating on viewers", () => {
  test("nothing is subscribed or sent until someone watches, and nothing after they leave", async () => {
    const { time, link, runtime, chunker } = setup();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(1000);
    expect(runtime.opens).toEqual([]);
    expect(time.running).toBe(false);

    chunker.setWatched([SESSION]);
    await settled();
    expect(runtime.opens).toEqual([SESSION]);
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    expect(link.appends).toHaveLength(1);

    chunker.setWatched([]);
    expect(runtime.closes).toEqual([SESSION]);
    expect(time.running).toBe(false);
    runtime.delta("m1", append("b"));
    await time.advance(1000);
    expect(link.appends).toHaveLength(1);
  });

  test("a Session watched again continues its seqs from the runtime's fresh baseline", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    runtime.delta("m1", append("b"));
    await time.advance(500);
    chunker.setWatched([]);
    chunker.setWatched([SESSION]);
    await settled();
    // A fresh subscriber's baseline: one reset per message in flight.
    runtime.delta("m1", reset("m1", "abc"));
    await time.advance(500);
    expect(link.appends.map((a) => [a.seq, a.baseline])).toEqual([
      [0, true],
      [1, false],
      [2, true],
    ]);
    expect(projectKeyedTranscriptMessage(readerFold(link.committed).get("m1")!)).toMatchObject({
      parts: [{ type: "text", text: "abc" }],
    });
  });

  test("setWatched keeps a Session it already watches, and does nothing once closed", async () => {
    const { runtime, chunker } = setup();
    chunker.setWatched([SESSION, "session-2"]);
    chunker.setWatched([SESSION, "session-2"]);
    await settled();
    expect(runtime.opens).toEqual([SESSION, "session-2"]);
    await chunker.close();
    expect(runtime.closes.toSorted()).toEqual([SESSION, "session-2"]);
    chunker.setWatched(["session-3"]);
    expect(runtime.opens).toHaveLength(2);
  });

  test("a subscription that fails to open is retried after a pause; one unwatched meanwhile is not", async () => {
    const { time, runtime, chunker, errors } = setup();
    runtime.failOpens(1);
    chunker.setWatched([SESSION]);
    await settled();
    expect(errors).toHaveLength(1);
    await time.advance(4_500);
    expect(runtime.opens).toEqual([SESSION]);
    await time.advance(1_000);
    expect(runtime.opens).toEqual([SESSION, SESSION]);

    runtime.failOpens(1);
    chunker.setWatched([SESSION, "session-2"]);
    await settled();
    chunker.setWatched([SESSION]);
    await time.advance(10_000);
    expect(runtime.opens.filter((id) => id === "session-2")).toHaveLength(1);
  });

  test("a subscription that opens after its Session stopped being watched is closed at once", async () => {
    const time = clock();
    const link = backend();
    let finish: (() => void) | null = null;
    const closes: string[] = [];
    const chunker = createStreamChunker({
      source: {
        open: (sessionId) =>
          new Promise((resolve) => {
            finish = () => resolve({ turnId: null, close: () => closes.push(sessionId) });
          }),
      },
      backend: link.port,
      timers: time.timers,
      now: time.now,
    });
    chunker.setWatched([SESSION]);
    chunker.setWatched([]);
    finish!();
    await settled();
    expect(closes).toEqual([SESSION]);
  });

  test("a subscription that fails is reported, dropped and opened again after a pause", async () => {
    const { time, link, runtime, chunker, errors } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    runtime.fail(SESSION, new Error("drain stopped"));
    expect(errors).toEqual([new Error("drain stopped")]);
    expect(runtime.closes).toEqual([SESSION]);
    await time.advance(4_500);
    expect(link.appends).toEqual([]);
    expect(runtime.opens).toEqual([SESSION]);
    await time.advance(1_000);
    expect(runtime.opens).toEqual([SESSION, SESSION]);
    // A late failure from the subscription it replaced changes nothing.
    await settled();
    runtime.fail(SESSION, new Error("late"), 0);
    runtime.delta("m1", reset("m1", "ab"));
    await time.advance(500);
    expect(link.appends).toHaveLength(1);
    expect(runtime.closes).toEqual([SESSION]);
    // Nor does one after the Session stopped being watched.
    chunker.setWatched([]);
    runtime.fail(SESSION, new Error("after"));
    expect(runtime.closes).toEqual([SESSION, SESSION]);
  });

  test("a turn that starts while the subscription opens is not overwritten by the older answer", async () => {
    const time = clock();
    const link = backend();
    let listener: ((emission: SessionStreamEmission) => void) | null = null;
    const chunker = createStreamChunker({
      source: {
        async open(_sessionId, onEmission) {
          listener = onEmission;
          // Replayed while opening: the subscription's own answer is older.
          onEmission(frame(6, { kind: "turn.started", turnId: "turn-2" }));
          return { turnId: "turn-1", close: () => {} };
        },
      },
      backend: link.port,
      timers: time.timers,
      now: time.now,
    });
    chunker.setWatched([SESSION]);
    await settled();
    listener!({
      kind: "overlay",
      sessionId: SESSION,
      throughSequence: 6,
      messageId: "m1",
      delta: reset("m1", "a"),
    });
    await time.advance(500);
    expect(link.appends.map((a) => a.turnId)).toEqual(["turn-2"]);
  });
});

describe("cadence", () => {
  test("deltas inside one 500 ms window coalesce into one chunk, text appends merged", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", ""));
    await time.advance(500);
    runtime.delta("m1", append("he"));
    runtime.delta("m1", append("ll"));
    runtime.delta("m1", append("o"));
    runtime.delta(
      "m1",
      { op: "part.upsert", key: "r", index: 1, part: { type: "reasoning", text: "x" } },
      7,
    );
    runtime.delta("m1", append("y", "r"));
    await time.advance(499);
    expect(link.appends).toHaveLength(1);
    await time.advance(1);
    expect(link.appends).toHaveLength(2);
    expect(link.appends[1]).toEqual({
      sessionId: SESSION,
      messageId: "m1",
      turnId: "turn-1",
      seq: 1,
      baseline: false,
      throughSequence: 7,
      ops: JSON.stringify([
        append("hello"),
        { op: "part.upsert", key: "r", index: 1, part: { type: "reasoning", text: "xy" } },
      ]),
    });
    // A quiet stream sends nothing.
    await time.advance(2000);
    expect(link.appends).toHaveLength(2);
  });

  test("non-text upserts and other ops are kept in order, not merged", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    const tool: TranscriptDelta = {
      op: "part.upsert",
      key: "tool",
      index: 1,
      part: {
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "c",
        state: "input-streaming",
        input: {},
      },
    };
    runtime.delta("m1", tool);
    runtime.delta("m1", append("x", "tool"));
    runtime.delta("m1", { op: "metadata", metadata: { model: "m" } });
    runtime.delta("m1", append("b"));
    runtime.delta("m1", { op: "part.remove", key: "tool" });
    await time.advance(500);
    expect(ops(link.appends[1])).toEqual([
      tool,
      append("x", "tool"),
      { op: "metadata", metadata: { model: "m" } },
      append("b"),
      { op: "part.remove", key: "tool" },
    ]);
  });

  test("at most one chunk is in flight per stream; what arrives meanwhile merges into the next", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    link.hold(true);
    runtime.delta("m1", reset("m1", "a"));
    runtime.delta("m2", reset("m2", "z"));
    await time.advance(500);
    expect(link.appends.map((a) => a.messageId)).toEqual(["m1", "m2"]);
    runtime.delta("m1", append("b"));
    await time.advance(1500);
    runtime.delta("m1", append("c"));
    expect(link.appends).toHaveLength(2);
    link.pending.shift()!.resolve();
    await settled();
    await time.advance(500);
    expect(link.appends).toHaveLength(3);
    expect(ops(link.appends[2])).toEqual([append("bc")]);
  });

  test("a stream sends a baseline at least every 10 s while it is active", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    for (let index = 0; index < 22; index += 1) {
      await time.advance(500);
      runtime.delta("m1", append("b"));
    }
    const baselines = link.appends.filter((a) => a.baseline).map((a) => a.seq);
    expect(baselines).toEqual([0, 20]);
    expect(ops(link.appends[20])).toEqual([reset("m1", `a${"b".repeat(20)}`)]);
  });
});

describe("lost chunks", () => {
  test("a failed chunk is not retried: its seq is skipped and the next chunk is a baseline that heals the reader", async () => {
    const { time, link, runtime, chunker, errors } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    link.failNext(1);
    runtime.delta("m1", append("b"));
    await time.advance(500);
    expect(errors).toEqual([new Error("offline")]);
    // Nothing new arrived, but the lost ops must still reach the reader: a
    // second later (the first backoff step) as a baseline.
    await time.advance(500);
    expect(link.appends).toHaveLength(2);
    await time.advance(500);
    runtime.delta("m1", append("c"));
    await time.advance(500);
    expect(link.appends.map((a) => [a.seq, a.baseline])).toEqual([
      [0, true],
      [1, false],
      [2, true],
      [3, false],
    ]);
    expect(link.committed.map((a) => a.seq)).toEqual([0, 2, 3]);
    expect(projectKeyedTranscriptMessage(readerFold(link.committed).get("m1")!).parts).toEqual([
      { type: "text", text: "abc" },
    ]);
  });

  test("appends that keep failing back off, doubling up to the baseline interval", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    link.failNext(100);
    runtime.delta("m1", reset("m1", "a"));
    const attemptsAt: number[] = [];
    for (let elapsed = 0; elapsed < 40_000; elapsed += 500) {
      const before = link.appends.length;
      await time.advance(500);
      if (link.appends.length > before) attemptsAt.push(time.now());
    }
    const gaps = attemptsAt.slice(1).map((at, index) => at - attemptsAt[index]);
    expect(gaps.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 10_000]);
    expect(gaps.slice(5).every((gap) => gap === 10_000)).toBe(true);
    // Every retry is a baseline: the failed ops are gone, the fold is not.
    expect(link.appends.every((a) => a.baseline)).toBe(true);
  });

  test("an append that throws instead of rejecting is a failure like any other", async () => {
    const { time, link, runtime, chunker, errors } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    const realAppend = link.port.append;
    link.port.append = () => {
      throw new Error("sync");
    };
    runtime.delta("m1", reset("m1", "a"));
    runtime.delta("m2", reset("m2", "b"));
    await time.advance(500);
    expect(errors).toEqual([new Error("sync"), new Error("sync")]);
    link.port.append = realAppend;
    await time.advance(1000);
    expect(link.appends.map((a) => [a.messageId, a.seq, a.baseline])).toEqual([
      ["m1", 1, true],
      ["m2", 1, true],
    ]);
  });

  test("a stream that cannot even be serialized is reported and leaves the others streaming", async () => {
    const { time, link, runtime, chunker, errors } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", {
      op: "reset",
      message: { id: "m1", role: "assistant", metadata: { n: 1n }, parts: [] },
    });
    runtime.delta("m2", reset("m2", "b"));
    await time.advance(500);
    expect(errors).toHaveLength(1);
    expect(link.appends.map((a) => a.messageId)).toEqual(["m2"]);
  });

  test("a reader that misses rows ignores the stream until the next baseline", () => {
    const rows: StreamChunkAppend[] = [0, 1, 2, 3].map((seq) => ({
      sessionId: SESSION,
      messageId: "m1",
      turnId: null,
      seq,
      baseline: seq === 0 || seq === 3,
      throughSequence: 1,
      ops: JSON.stringify(
        seq === 0
          ? [reset("m1", "a")]
          : seq === 3
            ? [reset("m1", "abcd")]
            : [append(String.fromCharCode(97 + seq))],
      ),
    }));
    // Row 1 never arrived: row 2 is ignored, row 3 heals.
    const missing = [rows[0], rows[2]];
    expect(readerFold(missing).has("m1")).toBe(false);
    expect(
      projectKeyedTranscriptMessage(readerFold([...missing, rows[3]]).get("m1")!).parts,
    ).toEqual([{ type: "text", text: "abcd" }]);
  });

  test("offline, nothing queues: pending deltas past a chunk collapse into the fold and leave as one baseline", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", ""));
    await time.advance(500);
    link.hold(true);
    runtime.delta("m1", append("a"));
    await time.advance(500);
    const big = "x".repeat(STREAM_CHUNK_MAX_BYTES);
    runtime.delta("m1", append(big));
    link.pending.shift()!.reject(new Error("offline"));
    link.hold(false);
    await time.advance(1000);
    const last = link.appends.at(-1)!;
    expect(last.baseline).toBe(true);
    expect(ops(last)).toEqual([reset("m1", `a${big}`)]);
  });

  test("pending text that escapes past the cap is sent as a baseline instead", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", ""));
    await time.advance(500);
    // Merged into the append before it, 10,000 newlines count as 10,000
    // bytes of text, but they are 20,000 of JSON.
    runtime.delta("m1", append("a"));
    runtime.delta("m1", append("\n".repeat(10_000)));
    await time.advance(500);
    const last = link.appends.at(-1)!;
    expect(last.baseline).toBe(true);
    expect(ops(last)).toEqual([reset("m1", `a${"\n".repeat(10_000)}`)]);
  });

  test("an increment too large for one chunk is sent as a baseline instead", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", ""));
    await time.advance(500);
    // Many small ops that do not merge: each under the cap, together over it.
    for (let index = 0; index < 200; index += 1) {
      runtime.delta("m1", { op: "metadata", metadata: { n: index, pad: "p".repeat(60) } });
    }
    await time.advance(500);
    const last = link.appends.at(-1)!;
    expect(last.baseline).toBe(true);
    expect(ops(last)).toHaveLength(1);
  });

  test("a message larger than a baseline may be stops streaming until a new reset", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "x".repeat(STREAM_CHUNK_BASELINE_MAX_BYTES)));
    await time.advance(500);
    runtime.delta("m1", append("more"));
    await time.advance(1000);
    expect(link.appends).toEqual([]);
    runtime.delta("m1", reset("m1", "short again"));
    await time.advance(500);
    expect(link.appends).toHaveLength(1);
    expect(link.appends[0].seq).toBe(0);
  });
});

describe("settle", () => {
  test("the settled fact drops the stream's pending deltas and tells the backend its sequence", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    runtime.delta("m1", append("b"));
    runtime.emit(frame(9, { kind: "transcript.referenced", turnId: "turn-1" }, "m1"));
    await time.advance(1000);
    expect(link.appends).toHaveLength(1);
    expect(link.settles).toEqual([{ sessionId: SESSION, messageId: "m1", sequence: 9 }]);
  });

  test("a settle waits for the chunk in flight, so the delete follows the last row", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    link.hold(true);
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    runtime.emit(frame(9, { kind: "transcript.referenced", turnId: "turn-1" }, "m1"));
    await settled();
    expect(link.settles).toEqual([]);
    link.pending.shift()!.resolve();
    await settled();
    expect(link.settles).toHaveLength(1);
  });

  test("a stream that never reached the backend settles without a call; failures are reported", async () => {
    const { time, link, runtime, chunker, errors } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    runtime.emit(frame(9, { kind: "transcript.referenced", turnId: "turn-1" }, "m1"));
    await time.advance(500);
    expect(link.appends).toEqual([]);
    expect(link.settles).toEqual([]);

    runtime.delta("m2", reset("m2", "a"));
    await time.advance(500);
    link.port.settle = () => Promise.reject(new Error("refused"));
    runtime.emit(frame(10, { kind: "transcript.referenced", turnId: "turn-1" }, "m2"));
    await settled();
    expect(errors).toEqual([new Error("refused")]);
  });

  test("frames that settle nothing are ignored, and a frame after unwatching is too", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    runtime.emit(frame(3, { kind: "transcript.referenced", turnId: null }));
    runtime.emit(frame(4, { kind: "transcript.referenced", turnId: null }, "other"));
    runtime.emit(frame(5, { kind: "attention.cleared", attentionId: "a" }, "m1"));
    runtime.emit({
      kind: "compaction",
      sessionId: SESSION,
      throughSequence: 5,
      state: "started",
      reason: "threshold",
    } as SessionStreamEmission);
    await time.advance(500);
    expect(link.appends).toHaveLength(1);
    expect(link.settles).toEqual([]);
  });
});

describe("stream lifecycle", () => {
  test("chunks name the Session's turn: the latest at subscribe, then each turn that starts", async () => {
    const { time, link, runtime, chunker } = setup({ turnId: null });
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    runtime.emit(frame(6, { kind: "turn.started", turnId: "turn-2" }));
    runtime.delta("m2", reset("m2", "b"));
    await time.advance(500);
    expect(link.appends.map((a) => a.turnId)).toEqual([null, "turn-2"]);
  });

  test("a delta with no baseline is ignored, as every fold ignores it", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", append("orphan"));
    await time.advance(1000);
    expect(link.appends).toEqual([]);
  });

  test("a removed message ends its stream, telling readers only if they saw it", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    runtime.delta("m1", append("b"));
    runtime.delta("m1", { op: "message.remove" });
    runtime.delta("m1", append("late"));
    await time.advance(500);
    // The pending append is moot: the removal alone is sent.
    expect(ops(link.appends[1])).toEqual([{ op: "message.remove" }]);
    expect(readerFold(link.committed).has("m1")).toBe(false);

    runtime.delta("m2", reset("m2", "a"));
    runtime.delta("m2", { op: "message.remove" });
    await time.advance(1000);
    expect(link.appends).toHaveLength(2);

    // The fact that replaces the removed message settles its rows.
    runtime.emit(frame(12, { kind: "transcript.referenced", turnId: "turn-1" }, "entry-1"));
    await settled();
    expect(link.settles).toEqual([{ sessionId: SESSION, messageId: "m1", sequence: 12 }]);
    runtime.emit(frame(13, { kind: "transcript.referenced", turnId: "turn-1" }, "entry-2"));
    await settled();
    expect(link.settles).toHaveLength(1);
  });

  test("a removal still pending when the replacing fact lands settles without being sent", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    runtime.delta("m1", { op: "message.remove" });
    runtime.emit(frame(7, { kind: "turn.completed", turnId: "turn-1" }));
    await time.advance(1000);
    expect(link.appends).toHaveLength(1);
    expect(link.settles).toEqual([{ sessionId: SESSION, messageId: "m1", sequence: 7 }]);
  });

  test("a removal with nothing else pending still reaches readers who saw the stream", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    link.hold(true);
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    runtime.delta("m1", { op: "message.remove" });
    link.pending.shift()!.resolve();
    await settled();
    await time.advance(500);
    expect(ops(link.appends[1])).toEqual([{ op: "message.remove" }]);
  });

  test("repeated upserts of one part leave only the last, as the fold would", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    for (let index = 0; index < 50; index += 1)
      runtime.delta("m1", progress("x".repeat(index * 100)));
    await time.advance(500);
    expect(link.appends[1].baseline).toBe(false);
    expect(ops(link.appends[1])).toEqual([progress("x".repeat(4900))]);
  });

  test("a turn's end drops the streams it left open, and what was pending with them", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    runtime.delta("m1", append("b"));
    runtime.emit(frame(8, { kind: "attachment.closed", outcome: "completed" }));
    await time.advance(1000);
    expect(link.appends).toHaveLength(1);
    expect(link.settles).toEqual([]);
  });

  test("a baseline older than its message's settle starts no stream; a newer one does", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.emit(frame(9, { kind: "transcript.referenced", turnId: "turn-1" }, "m1"));
    runtime.delta("m1", reset("m1", "stale"), 8);
    await time.advance(500);
    expect(link.appends).toEqual([]);
    runtime.delta("m1", reset("m1", "again"), 9);
    await time.advance(500);
    expect(ops(link.appends[0])).toEqual([reset("m1", "again")]);
    // A turn's end forgets the settles it saw.
    runtime.emit(frame(10, { kind: "turn.completed", turnId: "turn-1" }));
    runtime.delta("m1", reset("m1", "next turn"), 2);
    await time.advance(500);
    expect(link.appends).toHaveLength(2);
  });

  test("a frame the chunker cannot read is reported and drops nothing", async () => {
    const { time, link, runtime, chunker, errors } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    const broken = frame(3, { kind: "transcript.referenced", turnId: null });
    Object.defineProperty(broken, "transcript", {
      get() {
        throw new Error("unreadable");
      },
    });
    runtime.emit(broken);
    await time.advance(500);
    expect(errors).toEqual([new Error("unreadable")]);
    expect(link.appends).toHaveLength(1);
  });

  test("seqs are forgotten once the stream's rows have certainly been swept", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    await time.advance(STREAM_CHUNK_TTL_MS + 60_000);
    runtime.delta("m1", reset("m1", "b"));
    await time.advance(500);
    // Rows can outlive the TTL by a sweep interval: the seq continues.
    expect(link.appends.map((a) => a.seq)).toEqual([0, 1]);
    await time.advance(2 * STREAM_CHUNK_TTL_MS + 1000);
    runtime.delta("m1", reset("m1", "b"));
    await time.advance(500);
    expect(link.appends.map((a) => a.seq)).toEqual([0, 1, 0]);
  });

  test("close waits for the chunks in flight", async () => {
    const { time, link, runtime, chunker } = setup();
    chunker.setWatched([SESSION]);
    await settled();
    link.hold(true);
    runtime.delta("m1", reset("m1", "a"));
    await time.advance(500);
    let done = false;
    const closing = chunker.close().then(() => {
      done = true;
    });
    await settled();
    expect(done).toBe(false);
    link.pending.shift()!.resolve();
    await closing;
    expect(done).toBe(true);
    // A late emission from a closed subscription is ignored.
    runtime.delta("m1", append("b"));
  });

  test("the default timers are unref'd intervals", async () => {
    const link = backend();
    const runtime = source();
    const chunker = createStreamChunker({ source: runtime.port, backend: link.port, cadenceMs: 5 });
    chunker.setWatched([SESSION]);
    await settled();
    runtime.delta("m1", reset("m1", "a"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(link.appends).toHaveLength(1);
    await chunker.close();
  });
});

describe("the backend link and the runtime source", () => {
  test("chunks go over the link's live lane, and are refused at once while it is down", async () => {
    const calls: [string, Record<string, unknown>, unknown][] = [];
    let state: "connected" | "connecting" = "connected";
    const port = streamChunksOverLink({
      get status() {
        return state === "connected" ? { state } : { state };
      },
      mutate: async (name, args, options) => {
        calls.push([name, args, options]);
        return null;
      },
    });
    const chunk: StreamChunkAppend = {
      sessionId: SESSION,
      messageId: "m1",
      turnId: null,
      seq: 0,
      baseline: true,
      throughSequence: 0,
      ops: "[]",
    };
    await port.append(chunk);
    await port.settle({ sessionId: SESSION, messageId: "m1", sequence: 3 });
    expect(calls).toEqual([
      ["streamChunks:append", chunk, { priority: "live" }],
      [
        "streamChunks:settle",
        { sessionId: SESSION, messageId: "m1", sequence: 3 },
        { priority: "live" },
      ],
    ]);
    state = "connecting";
    await expect(port.append(chunk)).rejects.toMatchObject({ code: "offline" });
    await expect(
      port.settle({ sessionId: SESSION, messageId: "m1", sequence: 3 }),
    ).rejects.toBeInstanceOf(StreamLinkOfflineError);
    expect(calls).toHaveLength(2);
  });

  test("startStreamChunks watches what the link's viewer subscription names, until stopped", async () => {
    let listener: ((value: unknown) => void) | null = null;
    let unsubscribed = false;
    const subscribed: unknown[] = [];
    const appended: unknown[] = [];
    const time = clock();
    const runtime = {
      projection: async () => ({ projection: { latestTurnId: null }, throughSequence: 1 }) as never,
      subscribe: async (
        input: { sessionId: string },
        onEmission: (emission: SessionStreamEmission) => void,
      ) => {
        subscribed.push(input.sessionId);
        onEmission({
          kind: "overlay",
          sessionId: input.sessionId,
          throughSequence: 1,
          messageId: "m1",
          delta: reset("m1", "a"),
        });
        return () => {};
      },
    };
    const errors: unknown[] = [];
    const streams = startStreamChunks({
      link: {
        status: { state: "connected" },
        mutate: async (_name, args) => {
          appended.push(args);
          return null;
        },
        subscribe: (name, _args, onValue) => {
          expect(name).toBe(STREAM_CHUNK_FUNCTIONS.watched);
          listener = onValue;
          return () => {
            unsubscribed = true;
          };
        },
      },
      runtime,
      onError: (error) => errors.push(error),
      timers: time.timers,
      now: time.now,
    });
    listener!({ sessionIds: [SESSION, 7] });
    await settled();
    expect(subscribed).toEqual([SESSION]);
    await time.advance(500);
    expect(appended).toHaveLength(1);
    // A result that names nothing watches nothing.
    listener!(null);
    expect(time.running).toBe(false);
    await streams.stop();
    expect(unsubscribed).toBe(true);
    expect(errors).toEqual([]);
    // Defaults: no error port, real timers.
    const bare = startStreamChunks({
      link: { status: { state: "connected" }, mutate: async () => null, subscribe: () => () => {} },
      runtime,
    });
    await bare.stop();
  });

  test("runtimeStreamSource subscribes from the Session's head, so nothing durable replays", async () => {
    const subscriptions: { sessionId: string; afterSequence: number }[] = [];
    let closed = false;
    const failures: unknown[] = [];
    const sourcePort = runtimeStreamSource({
      projection: async () =>
        ({ projection: { latestTurnId: "turn-7" }, throughSequence: 41 }) as never,
      subscribe: async (input, _listener, onFailure) => {
        subscriptions.push(input);
        onFailure?.(new Error("x"));
        return () => {
          closed = true;
        };
      },
    });
    const subscription = await sourcePort.open(
      SESSION,
      () => {},
      (error) => failures.push(error),
    );
    expect(subscriptions).toEqual([{ sessionId: SESSION, afterSequence: 41 }]);
    expect(subscription.turnId).toBe("turn-7");
    expect(failures).toEqual([new Error("x")]);
    subscription.close();
    expect(closed).toBe(true);
  });
});
