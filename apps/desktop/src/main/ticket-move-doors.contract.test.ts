// @vitest-environment node
/**
 * One command, three doors, one handler (VC-668; HP § Contract harness).
 *
 * `ticket.move` is the first catalog command both kinds of door serve. Each
 * door here is the production one, and each projects the SAME host handler
 * map (`createHostHandlers`, via `testHostHandlers`, over a real database):
 *
 * - IPC: the desktop window's `volli:ticket-move` channel (`registerDataIpcHandlers`);
 * - WebSocket: the board router behind tRPC's stock adapter, JSON on the wire;
 * - socket: the agent verb door (`createAgentCommandService`), as `volli ticket move`.
 *
 * Every door must leave the same durable state, record the same history and
 * cause the same effects: the armed arrival, the backward-move interrupt and
 * no notification for a person. That is the check the VC-629 divergence (a
 * Done trim one door ran and the other did not) never had. The replies differ
 * only by envelope, and the change feed differs in the one way the handler
 * documents: the desktop window holds the committed board in its reply, so
 * the board change is not echoed back to it.
 *
 * Every door also runs its own policy at the map before the handler (D-A1):
 * the desktop window's, the router's and the socket's coordination policy,
 * each recorded ahead of the handler it admits, and a refusal never reaches
 * it. And a Done move runs the same detached trim through every door, over a
 * real worktree and the worktree bundle production builds.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentCommandService } from "@volli/host-core/agents";
import { getTicket, getTicketRow, listTicketEvents } from "@volli/host-core/db";
import {
  createTestSessionEngine,
  openTestDb,
  resetWorktreeSnapshotsForTest,
  sealTestHandlers,
  testHostHandlers,
  testProject,
  testTicket,
  type TestDb,
  type TestHandlerPorts,
} from "@volli/host-core/testing";
import { insertProject, insertTicket } from "@volli/host-core/db";
import { webSocketContractLink } from "@volli/host-protocol/testing";
import {
  admittedHandlers,
  ROUTER_POLICY,
  type AdmissionRecord,
  type HostHandlerMap,
  type HostHandlers,
} from "@volli/host-core/handlers";
import { getWorktreeSnapshots } from "@volli/host-core/worktree";
import {
  createBoardRouter,
  RpcDiagnosticLog,
  TICKET_RESOURCE,
  type BoardRouterHandlers,
  type SessionRouterHandlers,
} from "@volli/session-rpc";
import {
  DEFAULT_AUTHORITY_POLICY,
  type DataChangedEvent,
  type HandlerCall,
  type TicketMovedNotice,
  type TicketStatus,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      ipc.handlers.set(channel, handler);
    },
  },
  app: { isPackaged: false, getPath: () => "/volli-test-userdata" },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => undefined },
  dialog: { showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));

const { registerDataIpcHandlers } = await import("./data-ipc");

type Door = "ipc" | "websocket" | "socket";
const DOORS: readonly Door[] = ["ipc", "websocket", "socket"];
const OPERATOR_TOKEN = "volli_op_the-persons-token";

let ctx: TestDb;
let projectId: string;
let closers: (() => Promise<void>)[];
let tempDirs: string[];

/** A fresh board: VC-1 alone in Todo, on a worktree when one is named. */
function seed(worktreePath?: string): void {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: projectId, ticketPrefix: "VC", path: "/repo/volli" }));
  insertTicket(
    ctx.db,
    testTicket(projectId, {
      id: "ticket-1",
      ticketNumber: 1,
      status: "todo",
      order: 0,
      ...(worktreePath === undefined
        ? {}
        : { worktreePath, branch: "main", baseBranch: "main", usesWorktree: true }),
    }),
  );
}

beforeEach(() => {
  // A Workspace id is a UUID on the wire; the project is its own Workspace.
  projectId = randomUUID();
  closers = [];
  tempDirs = [];
  resetWorktreeSnapshotsForTest();
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  ipc.handlers.clear();
  vi.restoreAllMocks();
  resetWorktreeSnapshotsForTest();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The host's one map over this database, recording each effect a move may have. */
function host(ports: Omit<TestHandlerPorts, "db"> = {}) {
  const arrivals: Pick<TicketMovedNotice, "ticketId" | "from" | "to">[] = [];
  const interrupted: string[] = [];
  const notified: unknown[] = [];
  const published: Omit<DataChangedEvent, "entity">[] = [];
  const handlers = testHostHandlers({
    db: ctx.db,
    onDeliberateMove: ({ ticketId, from, to }) => arrivals.push({ ticketId, from, to }),
    interruptTicketSessions: (ticketId) => {
      interrupted.push(ticketId);
      return [];
    },
    notify: (request) => notified.push(request),
    onMutation: (change) => published.push(change),
    ...ports,
  });
  return { handlers, effects: { arrivals, interrupted, notified }, published };
}

/** How a door's caller is stated: the person by default, as on every door above. */
interface OpenerOptions {
  /** The WebSocket's caller is a Session, which the router admits to no `ticket.move`. */
  readonly sessionOnWebSocket?: boolean;
  /** The socket's caller presents no token: the coordination policy refuses it. */
  readonly anonymousOnSocket?: boolean;
  readonly readAuthorityPolicy?: Parameters<
    typeof createAgentCommandService
  >[0]["readAuthorityPolicy"];
}

/** Moves VC-1 through one production door, answering the door's own reply. */
async function opener(door: Door, handlers: HostHandlerMap, options: OpenerOptions = {}) {
  switch (door) {
    case "ipc": {
      registerDataIpcHandlers(
        { ok: true, db: ctx.db },
        { sessionEngine: createTestSessionEngine(ctx.db), handlers },
      );
      const channel = ipc.handlers.get("volli:ticket-move")!;
      return async (toStatus: TicketStatus) => {
        // The renderer's drop names an index; the end of the column is where a
        // column-only move lands it on the other two doors.
        const toIndex = 0;
        const input = { projectId, ticketId: "ticket-1", toStatus, toIndex };
        const reply = (await channel({ sender: {} }, input)) as
          | { ok: true; tickets: { id: string; status: string }[] }
          | { ok: false; error: string };
        return reply.ok
          ? { ok: true, status: reply.tickets.find(({ id }) => id === "ticket-1")?.status }
          : { ok: false, status: reply.error };
      };
    }
    case "websocket": {
      const link = webSocketContractLink({
        router: createBoardRouter(),
        createContext: () => ({
          caller: {
            actor: options.sessionOnWebSocket
              ? { kind: "session" as const, sessionId: randomUUID(), workspaceId: projectId }
              : { kind: "device" as const, deviceId: randomUUID(), workspaceId: projectId },
            current: () => true,
          },
          // The router's projection of the map: its policy, then the handler.
          handlers: admittedHandlers(handlers, ROUTER_POLICY),
          diagnostics: new RpcDiagnosticLog(),
          resourceWorkspace: (resource: { kind: string; id: string }) =>
            resource.kind === TICKET_RESOURCE
              ? (getTicketRow(ctx.db, resource.id)?.project_id ?? null)
              : null,
        }),
      });
      const connection = await link.open(undefined);
      closers.push(() => connection.close());
      return async (toStatus: TicketStatus) => {
        try {
          const reply = await connection.client.ticket.move.mutate({
            projectId,
            ticketId: "ticket-1",
            toStatus,
          });
          return { ok: true, status: reply.ticket.status };
        } catch (error) {
          return { ok: false, status: (error as Error).message };
        }
      };
    }
    case "socket": {
      const service = createAgentCommandService({
        handlers,
        db: ctx.db,
        sessionEngine: createTestSessionEngine(ctx.db),
        appVersion: "1.2.3",
        // The person at the host's shell: the socket's user, as the other
        // doors' callers are.
        verifyOperatorToken: (token) => (token === OPERATOR_TOKEN ? { login: "alice" } : null),
        ...(options.readAuthorityPolicy === undefined
          ? {}
          : { readAuthorityPolicy: options.readAuthorityPolicy }),
      });
      return async (toStatus: TicketStatus) => {
        const reply = await service.execute({
          v: 1,
          cmd: "ticket.move",
          args: { id: "VC-1", to: toStatus },
          ctx: {
            cwd: "/repo/volli",
            env: options.anonymousOnSocket ? {} : { operatorToken: OPERATOR_TOKEN },
          },
        });
        return reply.ok
          ? { ok: true, status: (reply.data as { ticket: { status: string } }).ticket.status }
          : { ok: false, status: reply.error.message };
      };
    }
  }
}

/** One door's whole outcome for a forward move, then a backward one. */
async function outcomeThrough(door: Door) {
  const { handlers, effects, published } = host();
  const move = await opener(door, handlers);
  const replies = [await move("doing"), await move("todo")];
  const row = getTicketRow(ctx.db, "ticket-1")!;
  return {
    replies,
    state: { status: row.status, position: row.position },
    history: listTicketEvents(ctx.db, "ticket-1")
      .filter((event) => event.payload.kind === "status_changed")
      .map(({ actor, actorContext, payload }) => ({ actor, actorContext, payload })),
    effects,
    published: published.filter((change) => change.kind === "ticket"),
  };
}

describe("the host's map and the routers' slices", () => {
  it("agree: host-core's map serves every family the routers declare (D2)", () => {
    // session-rpc declares each slice structurally, since it cannot import
    // host-core; this is where the two meet, as the composition root does.
    expectTypeOf<HostHandlers>().toExtend<SessionRouterHandlers & BoardRouterHandlers>();
  });
});

describe("ticket.move on every door it projects onto", () => {
  it("leaves the same state, history and effects through IPC, WebSocket and the socket", async () => {
    const outcomes: Record<string, Awaited<ReturnType<typeof outcomeThrough>>> = {};
    for (const door of DOORS) {
      // Each door starts from the same board.
      seed();
      try {
        outcomes[door] = await outcomeThrough(door);
      } finally {
        ctx.cleanup();
      }
    }

    const {
      ipc: viaIpc,
      websocket: viaWebSocket,
      socket: viaSocket,
    } = outcomes as Record<Door, Awaited<ReturnType<typeof outcomeThrough>>>;
    // The replies: one envelope each, the same answer in all three.
    for (const outcome of [viaIpc, viaWebSocket, viaSocket]) {
      expect(outcome.replies).toEqual([
        { ok: true, status: "doing" },
        { ok: true, status: "todo" },
      ]);
    }
    // The durable state and the history it was written with.
    expect(viaWebSocket.state).toEqual(viaIpc.state);
    expect(viaSocket.state).toEqual(viaIpc.state);
    expect(viaIpc.history).toEqual([
      expect.objectContaining({ actor: "user", payload: expect.objectContaining({ to: "doing" }) }),
      expect.objectContaining({ actor: "user", payload: expect.objectContaining({ to: "todo" }) }),
    ]);
    expect(viaWebSocket.history).toEqual(viaIpc.history);
    expect(viaSocket.history).toEqual(viaIpc.history);
    // The effects the handler owns: the same on every door.
    expect(viaIpc.effects).toEqual({
      arrivals: [
        { ticketId: "ticket-1", from: "todo", to: "doing" },
        { ticketId: "ticket-1", from: "doing", to: "todo" },
      ],
      interrupted: ["ticket-1"],
      notified: [],
    });
    expect(viaWebSocket.effects).toEqual(viaIpc.effects);
    expect(viaSocket.effects).toEqual(viaIpc.effects);
    // The feed: every other caller's move is published; the desktop window,
    // which holds the board in its reply, is not echoed its own.
    expect(viaIpc.published).toEqual([]);
    const change = { projectId, ticketId: "ticket-1", kind: "ticket" };
    expect(viaWebSocket.published).toEqual([change, change]);
    expect(viaSocket.published).toEqual(viaWebSocket.published);
  });
});

/** The handler, as a recording stand-in: it moves nothing, and answers the moved ticket. */
function recordingMove(log: string[]) {
  return vi.fn((input: { toStatus: TicketStatus }, _call: HandlerCall) => {
    log.push("handler ticket.move");
    return [{ ...getTicket(ctx.db, "ticket-1")!, status: input.toStatus }];
  });
}

const DOOR_POLICY: Record<Door, string> = {
  ipc: "desktop-ipc",
  websocket: "router",
  socket: "agent-socket",
};

describe("policy before the handler, on every door (D-A1)", () => {
  it.each(DOORS)(
    "%s: the door's policy admits the call at the map, then the handler runs",
    async (door) => {
      seed();
      try {
        const log: string[] = [];
        const move = recordingMove(log);
        const map = sealTestHandlers({ "ticket.move": move }, (record: AdmissionRecord) =>
          log.push(`${record.door} ${record.admitted ? "admitted" : "refused"} ${record.key}`),
        );
        const reply = await (await opener(door, map))("doing");
        expect(reply).toEqual({ ok: true, status: "doing" });
        expect(log).toEqual([`${DOOR_POLICY[door]} admitted ticket.move`, "handler ticket.move"]);
        expect(move).toHaveBeenCalledOnce();
      } finally {
        ctx.cleanup();
      }
    },
  );

  it("refuses before the handler: a Session on the WebSocket, an anonymous socket caller, and a policy narrowed before the map", async () => {
    const cases: [Door, OpenerOptions, string[]][] = [
      // The router's own middleware refuses first; the map is never asked.
      ["websocket", { sessionOnWebSocket: true }, []],
      // So does the socket's dispatch line.
      ["socket", { anonymousOnSocket: true }, []],
      // The project narrows its Sessions' and the person's verbs after the
      // dispatch admitted the call: the map's own judgement refuses it.
      [
        "socket",
        {
          readAuthorityPolicy: (() => {
            let reads = 0;
            const narrowed = {
              ...DEFAULT_AUTHORITY_POLICY,
              actors: {
                ...DEFAULT_AUTHORITY_POLICY.actors,
                user: { ...DEFAULT_AUTHORITY_POLICY.actors.user, coordinationVerbs: [] },
              },
            };
            return () => (reads++ === 0 ? DEFAULT_AUTHORITY_POLICY : narrowed);
          })(),
        },
        ["agent-socket refused ticket.move"],
      ],
    ];
    for (const [door, options, admissions] of cases) {
      seed();
      try {
        const log: string[] = [];
        const move = recordingMove(log);
        const map = sealTestHandlers({ "ticket.move": move }, (record: AdmissionRecord) =>
          log.push(`${record.door} ${record.admitted ? "admitted" : "refused"} ${record.key}`),
        );
        const reply = await (await opener(door, map, options))("doing");
        expect(reply.ok, door).toBe(false);
        expect(log, door).toEqual(admissions);
        expect(move, door).not.toHaveBeenCalled();
        expect(getTicketRow(ctx.db, "ticket-1")?.status, door).toBe("todo");
      } finally {
        ctx.cleanup();
      }
    }
  });
});

describe("the desktop window's volli:ticket-move channel", () => {
  it("projects handlers['ticket.move'] alone, as the desktop window, and replies synchronously", () => {
    seed();
    try {
      const log: string[] = [];
      const move = recordingMove(log);
      // Every other key throws if reached: the channel projects exactly one.
      const map = sealTestHandlers({ "ticket.move": move }, (record: AdmissionRecord) =>
        log.push(`${record.door} ${record.admitted ? "admitted" : "refused"} ${record.key}`),
      );
      registerDataIpcHandlers(
        { ok: true, db: ctx.db },
        { sessionEngine: createTestSessionEngine(ctx.db), handlers: map },
      );
      const input = { projectId, ticketId: "ticket-1", toStatus: "doing", toIndex: 0 };
      const reply = ipc.handlers.get("volli:ticket-move")!({ sender: {} }, input);
      // A synchronous policy over a synchronous move: no Promise on the wire.
      expect(reply).not.toBeInstanceOf(Promise);
      expect(reply).toMatchObject({ ok: true, tickets: [{ id: "ticket-1", status: "doing" }] });
      expect(log).toEqual(["desktop-ipc admitted ticket.move", "handler ticket.move"]);
      expect(move).toHaveBeenCalledExactlyOnceWith(input, {
        actor: { kind: "user" },
        origin: "desktop-window",
      });
    } finally {
      ctx.cleanup();
    }
  });
});

/** A real git checkout with an ignored dependency tree a Done trim removes. */
function seedGitWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "volli-ticket-move-doors-"));
  tempDirs.push(root);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Volli Test",
        GIT_AUTHOR_EMAIL: "test@volli.local",
        GIT_COMMITTER_NAME: "Volli Test",
        GIT_COMMITTER_EMAIL: "test@volli.local",
      },
    });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  mkdirSync(join(root, "node_modules", "fixture"), { recursive: true });
  writeFileSync(join(root, "node_modules", "fixture", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, ".env"), "FIXTURE=preserved\n");
  return root;
}

/** One door's Done move over a real worktree, through the production worktree bundle. */
async function doneThrough(door: Door, busy: boolean) {
  const root = seedGitWorktree();
  const dataDir = mkdtempSync(join(tmpdir(), "volli-ticket-move-data-"));
  tempDirs.push(dataDir);
  seed(root);
  try {
    const invalidate = vi.spyOn(getWorktreeSnapshots(), "invalidate");
    const detached: Promise<unknown>[] = [];
    const { handlers, published } = host({
      productionWorktree: { dataDir },
      busyWorktreeSites: async () => (busy ? [{ directory: root, surface: "agent" }] : []),
      detachedWork: { track: (work) => void detached.push(work) },
    });
    const reply = await (await opener(door, handlers))("done");
    // The reply never waits for the trim; the trim is enrolled to drain.
    expect(detached).toHaveLength(1);
    await Promise.all(detached);
    return {
      reply,
      dependenciesKept: existsSync(join(root, "node_modules")),
      env: readFileSync(join(root, ".env"), "utf8"),
      trimEvents: listTicketEvents(ctx.db, "ticket-1")
        .filter((event) => event.payload.kind === "worktree_trimmed")
        .map(({ actor, payload }) => ({ actor, kind: payload.kind })),
      invalidated: invalidate.mock.calls.map(([ticketId]) => ticketId),
      worktreeChanges: published.filter((change) => change.kind === "worktree"),
    };
  } finally {
    vi.restoreAllMocks();
    ctx.cleanup();
  }
}

describe("a Done move's detached trim, through every door", () => {
  it("is refused on a busy worktree, whichever door moved it", async () => {
    for (const door of DOORS) {
      expect(await doneThrough(door, true), door).toEqual({
        reply: { ok: true, status: "done" },
        dependenciesKept: true,
        env: "FIXTURE=preserved\n",
        trimEvents: [],
        invalidated: [],
        worktreeChanges: [],
      });
    }
  });

  it("completes detached, records it durably and invalidates, the same on every door", async () => {
    for (const door of DOORS) {
      expect(await doneThrough(door, false), door).toEqual({
        reply: { ok: true, status: "done" },
        dependenciesKept: false,
        env: "FIXTURE=preserved\n",
        trimEvents: [{ actor: "automation", kind: "worktree_trimmed" }],
        invalidated: ["ticket-1"],
        // Pushed to the desktop window too: only the board change is not echoed.
        worktreeChanges: [{ projectId, ticketId: "ticket-1", kind: "worktree" }],
      });
    }
  });
});
