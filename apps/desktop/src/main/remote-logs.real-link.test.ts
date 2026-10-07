// @vitest-environment node
/**
 * A remote host's log in the one log viewer, end to end over real links
 * (VC-712; exit criterion 6):
 *
 * - **the box:** the production host protocol listener, under hostd's own
 *   listener bounds (a 2 MiB frame, four streams per connection), serving the
 *   composed host router over a host handler map whose log is host-core's
 *   real ring, written through host-core's real logger, as hostd's is; two
 *   Workspaces, each behind a loopback route this test can cut;
 * - **desktop main:** VC-670's `createHostLink` per Workspace, the relay over
 *   them (`createHostLinkRelay`) in the desktop's own handler map, and main's
 *   real generic IPC bridge behind a fake `ipcMain`;
 * - **the window:** the bridge's real client link, a host-connection state
 *   fed by those links' own states, and the viewer's registration
 *   (`attachRemoteLogSources`) with the relayed link (`relayLogLink`), read
 *   as the viewer reads a source.
 *
 * It proves the tail and follow of 600 lines of 5 KiB (inside the frame, with
 * a gap) and of non-ASCII lines; registration on a ready granted link, the
 * switch to the other Workspace's link when the one in use closes, the dot
 * through a drop, and unregistration when the host loses its links or is
 * forgotten; and a polled tail when every link is full (AM1).
 */
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";

import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import { createLogger, createLogRing, type Logger } from "@volli/host-core/log";
import {
  createHostLink,
  type HostLink,
  type HostLinkState,
} from "@volli/host-protocol/client-link";
import { ipcLink, type IpcEvent, type IpcResponse } from "@volli/host-protocol/ipc";
import { createHostRouter, RpcDiagnosticLog, type DesktopIpcRouter } from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  type HostLogEntry,
} from "@volli/shared";
import { createTRPCClient } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  LOG_SOURCE_POLLING,
  remoteLogSources,
  type HostLinkLogSourceTiming,
  type LogSource,
  type LogSourceStatus,
} from "../renderer/src/components/logs/log-sources";
import {
  attachRemoteLogSources,
  relayLogLink,
} from "../renderer/src/components/logs/remote-log-sources";
import type {
  HostConnectionState,
  HostLinkView,
  HostRecord,
  ProjectLink,
} from "../renderer/src/stores/host-connection";
import { createHostLinkRelay } from "./host-link-relay";
import { REMOTE_HOST_LINK_FEATURES } from "./remote-hosts";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      void electron.handlers.set(channel, handler),
    on: (channel: string, listener: (...args: unknown[]) => unknown) =>
      void electron.listeners.set(channel, listener),
  },
}));

/** Two projects on the box, each its own Workspace and link. */
const ALPHA = "1a1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const BETA = "2b1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const MIB = 1024 * 1024;

/** hostd's listener bounds (`apps/hostd/src/host-protocol.ts`, `HOSTD_LISTENER_LIMITS`). */
const HOSTD_LIMITS = {
  maxConnections: 32,
  handshakeBurst: 32,
  handshakesPerSecond: 16,
  maxSubscriptions: 4,
  maxFrameBytes: 2 * MIB,
  maxReplayBytes: 1.5 * MIB,
  maxOutboundBytes: 4 * MIB,
  maxInboundBytes: 1 * MIB,
};

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  electron.handlers.clear();
  electron.listeners.clear();
});

// ---- the box -------------------------------------------------------------------

/** A hostd-shaped box: its log is host-core's ring, written through its logger. */
async function box(features: readonly string[]) {
  const ring = createLogRing();
  const log: Logger = createLogger({ level: "debug", sink: ring, component: "hostd" });
  const map = createHostHandlers(
    { events: { publish() {} }, attention: { deliver: () => ({}) } } as never,
    {
      db: null,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: { kind: "degraded" } as never,
      busyWorktreeSites: async () => [],
      logs: ring,
    },
  );
  // Scripted Session streams: open and quiet until let go, which is all a
  // stream budget needs to count.
  const sessionStreams = new Set<string>();
  const handlers = {
    ...admittedHandlers(map, ROUTER_POLICY),
    "session.projection": async () => ({ throughSequence: 0 }),
    "session.subscribe": async ({ sessionId }: { sessionId: string }) => {
      sessionStreams.add(sessionId);
      return () => void sessionStreams.delete(sessionId);
    },
  };
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST, version: "remote-logs-real-link" },
    features,
    workspace: (id) => (id === ALPHA || id === BETA ? { id, epoch: 1 } : null),
    verifier: {
      verify: ({ credential, workspaceId }) =>
        credential === `device:${workspaceId}`
          ? { actor: { kind: "device", deviceId: DEVICE, workspaceId }, current: () => true }
          : null,
    },
    context: () => ({
      handlers: handlers as never,
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: () => ALPHA,
    }),
    limits: HOSTD_LIMITS,
  });
  cleanups.push(() => listener.close());
  return { ring, log, url: listener.url, sessionStreams };
}

/** A loopback TCP route in front of the box that this test can cut (the tunnel). */
async function cuttableRoute(target: string) {
  const { hostname, port } = new URL(target);
  const sockets = new Set<Socket>();
  let blocked = false;
  const server: Server = createServer((client) => {
    if (blocked) {
      client.destroy();
      return;
    }
    const upstream = connect(Number(port), hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    cut(): void {
      blocked = true;
      for (const socket of sockets) socket.destroy();
    },
    unblock(): void {
      blocked = false;
    },
  };
}

// ---- desktop main --------------------------------------------------------------

function workspaceLink(url: string, workspaceId: string, features: readonly string[]): HostLink {
  const link = createHostLink({
    url,
    workspaceId,
    client: { kind: "desktop", version: "remote-logs-real-link" },
    features: features as never,
    credential: () => `device:${workspaceId}`,
    timing: { backoffBaseMs: 20, backoffCapMs: 40 },
  });
  cleanups.push(() => link.close());
  return link;
}

function untilState(link: HostLink, status: HostLinkState["status"]): Promise<void> {
  if (link.getState().status === status) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`never ${status}: ${link.getState().status}`)),
      5_000,
    );
    const stop = link.subscribeState((state) => {
      if (state.status !== status) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

/** Main: the relay over the engine's links, in the desktop's own map, behind the real bridge. */
async function desktopMain(links: ReadonlyMap<string, HostLink>) {
  const relay = createHostLinkRelay({
    workspaceLink: (workspaceId) => {
      const link = links.get(workspaceId);
      return link?.getState().status === "ready" ? link : null;
    },
    serves: (workspaceId) => links.has(workspaceId),
  });
  const map = createHostHandlers(
    { events: { publish() {} }, attention: { deliver: () => ({}) } } as never,
    {
      db: null,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: { kind: "degraded" } as never,
      busyWorktreeSites: async () => [],
      hostLinkRelay: relay,
    },
  );
  const { registerSessionRpcIpcHandlers } = await import("./session-rpc-ipc");
  const registration = registerSessionRpcIpcHandlers({
    handlers: admittedHandlers(map, ROUTER_POLICY),
  });
  cleanups.push(() => registration.close());
  return {
    relay,
    invoke: electron.handlers.get(SESSION_RPC_IPC_CHANNEL)!,
    cancel: electron.listeners.get(SESSION_RPC_CANCEL_CHANNEL)!,
  };
}

// ---- the window ----------------------------------------------------------------

let senders = 1;

/** A window's bridge client over main's real handlers. */
function windowClient(main: Awaited<ReturnType<typeof desktopMain>>) {
  const pushes = new Set<(event: IpcEvent) => void>();
  const sender = {
    id: senders++,
    isDestroyed: () => false,
    send: (channel: string, event: IpcEvent) => {
      expect(channel).toBe(SESSION_RPC_EVENT_CHANNEL);
      const copy = structuredClone(event);
      queueMicrotask(() => {
        for (const push of pushes) push(copy);
      });
    },
    once: () => {},
    on: () => {},
    removeListener: () => {},
  };
  return createTRPCClient<DesktopIpcRouter>({
    links: [
      ipcLink<DesktopIpcRouter>({
        request: async (request) =>
          structuredClone((await main.invoke({ sender }, structuredClone(request))) as IpcResponse),
        onEvent: (listener) => {
          pushes.add(listener);
          return () => void pushes.delete(listener);
        },
        cancel: (subscriptionId) => void main.cancel({ sender }, subscriptionId),
      }),
    ],
  });
}

const OFFLINE: HostLinkView = { status: "offline", since: 0, retryAt: null };

/**
 * The window's host-connection state, from main's links as its snapshot
 * says them (VC-700's engine, VC-576's mapping): a ready link is open and
 * names what it granted; a closed one is offline for good; anything else is
 * on its way back.
 */
function hostConnection(links: ReadonlyMap<string, HostLink>) {
  const listeners = new Set<() => void>();
  let forgotten = false;
  const views = new Map<string, ProjectLink>();
  let state: Pick<HostConnectionState, "hosts" | "projects">;
  const viewOf = (link: HostLink): ProjectLink => {
    const current = link.getState();
    if (current.status === "ready") {
      return { hostId: HOST, link: { status: "open" }, granted: current.welcome.features };
    }
    return {
      hostId: HOST,
      link: current.status === "closed" ? OFFLINE : { status: "reconnecting" },
    };
  };
  const compute = (): void => {
    const projects: Record<string, ProjectLink> = {};
    for (const [workspaceId, link] of links) {
      const next = viewOf(link);
      const before = views.get(workspaceId);
      // An unchanged project keeps its object, as the store's does.
      projects[workspaceId] =
        before !== undefined &&
        before.link.status === next.link.status &&
        before.granted === next.granted
          ? before
          : next;
      views.set(workspaceId, projects[workspaceId]!);
    }
    const all = Object.values(projects);
    const host: HostRecord = {
      id: HOST,
      name: "box",
      local: false,
      os: "linux",
      version: "remote-logs-real-link",
      link: all.some((claim) => claim.link.status === "open")
        ? { status: "open" }
        : all.every((claim) => claim.link.status === "offline")
          ? OFFLINE
          : { status: "reconnecting" },
      liveSessions: null,
      update: null,
      expiredSignIns: [],
    };
    state = forgotten ? { hosts: [], projects: {} } : { hosts: [host], projects };
  };
  compute();
  const changed = (): void => {
    compute();
    for (const listener of Array.from(listeners)) listener();
  };
  for (const link of links.values()) cleanups.push(link.subscribeState(changed));
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    forget(): void {
      forgotten = true;
      changed();
    },
    /** A project's link as `relayHostLink` reads it. */
    projectState: (workspaceId: string) => ({
      getState: () => state.projects[workspaceId]?.link ?? OFFLINE,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    }),
  };
}

/** What a viewer holds of one source: its lines, the gaps it heard, and its dot. */
function read(source: LogSource) {
  const lines: HostLogEntry[] = [];
  const batches: { count: number; gap: boolean }[] = [];
  const statuses: { status: LogSourceStatus; detail?: string }[] = [];
  const stop = source.start({
    onLines: (entries, gap) => {
      lines.push(...entries);
      batches.push({ count: entries.length, gap });
    },
    onStatus: (status, detail) =>
      void statuses.push({ status, ...(detail === undefined ? {} : { detail }) }),
  });
  cleanups.push(stop);
  return {
    lines,
    batches,
    statuses,
    stop,
    msgs: () => lines.map(({ record }) => record.msg),
    status: () => statuses.at(-1)?.status,
  };
}

/**
 * One line of about 5 KiB of UTF-8, as a verbose host writes one: a short
 * message and payload fields (each field is bounded in characters by the
 * logger, so the bytes are spread across a few), in `glyph`.
 */
function wide(index: number, glyph = "x"): { msg: string; fields: Record<string, string> } {
  const perGlyph = Buffer.byteLength(glyph);
  const fields: Record<string, string> = {};
  let left = Math.floor((5 * 1024) / perGlyph);
  for (let field = 0; left > 0; field += 1) {
    const take = Math.min(left, Math.floor(1_900 / glyph.length));
    fields[`part${field}`] = glyph.repeat(take);
    left -= take;
  }
  return { msg: `n${index}`, fields };
}

/** The whole path for a box serving both Workspaces. */
async function remoteHost(options: {
  features?: readonly string[];
  linkFeatures?: readonly string[];
  workspaces?: readonly string[];
  timing?: HostLinkLogSourceTiming;
}) {
  const features = options.features ?? ["host.logs", "sessions.subscribe"];
  const host = await box(features);
  const routes = new Map<string, Awaited<ReturnType<typeof cuttableRoute>>>();
  const links = new Map<string, HostLink>();
  for (const workspaceId of options.workspaces ?? [ALPHA]) {
    const route = await cuttableRoute(host.url);
    routes.set(workspaceId, route);
    const link = workspaceLink(
      route.url,
      workspaceId,
      options.linkFeatures ?? REMOTE_HOST_LINK_FEATURES,
    );
    links.set(workspaceId, link);
    await untilState(link, "ready");
  }
  const main = await desktopMain(links);
  const client = windowClient(main);
  const hosts = hostConnection(links);
  const detach = attachRemoteLogSources({
    hosts,
    link: (workspaceId) =>
      relayLogLink(workspaceId, {
        rpc: client,
        state: hosts.projectState(workspaceId),
        resumeDelaysMs: [10, 20],
      }),
    ...(options.timing === undefined ? {} : { timing: options.timing }),
  });
  cleanups.push(detach);
  return { host, routes, links, main, client, hosts, detach };
}

describe("a remote host's log in the one viewer, over the relay and real links (VC-712)", () => {
  it("tails 600 lines of 5 KiB inside hostd's frame, with a gap, then follows ASCII and non-ASCII lines", async () => {
    const { host, links, main } = await remoteHost({});
    for (let index = 0; index < 600; index += 1) {
      const line = wide(index);
      host.log.info(line.msg, line.fields);
    }
    // Each line is about 5 KiB of JSON: 500 of them would pass the 2 MiB frame.
    expect(host.ring.size().bytes / 600).toBeGreaterThan(5 * 1024);
    // Registered, by the host's name, from its one ready link that grants host.logs.
    expect(remoteLogSources().map(({ id, label }) => [id, label])).toEqual([[HOST, "box"]]);
    const viewer = read(remoteLogSources()[0]!);
    await vi.waitFor(() => expect(viewer.batches.length).toBeGreaterThan(0));
    // The tail did not fail on the frame: the newest lines that fit, and the gap.
    const [tail] = viewer.batches;
    expect(tail!.gap).toBe(true);
    expect(tail!.count).toBeGreaterThan(350);
    expect(tail!.count).toBeLessThan(500);
    expect(viewer.msgs().at(-1)).toBe("n599");
    await vi.waitFor(() => expect(main.relay.open(ALPHA)).toBe(1));
    expect(viewer.status()).toBe("live");

    // Followed: non-ASCII lines (two-, three- and four-byte glyphs) of about 5 KiB each.
    const glyphs = ["ü", "語", "🚀"];
    for (const [index, glyph] of glyphs.entries()) {
      const line = wide(1_000 + index, glyph);
      host.log.warn(`${line.msg} ${glyph}`, line.fields);
    }
    await vi.waitFor(() =>
      expect(viewer.msgs().slice(-3)).toEqual(["n1000 ü", "n1001 語", "n1002 🚀"]),
    );
    // Byte for byte as the box wrote them.
    expect(viewer.lines.slice(-3).map(({ record }) => record["part0"])).toEqual(
      glyphs.map((glyph, index) => wide(1_000 + index, glyph).fields["part0"]),
    );

    // A burst far past one frame in one turn: the newest within the frame, a
    // gap, and the connection is still up (no frame past 2 MiB was sent).
    for (let index = 0; index < 600; index += 1) {
      const line = wide(2_000 + index, "é");
      host.log.info(line.msg, line.fields);
    }
    await vi.waitFor(() => expect(viewer.msgs().at(-1)).toBe("n2599"));
    expect(viewer.batches.at(-1)!.gap).toBe(true);
    host.log.info("after the burst");
    await vi.waitFor(() => expect(viewer.msgs().at(-1)).toBe("after the burst"));
    expect(links.get(ALPHA)!.getState().status).toBe("ready");
    expect(viewer.status()).toBe("live");
    // Each line arrived once.
    expect(new Set(viewer.lines.map(({ cursor }) => cursor)).size).toBe(viewer.lines.length);
  });

  it("switches to the host's other link when the one in use closes, and unregisters when it loses them", async () => {
    const { host, links, main } = await remoteHost({ workspaces: [ALPHA, BETA] });
    host.log.info("first");
    const viewer = read(remoteLogSources()[0]!);
    await vi.waitFor(() => expect(viewer.msgs()).toContain("first"));
    // The least loaded first: neither is shown, so the first by id.
    await vi.waitFor(() => expect(main.relay.open(ALPHA)).toBe(1));
    expect(main.relay.open(BETA)).toBe(0);

    links.get(ALPHA)!.close();
    host.log.info("while switching");
    await vi.waitFor(() => expect(main.relay.open(BETA)).toBe(1));
    await vi.waitFor(() => expect(viewer.msgs()).toContain("while switching"));
    expect(main.relay.open(ALPHA)).toBe(0);
    host.log.info("over the other link");
    await vi.waitFor(() => expect(viewer.msgs().at(-1)).toBe("over the other link"));
    // Still registered: the host has a link.
    expect(remoteLogSources()).toHaveLength(1);
    expect(viewer.status()).toBe("live");

    links.get(BETA)!.close();
    await vi.waitFor(() => expect(remoteLogSources()).toEqual([]));
    expect(main.relay.open()).toBe(0);
    expect(new Set(viewer.msgs()).size).toBe(viewer.msgs().length);
  });

  it("shows a drop on the dot, resumes after its last line, and unregisters a forgotten host", async () => {
    const { host, routes, links, hosts } = await remoteHost({});
    const viewer = read(remoteLogSources()[0]!);
    host.log.info("before the drop");
    await vi.waitFor(() => expect(viewer.msgs()).toContain("before the drop"));
    await vi.waitFor(() => expect(viewer.status()).toBe("live"));

    routes.get(ALPHA)!.cut();
    await untilState(links.get(ALPHA)!, "unreachable");
    await vi.waitFor(() =>
      expect(viewer.statuses.at(-1)).toEqual({
        status: "connecting",
        detail: "Reconnecting to box…",
      }),
    );
    // Registered still: the host dropped, it did not lose its link.
    expect(remoteLogSources()).toHaveLength(1);
    host.log.info("while away");
    routes.get(ALPHA)!.unblock();
    await untilState(links.get(ALPHA)!, "ready");
    await vi.waitFor(() => expect(viewer.msgs()).toContain("while away"), { timeout: 5_000 });
    await vi.waitFor(() => expect(viewer.status()).toBe("live"));
    expect(viewer.msgs().filter((msg) => msg === "before the drop")).toHaveLength(1);

    hosts.forget();
    expect(remoteLogSources()).toEqual([]);
  });

  it("never registers a host whose links do not grant host.logs", async () => {
    // An older box: no log to offer.
    await remoteHost({ features: ["sessions.subscribe"] });
    expect(remoteLogSources()).toEqual([]);
  });

  // AM1: the follow is background; when every link of the host is full of
  // foreground streams the source reads by polling, never blank, and streams
  // again once a slot frees.
  it("polls the newest lines while the host's link is full, then streams again", async () => {
    const { host, main, client } = await remoteHost({
      linkFeatures: [...REMOTE_HOST_LINK_FEATURES, "sessions.subscribe"],
      timing: { pollMs: 20, pollsPerFollowRetry: 3 },
    });
    // Four chats fill the link (foreground).
    const chat = (sessionId: string) =>
      client.hostLink.subscribe.subscribe(
        { workspaceId: ALPHA, path: "session.subscribe", input: { sessionId } },
        { onData() {} },
      );
    const chats = ["s1", "s2", "s3", "s4"].map(chat);
    await vi.waitFor(() => expect(host.sessionStreams.size).toBe(4));
    expect(main.relay.open(ALPHA)).toBe(4);

    host.log.info("tail");
    const viewer = read(remoteLogSources()[0]!);
    await vi.waitFor(() =>
      expect(viewer.statuses.at(-1)).toEqual({ status: "live", detail: LOG_SOURCE_POLLING }),
    );
    host.log.info("polled");
    await vi.waitFor(() => expect(viewer.msgs()).toContain("polled"));
    expect(main.relay.open(ALPHA)).toBe(4);

    // A chat closes: the next ask for a stream takes the slot.
    chats[0]!.unsubscribe();
    await vi.waitFor(() => expect(host.sessionStreams.size).toBe(3));
    await vi.waitFor(() => expect(main.relay.open(ALPHA)).toBe(4), { timeout: 5_000 });
    await vi.waitFor(() => expect(viewer.statuses.at(-1)).toEqual({ status: "live" }));
    host.log.info("streamed");
    await vi.waitFor(() => expect(viewer.msgs().at(-1)).toBe("streamed"));
    expect(new Set(viewer.msgs()).size).toBe(viewer.msgs().length);
    for (const subscription of chats.slice(1)) subscription.unsubscribe();
  });
});
