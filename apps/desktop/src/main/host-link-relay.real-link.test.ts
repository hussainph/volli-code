// @vitest-environment node
/**
 * A remote project's board through the Workspace link relay, end to end over
 * a real link (VC-711):
 *
 * - **the box:** the production host protocol listener serving the composed
 *   host router over one host handler map and a test database (VC-1 seeded),
 *   granting `board.read` and `board.write`, behind a loopback TCP route this
 *   test can cut;
 * - **desktop main:** VC-670's `createHostLink` to it, the relay over that
 *   link (`createHostLinkRelay`), the desktop's own handler map holding it,
 *   and main's real generic IPC bridge registration (`registerSessionRpcIpcHandlers`)
 *   behind a fake `ipcMain`;
 * - **the window:** the generic bridge's real client link, the renderer's
 *   `relayHostLink`, and `createBoardClient(hostLinkTrpcLink(relay))` under
 *   the board's own sync engine (`BoardSync`) and facade.
 *
 * It proves the board round trip (read, create, move, comment, another
 * writer's change on the feed), that a link drop ends main's relayed stream
 * with a typed `lost` and the window's subscription resumes after reconnect,
 * that the window going ends main's streams, and that an operation the
 * welcome did not grant is refused typed. Nothing real signs in or connects
 * outward: every port is loopback.
 */
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";

import { boardResourceWorkspace, createBoardChangeFeed } from "@volli/host-core/board";
import { getTicketRow, insertProject, insertTicket, listComments } from "@volli/host-core/db";
import {
  ADMITTED,
  admittedHandlers,
  createHostHandlers,
  invokeHandler,
  ROUTER_POLICY,
  type HostHandlerMap,
} from "@volli/host-core/handlers";
import { openTestDb, testProject, testTicket } from "@volli/host-core/testing";
import { createLogRing } from "@volli/host-core/log";
import { runGitCapturing, runGitCapturingAsync } from "@volli/host-core/worktree";
import { readHostError } from "@volli/host-protocol";
import {
  createHostLink,
  hostLinkTrpcLink,
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
  HOST_LINK_RELAY_STREAMS_PER_LINK,
  type DataChangeScope,
  type HostLinkRelayEvent,
  type Project,
  type Ticket,
} from "@volli/shared";
import { createTRPCClient } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  boardApi,
  boardProtocol,
  boardSyncTransport,
  createBoardClient,
  protocolBoardApi,
  remoteAwareBoardClients,
  startBoardProtocol,
  stopBoardProtocol,
  type BoardClient,
} from "../renderer/src/lib/board-protocol";
import { relayHostLink, type RelayLinkStateSource } from "../renderer/src/lib/relay-host-link";
import { restoreRemoteSelection } from "../renderer/src/lib/restore-remote-selection";
import type { RemoteSelection } from "../renderer/src/stores/projects";
import { BoardSync, type BoardSyncView } from "../renderer/src/stores/board-sync";
import type { HostLinkView } from "../renderer/src/stores/host-connection";
import { followRemoteClaims } from "../renderer/src/lib/follow-remote-projects";
import { createRemoteBoardAvailabilityStore } from "../renderer/src/stores/remote-board-availability";
import { createHostLinkRelay, RELAY_LINK_FULL, RELAY_YIELDED } from "./host-link-relay";

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

/** The remote project: its own Workspace on the box. */
const PROJECT = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const CREDENTIAL = "relay-real-link-credential";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  electron.handlers.clear();
  electron.listeners.clear();
});

// ---- the box -------------------------------------------------------------------

interface Box {
  readonly map: HostHandlerMap;
  readonly db: ReturnType<typeof openTestDb>["db"];
  readonly url: string;
  /** Each open Session stream on the box, by Session and operation. */
  readonly sessionStreams: Set<string>;
  /** Streams the box's listener holds open now, across every connection. */
  streams(): number;
}

/** What the box offers; an older box offers less. */
const EVERY_FEATURE = [
  "board.read",
  "board.write",
  "sessions.subscribe",
  "sessions.queue",
  "host.logs",
] as const;

async function box(features: readonly string[] = EVERY_FEATURE): Promise<Box> {
  const ctx = openTestDb();
  cleanups.push(() => ctx.cleanup());
  insertProject(
    ctx.db,
    testProject({ id: PROJECT, name: "On the box", ticketPrefix: "BX", path: "/srv/repo" }),
  );
  insertTicket(
    ctx.db,
    testTicket(PROJECT, {
      id: "ticket-1",
      ticketNumber: 1,
      title: "Seeded on the box",
      status: "todo",
      order: 0,
      createdAt: 1_000,
    }),
  );
  const feed = createBoardChangeFeed({
    projectOfTicket: (ticketId) => getTicketRow(ctx.db, ticketId)?.project_id,
    workspaces: () => [PROJECT],
  });
  let clock = 10_000;
  const map = createHostHandlers(
    {
      events: {
        publish: (topic: string, payload: unknown) => {
          if (topic === "data-changed") feed.noteDataChanged(payload as DataChangeScope);
        },
      },
      attention: { deliver: () => ({ delivered: true }), focusedSessionIds: () => new Set() },
    } as unknown as Parameters<typeof createHostHandlers>[0],
    {
      db: ctx.db,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: {
        kind: "live",
        execution: { kind: "unavailable", pendingArmedRuns: { noteDeliberateMove: () => {} } },
      } as unknown as Parameters<typeof createHostHandlers>[1]["automations"],
      busyWorktreeSites: async () => [],
      boardFeed: feed,
      logs: createLogRing(),
      now: () => (clock += 1),
      worktree: { db: ctx.db, git: runGitCapturing, gitAsync: runGitCapturingAsync, blobsRoot: "" },
    },
  );
  // The box's Sessions are scripted: a stream stays open and quiet until it
  // is let go, which is all a stream budget needs to count.
  const sessionStreams = new Set<string>();
  const sessionStream =
    (key: string) =>
    async ({ sessionId }: { sessionId: string }): Promise<() => void> => {
      const name = `${key}:${sessionId}`;
      sessionStreams.add(name);
      return () => void sessionStreams.delete(name);
    };
  const handlers = {
    ...admittedHandlers(map, ROUTER_POLICY),
    "session.projection": async () => ({ throughSequence: 0 }),
    "session.subscribe": sessionStream("session.subscribe"),
    "session.subscribeQueue": sessionStream("session.subscribeQueue"),
  };
  const boardWorkspace = boardResourceWorkspace(ctx.db);
  const diagnostics = new RpcDiagnosticLog();
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST, version: "relay-real-link" },
    // hostd's own stream budget per connection (`HOSTD_LISTENER_LIMITS`),
    // which the relay's per-link budget is pinned to by hostd's test.
    limits: { maxSubscriptions: HOST_LINK_RELAY_STREAMS_PER_LINK },
    features,
    workspace: (id) => (id === PROJECT ? { id, epoch: 1 } : null),
    verifier: {
      verify: ({ credential }) =>
        credential === CREDENTIAL
          ? {
              actor: { kind: "device", deviceId: DEVICE, workspaceId: PROJECT },
              current: () => true,
            }
          : null,
    },
    context: () => ({
      handlers: handlers as never,
      diagnostics,
      resourceWorkspace: (resource: { kind: string; id: string }) =>
        resource.kind === "session" ? PROJECT : boardWorkspace(resource),
    }),
  });
  cleanups.push(() => listener.close());
  return { map, db: ctx.db, url: listener.url, sessionStreams, streams: () => listener.streams };
}

/** A loopback TCP route in front of the box that this test can cut and block (the tunnel). */
async function cuttableRoute(initial: string) {
  let target = new URL(initial);
  const sockets = new Set<Socket>();
  let blocked = false;
  const server: Server = createServer((client) => {
    if (blocked) {
      client.destroy();
      return;
    }
    const upstream = connect(Number(target.port), target.hostname);
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
    /** New connections reach another listener: the box restarted on a newer hostd. */
    retarget(url: string): void {
      target = new URL(url);
    },
  };
}

// ---- desktop main --------------------------------------------------------------

function workspaceLink(url: string, features: readonly string[]): HostLink {
  const link = createHostLink({
    url,
    workspaceId: PROJECT,
    client: { kind: "desktop", version: "relay-real-link" },
    features: features as never,
    credential: () => CREDENTIAL,
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

/** Main: the relay over the engine's one link, in the desktop's own map, behind the real bridge. */
async function desktopMain(link: HostLink) {
  const relay = createHostLinkRelay({
    workspaceLink: (workspaceId) =>
      workspaceId === PROJECT && link.getState().status === "ready" ? link : null,
    serves: (workspaceId) => workspaceId === PROJECT,
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

/** A window: its WebContents as main sees it, and the bridge's real client link over it. */
function window(main: Awaited<ReturnType<typeof desktopMain>>) {
  const pushes = new Set<(event: IpcEvent) => void>();
  const gone = new Set<() => void>();
  let destroyed = false;
  const sender = {
    id: senders++,
    isDestroyed: () => destroyed,
    send: (channel: string, event: IpcEvent) => {
      expect(channel).toBe(SESSION_RPC_EVENT_CHANNEL);
      const copy = structuredClone(event);
      queueMicrotask(() => {
        for (const push of pushes) push(copy);
      });
    },
    once: (_event: string, listener: () => void) => void gone.add(listener),
    on: () => {},
    removeListener: (_event: string, listener: () => void) => void gone.delete(listener),
  };
  const client = createTRPCClient<DesktopIpcRouter>({
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
  return {
    client,
    /** The window goes: its WebContents is destroyed. */
    close(): void {
      destroyed = true;
      for (const listener of Array.from(gone)) listener();
      pushes.clear();
    },
  };
}

/** The project's link as the window's host-connection store reads it (main's snapshot, mapped). */
const viewOf = (state: HostLinkState): HostLinkView =>
  state.status === "ready" ? { status: "open" } : { status: "reconnecting" };

function storeState(link: HostLink): RelayLinkStateSource {
  let current = viewOf(link.getState());
  return {
    getState: () => current,
    subscribe: (listener) =>
      link.subscribeState((state) => {
        current = viewOf(state);
        listener();
      }),
  };
}

interface Painted {
  tickets: Ticket[];
}

function boardOver(
  client: ReturnType<typeof createBoardClient>,
  adoptProject: (project: Project) => void = () => {},
) {
  const record = {
    painted: null as Painted | null,
    projects: [] as Project[],
    planning: [] as { ticketId?: string; projectId?: string }[],
    failures: [] as string[],
  };
  const view: BoardSyncView = {
    paint: (_projectId, tickets) => void (record.painted = { tickets }),
    adoptProject: (project) => {
      record.projects.push(project);
      adoptProject(project);
    },
    notePlanningChange: (change) => void record.planning.push(change),
    checkoutMoved: () => {},
    failed: (message) => void record.failures.push(message),
  };
  const sync = new BoardSync({
    transport: boardSyncTransport(client),
    view,
    readCoalesceMs: 1,
    retryDelaysMs: [5],
    feedRetryDelaysMs: [5, 20],
  });
  cleanups.push(() => sync.closeAll());
  return { sync, record };
}

const titleOf = (record: { painted: Painted | null }, id: string) =>
  record.painted?.tickets.find((ticket) => ticket.id === id);

/** One whole path: the box, main's link and relay, and a window over it. */
async function remoteProject(features: readonly string[] = EVERY_FEATURE) {
  const host = await box(features);
  const route = await cuttableRoute(host.url);
  const link = workspaceLink(route.url, EVERY_FEATURE);
  await untilState(link, "ready");
  const main = await desktopMain(link);
  const win = window(main);
  const limited: { path: string; reason: string | undefined }[] = [];
  const relayed = relayHostLink(PROJECT, {
    rpc: win.client,
    state: storeState(link),
    resumeDelaysMs: [10, 20],
    onStreamLimited: ({ path, error }) => void limited.push({ path, reason: error.reason }),
  });
  const board = createBoardClient(hostLinkTrpcLink(relayed));
  return { host, route, link, main, win, relayed, board, limited };
}

/** A boot-pending window: real link transitions, in-memory selection and snapshot rows. */
function pendingRemoteWindow(link: HostLink) {
  const selection: RemoteSelection = { hostId: HOST, projectId: PROJECT, hostName: "saved-box" };
  const local = testProject({ id: "local-project", name: "On this Mac" });
  const listeners = new Set<() => void>();
  let hostListeners = 0;
  let state = {
    projects: [local],
    selectedProjectId: null as string | null,
    pendingRemoteSelection: selection as RemoteSelection | null,
    settleRemoteRestore: vi.fn((pending: RemoteSelection, restored: boolean) => {
      if (state.pendingRemoteSelection !== pending) return;
      state = {
        ...state,
        pendingRemoteSelection: null,
        selectedProjectId: restored ? pending.projectId : local.id,
      };
      for (const listener of listeners) listener();
    }),
  };
  // The registry's claim survives a tunnel outage. Both link views are fed by
  // subscribeState, not a manually advanced connection fixture.
  const hosts = {
    getState: () => ({
      hosts: [
        {
          id: HOST,
          name: "loopback-box",
          local: false,
          os: "linux" as const,
          version: "relay-real-link",
          link: viewOf(link.getState()),
          liveSessions: null,
          update: null,
          expiredSignIns: [],
        },
      ],
      projects: { [PROJECT]: { hostId: HOST, link: viewOf(link.getState()) } },
    }),
    subscribe: (listener: () => void) => {
      hostListeners += 1;
      const stop = link.subscribeState(() => listener());
      return () => {
        hostListeners -= 1;
        stop();
      };
    },
  };
  const projects = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    selection,
    hosts,
    projects,
    listenerCounts: () => [hostListeners, listeners.size],
    adoptProject(project: Project) {
      state = { ...state, projects: [...state.projects, project] };
      for (const listener of listeners) listener();
    },
    selectLocal() {
      state = { ...state, pendingRemoteSelection: null, selectedProjectId: local.id };
      for (const listener of listeners) listener();
    },
    localId: local.id,
  };
}

/** What main's relay says to a window's raw relayed stream, as it says it. */
function rawStream(win: ReturnType<typeof window>, input: { path: string; input: unknown }) {
  const events: HostLinkRelayEvent[] = [];
  let completed = false;
  const subscription = win.client.hostLink.subscribe.subscribe(
    { workspaceId: PROJECT, ...input },
    {
      onData: (event) => void events.push(event),
      onError: (error) => void events.push({ kind: "error", error: readHostError(error) }),
      onComplete: () => void (completed = true),
    },
  );
  cleanups.push(() => subscription.unsubscribe());
  return { events, completed: () => completed, subscription };
}

describe("a remote project's board through the relay, over a real link", () => {
  it("restores boot's pending remote selection only after a real reconnect and board row (VC-730)", async () => {
    const { route, link, board } = await remoteProject();
    route.cut();
    await untilState(link, "unreachable");
    const pending = pendingRemoteWindow(link);
    const failed = vi.fn();
    cleanups.push(restoreRemoteSelection({ ...pending, failed }));
    const { sync, record } = boardOver(board, pending.adoptProject);
    expect(pending.listenerCounts()).toEqual([1, 1]);
    expect(pending.projects.getState().selectedProjectId).toBeNull();

    route.unblock();
    await untilState(link, "ready");
    // The real welcome makes the matching claim reachable, but is not a row.
    expect(pending.projects.getState().pendingRemoteSelection).toBe(pending.selection);
    expect(pending.projects.getState().settleRemoteRestore).not.toHaveBeenCalled();
    await sync.open(PROJECT);
    expect(record.projects.map(({ id, name }) => [id, name])).toEqual([[PROJECT, "On the box"]]);
    expect(pending.projects.getState().selectedProjectId).toBe(PROJECT);
    expect(pending.projects.getState().pendingRemoteSelection).toBeNull();
    expect(pending.projects.getState().settleRemoteRestore).toHaveBeenCalledExactlyOnceWith(
      pending.selection,
      true,
    );
    expect(pending.listenerCounts()).toEqual([0, 0]);
    expect(failed).not.toHaveBeenCalled();
    expect(record.failures).toEqual([]);
  });

  it("a person's pick cancels restore before late real reconnect and snapshot results (VC-730)", async () => {
    const { route, link, board } = await remoteProject();
    route.cut();
    await untilState(link, "unreachable");
    const pending = pendingRemoteWindow(link);
    const failed = vi.fn();
    cleanups.push(restoreRemoteSelection({ ...pending, failed }));
    const { sync, record } = boardOver(board, pending.adoptProject);
    expect(pending.listenerCounts()).toEqual([1, 1]);

    pending.selectLocal();
    expect(pending.listenerCounts()).toEqual([0, 0]);
    route.unblock();
    await untilState(link, "ready");
    await sync.open(PROJECT);
    expect(record.projects.map(({ id }) => id)).toEqual([PROJECT]);
    expect(pending.projects.getState().projects.some(({ id }) => id === PROJECT)).toBe(true);
    expect(pending.projects.getState().selectedProjectId).toBe(pending.localId);
    expect(pending.projects.getState().pendingRemoteSelection).toBeNull();
    expect(pending.projects.getState().settleRemoteRestore).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(record.failures).toEqual([]);
  });

  it("a cut link's restore deadline falls back once and releases listeners before late rows (VC-730)", async () => {
    const { route, link, board } = await remoteProject();
    route.cut();
    await untilState(link, "unreachable");
    const pending = pendingRemoteWindow(link);
    const failed = vi.fn();
    cleanups.push(restoreRemoteSelection({ ...pending, failed, deadlineMs: 100 }));
    expect(pending.listenerCounts()).toEqual([1, 1]);
    await vi.waitFor(() =>
      expect(failed).toHaveBeenCalledExactlyOnceWith(
        "Couldn't reopen the project on loopback-box. Showing This Mac.",
      ),
    );
    expect(pending.projects.getState().selectedProjectId).toBe(pending.localId);
    expect(pending.projects.getState().pendingRemoteSelection).toBeNull();
    expect(pending.listenerCounts()).toEqual([0, 0]);

    route.unblock();
    await untilState(link, "ready");
    const { sync, record } = boardOver(board, pending.adoptProject);
    await sync.open(PROJECT);
    expect(record.projects.map(({ id }) => id)).toEqual([PROJECT]);
    expect(pending.projects.getState().selectedProjectId).toBe(pending.localId);
    expect(pending.projects.getState().settleRemoteRestore).toHaveBeenCalledExactlyOnceWith(
      pending.selection,
      false,
    );
    expect(pending.listenerCounts()).toEqual([0, 0]);
    expect(failed).toHaveBeenCalledOnce();
    expect(record.failures).toEqual([]);
  });

  it("reads, creates, moves and comments, and follows another writer on the feed", async () => {
    const { host, main, board } = await remoteProject();
    const { sync, record } = boardOver(board);

    await sync.open(PROJECT);
    expect(record.projects.map(({ id, name }) => [id, name])).toEqual([[PROJECT, "On the box"]]);
    expect(record.painted?.tickets.map(({ id }) => id)).toEqual(["ticket-1"]);
    await vi.waitFor(() => expect(main.relay.open()).toBe(1));

    const created = await sync.createTicket(PROJECT, {
      status: "todo",
      title: "Made on the box from this Mac",
      body: "Over the relay.",
    });
    expect(created).toMatchObject({ title: "Made on the box from this Mac", ticketNumber: 2 });
    expect(getTicketRow(host.db, created!.id)?.title).toBe("Made on the box from this Mac");

    await sync.moveTickets(PROJECT, [created!.id], "doing", 0);
    await vi.waitFor(() => expect(getTicketRow(host.db, created!.id)?.status).toBe("doing"));
    await vi.waitFor(() => expect(titleOf(record, created!.id)?.status).toBe("doing"));

    const api = protocolBoardApi(() => board, sync);
    expect(
      await api.comments.create({ ticketId: created!.id, body: "From this Mac" }),
    ).toMatchObject({ ok: true, comment: { body: "From this Mac" } });
    expect(listComments(host.db, created!.id).map(({ body }) => body)).toEqual(["From this Mac"]);
    expect(await api.comments.list({ ticketId: created!.id })).toMatchObject({
      ok: true,
      comments: [{ body: "From this Mac" }],
    });
    expect(await api.tickets.body({ ticketId: created!.id })).toEqual({
      ok: true,
      body: "Over the relay.",
    });

    // Another writer on the box (its agent socket): the change arrives on the
    // feed, relayed by main, and the board paints it.
    await invokeHandler(
      host.map,
      { door: "agent-socket", admit: () => ADMITTED },
      "ticket.move",
      { projectId: PROJECT, ticketId: "ticket-1", toStatus: "done" },
      { actor: { kind: "user" } },
    );
    await vi.waitFor(() => expect(titleOf(record, "ticket-1")?.status).toBe("done"));
    expect(record.failures).toEqual([]);
  });

  it("ends main's stream with a typed `lost` on a drop, and the window resumes after reconnect", async () => {
    const { host, route, link, main, win, board } = await remoteProject();
    const { sync, record } = boardOver(board);
    await sync.open(PROJECT);
    const snapshot = await board.board.snapshot.query({ projectId: PROJECT });
    const raw = rawStream(win, {
      path: "board.changes",
      input: { projectId: PROJECT, lastEventId: snapshot.cursor },
    });
    await vi.waitFor(() => expect(raw.events).toContainEqual({ kind: "started" }));
    expect(main.relay.open()).toBe(2);

    route.cut();
    await untilState(link, "unreachable");
    // Main's relayed streams end at once, typed, and are let go.
    await vi.waitFor(() =>
      expect(raw.events.at(-1)).toMatchObject({
        kind: "lost",
        error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable" },
      }),
    );
    await vi.waitFor(() => expect(raw.completed()).toBe(true));
    expect(main.relay.open()).toBe(0);
    // A call while it is down is refused at once, typed, never queued.
    expect(
      await board.board.roster.query({ projectId: PROJECT }).catch((error) => readHostError(error)),
    ).toMatchObject({ code: "SERVICE_UNAVAILABLE", reason: "host-unreachable" });

    // A change made on the box while this Mac is away.
    await invokeHandler(
      host.map,
      { door: "agent-socket", admit: () => ADMITTED },
      "ticket.move",
      { projectId: PROJECT, ticketId: "ticket-1", toStatus: "doing" },
      { actor: { kind: "user" } },
    );
    route.unblock();
    await untilState(link, "ready");
    // The window's subscription resumed through the relay after its cursor,
    // and the change made while away reached the board.
    await vi.waitFor(() => expect(titleOf(record, "ticket-1")?.status).toBe("doing"), {
      timeout: 5_000,
    });
    await vi.waitFor(() => expect(main.relay.open()).toBe(1));
    // And it keeps following: a change after the reconnect.
    const made = await sync.createTicket(PROJECT, { status: "todo", title: "After the drop" });
    await vi.waitFor(() => expect(titleOf(record, made!.id)?.title).toBe("After the drop"));
    expect(record.failures).toEqual([]);
  });

  it("ends every relayed stream in main and on the box when the window goes", async () => {
    const { host, link, main, win, board } = await remoteProject();
    const { sync } = boardOver(board);
    await sync.open(PROJECT);
    rawStream(win, { path: "board.changes", input: { projectId: PROJECT } });
    await vi.waitFor(() => expect(main.relay.open()).toBe(2));
    await vi.waitFor(() => expect(host.streams()).toBe(2));
    win.close();
    await vi.waitFor(() => expect(main.relay.open()).toBe(0));
    // And on the box: its streams are let go, its connection kept for the next window.
    await vi.waitFor(() => expect(host.streams()).toBe(0));
    expect(link.getState().status).toBe("ready");
  });

  it("refuses typed what the welcome did not grant, before it leaves this Mac", async () => {
    // An older box offers reads only.
    const { win, board } = await remoteProject(["board.read"]);
    expect((await board.board.snapshot.query({ projectId: PROJECT })).project.id).toBe(PROJECT);
    expect(
      await board.board.createTicket
        .mutate({
          commandId: "0f8fad5b-d9cb-469f-a165-70867728950e",
          projectId: PROJECT,
          status: "todo",
          title: "Refused",
        })
        .catch((error) => readHostError(error)),
    ).toEqual({
      code: "FORBIDDEN",
      message: "board.createTicket is not among the operations this project’s link may send.",
      reason: "verb-refused",
    });
    // Main's own sign-in operations never ride the relay.
    expect(
      await win.client.hostLink.query
        .query({ workspaceId: PROJECT, path: "signIns.status" })
        .catch((error) => readHostError(error)),
    ).toMatchObject({ reason: "verb-refused" });
    // A project no host here serves.
    expect(
      await win.client.hostLink.query
        .query({ workspaceId: "0f8fad5b-d9cb-469f-a165-70867728950e", path: "board.snapshot" })
        .catch((error) => readHostError(error)),
    ).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
  });
  // AM1: one Workspace link carries at most hostd's four streams. The board's
  // feed and each Session's own stream are foreground; a Session's queue and
  // the host's log yield. Nothing goes blank: a refused or yielded stream
  // waits for a slot and resumes when one frees.
  it("keeps board, two chats and logs on one link inside its budget, foreground first", async () => {
    const { host, main, relayed, board, limited } = await remoteProject();
    const { sync, record } = boardOver(board);
    await sync.open(PROJECT);
    const quiet = { onData() {}, onResnapshot() {}, onError: vi.fn() };
    const chat = (sessionId: string) => ({
      stream: relayed.subscribe("session.subscribe", { sessionId }, quiet),
      queue: relayed.subscribe("session.subscribeQueue", { sessionId }, quiet),
    });
    const first = chat("session-1");
    await vi.waitFor(() => expect(host.sessionStreams.size).toBe(2));
    const logs: unknown[] = [];
    const follow = relayed.subscribe(
      "logs.follow",
      {},
      { onData: (batch) => void logs.push(batch), onResnapshot() {}, onError: quiet.onError },
    );
    await vi.waitFor(() => expect(main.relay.open(PROJECT)).toBe(4));

    // A second chat: its stream takes the logs' slot; its queue waits.
    const second = chat("session-2");
    await vi.waitFor(() =>
      expect([...host.sessionStreams].toSorted()).toEqual([
        "session.subscribe:session-1",
        "session.subscribe:session-2",
        "session.subscribeQueue:session-1",
      ]),
    );
    await vi.waitFor(() =>
      expect(limited).toEqual(
        expect.arrayContaining([
          { path: "logs.follow", reason: "subscription-limit" },
          { path: "session.subscribeQueue", reason: "subscription-limit" },
        ]),
      ),
    );
    expect(main.relay.open(PROJECT)).toBe(4);
    // The board still follows its feed: it is foreground.
    const made = await sync.createTicket(PROJECT, { status: "todo", title: "While full" });
    await vi.waitFor(() => expect(titleOf(record, made!.id)?.title).toBe("While full"));
    // Nobody heard a failure: they wait, typed, for a slot.
    expect(quiet.onError).not.toHaveBeenCalled();
    expect(RELAY_YIELDED).not.toBe(RELAY_LINK_FULL);

    // The second chat closes: a waiting background stream gets its slot back.
    second.stream.unsubscribe();
    second.queue.unsubscribe();
    await vi.waitFor(
      () => {
        expect(main.relay.open(PROJECT)).toBe(4);
        expect(host.sessionStreams.has("session.subscribe:session-2")).toBe(false);
      },
      { timeout: 5_000 },
    );
    first.stream.unsubscribe();
    first.queue.unsubscribe();
    follow.unsubscribe();
    await vi.waitFor(() => expect(main.relay.open(PROJECT)).toBe(1));
    expect(record.failures).toEqual([]);
  });

  // VC-711 review B1: a view told its stream waits for a slot may close
  // itself (and free another) from inside the callback. Nothing it closed may
  // open on the box again, nor wait for a slot.
  it("opens nothing on the box for a stream its view cancelled inside onStreamLimited", async () => {
    const { host, link, win } = await remoteProject();
    const quiet = { onData() {}, onResnapshot() {}, onError() {} };
    const plain = relayHostLink(PROJECT, { rpc: win.client, state: storeState(link) });
    const first = ["one", "two", "three", "four"].map((id) =>
      plain.subscribe("session.subscribe", { sessionId: id }, quiet),
    );
    await vi.waitFor(() => expect(host.sessionStreams.size).toBe(4));
    expect(host.streams()).toBe(HOST_LINK_RELAY_STREAMS_PER_LINK);
    let fifth!: { unsubscribe(): void };
    const limited = vi.fn(() => {
      fifth.unsubscribe();
      first[0]!.unsubscribe();
    });
    const custom = relayHostLink(PROJECT, {
      rpc: win.client,
      state: storeState(link),
      resumeDelaysMs: [10],
      onStreamLimited: limited,
    });
    fifth = custom.subscribe("session.subscribe", { sessionId: "cancel-in-callback" }, quiet);
    await vi.waitFor(() => expect(limited).toHaveBeenCalledOnce());
    // Past the retry it would have made, and then some.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(limited).toHaveBeenCalledOnce();
    expect(host.sessionStreams.has("session.subscribe:cancel-in-callback")).toBe(false);
    expect([...host.sessionStreams].toSorted()).toEqual([
      "session.subscribe:four",
      "session.subscribe:three",
      "session.subscribe:two",
    ]);
    expect(host.streams()).toBe(3);
    for (const subscription of first) subscription.unsubscribe();
  });

  // VC-711 PR 2: the app's own routing. One sync engine, this Mac's projects
  // on the local client, the remote project on its Workspace link: created,
  // moved and commented through `boardApi()` and the engine, as the board
  // store and the ticket view do.
  it("routes a remote project's board through the app's per-project clients", async () => {
    const { host, win, link } = await remoteProject();
    const local = new Proxy({} as BoardClient, {
      get: () => {
        throw new Error("this Mac's client was asked about the remote project");
      },
    });
    const adopted: Project[] = [];
    const painted = new Map<string, Ticket[]>();
    const clientFor = remoteAwareBoardClients(local, {
      isRemote: (projectId) => projectId === PROJECT,
      remote: (projectId) =>
        createBoardClient(
          hostLinkTrpcLink(relayHostLink(projectId, { rpc: win.client, state: storeState(link) })),
        ),
    });
    const { sync } = startBoardProtocol({
      client: local,
      clientFor,
      view: {
        paint: (projectId, tickets) => void painted.set(projectId, tickets),
        adoptProject: (project) => void adopted.push(project),
        notePlanningChange: () => {},
        checkoutMoved: () => {},
        failed: (message) => {
          throw new Error(message);
        },
      },
      sync: { readCoalesceMs: 1, retryDelaysMs: [5], feedRetryDelaysMs: [5, 20] },
    });
    cleanups.push(() => stopBoardProtocol());
    await sync.open(PROJECT);
    expect(adopted.map(({ id, name }) => [id, name])).toEqual([[PROJECT, "On the box"]]);
    const made = await sync.createTicket(PROJECT, { status: "todo", title: "Routed to the box" });
    await sync.moveTickets(PROJECT, [made!.id], "done", 0);
    await vi.waitFor(() => expect(getTicketRow(host.db, made!.id)?.status).toBe("done"));
    expect(boardProtocol()?.sync).toBe(sync);
    expect(await boardApi().comments.create({ ticketId: made!.id, body: "Routed" })).toMatchObject({
      ok: true,
    });
    const listed = await boardApi().comments.list({ ticketId: made!.id });
    expect(listed).toMatchObject({ ok: true, comments: [{ body: "Routed" }] });
    const commentId = listed.ok ? listed.comments[0]!.id : "";
    expect(await boardApi().comments.update({ commentId, body: "Edited" })).toMatchObject({
      ok: true,
    });
    expect(listComments(host.db, made!.id).map(({ body }) => body)).toEqual(["Edited"]);
    await vi.waitFor(() =>
      expect(painted.get(PROJECT)?.find(({ id }) => id === made!.id)?.status).toBe("done"),
    );
  });

  // VC-711 PR 2 review B1: a write made for a remote Workspace keeps that
  // Workspace's host for every retry and ends with the Workspace. Once it
  // closes (its claim gone), nothing pending is ever sent to This Mac.
  it("never sends a pending remote write to This Mac after its Workspace closes", async () => {
    const { route, link, board } = await remoteProject();
    let claimed = true;
    const localCalls: string[] = [];
    const local = new Proxy({} as BoardClient, {
      get: (_target, area) =>
        new Proxy(
          {},
          {
            get: (_inner, procedure) => ({
              mutate: async () => {
                localCalls.push(`${String(area)}.${String(procedure)}`);
                throw { data: { hostError: { code: "NOT_FOUND", message: "Not this Mac's" } } };
              },
              query: async () => {
                localCalls.push(`${String(area)}.${String(procedure)}`);
                throw { data: { hostError: { code: "NOT_FOUND", message: "Not this Mac's" } } };
              },
            }),
          },
        ),
    });
    const { sync } = startBoardProtocol({
      client: local,
      clientFor: remoteAwareBoardClients(local, {
        isRemote: () => claimed,
        remote: () => board,
      }),
      view: {
        paint() {},
        adoptProject() {},
        notePlanningChange() {},
        checkoutMoved() {},
        failed() {},
      },
      sync: { retryDelaysMs: [20] },
    });
    cleanups.push(() => stopBoardProtocol());
    await sync.open(PROJECT);
    // A comment the facade has seen, so an edit and a removal can be placed.
    const seen = await boardApi().comments.create({ ticketId: "ticket-1", body: "Seen" });
    expect(seen.ok).toBe(true);
    const commentId = seen.ok ? seen.comment.id : "";
    route.cut();
    await untilState(link, "unreachable");
    const api = boardApi();
    const pending = [
      api.comments.create({ ticketId: "ticket-1", body: "Must stay remote" }),
      api.comments.update({ commentId, body: "Must stay remote" }),
      api.comments.remove({ commentId }),
      api.projects.update({ id: PROJECT, baseBranch: "main" }),
      api.projects.setSkillModes({ id: PROJECT, modes: {} }),
      api.projects.setSessionDefaults({ id: PROJECT, model: null }),
    ];
    // Retrying against the box, which is away.
    await new Promise((resolve) => setTimeout(resolve, 60));
    claimed = false;
    sync.close(PROJECT);
    const settled = await Promise.all(pending);
    for (const outcome of settled) expect(outcome.ok).toBe(false);
    // Past several retry delays: nothing reached This Mac, and nothing retries.
    await new Promise((resolve) => setTimeout(resolve, 100));
    route.unblock();
    await untilState(link, "ready");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(localCalls).toEqual([]);
  });

  // VC-711 PR 2 review B2: an older host grants no `board.read`. Its board
  // is asked once, said once in the host's name, and opened again only when
  // the host changes (here: restarted on a newer hostd that offers it).
  it("says once that an older host offers no board, and opens it once the host does", async () => {
    const older = await box([]);
    const route = await cuttableRoute(older.url);
    const link = workspaceLink(route.url, EVERY_FEATURE);
    await untilState(link, "ready");
    const main = await desktopMain(link);
    const win = window(main);
    const relayed = relayHostLink(PROJECT, { rpc: win.client, state: storeState(link) });
    let snapshots = 0;
    const counted = {
      ...relayed,
      query: (path: string, input?: unknown, options?: never) => {
        if (path === "board.snapshot") snapshots += 1;
        return relayed.query(path, input, options);
      },
    };
    const board = createBoardClient(hostLinkTrpcLink(counted));
    const adopted: Project[] = [];
    const { sync } = startBoardProtocol({
      client: board,
      clientFor: () => board,
      view: {
        paint() {},
        adoptProject: (project) => void adopted.push(project),
        notePlanningChange() {},
        checkoutMoved() {},
        failed() {},
      },
      sync: { feedRetryDelaysMs: [5] },
    });
    cleanups.push(() => stopBoardProtocol());
    // The host-connection store as the remote source feeds it: the project's
    // link, a new view object on every change.
    const listeners = new Set<(state: never) => void>();
    let hostState = {
      hosts: [{ id: HOST, name: "old-host", local: false }],
      projects: { [PROJECT]: { hostId: HOST, link: viewOf(link.getState()) } },
    };
    cleanups.push(
      link.subscribeState((state) => {
        hostState = {
          ...hostState,
          projects: { [PROJECT]: { hostId: HOST, link: viewOf(state) } },
        };
        for (const listener of listeners) listener(hostState as never);
      }),
    );
    const availability = createRemoteBoardAvailabilityStore();
    const stop = followRemoteClaims({
      sync,
      store: {
        getState: () => hostState as never,
        subscribe: (listener) => {
          listeners.add(listener as (state: never) => void);
          return () => void listeners.delete(listener as (state: never) => void);
        },
      },
      alive: () => true,
      availability: availability.getState(),
      drop: () => {},
    });
    cleanups.push(stop);

    await vi.waitFor(() =>
      expect(availability.getState().unavailable[PROJECT]).toBe(
        "The board isn’t available on old-host — update it to use it here",
      ),
    );
    // Asked once, and not again while nothing changed.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(snapshots).toBe(1);
    expect(adopted).toEqual([]);
    expect(sync.follows(PROJECT)).toBe(false);
    // Try again, by hand: asked once more, refused once more, still bounded.
    availability.getState().retry!(PROJECT);
    await vi.waitFor(() => expect(snapshots).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(snapshots).toBe(2);

    // The box is updated: hostd restarts with the board, and the link
    // reconnects to it with a new welcome.
    const newer = await box();
    route.retarget(newer.url);
    route.cut();
    await untilState(link, "unreachable");
    route.unblock();
    await untilState(link, "ready");
    await vi.waitFor(() => expect(adopted.map(({ id }) => id)).toEqual([PROJECT]));
    expect(availability.getState().unavailable[PROJECT]).toBeUndefined();
    expect(sync.follows(PROJECT)).toBe(true);
  });
});
