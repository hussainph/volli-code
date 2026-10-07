// @vitest-environment node
/**
 * The board (VC-565) is one code path for this Mac's in-process host and for
 * a remote one. One real host handler map over a test database, with a real
 * board change feed that the map's commands stamp and the host's event bus
 * feeds, is served through both production doors:
 *
 * - `electron-ipc`: main's real generic IPC bridge registration
 *   (`registerSessionRpcIpcHandlers`, which serves the board router beside
 *   the Session router, VC-608) behind a fake `ipcMain`, and the generic
 *   bridge's real client link, joined by `servedIpcContractLink` the way
 *   Electron joins them: structured clone both ways, pushes a microtask later;
 * - `websocket`: the production host protocol listener serving the composed
 *   host router (`board.read`/`board.write`, a verifier minting a device of
 *   the Workspace), reached by the client host link (`createHostLink`,
 *   `hostLinkTrpcLink`) and `createBoardClient`.
 *
 * Each door runs the same cases, through the same board client type and the
 * same sync engine (`BoardSync` over `boardSyncTransport`) and facade
 * (`protocolBoardApi`), and the doors must answer alike, modulo the ids and
 * feed cursors each fresh host mints.
 */
import { readHostError } from "@volli/host-protocol";
import type { IpcEvent, IpcPeer, IpcResponse } from "@volli/host-protocol/ipc";
import { servedIpcContractLink } from "@volli/host-protocol/testing";
import { createHostLink, hostLinkTrpcLink, type HostLink } from "@volli/host-protocol/client-link";
import {
  boardResourceWorkspace,
  createBoardChangeFeed,
  setTicketPriorityCommand,
  type BoardChangeFeed,
} from "@volli/host-core/board";
import {
  getTicketRow,
  insertProject,
  insertTicket,
  listComments,
  listLabelsByProject,
  listTicketRosterByProject,
} from "@volli/host-core/db";
import {
  ADMITTED,
  admittedHandlers,
  createHostHandlers,
  invokeHandler,
  ROUTER_POLICY,
  type HostHandlerMap,
} from "@volli/host-core/handlers";
import { openTestDb, testProject, testTicket, type TestDb } from "@volli/host-core/testing";
import { runGitCapturing, runGitCapturingAsync } from "@volli/host-core/worktree";
import { createHostRouter, RpcDiagnosticLog, type DesktopIpcRouter } from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import {
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  type DataChangeScope,
  type Label,
  type Project,
  type Ticket,
} from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  boardSyncTransport,
  createBoardClient,
  protocolBoardApi,
  type BoardClient,
} from "../renderer/src/lib/board-protocol";
import { BoardSync, type BoardSyncView } from "../renderer/src/stores/board-sync";

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

/** A Workspace id is a UUID on the wire; the project is its own Workspace. */
const PROJECT = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const CREDENTIAL = "board-contract-credential";
const BOARD_FEATURES = ["board.read", "board.write"] as const;
const COMMAND = "0f8fad5b-d9cb-469f-a165-70867728950e";
/** Every id a case states itself, kept as is when answers are compared. */
const STATED = new Set([PROJECT, COMMAND]);

// ---- the host ----------------------------------------------------------------

interface Host {
  readonly ctx: TestDb;
  readonly map: HostHandlerMap;
  readonly feed: BoardChangeFeed;
  /** The clock every handler reads: the same sequence on both doors. */
  now(): number;
}

/**
 * The host's one handler map over a fresh database: VC-1 alone in Todo, the
 * feed fed by the map's own stamps and by every other writer's `data-changed`
 * on the host's bus, as main and hostd wire it.
 */
function openHost(): Host {
  const ctx = openTestDb();
  insertProject(
    ctx.db,
    testProject({ id: PROJECT, name: "Board", ticketPrefix: "VC", path: "/repo/board" }),
  );
  insertTicket(
    ctx.db,
    testTicket(PROJECT, {
      id: "ticket-1",
      ticketNumber: 1,
      title: "Seeded",
      body: "The seeded card.",
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
  const now = () => (clock += 1);
  const ports = {
    events: {
      publish: (topic: string, payload: unknown) => {
        if (topic === "data-changed") feed.noteDataChanged(payload as DataChangeScope);
      },
    },
    attention: { deliver: () => ({ delivered: true }), focusedSessionIds: () => new Set() },
  } as unknown as Parameters<typeof createHostHandlers>[0];
  const map = createHostHandlers(ports, {
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
    now,
    worktree: { db: ctx.db, git: runGitCapturing, gitAsync: runGitCapturingAsync, blobsRoot: "" },
  });
  return { ctx, map, feed, now };
}

// ---- the doors ---------------------------------------------------------------

interface Opened {
  readonly client: BoardClient;
  close(): Promise<void>;
}

interface Door {
  readonly name: "electron-ipc" | "websocket";
  open(host: Host): Promise<Opened>;
}

interface FakeSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, event: IpcEvent): void;
  once(event: "destroyed", listener: () => void): void;
  on(event: string, listener: (...args: never[]) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
}

/** The WebContents Electron would hand main's handlers for this peer. */
function senderFor(peer: IpcPeer): FakeSender {
  const detach = new Map<() => void, () => void>();
  return {
    id: peer.id,
    isDestroyed: () => peer.isDestroyed(),
    send: (channel, event) => {
      expect(channel).toBe(SESSION_RPC_EVENT_CHANNEL);
      peer.send(event);
    },
    once: (_event, listener) => void detach.set(listener, peer.onDestroyed(listener)),
    on: () => {},
    removeListener: (_event, listener) => {
      detach.get(listener as () => void)?.();
      detach.delete(listener as () => void);
    },
  };
}

/** Main's real generic bridge and the generic bridge's real link (VC-608). */
const ipcLink = servedIpcContractLink<Host, DesktopIpcRouter>({
  async serve(host) {
    const { registerSessionRpcIpcHandlers } = await import("./session-rpc-ipc");
    // As main registers it: the map through the router's policy.
    const registration = registerSessionRpcIpcHandlers({
      handlers: admittedHandlers(host.map, ROUTER_POLICY),
    });
    const invoke = electron.handlers.get(SESSION_RPC_IPC_CHANNEL)!;
    const cancel = electron.listeners.get(SESSION_RPC_CANCEL_CHANNEL)!;
    const senders = new Map<IpcPeer, FakeSender>();
    const sender = (peer: IpcPeer): FakeSender => {
      const known = senders.get(peer) ?? senderFor(peer);
      senders.set(peer, known);
      return known;
    };
    return {
      request: async (peer, request) =>
        (await invoke({ sender: sender(peer) }, request)) as IpcResponse,
      cancel: (peer, subscriptionId) => void cancel({ sender: sender(peer) }, subscriptionId),
      close: () => registration.close(),
    };
  },
});

const electronIpc: Door = {
  name: "electron-ipc",
  async open(host) {
    const connection = await ipcLink.open(host);
    // The desktop window's client serves the board router beside the Session one.
    return { client: connection.client as unknown as BoardClient, close: () => connection.close() };
  },
};

/** The production listener, as hostd serves it, reached by the client host link. */
const webSocket: Door = {
  name: "websocket",
  async open(host) {
    const handlers = admittedHandlers(host.map, ROUTER_POLICY);
    const diagnostics = new RpcDiagnosticLog();
    const listener = await startHostProtocolListener({
      router: createHostRouter(),
      bind: { host: "127.0.0.1", port: 0 },
      host: { id: HOST, version: "board-contract" },
      features: BOARD_FEATURES,
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
        handlers,
        diagnostics,
        resourceWorkspace: boardResourceWorkspace(host.ctx.db),
      }),
    });
    const link = createHostLink({
      url: listener.url,
      workspaceId: PROJECT,
      client: { kind: "desktop", version: "board-contract" },
      features: BOARD_FEATURES,
      credential: () => CREDENTIAL,
    });
    try {
      await ready(link);
    } catch (error) {
      link.close();
      await listener.close();
      throw error;
    }
    return {
      client: createBoardClient(hostLinkTrpcLink(link)),
      async close() {
        link.close();
        await listener.close();
      },
    };
  },
};

function ready(link: HostLink): Promise<void> {
  if (link.getState().status === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The host link never became ready: ${link.getState().status}`)),
      5_000,
    );
    const stop = link.subscribeState((state) => {
      if (state.status === "ready") {
        clearTimeout(timer);
        stop();
        resolve();
      } else if (state.status === "refused" || state.status === "fenced") {
        clearTimeout(timer);
        stop();
        reject(new Error(`The host link was ${state.status}: ${state.error.message}`));
      }
    });
  });
}

const DOORS: readonly Door[] = [electronIpc, webSocket];

// ---- what a case records -------------------------------------------------------

const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
  electron.handlers.clear();
  electron.listeners.clear();
});

/** A fresh host behind one door. */
async function serve(door: Door): Promise<{ host: Host; client: BoardClient }> {
  const host = openHost();
  closers.push(() => host.ctx.cleanup());
  const opened = await door.open(host);
  closers.push(() => opened.close());
  return { host, client: opened.client };
}

interface Painted {
  tickets: Ticket[];
  labels: Label[];
  unloaded: string[];
}

/** Where a sync engine paints, recording what it was told. */
function recordingView() {
  const record = {
    painted: null as Painted | null,
    projects: [] as Project[],
    planning: [] as { ticketId?: string; projectId?: string }[],
    failures: [] as string[],
  };
  const view: BoardSyncView = {
    paint: (_projectId, tickets, labels, unloaded) => {
      record.painted = { tickets, labels, unloaded: [...unloaded].toSorted() };
    },
    adoptProject: (project) => void record.projects.push(project),
    notePlanningChange: (change) => void record.planning.push(change),
    checkoutMoved: () => {},
    failed: (message) => void record.failures.push(message),
  };
  return { record, view };
}

/** A sync engine over the client, minting the same command ids on both doors. */
function syncOver(client: BoardClient) {
  const { record, view } = recordingView();
  let minted = 0;
  const sync = new BoardSync({
    transport: boardSyncTransport(client),
    view,
    mintCommandId: () => `00000000-0000-4000-8000-${String((minted += 1)).padStart(12, "0")}`,
    readCoalesceMs: 1,
    retryDelaysMs: [5],
    feedRetryDelaysMs: [5],
  });
  closers.push(() => sync.closeAll());
  return { sync, record };
}

const byId = <Row extends { id: string }>(left: Row, right: Row) => left.id.localeCompare(right.id);

/** The board the database holds, as a roster row each. */
function databaseBoard(host: Host) {
  return listTicketRosterByProject(host.ctx.db, PROJECT).toSorted(byId);
}

/** What the engine paints, as the roster rows the database holds. */
function paintedBoard(record: { painted: Painted | null }) {
  return (record.painted?.tickets ?? []).map(({ body: _body, ...row }) => row).toSorted(byId);
}

/** Waits until what the engine paints is the database's board, with no edit pending. */
async function converged(host: Host, record: { painted: Painted | null }): Promise<void> {
  await vi.waitFor(
    () => {
      const painted = paintedBoard(record);
      expect(painted.some(({ id }) => id.startsWith("pending:"))).toBe(false);
      expect(painted).toEqual(databaseBoard(host));
    },
    { timeout: 5_000, interval: 5 },
  );
}

/**
 * An answer with what each fresh host mints made comparable: every feed
 * cursor is `<cursor>`, and every UUID the case did not state is named by the
 * order it first appears in.
 */
function comparable(value: unknown): unknown {
  const named = new Map<string, string>();
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (/^\d+:[0-9a-f-]{36}:\d+$/u.test(node)) return "<cursor>";
      return node.replace(UUID, (id) => {
        if (STATED.has(id) || id.startsWith("00000000-0000-4000-8000-")) return id;
        if (!named.has(id)) named.set(id, `<id ${named.size + 1}>`);
        return named.get(id)!;
      });
    }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(value);
}

/** Each case's comparable answer, per door: the doors must agree. */
const answers = new Map<string, Map<Door["name"], unknown>>();

function answered(scenario: string, door: Door, answer: unknown): void {
  let byDoor = answers.get(scenario);
  if (byDoor === undefined) answers.set(scenario, (byDoor = new Map()));
  byDoor.set(door.name, comparable(answer));
}

const SCENARIOS = {
  reads: "reads the Workspace's board and its tickets' parts",
  sync: "a BoardSync opens, creates, moves and comments, and converges to the database",
  replay: "a retried command id replays its answer without a second effect",
  otherWriter: "the feed delivers another writer's change and the board re-reads to it",
} as const;

// ---- the cases, once per door --------------------------------------------------

for (const door of DOORS) {
  describe(`the board over ${door.name}`, () => {
    it(SCENARIOS.reads, async () => {
      const { client } = await serve(door);
      const snapshot = await client.board.snapshot.query({ projectId: PROJECT });
      expect(snapshot.project).toMatchObject({ id: PROJECT, name: "Board", ticketPrefix: "VC" });
      expect(snapshot.tickets.map(({ id, title, body }) => [id, title, body])).toEqual([
        ["ticket-1", "Seeded", "The seeded card."],
      ]);
      expect(snapshot.cursor).toMatch(/^0:[0-9a-f-]{36}:0$/u);
      const roster = await client.board.roster.query({ projectId: PROJECT });
      expect(roster.tickets.map(({ id }) => id)).toEqual(["ticket-1"]);
      for (const row of roster.tickets) expect(row).not.toHaveProperty("body");
      const parts = {
        body: await client.board.ticketBody.query({ ticketId: "ticket-1" }),
        comments: await client.board.comments.query({ ticketId: "ticket-1" }),
        archived: await client.board.archivedTickets.query({ projectId: PROJECT }),
        statusEntries: await client.board.statusEntries.query({ projectId: PROJECT }),
        folder: await client.board.projectFolder.query({ projectId: PROJECT }),
      };
      expect(parts.body).toEqual({ body: "The seeded card." });
      expect(parts.comments).toEqual([]);
      expect(parts.folder).toEqual({ path: "/repo/board", state: "missing" });
      // A ticket no Workspace holds is refused on both doors, but NOT alike:
      // the network door's Workspace check answers before the handler, while
      // the desktop's own window is checked against no Workspace, so the
      // handler's own failure reaches it. Pinned here so a change to either
      // shows; left out of the doors' comparison below.
      const refused = await client.board.ticketBody
        .query({ ticketId: "no-such-ticket" })
        .catch((error: unknown) => readHostError(error));
      expect(refused).toEqual(
        door.name === "websocket"
          ? {
              code: "NOT_FOUND",
              message: "Not found in this Workspace.",
              reason: "workspace-unknown",
            }
          : { code: "INTERNAL_SERVER_ERROR", message: "Unknown ticket" },
      );
      answered(SCENARIOS.reads, door, { snapshot, roster, parts });
    });

    it(SCENARIOS.sync, async () => {
      const { host, client } = await serve(door);
      const { sync, record } = syncOver(client);
      await sync.open(PROJECT);
      expect(record.projects.map(({ id }) => id)).toEqual([PROJECT]);
      expect(paintedBoard(record).map(({ id }) => id)).toEqual(["ticket-1"]);

      const created = await sync.createTicket(PROJECT, {
        status: "todo",
        title: "Made through the board router",
        body: "Its body.",
        priority: "high",
        labels: ["ui"],
      });
      expect(created).toMatchObject({ title: "Made through the board router", ticketNumber: 2 });
      await converged(host, record);
      expect(listLabelsByProject(host.ctx.db, PROJECT).map(({ name }) => name)).toEqual(["ui"]);

      await sync.moveTickets(PROJECT, [created!.id], "doing", 0);
      await converged(host, record);
      expect(getTicketRow(host.ctx.db, created!.id)?.status).toBe("doing");

      const api = protocolBoardApi(() => client, sync);
      const comment = await api.comments.create({ ticketId: created!.id, body: "From the facade" });
      expect(comment).toMatchObject({ ok: true, comment: { body: "From the facade" } });
      expect(listComments(host.ctx.db, created!.id).map(({ body }) => body)).toEqual([
        "From the facade",
      ]);
      const listed = await api.comments.list({ ticketId: created!.id });
      expect(listed).toMatchObject({ ok: true, comments: [{ body: "From the facade" }] });
      // The comment reaches the engine on the feed as the ticket's history.
      await vi.waitFor(() =>
        expect(record.planning).toContainEqual({ ticketId: created!.id, projectId: PROJECT }),
      );
      const body = await api.tickets.body({ ticketId: created!.id });
      expect(body).toEqual({ ok: true, body: "Its body." });
      await converged(host, record);
      expect(record.failures).toEqual([]);
      answered(SCENARIOS.sync, door, {
        painted: record.painted,
        created,
        comment,
        listed,
        body,
      });
    });

    it(SCENARIOS.replay, async () => {
      const { host, client } = await serve(door);
      const input = {
        commandId: COMMAND,
        projectId: PROJECT,
        status: "backlog" as const,
        title: "Sent twice",
      };
      const first = await client.board.createTicket.mutate(input);
      expect(first.receipt).toEqual({ commandId: COMMAND, status: "completed", replayed: false });
      const retried = await client.board.createTicket.mutate(input);
      expect(retried.receipt).toEqual({ commandId: COMMAND, status: "completed", replayed: true });
      expect(retried.ticket).toEqual(first.ticket);
      // One effect: the seeded card and one more.
      expect(
        databaseBoard(host)
          .map(({ title }) => title)
          .toSorted(),
      ).toEqual(["Seeded", "Sent twice"]);
      // The same id for another intent is the client's conflict, and runs nothing.
      const conflict = await client.board.createTicket
        .mutate({ ...input, title: "Something else" })
        .catch((error: unknown) => readHostError(error));
      expect(conflict).toMatchObject({ code: "CONFLICT", reason: "command-conflict" });
      expect(databaseBoard(host)).toHaveLength(2);
      answered(SCENARIOS.replay, door, { first, retried, conflict });
    });

    it(SCENARIOS.otherWriter, async () => {
      const { host, client } = await serve(door);
      const { sync, record } = syncOver(client);
      await sync.open(PROJECT);

      // The agent socket's `volli ticket move`: the same map, its own door.
      await invokeHandler(
        host.map,
        { door: "agent-socket", admit: () => ADMITTED },
        "ticket.move",
        { projectId: PROJECT, ticketId: "ticket-1", toStatus: "doing" },
        { actor: { kind: "user" } },
      );
      await vi.waitFor(() =>
        expect(record.painted?.tickets.find(({ id }) => id === "ticket-1")?.status).toBe("doing"),
      );
      await converged(host, record);

      // A writer the host only knows by its `data-changed`: a rowless change,
      // which the engine answers with a roster read.
      setTicketPriorityCommand(
        host.ctx.db,
        { ticketId: "ticket-1", priority: "low" },
        { now: host.now(), actor: { kind: "user" } },
      );
      host.feed.noteDataChanged({ ticketId: "ticket-1" });
      await vi.waitFor(() =>
        expect(record.painted?.tickets.find(({ id }) => id === "ticket-1")?.priority).toBe("low"),
      );
      await converged(host, record);
      expect(record.planning).toContainEqual({ ticketId: "ticket-1", projectId: PROJECT });
      expect(record.failures).toEqual([]);
      answered(SCENARIOS.otherWriter, door, { painted: record.painted });
    });
  });
}

describe("both doors", () => {
  it.each(Object.values(SCENARIOS))("answer alike: %s", (scenario) => {
    const byDoor = answers.get(scenario);
    expect([...(byDoor?.keys() ?? [])].toSorted()).toEqual(
      DOORS.map(({ name }) => name).toSorted(),
    );
    expect(byDoor!.get("electron-ipc")).toEqual(byDoor!.get("websocket"));
  });
});
