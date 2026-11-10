import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TRPCClientError } from "@trpc/client";
import type { IpcEvent, IpcResponse } from "@volli/host-protocol/ipc";
import type { SourceIconsSnapshot } from "@volli/shared";
import { createSessionRpcClient, type SessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { sourceIconsFor } from "./transport";

const state = vi.hoisted(() => ({
  client: null as SessionRpcClient | null,
  subscribe: null as SessionRpcClient["sourceIcons"]["watch"]["subscribe"] | null,
  cloud: false,
  remote: false,
}));
vi.mock("@renderer/lib/session-rpc-ipc-link", async (original) => ({
  ...(await original<typeof import("@renderer/lib/session-rpc-ipc-link")>()),
  sessionRpcClient: () =>
    state.subscribe ? { sourceIcons: { watch: { subscribe: state.subscribe } } } : state.client!,
}));
vi.mock("@renderer/stores/launch", () => ({
  launchStore: () => (state.cloud ? "cloud" : "local"),
}));
vi.mock("@renderer/lib/remote-owners", () => ({
  remoteOwnerOf: () => (state.remote ? { hostName: "remote" } : null),
  hostNotConnected: () => "offline",
}));
afterEach(() => {
  state.cloud = false;
  state.remote = false;
  state.client = null;
  state.subscribe = null;
});
const input = { sessionId: "session", origins: ["https://example.com"] };
const snapshot: SourceIconsSnapshot = {
  icons: [{ origin: input.origins[0]!, pictureId: null, registrableDomain: "example.com" }],
};
const turn = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const noop = () => {};
function bridge() {
  let deliver: (event: IpcEvent) => void = noop;
  let answer: (reply: IpcResponse) => void = noop;
  const cancel = vi.fn();
  const request = vi.fn(
    () =>
      new Promise<IpcResponse>((resolve) => {
        answer = resolve;
      }),
  );
  state.client = createSessionRpcClient({
    request,
    cancel,
    onEvent: (listener) => {
      deliver = listener;
      return () => {};
    },
  });
  return {
    request,
    cancel,
    ack: () => answer({ ok: true, subscriptionId: "sub" }),
    oldHost: () => answer({ ok: false, error: { code: "NOT_FOUND", message: "Unavailable" } }),
    emit: () =>
      deliver(
        structuredClone({ kind: "data", subscriptionId: "sub", eventId: null, data: snapshot }),
      ),
  };
}

describe("source icon subscription adapter through the actual generic IPC client", () => {
  it("subscribes once to the approved door and delivers snapshots", async () => {
    const wire = bridge();
    const receive = vi.fn();
    const stop = sourceIconsFor(null)!.watch(input, receive);
    await turn();
    wire.ack();
    await turn();
    wire.emit();
    expect(wire.request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "sourceIcons.watch", type: "subscription", input }),
    );
    expect(receive).toHaveBeenCalledWith(snapshot);
    stop();
    stop();
    wire.emit();
    expect(receive).toHaveBeenCalledTimes(1);
    expect(wire.cancel).toHaveBeenCalledExactlyOnceWith("sub");
  });

  it("cancels before asynchronous host setup acknowledges and discards late frames", async () => {
    const wire = bridge();
    const receive = vi.fn();
    const stop = sourceIconsFor(null)!.watch(input, receive);
    await turn();
    stop();
    wire.emit();
    wire.ack();
    await turn();
    wire.emit();
    expect(receive).not.toHaveBeenCalled();
    expect(wire.cancel).toHaveBeenCalledExactlyOnceWith("sub");
  });

  it("does not even start setup when cancelled in the same turn", async () => {
    const wire = bridge();
    const stop = sourceIconsFor(null)!.watch(input, vi.fn());
    stop();
    await turn();
    expect(wire.request).not.toHaveBeenCalled();
  });

  it("degrades old-host errors to a truthful tile", async () => {
    const wire = bridge();
    const receive = vi.fn();
    const stop = sourceIconsFor(null)!.watch(input, receive);
    await turn();
    wire.oldHost();
    await turn();
    expect(receive).toHaveBeenCalledWith({
      icons: [{ origin: "https://example.com", pictureId: null, registrableDomain: null }],
    });
    stop();
  });

  it("ignores late data and errors after cancellation, and data after ownership changes", async () => {
    let callbacks: Parameters<SessionRpcClient["sourceIcons"]["watch"]["subscribe"]>[1];
    const unsubscribe = vi.fn();
    state.subscribe = (_input, handlers) => {
      callbacks = handlers;
      return { unsubscribe };
    };
    const receive = vi.fn();
    const stop = sourceIconsFor(null)!.watch(input, receive);
    await turn();
    state.remote = true;
    callbacks!.onData?.(snapshot);
    expect(receive).not.toHaveBeenCalled();
    state.remote = false;
    callbacks!.onData?.(snapshot);
    expect(receive).toHaveBeenCalledExactlyOnceWith(snapshot);
    stop();
    callbacks!.onData?.(snapshot);
    callbacks!.onError?.(TRPCClientError.from(new Error("late failure")));
    expect(receive).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("closes a handle returned after cancellation during subscription construction", async () => {
    const unsubscribe = vi.fn();
    let stop = noop;
    state.subscribe = () => {
      stop();
      return { unsubscribe };
    };
    const receive = vi.fn();
    stop = sourceIconsFor(null)!.watch(input, receive);
    await turn();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(receive).not.toHaveBeenCalled();
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("never falls back to this Mac for cloud or remote Sessions", () => {
    const wire = bridge();
    state.cloud = true;
    expect(sourceIconsFor(null)).toBeNull();
    state.cloud = false;
    state.remote = true;
    expect(sourceIconsFor("project")).toBeNull();
    expect(wire.request).not.toHaveBeenCalled();
  });
});
