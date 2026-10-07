/**
 * Every connected remote host in the one log viewer (VC-712): when a host's
 * source registers, which links it reads over, and when it goes. The real
 * relay over real links is `main/remote-logs.real-link.test.ts`.
 */
import { readHostError } from "@volli/host-protocol";
import type { HostLinkRelayEvent } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { RelayHostLinkRpc } from "../../lib/relay-host-link";
import {
  useHostConnectionStore,
  type HostConnectionSource,
  type HostConnectionState,
  HostLinkView,
  HostRecord,
  ProjectLink,
} from "../../stores/host-connection";
import { remoteLogSources, type LogSource, type LogSourceLink } from "./log-sources";
import {
  attachRemoteLogSources,
  HOST_LOGS_FEATURE,
  relayLogLink,
  waitingStatus,
} from "./remote-log-sources";

const rpcClient = vi.hoisted(() => ({ queries: [] as unknown[] }));
vi.mock("../../lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({
    hostLink: {
      query: {
        query: (input: unknown) => {
          rpcClient.queries.push(input);
          return new Promise(() => {});
        },
      },
    },
  }),
}));

const BOX = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER = "c8d1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const OPEN: HostLinkView = { status: "open" };
const GRANTS = ["sign-ins", HOST_LOGS_FEATURE] as const;

function host(id: string, name: string, link: HostLinkView = OPEN, local = false): HostRecord {
  return {
    id,
    name,
    local,
    os: "linux",
    version: "1.0.0",
    link,
    liveSessions: null,
    update: null,
    expiredSignIns: [],
  };
}

const ready = (hostId: string, granted: readonly string[] = GRANTS): ProjectLink => ({
  hostId,
  link: OPEN,
  granted,
});

/** A host-connection state the test sets. */
function store(initial: Pick<HostConnectionState, "hosts" | "projects">) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: Partial<Pick<HostConnectionState, "hosts" | "projects">>) {
      state = { ...state, ...next };
      for (const listener of Array.from(listeners)) listener();
    },
    listeners,
  };
}

/** Links that answer nothing: the test reads which ones a source chose. */
function links() {
  const made: string[] = [];
  const streams: { workspaceId: string; unsubscribed: boolean }[] = [];
  return {
    made,
    streams,
    link: (workspaceId: string): LogSourceLink => {
      made.push(workspaceId);
      return {
        query: () => new Promise(() => {}),
        subscribe: () => {
          const stream = { workspaceId, unsubscribed: false };
          streams.push(stream);
          return { unsubscribe: () => void (stream.unsubscribed = true) };
        },
      };
    },
  };
}

const detaches: (() => void)[] = [];
afterEach(() => {
  for (const detach of detaches.splice(0)) detach();
});

function attach(options: Parameters<typeof attachRemoteLogSources>[0]) {
  const detach = attachRemoteLogSources(options);
  detaches.push(detach);
  return detach;
}

/** Starts a source as the viewer does, and records its dot. */
function start(source: LogSource) {
  const statuses: [string, string | undefined][] = [];
  const stop = source.start({
    onLines: () => {},
    onStatus: (status, detail) => void statuses.push([status, detail]),
  });
  return { statuses, stop };
}

describe("remote hosts in the one log viewer (VC-712)", () => {
  it("registers a host by name once one of its links is ready and grants host.logs", () => {
    const hosts = store({
      hosts: [host("this-mac", "This Mac", OPEN, true), host(BOX, "box")],
      projects: {
        // Ready, but an older host: no log on offer.
        "ws-1": ready(BOX, ["sign-ins"]),
        // Granted once, on its way back: not ready.
        "ws-2": { hostId: BOX, link: { status: "reconnecting" } },
        // This Mac's own project: never a remote source.
        "ws-local": { hostId: "this-mac", link: OPEN },
      },
    });
    attach({ hosts, link: links().link });
    expect(remoteLogSources()).toEqual([]);
    hosts.set({ projects: { ...hosts.getState().projects, "ws-2": ready(BOX) } });
    expect(remoteLogSources().map(({ id, label }) => [id, label])).toEqual([[BOX, "box"]]);
    // Nothing more on a change that changes nothing.
    const [source] = remoteLogSources();
    hosts.set({});
    expect(remoteLogSources()[0]).toBe(source);
  });

  it("reads over the least loaded link: the shown project's last, then by id; one link per Workspace", () => {
    const made = links();
    const hosts = store({
      hosts: [host(BOX, "box")],
      projects: { "ws-c": ready(BOX), "ws-a": ready(BOX), "ws-b": ready(BOX) },
    });
    attach({ hosts, link: made.link, shown: () => "ws-a" });
    start(remoteLogSources()[0]!);
    expect(made.made).toEqual(["ws-b", "ws-c", "ws-a"]);
    // The links are kept: a change makes none again.
    hosts.set({});
    expect(made.made).toHaveLength(3);
    // A project that goes takes its link with it; one that comes back gets a new one.
    const { "ws-c": _gone, ...rest } = hosts.getState().projects;
    hosts.set({ projects: rest });
    hosts.set({ projects: { ...rest, "ws-c": ready(BOX) } });
    start(remoteLogSources()[0]!);
    expect(made.made.at(-1)).toBe("ws-c");
  });

  it("stays while the host drops, its dot saying so, and goes when the host loses its links", () => {
    const hosts = store({
      hosts: [host(BOX, "box")],
      projects: { "ws-1": ready(BOX), "ws-2": ready(BOX) },
    });
    attach({ hosts, link: links().link });
    const viewer = start(remoteLogSources()[0]!);
    expect(viewer.statuses.at(-1)).toEqual(["connecting", undefined]);
    const down: HostLinkView = { status: "offline", since: 1, retryAt: 2 };
    hosts.set({
      hosts: [host(BOX, "box", down)],
      projects: {
        "ws-1": { hostId: BOX, link: down },
        "ws-2": { hostId: BOX, link: { status: "incompatible", reason: "refused" } },
      },
    });
    expect(remoteLogSources()).toHaveLength(1);
    expect(viewer.statuses.at(-1)).toEqual(["failed", "box can’t be reached right now."]);
    // Closed for good, and unable to serve: the host has no link left.
    hosts.set({
      projects: {
        "ws-1": { hostId: BOX, link: { status: "offline", since: 1, retryAt: null } },
        "ws-2": { hostId: BOX, link: { status: "incompatible", reason: "refused" } },
      },
    });
    expect(remoteLogSources()).toEqual([]);
    viewer.stop();
    // Ready again: registered again.
    hosts.set({ hosts: [host(BOX, "box")], projects: { "ws-1": ready(BOX) } });
    expect(remoteLogSources()).toHaveLength(1);
    // No projects at all: no link.
    hosts.set({ projects: {} });
    expect(remoteLogSources()).toEqual([]);
  });

  it("follows a rename, unregisters a forgotten host, and lets go of every source when detached", () => {
    const hosts = store({
      hosts: [host(BOX, "box"), host(OTHER, "other")],
      projects: { "ws-1": ready(BOX), "ws-2": ready(OTHER) },
    });
    const detach = attach({ hosts, link: links().link });
    expect(remoteLogSources().map(({ label }) => label)).toEqual(["box", "other"]);
    hosts.set({ hosts: [host(BOX, "the box"), host(OTHER, "other")] });
    expect(remoteLogSources().map(({ id, label }) => [id, label])).toEqual([
      [OTHER, "other"],
      [BOX, "the box"],
    ]);
    hosts.set({ hosts: [host(OTHER, "other")] });
    expect(remoteLogSources().map(({ id }) => id)).toEqual([OTHER]);
    detach();
    expect(remoteLogSources()).toEqual([]);
    expect(hosts.listeners.size).toBe(0);
  });

  it("reads the app's host-connection store over the relay, by default", () => {
    const snapshot = {
      hosts: [
        {
          id: BOX,
          name: "box",
          local: false,
          os: "linux" as const,
          version: "1.0.0",
          liveSessions: null,
          update: null,
          expiredSignIns: [],
        },
      ],
      projects: { "ws-1": ready(BOX) },
    };
    const source: HostConnectionSource = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      retry() {},
      updateHost() {},
      cancelScheduledUpdate() {},
      signIn() {},
    };
    const detachSource = useHostConnectionStore.getState().attach(source);
    attach({});
    expect(remoteLogSources().map(({ label }) => label)).toEqual(["box"]);
    const viewer = start(remoteLogSources()[0]!);
    expect(rpcClient.queries).toEqual([
      { workspaceId: "ws-1", path: "logs.tail", input: { limit: 500 } },
    ]);
    viewer.stop();
    detachSource();
    expect(remoteLogSources()).toEqual([]);
  });

  it("words the host's link for the dot while none of its links is ready", () => {
    expect(waitingStatus(host(BOX, "box", { status: "connecting" }))).toEqual({
      status: "connecting",
      detail: "Reconnecting to box…",
    });
    expect(waitingStatus(host(BOX, "box", { status: "reconnecting" }))).toEqual({
      status: "connecting",
      detail: "Reconnecting to box…",
    });
    expect(
      waitingStatus(host(BOX, "box", { status: "incompatible", reason: "host-too-old" })),
    ).toEqual({ status: "failed", detail: "box can’t serve this app." });
    expect(waitingStatus(host(BOX, "box"))).toEqual({
      status: "connecting",
      detail: "Waiting for a link to box that carries its log…",
    });
    expect(waitingStatus(undefined)).toEqual({
      status: "connecting",
      detail: "Waiting for a link to This host that carries its log…",
    });
  });
});

/** The window's client as the relay reaches it, the test's to answer. */
function fakeRpc() {
  const opened: {
    input: Record<string, unknown>;
    onData(event: HostLinkRelayEvent): void;
    onError(error: unknown): void;
    unsubscribe: ReturnType<typeof vi.fn>;
  }[] = [];
  const queries: unknown[] = [];
  const rpc = {
    hostLink: {
      query: {
        query: async (input: unknown) => {
          queries.push(input);
          return { entries: [], gap: false, cursor: "r:1" };
        },
      },
      mutate: { mutate: async () => undefined },
      subscribe: {
        subscribe: (input: Record<string, unknown>, options: Record<string, unknown>) => {
          const unsubscribe = vi.fn();
          opened.push({
            input,
            onData: options["onData"] as (event: HostLinkRelayEvent) => void,
            onError: options["onError"] as (error: unknown) => void,
            unsubscribe,
          });
          return { unsubscribe };
        },
      },
    },
  };
  // The test's fake of the window's client: only the relay's slice.
  return { rpc: rpc as unknown as RelayHostLinkRpc, opened, queries };
}

describe("a Workspace's relayed link as a log source reads it", () => {
  const openState = { getState: () => OPEN, subscribe: () => () => undefined };

  it("queries and follows over the relay, and says when the link's budget makes the follow wait", async () => {
    const { rpc, opened, queries } = fakeRpc();
    const link = relayLogLink("ws-1", {
      rpc,
      state: openState,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    expect(await link.query("logs.tail", { limit: 500 })).toMatchObject({ cursor: "r:1" });
    expect(queries).toEqual([{ workspaceId: "ws-1", path: "logs.tail", input: { limit: 500 } }]);
    const seen: unknown[] = [];
    const subscription = link.subscribe(
      "logs.follow",
      { after: "r:1" },
      {
        onData: (data) => void seen.push({ data }),
        onResnapshot: (error) => void seen.push({ resnapshot: readHostError(error).reason }),
        onError: (error) => void seen.push({ error: readHostError(error).reason }),
        onStarted: () => void seen.push("started"),
        onComplete: () => void seen.push("complete"),
        onLimited: (error) => void seen.push({ limited: readHostError(error).reason }),
      },
    );
    expect(opened[0]!.input).toEqual({
      workspaceId: "ws-1",
      path: "logs.follow",
      input: { after: "r:1" },
    });
    opened[0]!.onData({ kind: "started" });
    opened[0]!.onData({ kind: "data", data: { entries: [] }, id: "r:2" });
    opened[0]!.onData({
      kind: "error",
      error: { code: "TOO_MANY_REQUESTS", reason: "subscription-limit", message: "full" },
    });
    expect(seen).toEqual(["started", { data: { entries: [] } }, { limited: "subscription-limit" }]);
    subscription.unsubscribe();

    // Each ending reaches the source's own handler.
    const ends: unknown[] = [];
    const handlers = {
      onData: () => {},
      onResnapshot: () => void ends.push("resnapshot"),
      onError: () => void ends.push("error"),
    };
    link.subscribe("logs.follow", {}, handlers);
    opened[1]!.onData({
      kind: "resnapshot",
      error: { code: "CONFLICT", reason: "subscription-resnapshot-required", message: "again" },
    });
    link.subscribe("logs.follow", {}, handlers);
    opened[2]!.onData({ kind: "complete" });
    opened[2]!.onError(new Error("ignored after its end"));
    link.subscribe("logs.follow", {}, handlers);
    opened[3]!.onData({
      kind: "error",
      error: { code: "FORBIDDEN", reason: "verb-refused", message: "no" },
    });
    // Without the optional handlers, a start, an end and a wait are heard by no one.
    link.subscribe("logs.follow", {}, handlers);
    opened[4]!.onData({ kind: "started" });
    opened[4]!.onData({
      kind: "error",
      error: { code: "TOO_MANY_REQUESTS", reason: "subscription-limit", message: "full" },
    });
    link.subscribe("logs.follow", {}, handlers);
    opened[5]!.onData({ kind: "complete" });
    expect(ends).toEqual(["resnapshot", "error"]);
  });
});
