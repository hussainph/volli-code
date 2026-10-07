/**
 * The board's protocol door (VC-565): the sync engine's transport over a
 * board client, the start/stop of the protocol path, and `boardApi()` — the
 * legacy `window.api` functions with `cloud` off, the protocol facade (each
 * write under one `commandId`, retried while its outcome is unknown) with it
 * on. The board client here is a real `createTRPCClient<BoardRouter>` over a
 * terminating link this file answers.
 */
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { BoardRouter } from "@volli/session-rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { IpcRequest, IpcResponse } from "@volli/host-protocol/ipc";
import {
  boardApi,
  boardProtocol,
  boardSyncTransport,
  commentTickets,
  createBoardClient,
  remoteAwareBoardClients,
  protocolBoardApi,
  startBoardProtocol,
  stopBoardProtocol,
} from "./board-protocol";
import { BoardSync, type BoardSyncView } from "@renderer/stores/board-sync";
import { useHostConnectionStore } from "@renderer/stores/host-connection";

vi.mock("./session-rpc-ipc-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-rpc-ipc-link")>();
  // A fresh client over whatever bridge the case stubbed, not the app's singleton.
  return {
    ...actual,
    sessionRpcClient: vi.fn(() => actual.createSessionRpcClient(window.api.sessionRpc)),
  };
});

/** The router's error, as either board link delivers it: the envelope on `data.hostError`. */
function hostError(code: string, message: string, reason?: string): TRPCClientError<BoardRouter> {
  return new TRPCClientError(message, {
    result: {
      error: {
        code: -32_000,
        message,
        data: {
          code,
          httpStatus: 500,
          path: "board",
          hostError: reason === undefined ? { code, message } : { code, message, reason },
        },
      },
    },
  } as never);
}

const unavailable = () => hostError("SERVICE_UNAVAILABLE", "host-unreachable", "host-unreachable");

/** An answer that hands its input straight back. */
const echo = (input: unknown) => ({ echoed: input });

/** The link's side of one subscription: what the test pushes into it. */
interface FeedObserver {
  next(envelope: { result: { data: unknown } }): void;
  error(error: unknown): void;
  complete(): void;
}

interface Feed {
  readonly path: string;
  readonly input: unknown;
  readonly observer: FeedObserver;
  closed: boolean;
}

type Answer = (input: unknown) => unknown;

/**
 * A terminating link: each query or mutation answers from `answers[path]`
 * (a throw is the router's refusal), each subscription is a {@link Feed}
 * the test drives.
 */
function fakeBoard(answers: Record<string, Answer> = {}) {
  const calls: { path: string; type: string; input: unknown }[] = [];
  const feeds: Feed[] = [];
  const link: TRPCLink<BoardRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        calls.push({ path: op.path, type: op.type, input: op.input });
        if (op.type === "subscription") {
          const feed: Feed = {
            path: op.path,
            input: op.input,
            observer: observer as unknown as FeedObserver,
            closed: false,
          };
          feeds.push(feed);
          return () => {
            feed.closed = true;
          };
        }
        void (async () => {
          try {
            const answer = answers[op.path];
            if (answer === undefined) throw new Error(`no answer for ${op.path}`);
            const data = await answer(op.input);
            observer.next({ result: { data } });
            observer.complete();
          } catch (error) {
            observer.error(error as TRPCClientError<BoardRouter>);
          }
        })();
        return () => {};
      });
  const client = createBoardClient(link);
  return { client, calls, feeds };
}

/** A sync engine over the client that follows no Workspace: its commands prove by reply. */
function syncOver(client: Parameters<typeof boardSyncTransport>[0]): BoardSync {
  return new BoardSync({ transport: boardSyncTransport(client), view: silentView() });
}

function silentView(): BoardSyncView {
  return {
    paint: vi.fn(),
    adoptProject: vi.fn(),
    notePlanningChange: vi.fn(),
    checkoutMoved: vi.fn(),
    failed: vi.fn(),
  };
}

afterEach(() => {
  stopBoardProtocol();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- the transport -----------------------------------------------------------------------

describe("boardSyncTransport", () => {
  it("maps every call onto its board procedure, input and answer as they are", async () => {
    const { client, calls } = fakeBoard(
      Object.fromEntries(
        [
          "snapshot",
          "roster",
          "createTicket",
          "moveTickets",
          "setPriority",
          "updateTicket",
          "setLabels",
          "setLabelColor",
          "archiveTicket",
          "unarchiveTicket",
          "deleteTicket",
          "archivedTickets",
        ].map((name) => [`board.${name}`, echo]),
      ),
    );
    const transport = boardSyncTransport(client);
    const id = { commandId: "cmd-1" };

    const answers = await Promise.all([
      transport.snapshot("p1"),
      transport.roster("p1"),
      transport.createTicket({ ...id, projectId: "p1", status: "todo", title: "T" }),
      transport.moveTickets({
        ...id,
        projectId: "p1",
        ticketIds: ["a"],
        toStatus: "doing",
        toIndex: 0,
      }),
      transport.setPriority({ ...id, ticketId: "a", priority: "high" }),
      transport.updateTicket({ ...id, ticketId: "a", title: "U" }),
      transport.setLabels({ ...id, ticketId: "a", labels: ["bug"] }),
      transport.setLabelColor({ ...id, labelId: "l", color: "#f00" }),
      transport.archiveTicket({ ...id, ticketId: "a" }),
      transport.unarchiveTicket({ ...id, ticketId: "a" }),
      transport.deleteTicket({ ...id, ticketId: "a" }),
      transport.archivedTickets("p1"),
    ]);

    expect(calls).toEqual([
      { path: "board.snapshot", type: "query", input: { projectId: "p1" } },
      { path: "board.roster", type: "query", input: { projectId: "p1" } },
      {
        path: "board.createTicket",
        type: "mutation",
        input: { ...id, projectId: "p1", status: "todo", title: "T" },
      },
      {
        path: "board.moveTickets",
        type: "mutation",
        input: { ...id, projectId: "p1", ticketIds: ["a"], toStatus: "doing", toIndex: 0 },
      },
      {
        path: "board.setPriority",
        type: "mutation",
        input: { ...id, ticketId: "a", priority: "high" },
      },
      { path: "board.updateTicket", type: "mutation", input: { ...id, ticketId: "a", title: "U" } },
      {
        path: "board.setLabels",
        type: "mutation",
        input: { ...id, ticketId: "a", labels: ["bug"] },
      },
      {
        path: "board.setLabelColor",
        type: "mutation",
        input: { ...id, labelId: "l", color: "#f00" },
      },
      { path: "board.archiveTicket", type: "mutation", input: { ...id, ticketId: "a" } },
      { path: "board.unarchiveTicket", type: "mutation", input: { ...id, ticketId: "a" } },
      { path: "board.deleteTicket", type: "mutation", input: { ...id, ticketId: "a" } },
      { path: "board.archivedTickets", type: "query", input: { projectId: "p1" } },
    ]);
    expect(answers).toEqual(calls.map(({ input }) => ({ echoed: input })));
  });

  it("follows the feed from a cursor, handing each tracked frame's batch on, and stops it", () => {
    const { client, feeds } = fakeBoard();
    const handlers = { onBatch: vi.fn(), onResnapshot: vi.fn(), onError: vi.fn() };

    const stop = boardSyncTransport(client).changes("p1", "0:i:4", handlers);
    const batch = { cursor: "0:i:5", changes: [] };
    feeds[0]!.observer.next({ result: { data: { id: "0:i:5", data: batch } } });

    expect(feeds[0]).toMatchObject({
      path: "board.changes",
      input: { projectId: "p1", lastEventId: "0:i:4" },
    });
    expect(handlers.onBatch).toHaveBeenCalledWith(batch);
    stop();
    expect(feeds[0]!.closed).toBe(true);
    expect(handlers.onResnapshot).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("answers a cursor that cannot resume with a resnapshot", () => {
    const { client, feeds } = fakeBoard();
    const handlers = { onBatch: vi.fn(), onResnapshot: vi.fn(), onError: vi.fn() };
    boardSyncTransport(client).changes("p1", "0:i:4", handlers);

    feeds[0]!.observer.error(
      hostError(
        "PRECONDITION_FAILED",
        "read the snapshot again",
        "subscription-resnapshot-required",
      ),
    );

    expect(handlers.onResnapshot).toHaveBeenCalledOnce();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("answers any other end of the feed, an error or a completion, as an error", () => {
    const { client, feeds } = fakeBoard();
    const transport = boardSyncTransport(client);
    const dropped = { onBatch: vi.fn(), onResnapshot: vi.fn(), onError: vi.fn() };
    const bare = { onBatch: vi.fn(), onResnapshot: vi.fn(), onError: vi.fn() };
    const completed = { onBatch: vi.fn(), onResnapshot: vi.fn(), onError: vi.fn() };
    transport.changes("p1", "0:i:4", dropped);
    transport.changes("p1", "0:i:4", bare);
    transport.changes("p1", "0:i:4", completed);

    const unreachable = unavailable();
    const envelopeless = new TRPCClientError("no envelope");
    feeds[0]!.observer.error(unreachable);
    feeds[1]!.observer.error(envelopeless);
    feeds[2]!.observer.complete();

    expect(dropped.onError).toHaveBeenCalledWith(unreachable);
    expect(bare.onError).toHaveBeenCalledWith(envelopeless);
    expect(completed.onError).toHaveBeenCalledWith(new Error("The board feed ended"));
    for (const handlers of [dropped, bare, completed]) {
      expect(handlers.onResnapshot).not.toHaveBeenCalled();
    }
  });
});

// ---- the protocol path ------------------------------------------------------------------------

describe("startBoardProtocol / stopBoardProtocol", () => {
  const snapshot = {
    project: { id: "p1" },
    tickets: [],
    labels: [],
    cursor: "0:i:0",
  };

  it("is off until started, and off again once stopped", () => {
    expect(boardProtocol()).toBeNull();
    const { client } = fakeBoard();

    const started = startBoardProtocol({ view: silentView(), client });

    expect(boardProtocol()).toBe(started);
    expect(started.client).toBe(client);
    stopBoardProtocol();
    expect(boardProtocol()).toBeNull();
    // Stopping what is not running is harmless.
    stopBoardProtocol();
    expect(boardProtocol()).toBeNull();
  });

  it("runs the sync engine over the client, painting through the view it was given", async () => {
    const { client, calls, feeds } = fakeBoard({ "board.snapshot": () => snapshot });
    const view = silentView();

    const { sync } = startBoardProtocol({ view, client });
    await sync.open("p1");

    expect(calls[0]).toEqual({ path: "board.snapshot", type: "query", input: { projectId: "p1" } });
    expect(view.paint).toHaveBeenCalledWith("p1", [], [], new Set());
    expect(view.adoptProject).toHaveBeenCalledWith(snapshot.project);
    expect(feeds[0]?.input).toEqual({ projectId: "p1", lastEventId: "0:i:0" });
  });

  it("takes a test's own transport and options over the client's", async () => {
    const { client, calls } = fakeBoard();
    const transport = {
      ...boardSyncTransport(client),
      snapshot: vi.fn(async () => snapshot as never),
      changes: vi.fn(() => () => {}),
    };

    const { sync } = startBoardProtocol({
      view: silentView(),
      client,
      sync: { transport, mintCommandId: () => "fixed" },
    });
    await sync.open("p1");

    expect(transport.snapshot).toHaveBeenCalledWith("p1");
    expect(calls).toEqual([]);
  });

  it("closes the previous engine's Workspaces when it starts again, and when it stops", async () => {
    const first = fakeBoard({ "board.snapshot": () => snapshot });
    const { sync } = startBoardProtocol({ view: silentView(), client: first.client });
    await sync.open("p1");

    const second = startBoardProtocol({ view: silentView(), client: fakeBoard().client });

    expect(sync.follows("p1")).toBe(false);
    expect(first.feeds[0]!.closed).toBe(true);
    const closeAll = vi.spyOn(second.sync, "closeAll");
    stopBoardProtocol();
    expect(closeAll).toHaveBeenCalledOnce();
  });

  it("builds its client over the desktop's generic IPC bridge when given none", async () => {
    const request = vi.fn<(request: IpcRequest) => Promise<IpcResponse>>(async () => ({
      ok: true,
      data: snapshot,
    }));
    vi.stubGlobal("window", {
      api: { sessionRpc: { request, onEvent: vi.fn(() => () => {}), cancel: vi.fn() } },
    });

    const { sync } = startBoardProtocol({ view: silentView() });
    void sync.open("p1");
    await vi.waitFor(() => expect(request).toHaveBeenCalled());

    expect(request.mock.calls[0]?.[0]).toEqual({
      path: "board.snapshot",
      type: "query",
      input: { projectId: "p1" },
      // Every bridge request carries a trace (VC-699).
      trace: { traceId: expect.stringMatching(/^[0-9a-f]{32}$/u), spanId: expect.any(String) },
    });
  });
});

// ---- boardApi -------------------------------------------------------------------------------

describe("boardApi with the protocol off", () => {
  it("answers with window.api's own functions, untouched", async () => {
    const api = {
      tickets: {
        events: vi.fn(async () => "events"),
        body: vi.fn(async () => "body"),
        latestSignals: vi.fn(async () => "signals"),
        statusEntries: vi.fn(async () => "entries"),
      },
      comments: {
        list: vi.fn(async () => "list"),
        create: vi.fn(async () => "create"),
        update: vi.fn(async () => "update"),
        remove: vi.fn(async () => "remove"),
      },
      projects: {
        update: vi.fn(async () => "project"),
        setSkillModes: vi.fn(async () => "modes"),
        setSessionDefaults: vi.fn(async () => "defaults"),
        checkFolder: vi.fn(async () => "folder"),
      },
    };
    vi.stubGlobal("window", { api });
    const door = boardApi();

    const answers = await Promise.all([
      door.tickets.events({ ticketId: "a" }),
      door.tickets.body({ ticketId: "a" }),
      door.tickets.latestSignals({ projectId: "p1" }),
      door.tickets.statusEntries({ projectId: "p1" }),
      door.comments.list({ ticketId: "a" }),
      door.comments.create({ ticketId: "a", body: "hi" }),
      door.comments.update({ commentId: "c", body: "edit" }),
      door.comments.remove({ commentId: "c" }),
      door.projects.update({ id: "p1", baseBranch: "main" }),
      door.projects.setSkillModes({ id: "p1", modes: {} }),
      door.projects.setSessionDefaults({ id: "p1", model: null }),
      door.projects.checkFolder("p1"),
    ]);

    expect(answers).toEqual([
      "events",
      "body",
      "signals",
      "entries",
      "list",
      "create",
      "update",
      "remove",
      "project",
      "modes",
      "defaults",
      "folder",
    ]);
    expect(api.tickets.events).toHaveBeenCalledWith({ ticketId: "a" });
    expect(api.tickets.body).toHaveBeenCalledWith({ ticketId: "a" });
    expect(api.tickets.latestSignals).toHaveBeenCalledWith({ projectId: "p1" });
    expect(api.tickets.statusEntries).toHaveBeenCalledWith({ projectId: "p1" });
    expect(api.comments.list).toHaveBeenCalledWith({ ticketId: "a" });
    expect(api.comments.create).toHaveBeenCalledWith({ ticketId: "a", body: "hi" });
    expect(api.comments.update).toHaveBeenCalledWith({ commentId: "c", body: "edit" });
    expect(api.comments.remove).toHaveBeenCalledWith({ commentId: "c" });
    expect(api.projects.update).toHaveBeenCalledWith({ id: "p1", baseBranch: "main" });
    expect(api.projects.setSkillModes).toHaveBeenCalledWith({ id: "p1", modes: {} });
    expect(api.projects.setSessionDefaults).toHaveBeenCalledWith({ id: "p1", model: null });
    expect(api.projects.checkFolder).toHaveBeenCalledWith("p1");
  });
});

describe("boardApi with the protocol on", () => {
  beforeEach(() => {
    // Nothing on window.api may be reached with the protocol on.
    vi.stubGlobal("window", { api: {} });
  });

  it("is the protocol facade over the running client", async () => {
    const { client, calls } = fakeBoard({ "board.ticketBody": () => ({ body: "# Body" }) });
    startBoardProtocol({ view: silentView(), client });

    expect(await boardApi().tickets.body({ ticketId: "a" })).toEqual({ ok: true, body: "# Body" });
    expect(calls).toEqual([{ path: "board.ticketBody", type: "query", input: { ticketId: "a" } }]);
  });

  it("answers each read in its legacy envelope", async () => {
    const { client, calls } = fakeBoard({
      "board.ticketEvents": () => ["event"],
      "board.ticketBody": () => ({ body: "# Body" }),
      "board.latestSignals": () => ["signal"],
      "board.statusEntries": () => ["entry"],
      "board.comments": () => ["comment"],
      "board.projectFolder": () => ({ exists: true }),
    });
    const door = protocolBoardApi(() => client, syncOver(client));

    expect(
      await Promise.all([
        door.tickets.events({ ticketId: "a" }),
        door.tickets.body({ ticketId: "a" }),
        door.tickets.latestSignals({ projectId: "p1" }),
        door.tickets.statusEntries({ projectId: "p1" }),
        door.comments.list({ ticketId: "a" }),
        door.projects.checkFolder("p1"),
      ]),
    ).toEqual([
      { ok: true, events: ["event"] },
      { ok: true, body: "# Body" },
      { ok: true, signals: ["signal"] },
      { ok: true, entries: ["entry"] },
      { ok: true, comments: ["comment"] },
      { ok: true, exists: true },
    ]);
    expect(calls.map(({ path, input }) => [path, input])).toEqual([
      ["board.ticketEvents", { ticketId: "a" }],
      ["board.ticketBody", { ticketId: "a" }],
      ["board.latestSignals", { projectId: "p1" }],
      ["board.statusEntries", { projectId: "p1" }],
      ["board.comments", { ticketId: "a" }],
      ["board.projectFolder", { projectId: "p1" }],
    ]);
  });

  it("answers a failed read with its message, whatever was thrown", async () => {
    const thrown = [hostError("NOT_FOUND", "Unknown ticket"), new Error("bridge gone")];
    const { client } = fakeBoard({
      "board.ticketEvents": () => {
        throw thrown[0];
      },
      "board.ticketBody": () => {
        throw thrown[1];
      },
      "board.latestSignals": () => {
        throw unavailable();
      },
      "board.statusEntries": () => {
        throw hostError("NOT_FOUND", "gone");
      },
      "board.comments": () => {
        throw hostError("NOT_FOUND", "no comments");
      },
      "board.projectFolder": () => {
        throw hostError("NOT_FOUND", "no folder");
      },
    });
    const door = protocolBoardApi(() => client, syncOver(client));

    expect(
      await Promise.all([
        door.tickets.events({ ticketId: "a" }),
        door.tickets.body({ ticketId: "a" }),
        door.tickets.latestSignals({ projectId: "p1" }),
        door.tickets.statusEntries({ projectId: "p1" }),
        door.comments.list({ ticketId: "a" }),
        door.projects.checkFolder("p1"),
      ]),
    ).toEqual([
      { ok: false, error: "Unknown ticket" },
      { ok: false, error: "bridge gone" },
      { ok: false, error: "host-unreachable" },
      { ok: false, error: "gone" },
      { ok: false, error: "no comments" },
      { ok: false, error: "no folder" },
    ]);
  });

  it("sends each write under a fresh commandId and answers it in its legacy envelope", async () => {
    const { client, calls } = fakeBoard({
      "board.createComment": () => ({ comment: { id: "c1" } }),
      "board.updateComment": () => ({ comment: { id: "c1", body: "edit" } }),
      "board.removeComment": () => ({}),
      "board.updateProject": () => ({ project: { id: "p1" } }),
      "board.setSkillModes": () => ({ project: { id: "p1", skillModes: {} } }),
      "board.setSessionDefaults": () => ({ project: { id: "p1", sessionModel: null } }),
    });
    const door = protocolBoardApi(() => client, syncOver(client));

    const answers = [
      await door.comments.create({ ticketId: "a", body: "hi", sessionId: null }),
      await door.comments.update({ commentId: "c1", body: "edit" }),
      await door.comments.remove({ commentId: "c1" }),
      await door.projects.update({ id: "p1", baseBranch: "main" }),
      await door.projects.update({ id: "p1", baseBranch: null, setupCommand: "pnpm i" }),
      await door.projects.setSkillModes({ id: "p1", modes: { review: "off" } }),
      await door.projects.setSessionDefaults({ id: "p1", model: null }),
    ];

    expect(answers).toEqual([
      { ok: true, comment: { id: "c1" } },
      { ok: true, comment: { id: "c1", body: "edit" } },
      { ok: true },
      { ok: true, project: { id: "p1" } },
      { ok: true, project: { id: "p1" } },
      { ok: true, project: { id: "p1", skillModes: {} } },
      { ok: true, project: { id: "p1", sessionModel: null } },
    ]);
    const commandIds = calls.map(({ input }) => (input as { commandId: string }).commandId);
    expect(new Set(commandIds).size).toBe(calls.length);
    expect(
      calls.map(({ path, input }) => {
        const { commandId: _commandId, ...rest } = input as { commandId: string };
        return [path, rest];
      }),
    ).toEqual([
      ["board.createComment", { ticketId: "a", body: "hi", sessionId: null }],
      ["board.updateComment", { commentId: "c1", body: "edit" }],
      ["board.removeComment", { commentId: "c1" }],
      ["board.updateProject", { projectId: "p1", baseBranch: "main" }],
      ["board.updateProject", { projectId: "p1", baseBranch: null, setupCommand: "pnpm i" }],
      ["board.setSkillModes", { projectId: "p1", modes: { review: "off" } }],
      ["board.setSessionDefaults", { projectId: "p1", model: null }],
    ]);
  });

  it("sends a write again under the same commandId while its outcome is unknown", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { client, calls } = fakeBoard({
      "board.createComment": () => {
        attempts += 1;
        if (attempts === 1) throw unavailable();
        if (attempts === 2) throw new Error("bridge gone");
        return { comment: { id: "c1" } };
      },
    });

    const creating = protocolBoardApi(() => client, syncOver(client)).comments.create({
      ticketId: "a",
      body: "hi",
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await creating).toEqual({ ok: true, comment: { id: "c1" } });
    const commandIds = calls.map(({ input }) => (input as { commandId: string }).commandId);
    expect(commandIds).toHaveLength(3);
    expect(new Set(commandIds).size).toBe(1);
  });

  it("never gives up on an unknown outcome, and never retries a refusal", async () => {
    vi.useFakeTimers();
    let down = true;
    const { client, calls } = fakeBoard({
      "board.updateComment": () => {
        if (down) throw unavailable();
        return { comment: { id: "c1", body: "edit" } };
      },
      "board.removeComment": () => {
        throw hostError("FORBIDDEN", "not yours");
      },
    });
    const door = protocolBoardApi(() => client, syncOver(client));

    let settled = false;
    const updating = door.comments.update({ commentId: "c1", body: "edit" });
    void updating.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(60_000);
    // Still unknown, so still trying under the one id: never answered as failed.
    expect(settled).toBe(false);
    const tries = calls.filter(({ path }) => path === "board.updateComment");
    expect(tries.length).toBeGreaterThan(8);
    expect(new Set(tries.map(({ input }) => (input as { commandId: string }).commandId)).size).toBe(
      1,
    );
    down = false;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await updating).toEqual({ ok: true, comment: { id: "c1", body: "edit" } });

    expect(await door.comments.remove({ commentId: "c1" })).toEqual({
      ok: false,
      error: "not yours",
    });
    expect(calls.filter(({ path }) => path === "board.removeComment")).toHaveLength(1);
  });

  it("counts a retried comment removal the host no longer finds as done", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { client } = fakeBoard({
      "board.removeComment": () => {
        attempts += 1;
        // The first removal lands but its answer is lost; the retry finds nothing.
        throw attempts === 1 ? unavailable() : hostError("NOT_FOUND", "Not found");
      },
    });
    const removing = protocolBoardApi(() => client, syncOver(client)).comments.remove({
      commentId: "c1",
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(await removing).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it("says what a client that threw a bare value threw", async () => {
    // A structural client: a real one wraps every throw in a TRPCClientError.
    const client = {
      board: { ticketBody: { query: () => Promise.reject("not an error") } },
    } as unknown as Parameters<typeof boardSyncTransport>[0];

    expect(
      await protocolBoardApi(() => client, syncOver(client)).tickets.body({ ticketId: "a" }),
    ).toEqual({
      ok: false,
      error: "not an error",
    });
  });

  it("reads the message off a refusal of every write", async () => {
    const refuse = () => {
      throw hostError("BAD_REQUEST", "refused");
    };
    const { client } = fakeBoard({
      "board.createComment": refuse,
      "board.updateComment": refuse,
      "board.updateProject": refuse,
      "board.setSkillModes": refuse,
      "board.setSessionDefaults": refuse,
    });
    const door = protocolBoardApi(() => client, syncOver(client));

    expect(
      await Promise.all([
        door.comments.create({ ticketId: "a", body: "hi" }),
        door.comments.update({ commentId: "c1", body: "edit" }),
        door.projects.update({ id: "p1", baseBranch: null }),
        door.projects.setSkillModes({ id: "p1", modes: {} }),
        door.projects.setSessionDefaults({ id: "p1", model: null }),
      ]),
    ).toEqual(Array.from({ length: 5 }, () => ({ ok: false, error: "refused" })));
  });

  it("answers a write the feed proved with the row the feed carried, in its legacy envelope", async () => {
    const { client } = fakeBoard({});
    // An engine whose every command is proved by the feed, its row in hand.
    const proving = {
      workspaceOf: () => undefined,
      command: async (spec: { fromFeed: (row: unknown, commandId: string) => unknown }) => ({
        ok: true,
        answer: spec.fromFeed({ id: "fed" }, "cmd-fed"),
      }),
    } as unknown as BoardSync;
    const door = protocolBoardApi(() => client, proving);

    expect(
      await Promise.all([
        door.comments.create({ ticketId: "a", body: "hi" }),
        door.comments.update({ commentId: "c1", body: "edit" }),
        door.comments.remove({ commentId: "c1" }),
        door.projects.update({ id: "p1", baseBranch: null }),
        door.projects.setSkillModes({ id: "p1", modes: {} }),
        door.projects.setSessionDefaults({ id: "p1", model: null }),
      ]),
    ).toEqual([
      { ok: true, comment: { id: "fed" } },
      { ok: true, comment: { id: "fed" } },
      { ok: true },
      { ok: true, project: { id: "fed" } },
      { ok: true, project: { id: "fed" } },
      { ok: true, project: { id: "fed" } },
    ]);
  });
});

// ---- routing by project (VC-711) ---------------------------------------------------------

const comment = (id: string, ticketId: string) => ({ id, ticketId, body: "b" });
const paths = (calls: { path: string }[]) => calls.map(({ path }) => path);

describe("each project's board client", () => {
  const remoteSnapshot = {
    project: { id: "r1" },
    tickets: [{ id: "rt", projectId: "r1", status: "todo", order: 0, body: "" }],
    labels: [],
    cursor: "0:r:0",
  };
  const localSnapshot = { project: { id: "p1" }, tickets: [], labels: [], cursor: "0:i:0" };

  it("routes the engine and every surface by project, ticket or comment", async () => {
    const receipt = { receipt: { commandId: "c", status: "completed", replayed: false } };
    const answers = (snapshot: unknown) => ({
      "board.snapshot": () => snapshot,
      "board.comments": () => [comment("rc", "rt")],
      "board.updateComment": () => ({ ...receipt, comment: comment("rc", "rt") }),
      "board.createComment": () => ({ ...receipt, comment: comment("rc2", "rt") }),
      "board.removeComment": () => receipt,
      "board.latestSignals": () => [],
      "board.projectFolder": () => ({ path: "/srv", state: "present" }),
      "board.ticketBody": () => ({ body: "remote body" }),
    });
    const local = fakeBoard(answers(localSnapshot));
    const remote = fakeBoard(answers(remoteSnapshot));
    const clientFor = vi.fn((projectId: string | undefined) =>
      projectId === "r1" ? remote.client : local.client,
    );
    const { sync } = startBoardProtocol({ view: silentView(), client: local.client, clientFor });
    await sync.open("p1");
    await sync.open("r1");
    expect(local.feeds.map(({ input }) => input)).toEqual([
      { projectId: "p1", lastEventId: "0:i:0" },
    ]);
    expect(remote.feeds.map(({ input }) => input)).toEqual([
      { projectId: "r1", lastEventId: "0:r:0" },
    ]);

    const api = boardApi();
    expect(await api.tickets.body({ ticketId: "rt" })).toEqual({ ok: true, body: "remote body" });
    expect(await api.comments.list({ ticketId: "rt" })).toMatchObject({ ok: true });
    // A comment the facade has seen goes to its ticket's host, through any later facade.
    expect(await boardApi().comments.update({ commentId: "rc", body: "x" })).toMatchObject({
      ok: true,
    });
    expect(await boardApi().comments.create({ ticketId: "rt", body: "y" })).toMatchObject({
      ok: true,
    });
    expect(await boardApi().comments.remove({ commentId: "rc2" })).toEqual({ ok: true });
    expect(await api.tickets.latestSignals({ projectId: "r1" })).toEqual({ ok: true, signals: [] });
    expect(await api.projects.checkFolder("r1")).toMatchObject({ ok: true, state: "present" });
    // A comment it has never seen is this Mac's, as every call was before.
    await boardApi().comments.remove({ commentId: "unknown" });

    expect(paths(remote.calls)).toEqual([
      "board.snapshot",
      "board.changes",
      "board.ticketBody",
      "board.comments",
      "board.updateComment",
      "board.createComment",
      "board.removeComment",
      "board.latestSignals",
      "board.projectFolder",
    ]);
    expect(paths(local.calls)).toEqual(["board.snapshot", "board.changes", "board.removeComment"]);
  });

  it("gives a remote project its own client, once, and every other project this Mac's", () => {
    const local = fakeBoard().client;
    const made: string[] = [];
    const resolve = remoteAwareBoardClients(local, {
      isRemote: (projectId) => projectId.startsWith("r"),
      remote: (projectId) => {
        made.push(projectId);
        return fakeBoard().client;
      },
    });
    expect(resolve(undefined)).toBe(local);
    expect(resolve("p1")).toBe(local);
    const remote = resolve("r1");
    expect(remote).not.toBe(local);
    expect(resolve("r1")).toBe(remote);
    expect(made).toEqual(["r1"]);
  });

  it("asks the host-connection store which projects are remote, and reaches them over the relay", () => {
    const local = fakeBoard().client;
    const resolve = remoteAwareBoardClients(local);
    expect(resolve("r1")).toBe(local);
    useHostConnectionStore.setState({
      hosts: [],
      projects: { r1: { hostId: "box", link: { status: "open" } } },
    });
    try {
      const remote = resolve("r1");
      expect(remote).not.toBe(local);
      expect(typeof remote.board.snapshot.query).toBe("function");
    } finally {
      useHostConnectionStore.setState({ hosts: [], projects: {} });
    }
  });

  it("remembers a bounded number of comments' tickets, the oldest first out", () => {
    const tickets = commentTickets(2);
    tickets.note("a", "t1");
    tickets.note("b", "t2");
    tickets.note("a", "t1");
    tickets.note("c", "t3");
    expect([tickets.get("a"), tickets.get("b"), tickets.get("c")]).toEqual(["t1", undefined, "t3"]);
  });
});

// VC-711 PR 2 review B1: where a write goes is decided when it is made.
describe("a facade write's host", () => {
  it("is fixed when the write is made, and owned by the Workspace it was made for", async () => {
    const first = fakeBoard();
    const second = fakeBoard();
    let current = first.client;
    const clientFor = vi.fn((_projectId: string | undefined) => current);
    const specs: { owner?: string; send(commandId: string): Promise<unknown> }[] = [];
    const sync = {
      workspaceOf: (ticketId: string) => (ticketId === "rt" ? "r1" : undefined),
      command: (spec: { owner?: string; send(commandId: string): Promise<unknown> }) => {
        specs.push(spec);
        return Promise.resolve({ ok: false, error: "held" });
      },
    } as unknown as BoardSync;
    const comments = commentTickets();
    comments.note("rc", "rt");
    const api = protocolBoardApi(clientFor, sync, comments);
    await api.comments.create({ ticketId: "rt", body: "b" });
    await api.comments.update({ commentId: "rc", body: "b" });
    await api.comments.remove({ commentId: "unseen" });
    await api.projects.update({ id: "r1", baseBranch: null });
    await api.projects.setSkillModes({ id: "r1", modes: {} });
    await api.projects.setSessionDefaults({ id: "r1", model: null });
    expect(specs.map(({ owner }) => owner)).toEqual(["r1", "r1", undefined, "r1", "r1", "r1"]);
    // The resolver moves on (the claim went): a retry still goes where the write was made.
    current = second.client;
    await Promise.allSettled(specs.map((spec) => spec.send("cmd")));
    expect(second.calls).toEqual([]);
    expect(first.calls.map(({ path }) => path)).toEqual([
      "board.createComment",
      "board.updateComment",
      "board.removeComment",
      "board.updateProject",
      "board.setSkillModes",
      "board.setSessionDefaults",
    ]);
  });
});
