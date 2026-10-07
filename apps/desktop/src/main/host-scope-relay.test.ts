// @vitest-environment node
/** Dedicated HOST relay: grants, identity, trace and the same bounded stream owner. */
import { hostError, readHostError } from "@volli/host-protocol";
import type {
  HostScopeLink,
  HostScopeLinkState,
  HostLinkSubscribeOptions,
  HostLinkSubscriptionHandlers,
} from "@volli/host-protocol/client-link";
import type { HostLinkRelayEvent } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import { createHostScopeRelay, engineHostScopeLinks } from "./host-link-relay";

const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" };
function fixture() {
  let state: HostScopeLinkState = {
    status: "ready",
    welcome: {
      scope: "host",
      protocolVersion: 1,
      host: { id: HOST, version: "1" },
      actor: { kind: "device", deviceId: DEVICE, scope: "host" },
      features: ["host.workspaces", "host.logs", "sign-ins", "auth.callback"],
      proof: null,
    },
  };
  const watchers = new Set<(state: HostScopeLinkState) => void>();
  const opened: {
    handlers: HostLinkSubscriptionHandlers;
    options: HostLinkSubscribeOptions | undefined;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const link: HostScopeLink = {
    hostId: HOST,
    getState: () => state,
    subscribeState: (listener) => {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
    query: vi.fn(async (path, input) => ({ path, input })),
    mutate: vi.fn(async (path, input) => ({ path, input })),
    subscribe: vi.fn((_path, _input, handlers, options) => {
      const stop = vi.fn();
      opened.push({ handlers, options, stop });
      return { unsubscribe: stop };
    }),
    wake: vi.fn(),
    reconnect: vi.fn(),
    close: vi.fn(),
  };
  let hosts = [{ id: HOST }];
  let held: HostScopeLink | null = link;
  const source = engineHostScopeLinks({
    hostScopeLink: (id) => (id === HOST ? held : null),
    snapshot: () => ({ hosts }),
  });
  const relay = createHostScopeRelay(source, { trace: () => TRACE, streamsPerLink: 1 });
  return {
    link,
    source,
    relay,
    opened,
    watchers,
    forget: () => {
      hosts = [];
    },
    withdraw: () => {
      held = null;
    },
    set: (next: HostScopeLinkState) => {
      state = next;
      for (const listener of watchers) listener(next);
    },
  };
}
async function failure(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return readHostError(error);
  }
  throw new Error("Expected refusal");
}

describe("HOST relay without a Workspace", () => {
  it("uses enrolled host identity, host bootstrap/grants and request traces", async () => {
    const f = fixture();
    expect(f.source.serves(HOST)).toBe(true);
    expect(f.source.serves("unknown")).toBe(false);
    expect(f.source.hostScopeLink(HOST)).toBe(f.link);
    await f.relay.query(HOST, "protocol.hostWelcome", undefined);
    await f.relay.query(HOST, "workspaces.list", undefined);
    await f.relay.mutate(HOST, "workspaces.create", {
      commandId: DEVICE,
      source: { path: "/project" },
    });
    expect(f.link.query).toHaveBeenLastCalledWith("workspaces.list", undefined, { trace: TRACE });
    expect(f.link.mutate).toHaveBeenCalledWith(
      "workspaces.create",
      { commandId: DEVICE, source: { path: "/project" } },
      { trace: TRACE },
    );
    for (const path of [
      "protocol.welcome",
      "board.snapshot",
      "signIns.status",
      "auth.callback.deliver",
    ])
      expect(await failure(f.relay.query(HOST, path, {}))).toMatchObject({
        reason: "verb-refused",
      });
    f.withdraw();
    expect(await failure(f.relay.query(HOST, "workspaces.list", undefined))).toMatchObject({
      reason: "host-unreachable",
      message: "The host can’t be reached right now.",
    });
    f.forget();
    expect(await failure(f.relay.query(HOST, "workspaces.list", undefined))).toMatchObject({
      reason: "host-unreachable",
      message: "No enrolled host on this Mac has that identity.",
    });
  });

  it("bounds HOST streams, preserves cursors, releases once on loss and owner cancellation", () => {
    const f = fixture();
    const seen: HostLinkRelayEvent[] = [];
    const stop = f.relay.subscribe(HOST, "logs.follow", {}, "cursor-1", (event) => {
      seen.push(event);
    });
    expect(f.opened[0]?.options).toEqual({ trace: TRACE, lastEventId: "cursor-1" });
    expect(f.relay.open()).toBe(1);
    expect(f.relay.open(HOST)).toBe(1);
    const refused: HostLinkRelayEvent[] = [];
    f.relay.subscribe(HOST, "logs.follow", {}, undefined, (event) => {
      refused.push(event);
    });
    expect(refused).toMatchObject([{ kind: "error", error: { reason: "subscription-limit" } }]);
    expect(f.opened).toHaveLength(1);
    f.opened[0]!.handlers.onStarted?.();
    f.opened[0]!.handlers.onData("line", { id: "cursor-2" });
    f.set({ status: "closed" });
    expect(seen).toMatchObject([
      { kind: "started" },
      { kind: "data", data: "line", id: "cursor-2" },
      {
        kind: "lost",
        error: { reason: "host-unreachable", message: "The host can’t be reached right now." },
      },
    ]);
    expect(f.relay.open()).toBe(0);
    expect(f.watchers.size).toBe(0);
    stop();
    expect(f.opened[0]!.stop).toHaveBeenCalledOnce();
  });

  it("ends a HOST stream with its own error and does not retain an unavailable stream", () => {
    const f = fixture();
    const seen: HostLinkRelayEvent[] = [];
    f.relay.subscribe(HOST, "logs.follow", {}, undefined, (event) => {
      seen.push(event);
    });
    f.set({
      status: "refused",
      error: hostError("credential-invalid", "Enrollment revoked"),
      closeCode: 4401,
    });
    expect(seen).toMatchObject([{ kind: "lost", error: { message: "Enrollment revoked" } }]);
    f.relay.subscribe(HOST, "logs.follow", {}, undefined, (event) => {
      seen.push(event);
    });
    expect(seen.at(-1)).toMatchObject({ kind: "lost" });
    expect(f.relay.open()).toBe(0);
  });
});
