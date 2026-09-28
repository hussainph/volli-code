import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { DEFAULT_SESSION_WATCHDOG_SILENCE_MS } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  STREAM_IDLE_MESSAGE,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_WAKE_MESSAGE,
  superviseStreams,
  WAKE_STREAM_GRACE_MS,
} from "./stream-supervision";
import { classifyDiagnostic, isTransientTransportFailure, sanitizeDiagnostic } from "./transcript";

type RequestModel = Parameters<StreamFn>[0];
type RequestContext = Parameters<StreamFn>[1];

const MODEL = {
  id: "claude-haiku-4-5",
  api: "anthropic-messages",
  provider: "anthropic",
} as RequestModel;
const CONTEXT = { messages: [] } as unknown as RequestContext;
const TIMING = { idleTimeoutMs: 1_000, wakeGraceMs: 100 };

function reply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "partial" }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

/** A provider the test drives by hand: the stream it returned, and the signal it was given. */
interface Driven {
  stream: AssistantMessageEventStream;
  signal: AbortSignal | undefined;
}

function drivenProvider(): { inner: StreamFn; calls: Driven[] } {
  const calls: Driven[] = [];
  const inner: StreamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    calls.push({ stream, signal: options?.signal });
    return stream;
  };
  return { inner, calls };
}

/** A wrapper further in that broke the report-as-an-event contract. */
const throwingProvider: StreamFn = () => Promise.reject(new Error("adapter exploded"));

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("superviseStreams", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("errs long, but beneath the session watchdog's own silence threshold", () => {
    expect(STREAM_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(STREAM_IDLE_TIMEOUT_MS).toBeLessThan(DEFAULT_SESSION_WATCHDOG_SILENCE_MS);
    expect(WAKE_STREAM_GRACE_MS).toBeGreaterThan(0);
  });

  it("reports each cut as a transient transport failure", () => {
    for (const message of [STREAM_IDLE_MESSAGE, STREAM_WAKE_MESSAGE]) {
      const sanitized = sanitizeDiagnostic(message);
      expect(
        isTransientTransportFailure({ reason: classifyDiagnostic(sanitized), message: sanitized }),
      ).toBe(true);
    }
  });

  it("passes a healthy stream through untouched and stops watching it", async () => {
    const { inner, calls } = drivenProvider();
    const supervisor = superviseStreams(inner, TIMING);
    const out = supervisor.streamFn(MODEL, CONTEXT, {}) as AssistantMessageEventStream;
    const events = collect(out);
    await vi.advanceTimersByTimeAsync(0);
    const done = reply();
    calls[0]!.stream.push({ type: "start", partial: done });
    calls[0]!.stream.push({ type: "done", reason: "stop", message: done });
    calls[0]!.stream.end(done);

    expect((await events).map(({ type }) => type)).toEqual(["start", "done"]);
    await expect(out.result()).resolves.toBe(done);
    // Nothing is left armed to cut a request that already settled.
    await vi.advanceTimersByTimeAsync(TIMING.idleTimeoutMs * 2);
    expect(calls[0]!.signal?.aborted).toBe(false);
  });

  it("uses the default timing when none is given", async () => {
    const { inner, calls } = drivenProvider();
    const out = superviseStreams(inner).streamFn(MODEL, CONTEXT) as AssistantMessageEventStream;
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(calls[0]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(out.result()).resolves.toMatchObject({ errorMessage: STREAM_IDLE_MESSAGE });
  });

  it("cuts a request that goes silent, and fails it as an error with what it had", async () => {
    const { inner, calls } = drivenProvider();
    const out = superviseStreams(inner, TIMING).streamFn(
      MODEL,
      CONTEXT,
      {},
    ) as AssistantMessageEventStream;
    const events = collect(out);
    await vi.advanceTimersByTimeAsync(0);
    const partial = reply();
    calls[0]!.stream.push({ type: "start", partial });
    // Each event re-arms the cut.
    await vi.advanceTimersByTimeAsync(TIMING.idleTimeoutMs - 10);
    calls[0]!.stream.push({ type: "text_start", contentIndex: 0, partial });
    await vi.advanceTimersByTimeAsync(TIMING.idleTimeoutMs - 10);
    expect(calls[0]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10);

    // The provider's own request is aborted; the run's is not touched.
    expect(calls[0]!.signal?.aborted).toBe(true);
    const failed = await out.result();
    expect(failed).toMatchObject({
      stopReason: "error",
      errorMessage: STREAM_IDLE_MESSAGE,
      content: partial.content,
    });
    // What the provider says on its way down is about a request nobody reads.
    calls[0]!.stream.push({ type: "text_delta", contentIndex: 0, delta: "late", partial });
    calls[0]!.stream.push({
      type: "error",
      reason: "aborted",
      error: reply({ stopReason: "aborted" }),
    });
    calls[0]!.stream.end();
    expect((await events).map(({ type }) => type)).toEqual(["start", "text_start", "error"]);
  });

  it("fails a request that never started with an empty reply of its own", async () => {
    const { inner } = drivenProvider();
    const out = superviseStreams(inner, TIMING).streamFn(
      MODEL,
      CONTEXT,
      {},
    ) as AssistantMessageEventStream;
    await vi.advanceTimersByTimeAsync(TIMING.idleTimeoutMs);
    expect(await out.result()).toMatchObject({
      role: "assistant",
      content: [],
      api: MODEL.api,
      provider: MODEL.provider,
      model: MODEL.id,
      stopReason: "error",
      errorMessage: STREAM_IDLE_MESSAGE,
    });
  });

  it("cuts a request that says nothing after the machine wakes", async () => {
    const { inner, calls } = drivenProvider();
    const supervisor = superviseStreams(inner, TIMING);
    const out = supervisor.streamFn(MODEL, CONTEXT, {}) as AssistantMessageEventStream;
    await vi.advanceTimersByTimeAsync(0);
    calls[0]!.stream.push({ type: "start", partial: reply() });
    await vi.advanceTimersByTimeAsync(10);

    supervisor.wake();
    await vi.advanceTimersByTimeAsync(TIMING.wakeGraceMs);

    expect(calls[0]!.signal?.aborted).toBe(true);
    await expect(out.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: STREAM_WAKE_MESSAGE,
    });
  });

  it("keeps a request whose socket survived the sleep", async () => {
    const { inner, calls } = drivenProvider();
    const supervisor = superviseStreams(inner, TIMING);
    supervisor.streamFn(MODEL, CONTEXT, {});
    await vi.advanceTimersByTimeAsync(0);
    const partial = reply();
    calls[0]!.stream.push({ type: "start", partial });

    supervisor.wake();
    calls[0]!.stream.push({ type: "text_start", contentIndex: 0, partial });
    await vi.advanceTimersByTimeAsync(TIMING.wakeGraceMs);

    expect(calls[0]!.signal?.aborted).toBe(false);
  });

  it("forgets a wake check whose request settled, and every check on dispose", async () => {
    const { inner, calls } = drivenProvider();
    const supervisor = superviseStreams(inner, TIMING);
    const settledOut = supervisor.streamFn(MODEL, CONTEXT, {}) as AssistantMessageEventStream;
    await vi.advanceTimersByTimeAsync(0);
    supervisor.wake();
    // Settled inside the grace window: the wake check that fires afterwards
    // finds nothing left to cut.
    const done = reply();
    calls[0]!.stream.push({ type: "done", reason: "stop", message: done });
    await vi.advanceTimersByTimeAsync(TIMING.wakeGraceMs);
    await expect(settledOut.result()).resolves.toBe(done);

    const pending = supervisor.streamFn(MODEL, CONTEXT, {}) as AssistantMessageEventStream;
    await vi.advanceTimersByTimeAsync(0);
    supervisor.wake();
    supervisor.dispose();
    await vi.advanceTimersByTimeAsync(TIMING.wakeGraceMs);
    expect(calls[1]!.signal?.aborted).toBe(false);
    // Only the idle cut is left, and it is still the request's own.
    await vi.advanceTimersByTimeAsync(TIMING.idleTimeoutMs);
    await expect(pending.result()).resolves.toMatchObject({ errorMessage: STREAM_IDLE_MESSAGE });
  });

  it("does not cut twice when the wake check fires after the idle cut", async () => {
    const { inner } = drivenProvider();
    const supervisor = superviseStreams(inner, { idleTimeoutMs: 50, wakeGraceMs: 100 });
    const out = supervisor.streamFn(MODEL, CONTEXT, {}) as AssistantMessageEventStream;
    const events = collect(out);
    await vi.advanceTimersByTimeAsync(0);
    supervisor.wake();
    await vi.advanceTimersByTimeAsync(100);
    expect(await events).toEqual([
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ errorMessage: STREAM_IDLE_MESSAGE }),
      }),
    ]);
  });

  it("carries a Stop through to the provider and its abort back unchanged", async () => {
    const { inner, calls } = drivenProvider();
    const run = new AbortController();
    const out = superviseStreams(inner, TIMING).streamFn(MODEL, CONTEXT, {
      signal: run.signal,
    }) as AssistantMessageEventStream;
    await vi.advanceTimersByTimeAsync(0);
    run.abort();
    expect(calls[0]!.signal?.aborted).toBe(true);
    const aborted = reply({ stopReason: "aborted", errorMessage: "Request was aborted" });
    calls[0]!.stream.push({ type: "error", reason: "aborted", error: aborted });
    await expect(out.result()).resolves.toBe(aborted);
  });

  it("hands an already-stopped run's abort to the provider at once", async () => {
    const { inner, calls } = drivenProvider();
    const run = new AbortController();
    run.abort();
    superviseStreams(inner, TIMING).streamFn(MODEL, CONTEXT, { signal: run.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("accepts a provider that hands its stream back as a promise", async () => {
    const done = reply();
    const inner: StreamFn = async () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end(done);
      });
      return stream;
    };
    const out = superviseStreams(inner, TIMING).streamFn(
      MODEL,
      CONTEXT,
    ) as AssistantMessageEventStream;
    await expect(out.result()).resolves.toBe(done);
  });

  it("settles a stream that ended without a terminal event on its result", async () => {
    const { inner, calls } = drivenProvider();
    const out = superviseStreams(inner, TIMING).streamFn(
      MODEL,
      CONTEXT,
      {},
    ) as AssistantMessageEventStream;
    const events = collect(out);
    await vi.advanceTimersByTimeAsync(0);
    const done = reply();
    calls[0]!.stream.push({ type: "start", partial: done });
    calls[0]!.stream.end(done);
    await expect(out.result()).resolves.toBe(done);
    expect((await events).map(({ type }) => type)).toEqual(["start"]);
  });

  it("still cuts a stream whose result never comes", async () => {
    const { inner, calls } = drivenProvider();
    const out = superviseStreams(inner, TIMING).streamFn(
      MODEL,
      CONTEXT,
      {},
    ) as AssistantMessageEventStream;
    await vi.advanceTimersByTimeAsync(0);
    calls[0]!.stream.end();
    await vi.advanceTimersByTimeAsync(TIMING.idleTimeoutMs);
    await expect(out.result()).resolves.toMatchObject({ errorMessage: STREAM_IDLE_MESSAGE });
    // The result arriving after the cut changes nothing.
    calls[0]!.stream.end(reply());
    await vi.advanceTimersByTimeAsync(0);
    await expect(out.result()).resolves.toMatchObject({ errorMessage: STREAM_IDLE_MESSAGE });
  });

  it("fails a provider that throws instead of reporting", async () => {
    const out = superviseStreams(throwingProvider, TIMING).streamFn(
      MODEL,
      CONTEXT,
    ) as AssistantMessageEventStream;
    await expect(out.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "adapter exploded",
      content: [],
    });
  });

  it("reports a throw after a Stop as the abort it is", async () => {
    const run = new AbortController();
    const inner: StreamFn = () => {
      run.abort();
      return Promise.reject("stopped");
    };
    const out = superviseStreams(inner, TIMING).streamFn(MODEL, CONTEXT, {
      signal: run.signal,
    }) as AssistantMessageEventStream;
    await expect(out.result()).resolves.toMatchObject({
      stopReason: "aborted",
      errorMessage: "stopped",
    });
  });

  it("ignores a throw from a request it already cut", async () => {
    let fail!: (error: unknown) => void;
    const inner: StreamFn = () =>
      new Promise<AssistantMessageEventStream>((_resolve, reject) => {
        fail = reject;
      });
    const out = superviseStreams(inner, TIMING).streamFn(
      MODEL,
      CONTEXT,
    ) as AssistantMessageEventStream;
    await vi.advanceTimersByTimeAsync(TIMING.idleTimeoutMs);
    fail(new Error("too late"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(out.result()).resolves.toMatchObject({ errorMessage: STREAM_IDLE_MESSAGE });
  });
});
