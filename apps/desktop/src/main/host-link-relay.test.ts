// @vitest-environment node
/**
 * The Workspace link relay (VC-711) against a fake client link: which calls
 * it lets through (a served Workspace, a ready link, a granted operation that
 * main does not keep for itself), how each refusal is typed, and a relayed
 * subscription's one owner and bounded life: it ends, once, on its link's
 * loss, a resnapshot, a failure, a clean end, or its owner's stop.
 * `host-link-relay.real-link.test.ts` runs the same over a real link.
 */
import { readHostError } from "@volli/host-protocol";
import {
  HostLinkError,
  type HostLink,
  type HostLinkState,
  type HostLinkSubscriptionHandlers,
} from "@volli/host-protocol/client-link";
import type { HostLinkRelayEvent } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createHostLinkRelay,
  engineWorkspaceLinks,
  RELAY_LINK_FULL,
  RELAY_YIELDED,
  RELAY_SUBSCRIPTION_LIMIT,
  RELAY_UNKNOWN_WORKSPACE,
  RELAY_UNREACHABLE,
  type WorkspaceLinkSource,
} from "./host-link-relay";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" };

function ready(features: readonly string[] = ["board.read", "board.write"]): HostLinkState {
  return { status: "ready", welcome: { features } as never };
}

function fakeLink(initial: HostLinkState = ready()) {
  let state = initial;
  const watchers = new Set<(state: HostLinkState) => void>();
  const opened: {
    path: string;
    input: unknown;
    handlers: HostLinkSubscriptionHandlers;
    options: unknown;
    unsubscribe: ReturnType<typeof vi.fn>;
  }[] = [];
  const link = {
    workspaceId: WORKSPACE,
    getState: () => state,
    subscribeState: (listener: (state: HostLinkState) => void) => {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
    query: vi.fn(async (path: string, input?: unknown) => ({ path, input })),
    mutate: vi.fn(async (path: string) => {
      if (path === "board.deleteTicket") {
        throw new HostLinkError({
          code: "SERVICE_UNAVAILABLE",
          message: "The host link is not connected",
          reason: "host-unreachable",
        });
      }
      return { done: path };
    }),
    subscribe: vi.fn(
      (path: string, input: unknown, handlers: HostLinkSubscriptionHandlers, options?: unknown) => {
        const unsubscribe = vi.fn();
        opened.push({ path, input, handlers, options, unsubscribe });
        return { unsubscribe };
      },
    ),
  } as unknown as HostLink & {
    query: ReturnType<typeof vi.fn>;
    mutate: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  return {
    link,
    opened,
    watchers,
    set(next: HostLinkState) {
      state = next;
      for (const watcher of Array.from(watchers)) watcher(next);
    },
  };
}

function source(link: HostLink | null, served = [WORKSPACE]): WorkspaceLinkSource {
  return {
    workspaceLink: (workspaceId) => (workspaceId === WORKSPACE ? link : null),
    serves: (workspaceId) => served.includes(workspaceId),
  };
}

async function refusalOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return readHostError(error);
  }
  throw new Error("expected a refusal");
}

function collect() {
  const events: HostLinkRelayEvent[] = [];
  return { events, listener: (event: HostLinkRelayEvent) => void events.push(event) };
}

describe("relayed queries and mutations", () => {
  it("sends a granted operation over the Workspace's ready link, with the window's trace", async () => {
    const host = fakeLink();
    const relay = createHostLinkRelay(source(host.link), { trace: () => TRACE });
    expect(await relay.query(WORKSPACE, "board.snapshot", { projectId: WORKSPACE })).toEqual({
      path: "board.snapshot",
      input: { projectId: WORKSPACE },
    });
    expect(await relay.mutate(WORKSPACE, "board.setPriority", { priority: 1 })).toEqual({
      done: "board.setPriority",
    });
    expect(host.link.query).toHaveBeenCalledWith(
      "board.snapshot",
      { projectId: WORKSPACE },
      { trace: TRACE },
    );
    expect(host.link.mutate).toHaveBeenCalledWith(
      "board.setPriority",
      { priority: 1 },
      { trace: TRACE },
    );
  });

  it("sends no trace when the window's request carries none", async () => {
    const host = fakeLink();
    const relay = createHostLinkRelay(source(host.link), { trace: () => null });
    await relay.query(WORKSPACE, "board.snapshot", undefined);
    expect(host.link.query).toHaveBeenCalledWith("board.snapshot", undefined, {});
    // The default reads the request's own trace: outside one, none.
    const ambient = createHostLinkRelay(source(host.link));
    await ambient.query(WORKSPACE, "board.roster", undefined);
    expect(host.link.query).toHaveBeenLastCalledWith("board.roster", undefined, {});
  });

  it("types each refusal: unknown Workspace, no ready link, not granted, main's own", async () => {
    const host = fakeLink();
    const relay = createHostLinkRelay(source(host.link, [WORKSPACE, OTHER]));
    expect(await refusalOf(relay.query(OTHER, "board.snapshot", {}))).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: RELAY_UNREACHABLE,
      reason: "host-unreachable",
    });
    const unserved = createHostLinkRelay(source(host.link, []));
    expect(await refusalOf(unserved.query(WORKSPACE, "board.snapshot", {}))).toEqual({
      code: "NOT_FOUND",
      message: RELAY_UNKNOWN_WORKSPACE,
      reason: "workspace-unknown",
    });
    host.set({ status: "connecting", attempt: 1 });
    expect(await refusalOf(relay.mutate(WORKSPACE, "board.setPriority", {}))).toMatchObject({
      reason: "host-unreachable",
    });
    host.set(ready(["board.read", "sign-ins", "auth.callback"]));
    for (const path of ["board.setPriority", "signIns.start", "auth.callback.deliver", "x.y"]) {
      expect(await refusalOf(relay.mutate(WORKSPACE, path, {})), path).toEqual({
        code: "FORBIDDEN",
        message: `${path} is not among the operations this project’s link may send.`,
        reason: "verb-refused",
      });
    }
    // The base operation is every connection's.
    expect(await relay.query(WORKSPACE, "protocol.welcome", undefined)).toMatchObject({
      path: "protocol.welcome",
    });
    expect(host.link.mutate).not.toHaveBeenCalled();
  });

  it("passes the link's own failure on as it threw it", async () => {
    const host = fakeLink();
    const relay = createHostLinkRelay(source(host.link));
    expect(await refusalOf(relay.mutate(WORKSPACE, "board.deleteTicket", {}))).toMatchObject({
      reason: "host-unreachable",
    });
  });

  it("lets the engine's own refusal (cloud off) through untyped, for the router to say", async () => {
    const off = new Error("Remote hosts are off");
    const relay = createHostLinkRelay({
      workspaceLink: () => {
        throw off;
      },
      serves: () => true,
    });
    await expect(relay.query(WORKSPACE, "board.snapshot", {})).rejects.toBe(off);
    expect(() => relay.subscribe(WORKSPACE, "board.changes", {}, () => {})).toThrow(off);
  });

  it("reads the engine: its Workspace links, and the remote projects its snapshot names", () => {
    const host = fakeLink();
    const engine = {
      workspaceLink: vi.fn(() => host.link),
      snapshot: () => ({ projects: { [WORKSPACE]: { hostId: "h" } } }),
    };
    const links = engineWorkspaceLinks(engine);
    expect(links.serves(WORKSPACE)).toBe(true);
    expect(links.serves(OTHER)).toBe(false);
    expect(links.serves("toString")).toBe(false);
    expect(links.workspaceLink(WORKSPACE)).toBe(host.link);
    expect(engine.workspaceLink).toHaveBeenCalledWith(WORKSPACE);
  });
});

describe("a relayed subscription", () => {
  it("relays starts and emissions, each tracked one with its id, after a resume cursor", () => {
    const host = fakeLink();
    const relay = createHostLinkRelay(source(host.link), { trace: () => TRACE });
    const { events, listener } = collect();
    relay.subscribe(WORKSPACE, "board.changes", { projectId: WORKSPACE }, listener, {
      lastEventId: "41",
    });
    const [opened] = host.opened;
    expect(opened).toMatchObject({
      path: "board.changes",
      input: { projectId: WORKSPACE },
      options: { trace: TRACE, lastEventId: "41" },
    });
    opened!.handlers.onStarted!();
    opened!.handlers.onData({ id: "42", data: { cursor: "42" } }, { id: "42" });
    opened!.handlers.onData("untracked");
    expect(events).toEqual([
      { kind: "started" },
      { kind: "data", data: { id: "42", data: { cursor: "42" } }, id: "42" },
      { kind: "data", data: "untracked" },
    ]);
    expect(relay.open()).toBe(1);
  });

  it("ends with `lost` the moment its link leaves ready, and lets go of the host's stream", () => {
    const host = fakeLink();
    const relay = createHostLinkRelay(source(host.link));
    const { events, listener } = collect();
    const stop = relay.subscribe(WORKSPACE, "board.changes", {}, listener);
    // A fresh welcome on the same connection is no loss.
    host.set(ready());
    expect(events).toEqual([]);
    host.set({
      status: "unreachable",
      attempt: 1,
      error: { code: "SERVICE_UNAVAILABLE", message: "socket closed", reason: "host-unreachable" },
      closeCode: 1006,
      retryAt: 0,
    });
    expect(events).toEqual([
      {
        kind: "lost",
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "socket closed",
          reason: "host-unreachable",
        },
      },
    ]);
    expect(host.opened[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(host.watchers.size).toBe(0);
    expect(relay.open()).toBe(0);
    // Nothing after the end: a late emission, another change, the owner's stop.
    host.opened[0]!.handlers.onData("late");
    host.opened[0]!.handlers.onStarted!();
    stop();
    expect(events).toHaveLength(1);
    expect(host.opened[0]!.unsubscribe).toHaveBeenCalledOnce();
  });

  it("says a closed link is lost too, in the relay's own words", () => {
    const host = fakeLink();
    const relay = createHostLinkRelay(source(host.link));
    const { events, listener } = collect();
    relay.subscribe(WORKSPACE, "board.changes", {}, listener);
    host.set({ status: "closed" });
    expect(events).toEqual([
      {
        kind: "lost",
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: RELAY_UNREACHABLE,
          reason: "host-unreachable",
        },
      },
    ]);
  });

  it("ends on a resnapshot, a failure (a lost one as `lost`), or a clean end", () => {
    const host = fakeLink();
    const relay = createHostLinkRelay(source(host.link));
    const runs = [0, 1, 2, 3].map(() => {
      const run = collect();
      relay.subscribe(WORKSPACE, "board.changes", {}, run.listener);
      return run;
    });
    const resnapshot = {
      code: "PRECONDITION_FAILED" as const,
      message: "resnapshot",
      reason: "subscription-resnapshot-required" as const,
    };
    host.opened[0]!.handlers.onResnapshot(resnapshot);
    host.opened[1]!.handlers.onError(
      new HostLinkError({ code: "NOT_FOUND", message: "gone", reason: "workspace-unknown" }),
    );
    host.opened[2]!.handlers.onError(
      new HostLinkError({
        code: "SERVICE_UNAVAILABLE",
        message: "dropped",
        reason: "host-unreachable",
      }),
    );
    host.opened[3]!.handlers.onComplete!();
    const bare = collect();
    relay.subscribe(WORKSPACE, "board.changes", {}, bare.listener);
    host.opened[4]!.handlers.onError({ message: "Not here", data: { code: "NOT_FOUND" } });
    expect(bare.events).toEqual([
      { kind: "error", error: { code: "NOT_FOUND", message: "Not here" } },
    ]);
    expect(runs.map(({ events }) => events)).toEqual([
      [{ kind: "resnapshot", error: resnapshot }],
      [
        {
          kind: "error",
          error: { code: "NOT_FOUND", message: "gone", reason: "workspace-unknown" },
        },
      ],
      [
        {
          kind: "lost",
          error: { code: "SERVICE_UNAVAILABLE", message: "dropped", reason: "host-unreachable" },
        },
      ],
      [{ kind: "complete" }],
    ]);
    for (const opened of host.opened) expect(opened.unsubscribe).toHaveBeenCalledOnce();
    expect(relay.open()).toBe(0);
  });

  it("ends at once, as events, when it cannot open: unknown, unreachable, not granted", () => {
    const host = fakeLink(ready(["board.read"]));
    const relay = createHostLinkRelay(source(host.link, [WORKSPACE, OTHER]));
    const runs = [
      [OTHER, "board.changes"],
      [WORKSPACE, "signIns.subscribe"],
    ].map(([workspaceId, path]) => {
      const run = collect();
      const stop = relay.subscribe(workspaceId!, path!, {}, run.listener);
      stop();
      return run.events;
    });
    const unknown = collect();
    createHostLinkRelay(source(host.link, [])).subscribe(
      WORKSPACE,
      "board.changes",
      {},
      unknown.listener,
    )();
    expect(runs).toEqual([
      [
        {
          kind: "lost",
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: RELAY_UNREACHABLE,
            reason: "host-unreachable",
          },
        },
      ],
      [
        {
          kind: "error",
          error: {
            code: "FORBIDDEN",
            message: "signIns.subscribe is not among the operations this project’s link may send.",
            reason: "verb-refused",
          },
        },
      ],
    ]);
    expect(unknown.events).toEqual([
      {
        kind: "error",
        error: { code: "NOT_FOUND", message: RELAY_UNKNOWN_WORKSPACE, reason: "workspace-unknown" },
      },
    ]);
    expect(host.opened).toEqual([]);
    expect(relay.open()).toBe(0);
  });

  it("ends when its owner stops it: the window cancelled or went", () => {
    const host = fakeLink();
    const relay = createHostLinkRelay(source(host.link));
    const { events, listener } = collect();
    const stop = relay.subscribe(WORKSPACE, "board.changes", {}, listener);
    stop();
    stop();
    expect(host.opened[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(host.watchers.size).toBe(0);
    expect(relay.open()).toBe(0);
    host.set({ status: "closed" });
    expect(events).toEqual([]);
  });

  it("holds at most its cap open, and refuses past it as subscription-limit", () => {
    const host = fakeLink();
    const relay = createHostLinkRelay(source(host.link), { subscriptionCap: 2 });
    const stops = [0, 1].map(() => relay.subscribe(WORKSPACE, "board.changes", {}, () => {}));
    const past = collect();
    relay.subscribe(WORKSPACE, "board.changes", {}, past.listener)();
    expect(past.events).toEqual([
      {
        kind: "error",
        error: {
          code: "TOO_MANY_REQUESTS",
          message: RELAY_SUBSCRIPTION_LIMIT,
          reason: "subscription-limit",
        },
      },
    ]);
    expect(host.opened).toHaveLength(2);
    (stops[0] as () => void)();
    relay.subscribe(WORKSPACE, "board.changes", {}, () => {});
    expect(host.opened).toHaveLength(3);
  });

  it("lets go of a stream that ended while it was opening", () => {
    const host = fakeLink();
    host.link.subscribe.mockImplementationOnce(
      (_path: string, _input: unknown, handlers: HostLinkSubscriptionHandlers) => {
        handlers.onComplete!();
        const unsubscribe = vi.fn();
        host.opened.push({ path: "", input: null, handlers, options: null, unsubscribe });
        return { unsubscribe };
      },
    );
    const relay = createHostLinkRelay(source(host.link));
    const { events, listener } = collect();
    relay.subscribe(WORKSPACE, "board.changes", {}, listener);
    expect(events).toEqual([{ kind: "complete" }]);
    expect(host.opened[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(relay.open()).toBe(0);
  });

  it("tells its owner when a listener throws or rejects, and keeps relaying", async () => {
    const host = fakeLink();
    const onListenerError = vi.fn();
    const relay = createHostLinkRelay(source(host.link), { onListenerError });
    let calls = 0;
    relay.subscribe(WORKSPACE, "board.changes", {}, () => {
      calls += 1;
      if (calls === 1) throw new Error("threw");
      return Promise.reject(new Error("rejected"));
    });
    host.opened[0]!.handlers.onData(1);
    host.opened[0]!.handlers.onData(2);
    await vi.waitFor(() => expect(onListenerError).toHaveBeenCalledTimes(2));
    expect(onListenerError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      "threw",
      "rejected",
    ]);
    // Without an owner to tell, a throwing listener is still contained.
    const quiet = createHostLinkRelay(source(host.link));
    quiet.subscribe(WORKSPACE, "board.changes", {}, () => {
      throw new Error("unheard");
    });
    expect(() => host.opened[1]!.handlers.onData(1)).not.toThrow();
  });
});

/** A full link's refusal, as the relay says it. */
const full = (message: string) => ({
  kind: "error",
  error: { code: "TOO_MANY_REQUESTS", message, reason: "subscription-limit" },
});

describe("the stream budget on each Workspace link (AM1)", () => {
  it("holds hostd's four per link: foreground takes the newest background's slot", () => {
    const host = fakeLink(
      ready(["board.read", "sessions.subscribe", "sessions.queue", "host.logs"]),
    );
    const relay = createHostLinkRelay(source(host.link));
    const open = (path: string) => {
      const run = collect();
      const stop = relay.subscribe(WORKSPACE, path, {}, run.listener);
      return { ...run, stop };
    };
    const feed = open("board.changes");
    open("session.subscribe");
    const queue = open("session.subscribeQueue");
    const logs = open("logs.follow");
    expect(relay.open(WORKSPACE)).toBe(4);
    expect(relay.open(OTHER)).toBe(0);

    // A background stream past the budget waits, typed; nothing yields to it.
    const moreLogs = open("logs.follow");
    expect(moreLogs.events).toEqual([full(RELAY_LINK_FULL)]);
    moreLogs.stop();
    // A foreground one takes the newest background stream's slot: the logs'.
    const second = open("session.subscribe");
    expect(logs.events).toEqual([full(RELAY_YIELDED)]);
    expect(host.opened[3]!.unsubscribe).toHaveBeenCalledOnce();
    expect(second.events).toEqual([]);
    // Then the queue's.
    open("session.subscribe");
    expect(queue.events).toEqual([full(RELAY_YIELDED)]);
    // Then none is left to yield: a foreground stream waits too.
    const fourth = open("session.subscribe");
    expect(fourth.events).toEqual([full(RELAY_LINK_FULL)]);
    expect(relay.open(WORKSPACE)).toBe(4);
    expect(feed.events).toEqual([]);

    // A stream that ends gives its slot back.
    feed.stop();
    expect(relay.open(WORKSPACE)).toBe(3);
    expect(open("logs.follow").events).toEqual([]);
    expect(relay.open(WORKSPACE)).toBe(4);
  });

  it("counts each link on its own, and lets go of a link with none left", () => {
    const one = fakeLink();
    const two = fakeLink();
    const relay = createHostLinkRelay(
      {
        workspaceLink: (workspaceId) => (workspaceId === WORKSPACE ? one.link : two.link),
        serves: () => true,
      },
      { streamsPerLink: 1 },
    );
    const stop = relay.subscribe(WORKSPACE, "board.changes", {}, () => {});
    const other = collect();
    relay.subscribe(OTHER, "board.changes", {}, other.listener);
    expect(other.events).toEqual([]);
    expect([relay.open(WORKSPACE), relay.open(OTHER), relay.open()]).toEqual([1, 1, 2]);
    stop();
    expect(relay.open(WORKSPACE)).toBe(0);
    const again = collect();
    relay.subscribe(WORKSPACE, "board.changes", {}, again.listener);
    expect(again.events).toEqual([]);
  });
});
