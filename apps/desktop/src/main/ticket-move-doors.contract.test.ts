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
 */
import { randomUUID } from "node:crypto";

import { createAgentCommandService } from "@volli/host-core/agents";
import { getTicketRow, listTicketEvents } from "@volli/host-core/db";
import {
  createTestSessionEngine,
  openTestDb,
  testHostHandlers,
  testProject,
  testTicket,
  type TestDb,
} from "@volli/host-core/testing";
import { insertProject, insertTicket } from "@volli/host-core/db";
import { webSocketContractLink } from "@volli/host-protocol/testing";
import type { HostHandlers } from "@volli/host-core/handlers";
import {
  createBoardRouter,
  RpcDiagnosticLog,
  TICKET_RESOURCE,
  type BoardRouterHandlers,
  type SessionRouterHandlers,
} from "@volli/session-rpc";
import type { DataChangedEvent, TicketMovedNotice, TicketStatus } from "@volli/shared";
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

/** A fresh board: VC-1 alone in Todo. */
function seed(): void {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: projectId, ticketPrefix: "VC", path: "/repo/volli" }));
  insertTicket(
    ctx.db,
    testTicket(projectId, { id: "ticket-1", ticketNumber: 1, status: "todo", order: 0 }),
  );
}

beforeEach(() => {
  // A Workspace id is a UUID on the wire; the project is its own Workspace.
  projectId = randomUUID();
  closers = [];
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  ipc.handlers.clear();
});

/** The host's one map over this database, recording each effect a move may have. */
function host() {
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
  });
  return { handlers, effects: { arrivals, interrupted, notified }, published };
}

/** Moves VC-1 through one production door, answering the door's own reply. */
async function opener(door: Door, handlers: ReturnType<typeof host>["handlers"]) {
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
        const reply = (await channel({ sender: {} }, input)) as {
          ok: boolean;
          tickets: { id: string; status: string }[];
        };
        if (!reply.ok) throw new Error(JSON.stringify(reply));
        return { ok: reply.ok, status: reply.tickets.find(({ id }) => id === "ticket-1")?.status };
      };
    }
    case "websocket": {
      const link = webSocketContractLink({
        router: createBoardRouter(),
        createContext: () => ({
          caller: {
            actor: { kind: "device" as const, deviceId: randomUUID(), workspaceId: projectId },
            current: () => true,
          },
          handlers,
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
        const reply = await connection.client.ticket.move.mutate({
          projectId,
          ticketId: "ticket-1",
          toStatus,
        });
        return { ok: true, status: reply.ticket.status };
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
      });
      return async (toStatus: TicketStatus) => {
        const reply = await service.execute({
          v: 1,
          cmd: "ticket.move",
          args: { id: "VC-1", to: toStatus },
          ctx: { cwd: "/repo/volli", env: { operatorToken: OPERATOR_TOKEN } },
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
