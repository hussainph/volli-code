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
  boardSyncTransport,
  createBoardClient,
  protocolBoardApi,
} from "../renderer/src/lib/board-protocol";
import { relayHostLink, type RelayLinkStateSource } from "../renderer/src/lib/relay-host-link";
import { BoardSync, type BoardSyncView } from "../renderer/src/stores/board-sync";
import type { HostLinkView } from "../renderer/src/stores/host-connection";
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

function boardOver(client: ReturnType<typeof createBoardClient>) {
  const record = {
    painted: null as Painted | null,
    projects: [] as Project[],
    planning: [] as { ticketId?: string; projectId?: string }[],
    failures: [] as string[],
  };
  const view: BoardSyncView = {
    paint: (_projectId, tickets) => void (record.painted = { tickets }),
    adoptProject: (project) => void record.projects.push(project),
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

    const api = protocolBoardApi(board, sync);
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
});
