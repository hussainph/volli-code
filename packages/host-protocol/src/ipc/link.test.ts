import { createTRPCClient } from "@trpc/client";
import { initTRPC, tracked } from "@trpc/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ipcLink,
  type IpcClientRouter,
  type IpcPerformanceObserver,
  type IpcPerformanceSample,
} from "./link";
import type { IpcBridge, IpcEvent, IpcRequest, IpcResponse } from "./wire";

/** A router shaped like the Session router's corner of the desktop's: the link never reads it. */
const t = initTRPC.create();
const sessionId = (value: unknown) => value as { sessionId: string };
const toyRouter = t.router({
  session: {
    projection: t.procedure
      .input(sessionId)
      .query(() => ({ projection: {} as Record<string, unknown>, throughSequence: 0 })),
    snapshot: t.procedure
      .input(sessionId)
      .query(() => ({ projection: {}, frames: [] as unknown[], throughSequence: 0 })),
    subscribe: t.procedure
      .input(
        (value: unknown) =>
          value as { sessionId: string; afterSequence?: number; lastEventId?: string },
      )
      .subscription(async function* () {
        yield tracked("1", { sequence: 1 });
      }),
    withheld: t.procedure.query(() => "never served"),
  },
  modelAccess: {
    defaults: t.procedure.query(() => ({ global: null })),
    setDefault: t.procedure
      .input((value: unknown) => value as { purpose: string; selection: unknown })
      .mutation(({ input }) => input),
  },
});
type ToyClientRouter = IpcClientRouter<
  typeof toyRouter,
  | "session.projection"
  | "session.snapshot"
  | "session.subscribe"
  | "modelAccess.defaults"
  | "modelAccess.setDefault"
>;

function toyClient(bridge: IpcBridge, observer?: IpcPerformanceObserver) {
  return createTRPCClient<ToyClientRouter>({ links: [ipcLink(bridge, observer)] });
}

// A withheld path is not a method of the client the view types.
function assertServedOnly(client: ReturnType<typeof toyClient>): void {
  // @ts-expect-error The view types only the served paths.
  void client.session.withheld;
}
void assertServedOnly;

interface FakeBridge extends IpcBridge {
  /** What crossed, less its trace (VC-699), which {@link traces} keeps. */
  readonly requests: IpcRequest[];
  readonly traces: (IpcRequest["trace"] | undefined)[];
  readonly cancelled: string[];
  readonly listenerCount: () => number;
  /** Answers the oldest unanswered request. */
  reply(response: IpcResponse): void;
  rejectRequest(error: Error): void;
  emit(event: IpcEvent): void;
}

function fakeBridge(): FakeBridge {
  const requests: IpcRequest[] = [];
  const traces: (IpcRequest["trace"] | undefined)[] = [];
  const cancelled: string[] = [];
  const listeners = new Set<(event: IpcEvent) => void>();
  const pending: { resolve(value: IpcResponse): void; reject(error: Error): void }[] = [];
  const settle = () => {
    const next = pending.shift();
    if (!next) throw new Error("No IPC request is awaiting a reply");
    return next;
  };
  return {
    requests,
    traces,
    cancelled,
    listenerCount: () => listeners.size,
    request: ({ trace, ...request }) => {
      requests.push(request);
      traces.push(trace);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel: (subscriptionId) => {
      cancelled.push(subscriptionId);
    },
    reply: (response) => settle().resolve(response),
    rejectRequest: (error) => settle().reject(error),
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

/** Lets every queued microtask run — the link settles its requests on promises. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function subscriptionRecorder() {
  return {
    started: 0,
    data: [] as unknown[],
    errors: [] as unknown[],
    completed: 0,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("query and mutation", () => {
  it("carries the operation's trace from the call's context, with a fresh span per request (VC-699)", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const flow = "4bf92f3577b34da6a3ce929d0e0e4736";
    const traced = { context: { trace: { traceId: flow } } };
    void client.session.projection.query({ sessionId: "s" }, traced);
    void client.session.projection.query({ sessionId: "s" }, traced);
    void client.session.projection.query(
      { sessionId: "s" },
      { context: { trace: { traceId: "bad" } } },
    );
    void client.session.projection.query({ sessionId: "s" }, { context: { trace: "bad" } });
    void client.session.projection.query({ sessionId: "s" });
    await flush();
    const traces = bridge.traces.map((trace) => trace!);
    expect(traces.slice(0, 2).map(({ traceId }) => traceId)).toEqual([flow, flow]);
    expect(traces[0]!.spanId).not.toBe(traces[1]!.spanId);
    for (const trace of traces.slice(2)) {
      expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/u);
      expect(trace.traceId).not.toBe(flow);
      expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/u);
    }
  });

  it("routes a query through the bridge and resolves its data", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);

    const answer = client.session.projection.query({ sessionId: "session-1" });
    await flush();
    expect(bridge.requests).toEqual([
      { path: "session.projection", type: "query", input: { sessionId: "session-1" } },
    ]);

    bridge.reply({ ok: true, data: { projection: {}, throughSequence: 4 } });
    await expect(answer).resolves.toEqual({
      projection: {},
      throughSequence: 4,
    });
  });

  it("reports payload-free round-trip timings to an optional benchmark observer", async () => {
    const bridge = fakeBridge();
    const samples: IpcPerformanceSample[] = [];
    let now = 10;
    const client = toyClient(bridge, {
      now: () => (now += 2),
      record: (sample) => samples.push(sample),
    });

    const answer = client.session.projection.query({ sessionId: "session-1" });
    await flush();
    bridge.reply({ ok: true, data: { projection: {}, throughSequence: 4 } });
    await answer;

    expect(samples).toEqual([
      {
        kind: "round-trip",
        procedure: "session.projection",
        durationMs: 2,
        requestBytes: 161,
        responseBytes: 56,
        outcome: "ok",
      },
    ]);
    expect(JSON.stringify(samples)).not.toContain("session-1");
  });

  it("keeps observer failures and unserializable metric values off the RPC path", async () => {
    const bridge = fakeBridge();
    const input = { sessionId: "session-1" } as { sessionId: string; self?: unknown };
    input.self = input;
    const client = toyClient(bridge, {
      record: () => {
        throw new Error("observer failed");
      },
    });

    const answer = client.session.projection.query(input);
    await flush();
    const response = { ok: true as const, data: { projection: {}, throughSequence: 4 } };
    Object.defineProperty(response, "toJSON", { value: () => undefined });
    bridge.reply(response);

    await expect(answer).resolves.toEqual(response.data);
  });

  it("times a transport failure too, without carrying the payload into the sample", async () => {
    const bridge = fakeBridge();
    const samples: IpcPerformanceSample[] = [];
    let now = 10;
    const client = toyClient(bridge, {
      now: () => (now += 3),
      record: (sample) => samples.push(sample),
    });

    const answer = client.session.projection.query({ sessionId: "session-1" });
    await flush();
    // A bridge that never answers is the case a latency number is most wanted
    // for, so the failed call is measured rather than dropped. There is no
    // response, so its byte count is zero rather than a guess.
    bridge.rejectRequest(new Error("bridge is gone"));

    await expect(answer).rejects.toThrow("bridge is gone");
    expect(samples).toEqual([
      {
        kind: "round-trip",
        procedure: "session.projection",
        durationMs: 3,
        requestBytes: 161,
        responseBytes: 0,
        outcome: "transport-error",
      },
    ]);
    expect(JSON.stringify(samples)).not.toContain("session-1");
  });

  it("skips a round-trip sample when a clock read fails around a transport failure", async () => {
    const bridge = fakeBridge();
    const samples: IpcPerformanceSample[] = [];
    let reads = 0;
    const client = toyClient(bridge, {
      now: () => {
        reads += 1;
        if (reads === 2) throw new Error("clock failed");
        return reads;
      },
      record: (sample) => samples.push(sample),
    });

    const answer = client.session.projection.query({ sessionId: "session-1" });
    await flush();
    bridge.rejectRequest(new Error("bridge is gone"));

    await expect(answer).rejects.toThrow("bridge is gone");
    expect(samples).toEqual([]);
  });

  it("skips a round-trip sample when either performance clock read fails", async () => {
    for (const failedRead of [1, 2]) {
      const bridge = fakeBridge();
      const samples: IpcPerformanceSample[] = [];
      let reads = 0;
      const client = toyClient(bridge, {
        now: () => {
          reads += 1;
          if (reads === failedRead) throw new Error("clock failed");
          return reads;
        },
        record: (sample) => samples.push(sample),
      });

      const answer = client.session.snapshot.query({ sessionId: "session-1" });
      await flush();
      bridge.reply({ ok: true, data: { projection: {}, frames: [], throughSequence: 4 } });

      await expect(answer).resolves.toEqual({ projection: {}, frames: [], throughSequence: 4 });
      expect(samples).toEqual([]);
    }
  });

  it("routes a mutation the same way", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };
    const saved = { global: selection, ticket: null, utility: null };

    const answer = client.modelAccess.setDefault.mutate({ purpose: "global", selection });
    await flush();
    expect(bridge.requests[0]).toMatchObject({ path: "modelAccess.setDefault", type: "mutation" });

    bridge.reply({ ok: true, data: saved });
    await expect(answer).resolves.toEqual(saved);
  });

  // The bridge flattens a router failure into `{ code, message }`, and a caller
  // that cannot tell "this project does not exist" from "the catalog broke" has
  // to guess which one it is showing.
  it("keeps the router's error code readable off the rejection", async () => {
    const bridge = fakeBridge();
    const samples: IpcPerformanceSample[] = [];
    const client = toyClient(bridge, {
      now: () => 1,
      record: (sample) => samples.push(sample),
    });

    const answer = client.modelAccess.defaults.query();
    await flush();
    bridge.reply({ ok: false, error: { code: "NOT_FOUND", message: "Unknown model" } });

    await expect(answer).rejects.toMatchObject({
      message: "Unknown model",
      data: { code: "NOT_FOUND", httpStatus: 404, path: "modelAccess.defaults" },
    });
    expect(samples).toEqual([
      expect.objectContaining({
        kind: "round-trip",
        procedure: "modelAccess.defaults",
        outcome: "rpc-error",
      }),
    ]);
  });

  // A boot whose database failed registers no handler at all, so the invoke
  // rejects instead of answering. That is a different failure from a procedure
  // that ran and refused, and it has to read as one.
  it("surfaces an unreachable bridge as a clean client error", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);

    const answer = client.session.snapshot.query({ sessionId: "session-1" });
    await flush();
    bridge.rejectRequest(new Error("No handler registered for 'volli:session-rpc'"));

    await expect(answer).rejects.toMatchObject({
      message: "No handler registered for 'volli:session-rpc'",
      data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
    });
  });

  it("reports a bridge failure that carries no message", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);

    const answer = client.session.snapshot.query({ sessionId: "session-1" });
    await flush();
    bridge.rejectRequest("gone" as unknown as Error);

    await expect(answer).rejects.toMatchObject({ message: "The IPC bridge is unreachable" });
  });

  it("refuses a subscription acknowledgement in answer to a call", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);

    const answer = client.session.snapshot.query({ sessionId: "session-1" });
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });

    await expect(answer).rejects.toMatchObject({
      message: "session.snapshot answered with a subscription id",
    });
  });

  it("refuses to answer a call whose caller walked away", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const abort = new AbortController();

    const answer = client.session.snapshot.query(
      { sessionId: "session-1" },
      { signal: abort.signal },
    );
    await flush();
    abort.abort();
    bridge.reply({ ok: true, data: { throughSequence: 0 } });

    await expect(answer).rejects.toMatchObject({
      message: "session.snapshot was abandoned before it answered",
      data: { code: "CLIENT_CLOSED_REQUEST" },
    });
  });
});

describe("subscription", () => {
  it("starts before it delivers, and delivers the frames that beat the acknowledgement", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const seen: string[] = [];
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      {
        onStarted: () => {
          record.started += 1;
          seen.push("started");
        },
        onData: (value) => {
          record.data.push(value);
          seen.push(`data:${value.id}`);
        },
      },
    );
    await flush();

    // Main mints the id AFTER it starts pumping, so these arrive before the
    // renderer can possibly know what to call them.
    bridge.emit({ kind: "data", subscriptionId: "sub-1", eventId: "3", data: { sequence: 3 } });
    bridge.emit({ kind: "data", subscriptionId: "sub-1", eventId: "4", data: { sequence: 4 } });
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();

    expect(seen).toEqual(["started", "data:3", "data:4"]);
    expect(record.data).toEqual([
      { id: "3", data: { sequence: 3 } },
      { id: "4", data: { sequence: 4 } },
    ]);
  });

  it("measures pre-ack buffering and live renderer handler cost", async () => {
    const bridge = fakeBridge();
    const samples: IpcPerformanceSample[] = [];
    let now = 0;
    const client = toyClient(bridge, {
      now: () => ++now,
      record: (sample) => samples.push(sample),
    });

    client.session.subscribe.subscribe({ sessionId: "session-1" }, { onData: () => undefined });
    await flush();
    bridge.emit({ kind: "data", subscriptionId: "sub-1", eventId: "3", data: { sequence: 3 } });
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();
    bridge.emit({ kind: "data", subscriptionId: "sub-1", eventId: "4", data: { sequence: 4 } });

    expect(samples.filter((sample) => sample.kind === "push")).toEqual([
      expect.objectContaining({
        disposition: "buffered-before-ack",
        awaitingAck: 1,
        bufferedFrames: 1,
        durationMs: 1,
      }),
      expect.objectContaining({
        disposition: "delivered",
        awaitingAck: 0,
        bufferedFrames: 0,
        durationMs: 1,
      }),
    ]);
  });

  it("delivers live frames once the acknowledgement has landed", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1", afterSequence: 2 },
      { onData: (value) => record.data.push(value), onComplete: () => (record.completed += 1) },
    );
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();

    bridge.emit({ kind: "data", subscriptionId: "sub-1", eventId: "5", data: { sequence: 5 } });
    bridge.emit({ kind: "done", subscriptionId: "sub-1" });
    await flush();

    expect(record.data).toEqual([{ id: "5", data: { sequence: 5 } }]);
    expect(record.completed).toBe(1);
  });

  it("ignores frames addressed to another subscription", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onData: (value) => record.data.push(value) },
    );
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();

    bridge.emit({ kind: "data", subscriptionId: "sub-2", eventId: "9", data: { sequence: 9 } });
    await flush();

    expect(record.data).toEqual([]);
  });

  it("carries a terminal error frame's code through to the consumer", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onError: (error) => record.errors.push(error) },
    );
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    bridge.emit({
      kind: "error",
      subscriptionId: "sub-1",
      error: { code: "CLIENT_CLOSED_REQUEST", message: "Renderer closed" },
    });
    await flush();

    expect(record.errors).toMatchObject([
      {
        message: "Renderer closed",
        data: { code: "CLIENT_CLOSED_REQUEST", httpStatus: 499, path: "session.subscribe" },
      },
    ]);
  });

  // The envelope's reason is what a client branches on (`readHostError`); one
  // this build does not know is dropped rather than forwarded unread.
  it("forwards a reason this build knows on data.hostError, and drops one it does not", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onError: (error) => record.errors.push(error) },
    );
    client.session.subscribe.subscribe(
      { sessionId: "session-2" },
      { onError: (error) => record.errors.push(error) },
    );
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    bridge.reply({ ok: true, subscriptionId: "sub-2" });
    await flush();
    bridge.emit({
      kind: "error",
      subscriptionId: "sub-1",
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Fell behind",
        reason: "subscription-overflow",
      },
    });
    bridge.emit({
      kind: "error",
      subscriptionId: "sub-2",
      error: { code: "TOO_MANY_REQUESTS", message: "Fell behind", reason: "from-the-future" },
    });
    await flush();

    expect(record.errors).toMatchObject([
      {
        data: {
          hostError: {
            code: "TOO_MANY_REQUESTS",
            message: "Fell behind",
            reason: "subscription-overflow",
          },
        },
      },
      { data: { hostError: { code: "TOO_MANY_REQUESTS", message: "Fell behind" } } },
    ]);
    expect(
      (record.errors[1] as { data: { hostError: Record<string, unknown> } }).data.hostError,
    ).not.toHaveProperty("reason");
  });

  // A router may yield without `tracked()`: the frame then carries no id, and
  // the consumer receives the emission itself, as tRPC's own links deliver it.
  it("delivers an untracked emission as itself", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onData: (data) => record.data.push(data) },
    );
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();
    bridge.emit({ kind: "data", subscriptionId: "sub-1", eventId: null, data: { sequence: 1 } });
    await flush();

    expect(record.data).toEqual([{ sequence: 1 }]);
  });

  // The router raises its own codes — `SUBSCRIPTION_OVERFLOW` when a stream
  // falls behind — which tRPC's numeric table has no entry for. It still has to
  // reach the consumer as a readable failure rather than an unknown-key crash.
  it("falls back to a server error for a code tRPC does not know", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onError: (error) => record.errors.push(error) },
    );
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    bridge.emit({
      kind: "error",
      subscriptionId: "sub-1",
      error: { code: "SUBSCRIPTION_OVERFLOW", message: "Resume from the last event id" },
    });
    await flush();

    expect(record.errors).toMatchObject([
      {
        message: "Resume from the last event id",
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      },
    ]);
  });

  // One event listener carries every subscription, so two of them in flight at
  // once must not read each other's frames — nor retire each other's buffers
  // when the first acknowledgement lands.
  it("keeps two overlapping subscriptions apart", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const first: unknown[] = [];
    const second: unknown[] = [];

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onData: (value) => first.push(value) },
    );
    client.session.subscribe.subscribe(
      { sessionId: "session-2" },
      { onData: (value) => second.push(value) },
    );
    await flush();

    bridge.emit({ kind: "data", subscriptionId: "sub-2", eventId: "8", data: { sequence: 8 } });
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-2" });
    await flush();

    expect(first).toEqual([]);
    expect(second).toEqual([{ id: "8", data: { sequence: 8 } }]);
  });

  it("reports a refused subscription request", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onError: (error) => record.errors.push(error) },
    );
    await flush();
    bridge.reply({ ok: false, error: { code: "BAD_REQUEST", message: "Unknown session" } });
    await flush();

    expect(record.errors).toMatchObject([{ message: "Unknown session" }]);
  });

  it("reports a subscription request that answered without an id", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onError: (error) => record.errors.push(error) },
    );
    await flush();
    bridge.reply({ ok: true, data: null });
    await flush();

    expect(record.errors).toMatchObject([
      { message: "session.subscribe answered without a subscription id" },
    ]);
  });

  it("reports an unreachable bridge to the subscriber", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onError: (error) => record.errors.push(error) },
    );
    await flush();
    bridge.rejectRequest(new Error("No handler registered for 'volli:session-rpc'"));
    await flush();

    expect(record.errors).toMatchObject([
      { message: "No handler registered for 'volli:session-rpc'" },
    ]);
  });

  it("cancels a subscription its consumer already left", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    const handle = client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onStarted: () => (record.started += 1), onData: (value) => record.data.push(value) },
    );
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();

    handle.unsubscribe();
    bridge.emit({ kind: "data", subscriptionId: "sub-1", eventId: "6", data: { sequence: 6 } });
    await flush();

    expect(bridge.cancelled).toEqual(["sub-1"]);
    expect(record.data).toEqual([]);
  });

  // The id can only be cancelled once it exists, so an unsubscribe that lands
  // first has to latch and fire when the acknowledgement arrives — otherwise
  // main keeps pumping a stream nobody is reading.
  it("cancels a subscription abandoned before its id existed", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    const handle = client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onStarted: () => (record.started += 1), onData: (value) => record.data.push(value) },
    );
    await flush();
    bridge.emit({ kind: "data", subscriptionId: "sub-1", eventId: "3", data: { sequence: 3 } });
    handle.unsubscribe();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();

    expect(bridge.cancelled).toEqual(["sub-1"]);
    expect(record.started).toBe(0);
    expect(record.data).toEqual([]);
  });

  // A frame can still be in flight when a cancellation lands. Nothing will ever
  // claim it, so holding it would be a slow leak of frames nobody can read.
  it("drops a straggler frame once nothing is awaiting an id", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    const handle = client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onData: (value) => record.data.push(value) },
    );
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();
    handle.unsubscribe();

    bridge.emit({ kind: "data", subscriptionId: "sub-1", eventId: "7", data: { sequence: 7 } });

    // A later subscription must not inherit the straggler.
    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onData: (value) => record.data.push(value) },
    );
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();

    expect(record.data).toEqual([]);
  });

  it("retires an unclaimed frame when the request it raced fails", async () => {
    const bridge = fakeBridge();
    const client = toyClient(bridge);
    const record = subscriptionRecorder();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onData: (value) => record.data.push(value), onError: (error) => record.errors.push(error) },
    );
    await flush();
    bridge.emit({ kind: "data", subscriptionId: "sub-1", eventId: "3", data: { sequence: 3 } });
    bridge.reply({ ok: false, error: { code: "NOT_FOUND", message: "Unknown session" } });
    await flush();

    client.session.subscribe.subscribe(
      { sessionId: "session-1" },
      { onData: (value) => record.data.push(value) },
    );
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });
    await flush();

    expect(record.data).toEqual([]);
    expect(record.errors).toHaveLength(1);
  });
});
