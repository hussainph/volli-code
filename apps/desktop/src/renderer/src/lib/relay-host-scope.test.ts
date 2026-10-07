import type { HostLinkRelayEvent } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useHostConnectionStore, type HostRecord } from "../stores/host-connection";
import { relayHostScope, type RelayHostScopeOptions } from "./relay-host-scope";

const ipc = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./session-rpc-ipc-link", () => ({ sessionRpcClient: () => ipc.current }));
const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" };
const before = useHostConnectionStore.getState();
afterEach(() => {
  useHostConnectionStore.setState(before, true);
  vi.useRealTimers();
  ipc.current = null;
});
function host(
  scope: HostRecord["hostScope"],
  link: HostRecord["link"] = { status: "open" },
): HostRecord {
  return {
    id: HOST,
    name: "Box",
    local: false,
    os: "linux",
    version: "1",
    link,
    hostScope: scope,
    liveSessions: null,
    update: null,
    expiredSignIns: [],
  };
}
function fixture() {
  const opened: {
    input: Record<string, unknown>;
    options: { onData(event: HostLinkRelayEvent): void; onError(error: unknown): void };
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const raw = {
    hostScope: {
      query: { query: vi.fn(async (input: unknown) => input) },
      mutate: { mutate: vi.fn(async (input: unknown) => input) },
      subscribe: {
        subscribe: vi.fn(
          (
            input: Record<string, unknown>,
            options: { onData(event: HostLinkRelayEvent): void; onError(error: unknown): void },
          ) => {
            const stop = vi.fn();
            opened.push({ input, options, stop });
            return { unsubscribe: stop };
          },
        ),
      },
    },
  };
  return { raw, rpc: raw as unknown as NonNullable<RelayHostScopeOptions["rpc"]>, opened };
}

describe("HOST renderer relay", () => {
  it("addresses only hostId and preserves call traces and inputs", async () => {
    const f = fixture();
    const relay = relayHostScope(HOST, { rpc: f.rpc });
    await relay.query("workspaces.list", undefined, { trace: TRACE });
    await relay.mutate("workspaces.create", { name: "Project" });
    expect(f.raw.hostScope.query.query).toHaveBeenCalledWith(
      { hostId: HOST, path: "workspaces.list", input: undefined },
      { context: { trace: TRACE } },
    );
    expect(f.raw.hostScope.mutate.mutate).toHaveBeenCalledWith(
      { hostId: HOST, path: "workspaces.create", input: { name: "Project" } },
      {},
    );
    expect(relay.hostId).toBe(HOST);
    expect(relay).not.toHaveProperty("workspaceId");
  });

  it("uses only HOST readiness, never a ready or fenced Workspace, and reads default IPC lazily", async () => {
    const f = fixture();
    ipc.current = f.rpc;
    const relay = relayHostScope(HOST);
    expect(relay.getState()).toEqual({ status: "connecting" });
    useHostConnectionStore.setState({ hosts: [host(undefined)] });
    expect(relay.getState()).toEqual({ status: "connecting" });
    const heard = vi.fn();
    const stop = relay.subscribeState(heard);
    useHostConnectionStore.setState({
      hosts: [
        host(
          { status: "ready", granted: ["host.workspaces"] },
          { status: "incompatible", reason: "host-too-old" },
        ),
      ],
    });
    expect(relay.getState()).toEqual({ status: "open" });
    expect(heard).toHaveBeenCalledOnce();
    await relay.query("workspaces.list");
    useHostConnectionStore.setState({ hosts: [host({ status: "unavailable", granted: [] })] });
    expect(relay.getState()).toEqual({ status: "connecting" });
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });

  it("waits for a HOST welcome, resumes logs by cursor after loss and cancels its owner", () => {
    vi.useFakeTimers();
    const f = fixture();
    const relay = relayHostScope(HOST, { rpc: f.rpc, resumeDelaysMs: [10] });
    const onData = vi.fn();
    const subscription = relay.subscribe(
      "logs.follow",
      {},
      { onData, onResnapshot: vi.fn(), onError: vi.fn() },
      { trace: TRACE },
    );
    expect(f.opened).toHaveLength(0);
    useHostConnectionStore.setState({ hosts: [host({ status: "ready", granted: ["host.logs"] })] });
    expect(f.opened[0]!.input).toEqual({ hostId: HOST, path: "logs.follow", input: {} });
    expect(f.opened[0]!.options).toMatchObject({ context: { trace: TRACE } });
    f.opened[0]!.options.onData({ kind: "data", data: "line", id: "cursor" });
    expect(onData).toHaveBeenCalledWith("line", { id: "cursor" });
    f.opened[0]!.options.onData({
      kind: "lost",
      error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "Gone" },
    });
    vi.advanceTimersByTime(10);
    expect(f.opened[1]!.input).toEqual({
      hostId: HOST,
      path: "logs.follow",
      input: {},
      lastEventId: "cursor",
    });
    subscription.unsubscribe();
    expect(f.opened[0]!.stop).toHaveBeenCalledOnce();
    expect(f.opened[1]!.stop).toHaveBeenCalledOnce();
  });

  it("accepts an injected state source and untraced stream with an initial cursor", () => {
    const f = fixture();
    const relay = relayHostScope(HOST, {
      rpc: f.rpc,
      state: { getState: () => ({ status: "open" }), subscribe: () => () => {} },
    });
    const subscription = relay.subscribe(
      "logs.follow",
      {},
      { onData: vi.fn(), onError: vi.fn(), onResnapshot: vi.fn() },
      { lastEventId: "initial" },
    );
    expect(f.opened[0]!.input.lastEventId).toBe("initial");
    expect(f.opened[0]!.options).not.toHaveProperty("context");
    subscription.unsubscribe();
  });
});
