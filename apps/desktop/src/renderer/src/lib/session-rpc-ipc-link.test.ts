import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  SessionRpcIpcEvent,
  SessionRpcIpcRequest,
  SessionRpcIpcResponse,
} from "@volli/shared";

import {
  createSessionRpcClient,
  sessionRpcClient,
  type SessionRpcBridge,
  type SessionRpcClient,
} from "./session-rpc-ipc-link";

function assertPresentationClient(client: SessionRpcClient): void {
  void client.session.command.mutate({
    commandId: "command-attach",
    sessionId: "session-1",
    command: {
      // @ts-expect-error Product renderer commands never name adapters or profiles.
      kind: "adapter.attach",
      adapterId: "pi",
      profileId: "native",
      continuity: "fresh",
    },
  });
  void client.session.projection.query({ sessionId: "session-1" }).then(({ projection }) => {
    // @ts-expect-error The presentation projection has no adapter-shaped attachment inventory.
    return projection.attachments;
  });
  client.session.subscribe.subscribe(
    { sessionId: "session-1" },
    {
      onData: ({ data }) => {
        if ("sequence" in data && data.event.payload.kind === "attachment.opened") {
          // @ts-expect-error Streamed presentation frames omit executor identity.
          void data.event.payload.attachment.adapterId;
        }
      },
    },
  );
}
void assertPresentationClient;

interface FakeBridge extends SessionRpcBridge {
  readonly requests: SessionRpcIpcRequest[];
  readonly cancelled: string[];
  readonly listenerCount: () => number;
  /** Answers the oldest unanswered request. */
  reply(response: SessionRpcIpcResponse): void;
  rejectRequest(error: Error): void;
  emit(event: SessionRpcIpcEvent): void;
}

function fakeBridge(): FakeBridge {
  const requests: SessionRpcIpcRequest[] = [];
  const cancelled: string[] = [];
  const listeners = new Set<(event: SessionRpcIpcEvent) => void>();
  const pending: { resolve(value: SessionRpcIpcResponse): void; reject(error: Error): void }[] = [];
  const settle = () => {
    const next = pending.shift();
    if (!next) throw new Error("No Session RPC request is awaiting a reply");
    return next;
  };
  return {
    requests,
    cancelled,
    listenerCount: () => listeners.size,
    request: (request) => {
      requests.push(request);
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
  it("routes a query through the bridge and resolves its data", async () => {
    const bridge = fakeBridge();
    const client = createSessionRpcClient(bridge);

    const answer = client.session.projection.query({ sessionId: "session-1" });
    await flush();
    expect(bridge.requests).toEqual([
      { procedure: "session.projection", input: { sessionId: "session-1" } },
    ]);

    bridge.reply({ ok: true, data: { projection: {}, throughSequence: 4 } });
    await expect(answer).resolves.toEqual({
      projection: {},
      throughSequence: 4,
    });
  });

  it("routes a mutation the same way", async () => {
    const bridge = fakeBridge();
    const client = createSessionRpcClient(bridge);
    const selection = {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high" as const,
    };
    const saved = { global: selection, ticket: null, utility: null };

    const answer = client.modelAccess.setDefault.mutate({ purpose: "global", selection });
    await flush();
    expect(bridge.requests[0]?.procedure).toBe("modelAccess.setDefault");

    bridge.reply({ ok: true, data: saved });
    await expect(answer).resolves.toEqual(saved);
  });

  // The bridge flattens a router failure into `{ code, message }`, and a caller
  // that cannot tell "this project does not exist" from "the catalog broke" has
  // to guess which one it is showing.
  it("keeps the router's error code readable off the rejection", async () => {
    const bridge = fakeBridge();
    const client = createSessionRpcClient(bridge);

    const answer = client.modelAccess.defaults.query();
    await flush();
    bridge.reply({ ok: false, error: { code: "NOT_FOUND", message: "Unknown model" } });

    await expect(answer).rejects.toMatchObject({
      message: "Unknown model",
      data: { code: "NOT_FOUND", httpStatus: 404, path: "modelAccess.defaults" },
    });
  });

  // A boot whose database failed registers no handler at all, so the invoke
  // rejects instead of answering. That is a different failure from a procedure
  // that ran and refused, and it has to read as one.
  it("surfaces an unreachable bridge as a clean client error", async () => {
    const bridge = fakeBridge();
    const client = createSessionRpcClient(bridge);

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
    const client = createSessionRpcClient(bridge);

    const answer = client.session.snapshot.query({ sessionId: "session-1" });
    await flush();
    bridge.rejectRequest("gone" as unknown as Error);

    await expect(answer).rejects.toMatchObject({ message: "Session RPC is unreachable" });
  });

  // Lab diagnostics are deliberately absent from the IPC allow-list, so main
  // would answer BAD_REQUEST — which reads as a caller bug rather than as a
  // procedure this transport does not carry.
  it("refuses a procedure this transport has no route for, without a round trip", async () => {
    const bridge = fakeBridge();
    const client = createSessionRpcClient(bridge);

    await expect(client.labDiagnostics.list.query()).rejects.toMatchObject({
      message: "labDiagnostics.list is not routed over Session IPC",
      data: { code: "NOT_FOUND" },
    });
    expect(bridge.requests).toEqual([]);
  });

  it("refuses a subscription acknowledgement in answer to a call", async () => {
    const bridge = fakeBridge();
    const client = createSessionRpcClient(bridge);

    const answer = client.session.snapshot.query({ sessionId: "session-1" });
    await flush();
    bridge.reply({ ok: true, subscriptionId: "sub-1" });

    await expect(answer).rejects.toMatchObject({
      message: "session.snapshot answered with a subscription id",
    });
  });

  it("refuses to answer a call whose caller walked away", async () => {
    const bridge = fakeBridge();
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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

  it("delivers live frames once the acknowledgement has landed", async () => {
    const bridge = fakeBridge();
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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

  // The router raises its own codes — `SUBSCRIPTION_OVERFLOW` when a stream
  // falls behind — which tRPC's numeric table has no entry for. It still has to
  // reach the consumer as a readable failure rather than an unknown-key crash.
  it("falls back to a server error for a code tRPC does not know", async () => {
    const bridge = fakeBridge();
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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
    const client = createSessionRpcClient(bridge);
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

describe("sessionRpcClient", () => {
  // A StrictMode double render must not stack a second event listener onto the
  // bridge: every frame would then arrive twice.
  it("builds the app's client once, on first use", () => {
    const bridge = fakeBridge();
    vi.stubGlobal("window", { api: { sessionRpc: bridge } });

    expect(bridge.listenerCount()).toBe(0);
    const first = sessionRpcClient();
    expect(sessionRpcClient()).toBe(first);
    expect(bridge.listenerCount()).toBe(1);
  });
});
