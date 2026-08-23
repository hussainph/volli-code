import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StopReason,
} from "@earendil-works/pi-ai";
import {
  ObservabilityReducer,
  type ObservabilityEvent,
  type ObservabilitySink,
  type RuntimeObservation,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  attemptStopReason,
  instrumentStreamFn,
  providerErrorClass,
  recordObservationToSink,
  teeObservationsToSink,
} from "./observability";

const SENSITIVE = "SENSITIVE-user-material";

async function settle(stream: AssistantMessageEventStream): Promise<void> {
  await stream.result();
  // The envelope lands on a microtask attached before this await; yield once
  // more so the assertion runs after it.
  await Promise.resolve();
}

function recordingSink(): { sink: ObservabilitySink; events: ObservabilityEvent[] } {
  const events: ObservabilityEvent[] = [];
  return { sink: { record: (event) => void events.push(event) }, events };
}

function model(): Model<string> {
  return {
    id: "claude-haiku-4-5",
    name: "Claude Haiku",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://provider.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

function settledMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: SENSITIVE }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage: {
      input: 120,
      output: 30,
      cacheRead: 4_000,
      cacheWrite: 500,
      totalTokens: 4_650,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0005, total: 0.0036 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

/** A clock that advances a fixed step per reading, so timings are exact. */
function steppingClock(stepMs: number): () => number {
  let at = 0;
  return () => (at += stepMs);
}

describe("attemptStopReason", () => {
  it("carries every terminal Pi stop reason through unchanged", () => {
    for (const reason of ["stop", "length", "toolUse", "error", "aborted", "deferred"] as const) {
      expect(attemptStopReason(reason)).toBe(reason);
    }
  });

  it("bounds pending and out-of-vocabulary values to unknown", () => {
    expect(attemptStopReason("pending")).toBe("unknown");
    expect(attemptStopReason("upstream-novelty" as StopReason)).toBe("unknown");
  });
});

describe("providerErrorClass", () => {
  it.each([
    ["No API key found", "auth"],
    ["HTTP 429 rate limit exceeded", "rate-limit"],
    ["The service is overloaded", "overloaded"],
    ["Request timed out", "timeout"],
    ["WebSocket connection reset", "transport"],
    ["HTTP 400 invalid request", "invalid-request"],
    [SENSITIVE, "unknown"],
  ] as const)("reduces %s to %s without retaining provider prose", (message, expected) => {
    expect(providerErrorClass("error", message)).toBe(expected);
  });

  it("does not call an aborted request a provider error", () => {
    expect(providerErrorClass("aborted", SENSITIVE)).toBeUndefined();
  });

  it("uses unknown when Pi supplied no provider diagnostic", () => {
    expect(providerErrorClass("error", undefined)).toBe("unknown");
  });
});

describe("teeObservationsToSink", () => {
  const turnStarted: RuntimeObservation = { kind: "turn", state: "started", turnId: "t1" };
  const turnCompleted: RuntimeObservation = { kind: "turn", state: "completed", turnId: "t1" };

  it("records the reduced event, stamped with the run id, before delivering", async () => {
    const order: string[] = [];
    const { events } = recordingSink();
    const teed = teeObservationsToSink(
      async () => {
        order.push("observer");
      },
      new ObservabilityReducer(() => 0),
      {
        record: (event) => {
          order.push("sink");
          events.push(event);
        },
      },
      "run-1",
    );

    await teed(turnStarted);
    await teed(turnCompleted);

    expect(events).toEqual([{ kind: "turn", outcome: "completed", durationMs: 0, runId: "run-1" }]);
    // The started observation reduces to null — observer only. The terminal
    // one hits the sink first, then the consumer.
    expect(order).toEqual(["observer", "sink", "observer"]);
  });

  it("still delivers when the sink throws", async () => {
    const seen: RuntimeObservation[] = [];
    const teed = teeObservationsToSink(
      async (observation) => {
        seen.push(observation);
      },
      new ObservabilityReducer(() => 0),
      {
        record: () => {
          throw new Error("sink offline");
        },
      },
      "run-1",
    );

    await expect(teed(turnCompleted)).resolves.toBeUndefined();
    expect(seen).toEqual([turnCompleted]);
  });

  it("records an observability-only allowance without involving the runtime observer", () => {
    const { sink, events } = recordingSink();
    const reducer = new ObservabilityReducer(() => 0);

    recordObservationToSink(reducer, sink, "run-1", {
      kind: "authority",
      state: "allowed",
      turnId: "t1",
      toolCallId: "call-1",
    });

    expect(events).toEqual([{ kind: "authority", outcome: "allowed", runId: "run-1" }]);
  });

  it("still delivers when the reducer itself throws", async () => {
    const seen: RuntimeObservation[] = [];
    const poisoned = {
      reduce: () => {
        throw new Error("reducer broke");
      },
    } as unknown as ObservabilityReducer;
    const { sink, events } = recordingSink();
    const teed = teeObservationsToSink(
      async (observation) => {
        seen.push(observation);
      },
      poisoned,
      sink,
      "run-1",
    );

    await expect(teed(turnCompleted)).resolves.toBeUndefined();
    expect(seen).toEqual([turnCompleted]);
    expect(events).toEqual([]);
  });
});

describe("instrumentStreamFn", () => {
  function scripted(message: AssistantMessage): {
    inner: StreamFn;
    finish: () => void;
    stream: AssistantMessageEventStream;
  } {
    const stream = createAssistantMessageEventStream();
    return {
      stream,
      inner: (() => stream) as StreamFn,
      finish: () => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: SENSITIVE, partial: message });
        stream.push({ type: "done", reason: "stop", message });
      },
    };
  }

  it("emits one attempt envelope with identity, usage, timing, and no content", async () => {
    const { sink, events } = recordingSink();
    const message = settledMessage({ responseModel: "claude-haiku-4-5-concrete" });
    const { inner, finish, stream } = scripted(message);
    const wrapped = instrumentStreamFn(inner, { sink, runId: "run-9", now: steppingClock(10) });

    const produced = wrapped(model(), { messages: [] }, { reasoning: "high" });
    expect(produced).toBe(stream);
    finish();
    await settle(stream);

    // Clock readings: start=10, first event=20, settlement=30. Later pushes
    // only count — the clock is read once for TTFT, not per chunk.
    expect(events).toEqual([
      {
        kind: "provider-attempt",
        providerId: "anthropic",
        modelId: "claude-haiku-4-5",
        api: "anthropic-messages",
        reasoningLevel: "high",
        stopReason: "stop",
        durationMs: 20,
        ttftMs: 10,
        chunkCount: 3,
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 500,
        totalTokens: 4_650,
        costUsd: 0.0036,
        responseModelId: "claude-haiku-4-5-concrete",
        runId: "run-9",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(SENSITIVE);
  });

  it("reports no elapsed time rather than a negative one when the clock steps back", async () => {
    const { sink, events } = recordingSink();
    const { inner, finish, stream } = scripted(settledMessage());
    // A wall clock that jumps backwards mid-request — an NTP correction, or a
    // laptop waking up. Without the guard the envelope carries a negative
    // duration, which the exporter turns into a span that ends before it began.
    const readings = [1_000, 900, 800];
    const wrapped = instrumentStreamFn(inner, {
      sink,
      runId: "run-9",
      now: () => readings.shift() ?? 700,
    });

    wrapped(model(), { messages: [] });
    finish();
    await settle(stream);

    expect(events[0]).toMatchObject({ durationMs: 0 });
    // TTFT was measured across the same backwards step, so it is absent rather
    // than zero: absent means "not measured", and zero would claim an instant
    // first token.
    expect(events[0]).not.toHaveProperty("ttftMs");
  });

  it("omits reasoning, reasoning tokens, and response model when absent", async () => {
    const { sink, events } = recordingSink();
    const { inner, finish, stream } = scripted(settledMessage());
    const wrapped = instrumentStreamFn(inner, { sink, runId: "run-9", now: steppingClock(1) });

    wrapped(model(), { messages: [] });
    finish();
    await settle(stream);

    expect(events[0]).not.toHaveProperty("reasoningLevel");
    expect(events[0]).not.toHaveProperty("reasoningTokens");
    expect(events[0]).not.toHaveProperty("responseModelId");
  });

  it("reports the provider's reasoning-token split when it says one", async () => {
    const { sink, events } = recordingSink();
    const message = settledMessage();
    message.usage.reasoning = 12;
    const { inner, finish, stream } = scripted(message);
    const wrapped = instrumentStreamFn(inner, { sink, runId: "run-9", now: steppingClock(1) });

    wrapped(model(), { messages: [] });
    finish();
    await settle(stream);

    expect(events[0]).toMatchObject({ reasoningTokens: 12 });
  });

  it("maps an errored stream to its bounded stop reason", async () => {
    const { sink, events } = recordingSink();
    const message = settledMessage({ stopReason: "aborted", errorMessage: SENSITIVE });
    const stream = createAssistantMessageEventStream();
    const wrapped = instrumentStreamFn((() => stream) as StreamFn, {
      sink,
      runId: "run-9",
      now: steppingClock(1),
    });

    wrapped(model(), { messages: [] });
    stream.push({ type: "error", reason: "aborted", error: message });
    await settle(stream);

    expect(events[0]).toMatchObject({ kind: "provider-attempt", stopReason: "aborted" });
    expect(JSON.stringify(events)).not.toContain(SENSITIVE);
  });

  it("adds a bounded error class without carrying provider error prose", async () => {
    const { sink, events } = recordingSink();
    const message = settledMessage({
      stopReason: "error",
      errorMessage: `HTTP 429 rate limit exceeded for ${SENSITIVE}`,
    });
    const { inner, finish, stream } = scripted(message);
    const wrapped = instrumentStreamFn(inner, { sink, runId: "run-9", now: steppingClock(1) });

    wrapped(model(), { messages: [] });
    finish();
    await settle(stream);

    expect(events).toMatchObject([
      { kind: "provider-attempt", stopReason: "error", providerErrorClass: "rate-limit" },
    ]);
    expect(JSON.stringify(events)).not.toContain(SENSITIVE);
  });

  it("instruments a stream function that resolves its stream asynchronously", async () => {
    const { sink, events } = recordingSink();
    const message = settledMessage();
    const stream = createAssistantMessageEventStream();
    const wrapped = instrumentStreamFn((async () => stream) as StreamFn, {
      sink,
      runId: "run-9",
      now: steppingClock(1),
    });

    const produced = await wrapped(model(), { messages: [] });
    expect(produced).toBe(stream);
    stream.push({ type: "done", reason: "stop", message });
    await settle(stream);

    expect(events).toHaveLength(1);
  });

  it("still envelopes a stream that pins push against instrumentation", async () => {
    const { sink, events } = recordingSink();
    const message = settledMessage();
    const stream = createAssistantMessageEventStream();
    Object.defineProperty(stream, "push", {
      value: AssistantMessageEventStreamPush(stream),
      writable: false,
      configurable: false,
    });
    const wrapped = instrumentStreamFn((() => stream) as StreamFn, {
      sink,
      runId: "run-9",
      now: steppingClock(10),
    });

    wrapped(model(), { messages: [] });
    stream.push({ type: "done", reason: "stop", message });
    await settle(stream);

    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("ttftMs");
    expect(events[0]).not.toHaveProperty("chunkCount");
  });

  it("keeps delivering stream events when the clock breaks mid-stream", async () => {
    const { sink, events } = recordingSink();
    const message = settledMessage();
    const { inner, finish, stream } = scripted(message);
    let readings = 0;
    const wrapped = instrumentStreamFn(inner, {
      sink,
      runId: "run-9",
      now: () => {
        readings += 1;
        // The attempt clock reads once at start; every in-stream reading breaks.
        if (readings > 1 && readings < 5) throw new Error("clock skew");
        return readings * 100;
      },
    });

    wrapped(model(), { messages: [] });
    finish();
    const settled = await stream.result();
    expect(settled).toBe(message);
    await Promise.resolve();

    // The envelope still lands; the broken readings only cost enrichment.
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("ttftMs");
  });

  it("drops the envelope, not the stream, when the sink throws at settlement", async () => {
    const message = settledMessage();
    const { inner, finish, stream } = scripted(message);
    const wrapped = instrumentStreamFn(inner, {
      sink: {
        record: () => {
          throw new Error("sink offline");
        },
      },
      runId: "run-9",
      now: steppingClock(1),
    });

    wrapped(model(), { messages: [] });
    finish();
    await expect(stream.result()).resolves.toBe(message);
  });

  it("survives a stream whose result() rejects or throws", async () => {
    const { sink, events } = recordingSink();
    const rejecting = {
      push: () => {},
      result: () => Promise.reject(new Error("no result")),
    } as unknown as AssistantMessageEventStream;
    const throwing = {
      push: () => {},
      result: () => {
        throw new Error("no result at all");
      },
    } as unknown as AssistantMessageEventStream;
    const wrapped = instrumentStreamFn(
      ((streamModel: Model<string>) =>
        streamModel.id === "rejecting" ? rejecting : throwing) as unknown as StreamFn,
      { sink, runId: "run-9", now: steppingClock(1) },
    );

    expect(wrapped({ ...model(), id: "rejecting" }, { messages: [] })).toBe(rejecting);
    expect(wrapped({ ...model(), id: "throwing" }, { messages: [] })).toBe(throwing);
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([]);
  });

  it("drops the envelope when the settled message is malformed", async () => {
    const { sink, events } = recordingSink();
    const message = settledMessage();
    Reflect.deleteProperty(message, "usage");
    const { inner, finish, stream } = scripted(message);
    const wrapped = instrumentStreamFn(inner, { sink, runId: "run-9", now: steppingClock(1) });

    wrapped(model(), { messages: [] });
    finish();
    await settle(stream);

    expect(events).toEqual([]);
  });
});

/** The stream's own push, bound, so a pinned property still behaves normally. */
function AssistantMessageEventStreamPush(stream: AssistantMessageEventStream) {
  return stream.push.bind(stream);
}
