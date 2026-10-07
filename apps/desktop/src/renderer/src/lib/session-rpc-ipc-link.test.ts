import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { IpcEvent, IpcRequest, IpcResponse } from "@volli/host-protocol/ipc";

import {
  createSessionRpcClient,
  sessionRpcClient,
  type SessionRpcBridge,
  type SessionRpcClient,
  type SessionRpcPerformanceSample,
} from "./session-rpc-ipc-link";

function assertPresentationClient(client: SessionRpcClient): void {
  void client.session.command.mutate({
    commandId: "command-attach",
    sessionId: "session-1",
    command: {
      kind: "adapter.attach",
      // @ts-expect-error Product renderer commands never name adapters or profiles.
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

// The client is typed from the routers main serves (`DesktopIpcRouter`): a
// procedure the desktop withholds from IPC is not a method of it.
function assertServedOnly(client: SessionRpcClient): void {
  // @ts-expect-error Lab diagnostics never cross the desktop's IPC bridge.
  void client.labDiagnostics;
  // @ts-expect-error The WebSocket's Session reads are its own.
  void client.session.list;
  // @ts-expect-error The handshake's welcome is never the window's.
  void client.protocol;
}
void assertServedOnly;

interface FakeBridge extends SessionRpcBridge {
  readonly requests: IpcRequest[];
  readonly cancelled: string[];
  readonly listenerCount: () => number;
  /** Answers the oldest unanswered request. */
  reply(response: IpcResponse): void;
  rejectRequest(error: Error): void;
  emit(event: IpcEvent): void;
}

function fakeBridge(): FakeBridge {
  const requests: IpcRequest[] = [];
  const cancelled: string[] = [];
  const listeners = new Set<(event: IpcEvent) => void>();
  const pending: { resolve(value: IpcResponse): void; reject(error: Error): void }[] = [];
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSessionRpcClient", () => {
  // The link itself is `@volli/host-protocol/ipc`'s, tested there; this is the
  // renderer's typing of it over the preload door.
  it("routes a typed call over the bridge as a path, a type, its input and its trace", async () => {
    const bridge = fakeBridge();
    const client = createSessionRpcClient(bridge);

    const answer = client.session.projection.query({ sessionId: "session-1" });
    await flush();
    expect(bridge.requests).toEqual([
      {
        path: "session.projection",
        type: "query",
        input: { sessionId: "session-1" },
        // A fresh trace when the caller names none (VC-699).
        trace: { traceId: expect.stringMatching(/^[0-9a-f]{32}$/u), spanId: expect.any(String) },
      },
    ]);
    bridge.reply({ ok: true, data: { projection: {}, throughSequence: 4 } });
    await expect(answer).resolves.toEqual({ projection: {}, throughSequence: 4 });
  });
});

describe("sessionRpcClient", () => {
  it("ignores a malformed init-script benchmark observer", async () => {
    const bridge = fakeBridge();
    vi.stubGlobal("window", {
      api: { sessionRpc: bridge },
      __VOLLI_SESSION_RPC_PERFORMANCE__: { record: null },
    });
    vi.resetModules();
    const { sessionRpcClient: isolatedSessionRpcClient } = await import("./session-rpc-ipc-link");

    const answer = isolatedSessionRpcClient().session.projection.query({ sessionId: "session-1" });
    await flush();
    bridge.reply({ ok: true, data: { projection: {}, throughSequence: 4 } });

    await expect(answer).resolves.toEqual({ projection: {}, throughSequence: 4 });
  });

  it("accepts an init-script observer that brings no clock of its own", async () => {
    const bridge = fakeBridge();
    const samples: SessionRpcPerformanceSample[] = [];
    vi.stubGlobal("window", {
      api: { sessionRpc: bridge },
      // `now` is optional: a harness that only wants byte counts and procedure
      // names should not have to supply a clock, and then the ambient one is
      // used rather than the sample being dropped.
      __VOLLI_SESSION_RPC_PERFORMANCE__: {
        record: (sample: SessionRpcPerformanceSample) => samples.push(sample),
      },
    });
    vi.resetModules();
    const { sessionRpcClient: isolatedSessionRpcClient } = await import("./session-rpc-ipc-link");

    const answer = isolatedSessionRpcClient().session.projection.query({ sessionId: "session-1" });
    await flush();
    bridge.reply({ ok: true, data: { projection: {}, throughSequence: 4 } });
    await answer;

    expect(samples).toEqual([
      expect.objectContaining({ kind: "round-trip", procedure: "session.projection" }),
    ]);
    expect(samples[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  // A StrictMode double render must not stack a second event listener onto the
  // bridge: every frame would then arrive twice.
  it("builds the app's client once and attaches an init-script benchmark observer", async () => {
    const bridge = fakeBridge();
    const samples: SessionRpcPerformanceSample[] = [];
    vi.stubGlobal("window", {
      api: { sessionRpc: bridge },
      __VOLLI_SESSION_RPC_PERFORMANCE__: {
        now: () => 1,
        record: (sample: SessionRpcPerformanceSample) => samples.push(sample),
      },
    });

    expect(bridge.listenerCount()).toBe(0);
    const first = sessionRpcClient();
    expect(sessionRpcClient()).toBe(first);
    expect(bridge.listenerCount()).toBe(1);

    const answer = first.session.projection.query({ sessionId: "session-1" });
    await flush();
    bridge.reply({ ok: true, data: { projection: {}, throughSequence: 4 } });
    await answer;
    expect(samples).toEqual([
      expect.objectContaining({ kind: "round-trip", procedure: "session.projection" }),
    ]);
  });
});
