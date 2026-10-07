/**
 * The remote host source's defaults (VC-700 PR 2): the real timer that
 * re-words a dropped project, and the bridge client the binding makes when
 * none is given. The bridge is a stand-in here: no IPC.
 */
import type { RemoteHostsSnapshot } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const bridge = vi.hoisted(() => {
  const handlers: { onData(data: unknown): void; onError(error: unknown): void }[] = [];
  const unsubscribe = vi.fn();
  return {
    handlers,
    unsubscribe,
    client: {
      hosts: {
        subscribe: {
          subscribe: (
            _input: undefined,
            handler: { onData(data: unknown): void; onError(error: unknown): void },
          ) => {
            handlers.push(handler);
            return { unsubscribe };
          },
        },
        retry: { mutate: vi.fn(async () => null) },
        updateHost: { mutate: vi.fn(async () => null) },
        cancelScheduledUpdate: { mutate: vi.fn(async () => null) },
        signIn: { mutate: vi.fn(async () => null) },
      },
    },
  };
});

vi.mock("../lib/session-rpc-ipc-link", () => ({ sessionRpcClient: () => bridge.client }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { useHostSignInSheet } from "../components/hosts/sign-ins/remote-host-sign-in-source";
import { createHostConnectionStore, HOST_OFFLINE_AFTER_MS } from "./host-connection";
import { attachRemoteHostsWhileCloud, createRemoteHostSource } from "./remote-host-source";
import { useRemoteHostsStore } from "./remote-hosts";

const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const ERROR = { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "down" };

function snapshot(link: RemoteHostsSnapshot["projects"][string]["link"]): RemoteHostsSnapshot {
  return {
    v: 1,
    hosts: [
      {
        id: HOST,
        name: "box",
        target: "deploy@box",
        transport: "ssh-tunnel",
        os: "linux",
        mode: "system",
        agentsShareAccount: false,
        version: "1.1.0",
        availableUpdate: null,
        hostIsNewer: false,
        deviceId: "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
        addedAt: "2026-10-07T00:00:00.000Z",
        liveSessions: null,
        system: null,
        arch: null,
        hostKeys: [],
      },
    ],
    projects: { p1: { hostId: HOST, link } },
    readOnly: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
  bridge.handlers.length = 0;
});

describe("the remote host source's defaults", () => {
  it("re-words a dropped project on a real timer, and clears it at close", () => {
    vi.useFakeTimers({ now: 10_000 });
    const handlers: { onData(data: RemoteHostsSnapshot): void }[] = [];
    const source = createRemoteHostSource({
      subscribe(handler) {
        handlers.push(handler);
        return () => {};
      },
      retry: async () => null,
      signIn: async () => null,
    });
    handlers[0]!.onData(snapshot({ status: "ready" }));
    handlers[0]!.onData(
      snapshot({ status: "unreachable", attempt: 1, error: ERROR, closeCode: null, retryAt: 0 }),
    );
    expect(source.getSnapshot().projects["p1"]?.link).toEqual({ status: "reconnecting" });
    vi.advanceTimersByTime(HOST_OFFLINE_AFTER_MS);
    expect(source.getSnapshot().projects["p1"]?.link.status).toBe("offline");
    handlers[0]!.onData(snapshot({ status: "ready" }));
    handlers[0]!.onData(
      snapshot({ status: "unreachable", attempt: 2, error: ERROR, closeCode: null, retryAt: 0 }),
    );
    expect(vi.getTimerCount()).toBe(1);
    source.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says a refused action in a toast, and words a project whose host it has not heard of", async () => {
    const handlers: { onData(data: RemoteHostsSnapshot): void }[] = [];
    const source = createRemoteHostSource({
      subscribe(handler) {
        handlers.push(handler);
        return () => {};
      },
      retry: async () => {
        throw new Error("No remote host there.");
      },
      signIn: async () => null,
    });
    await source.retry?.(HOST);
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith("No remote host there."));
    const orphan = snapshot({ status: "ready" });
    handlers[0]!.onData({ ...orphan, hosts: [] });
    expect(source.getSnapshot().projects["p1"]?.link).toEqual({ status: "open" });
    source.close();
  });

  it("opens the one host sign-in sheet by default after Sign in's preflight", async () => {
    const source = createRemoteHostSource({
      subscribe: () => () => {},
      retry: async () => null,
      signIn: async () => null,
    });
    source.signIn(HOST, "anthropic");
    await vi.waitFor(() =>
      expect(useHostSignInSheet.getState().target).toEqual({
        hostId: HOST,
        hostName: "the host",
        providerId: "anthropic",
      }),
    );
    useHostSignInSheet.getState().close();
    source.close();
  });

  it("arms one timer, at the soonest of its projects' re-words", () => {
    vi.useFakeTimers({ now: 10_000 });
    const handlers: { onData(data: RemoteHostsSnapshot): void }[] = [];
    const source = createRemoteHostSource({
      subscribe(handler) {
        handlers.push(handler);
        return () => {};
      },
      retry: async () => null,
      signIn: async () => null,
    });
    const down = {
      status: "unreachable",
      attempt: 1,
      error: ERROR,
      closeCode: null,
      retryAt: 0,
    } as const;
    const two = (p1: RemoteHostsSnapshot["projects"][string]["link"], p2: typeof p1) => {
      const base = snapshot(p1);
      return {
        ...base,
        projects: { p1: { hostId: HOST, link: p1 }, p2: { hostId: HOST, link: p2 } },
      };
    };
    handlers[0]!.onData(two({ status: "ready" }, { status: "ready" }));
    handlers[0]!.onData(two({ status: "ready" }, down));
    vi.advanceTimersByTime(1_000);
    handlers[0]!.onData(two(down, down));
    // p2 dropped first: its grace ends first, and p1's a second later.
    vi.advanceTimersByTime(HOST_OFFLINE_AFTER_MS - 1_000);
    expect(source.getSnapshot().projects["p2"]?.link.status).toBe("offline");
    expect(source.getSnapshot().projects["p1"]?.link.status).toBe("reconnecting");
    vi.advanceTimersByTime(1_000);
    expect(source.getSnapshot().projects["p1"]?.link.status).toBe("offline");
    source.close();
  });

  it("subscribes over the bridge's tier client when no source is given", () => {
    const store = createHostConnectionStore();
    const stop = attachRemoteHostsWhileCloud({
      experiments: {
        getState: () => ({ snapshot: { cloud: { enabled: true } } as never }),
        subscribe: () => () => {},
      },
      hosts: store,
    });
    expect(bridge.handlers).toHaveLength(1);
    bridge.handlers[0]!.onData(snapshot({ status: "ready" }));
    expect(store.getState().projects["p1"]?.hostId).toBe(HOST);
    try {
      store.getState().updateHost(HOST, "now");
      expect(useRemoteHostsStore.getState().addHost).toEqual({ open: true, target: "deploy@box" });
      useRemoteHostsStore.getState().closeAddHost();
      store.getState().cancelScheduledUpdate(HOST);
      expect(useRemoteHostsStore.getState().addHost).toEqual({ open: true, target: "deploy@box" });
      expect(bridge.client.hosts.updateHost.mutate).not.toHaveBeenCalled();
      expect(bridge.client.hosts.cancelScheduledUpdate.mutate).not.toHaveBeenCalled();
    } finally {
      stop();
      useRemoteHostsStore.getState().closeAddHost();
    }
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
