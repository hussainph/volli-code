/**
 * Every router procedure is a projection of the host's handler map (VC-668):
 * it reaches exactly `handlers[its own key]`, and nothing else in the map.
 *
 * The context types already hold no domain port but `handlers`
 * (`RouterContextPorts`); this drives each procedure through the real
 * builders with a map that records what it is asked for, so a resolver that
 * reached another key, or two, fails here. `SAMPLE_INPUTS` is total over the
 * served paths, so a procedure added without a row does not compile.
 */
import { LOCAL_DEVICE_ACTOR, type HostActor } from "@volli/host-protocol";
import {
  DESKTOP_HANDLER_KEYS,
  DOOR_LOCAL_CATALOG_KEYS,
  HandlerRefusedError,
  HOST_HANDLER_KEYS,
  OperationUnavailableError,
  type HandlerCall,
  type Ticket,
} from "@volli/shared";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  createBoardRouter,
  TICKET_RESOURCE,
  type BoardRouterContextPorts,
  type BoardRouterHandlersCoverage,
} from "./board-router";
import {
  createCatalogBuilders,
  handlerCallOf,
  type ProcedurePaths,
  hostAnswer,
  HostProcedureError,
  LOCAL_DESKTOP_CALLER,
  type RouterCaller,
} from "./catalog";
import type { ExampleAreaContextPorts } from "./example-area.test-support";
import {
  createDesktopRouter,
  type DesktopRouter,
  type DesktopRouterContextPorts,
  type DesktopRouterHandlersCoverage,
} from "./desktop-router";
import type { HostRouterPaths } from "./host-router";
import {
  createSessionRouter,
  RpcDiagnosticLog,
  type SessionRouterContextPorts,
  type SessionRouterHandlersCoverage,
} from "./index";

const SESSION = { sessionId: "session-1" };
const PROJECT = "project-1";
const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const FLOW = "flow-1";
const COMMAND = "00000000-0000-4000-8000-000000000001";

/** One valid input per served procedure path, both tiers. */
const SAMPLE_INPUTS: {
  readonly [Path in HostRouterPaths | ProcedurePaths<DesktopRouter["_def"]["record"]>]: unknown;
} = {
  "project.reorder": { orderedIds: [PROJECT] },
  "worktree.trimSettings": undefined,
  "hosts.snapshot": undefined,
  "hosts.subscribe": undefined,
  "hosts.retry": { hostId: HOST },
  "hosts.updateHost": { hostId: HOST, when: "when-idle" },
  "hosts.cancelScheduledUpdate": { hostId: HOST },
  "hosts.signIn": { hostId: HOST, providerId: "anthropic" },
  "hosts.forget": { hostId: HOST },
  "hostAdd.start": { target: "you@box", name: "Box" },
  "hostAdd.subscribe": { flowId: FLOW },
  "hostAdd.answer": { flowId: FLOW, questionId: "q1", answer: { kind: "accept-host-key" } },
  "hostAdd.sudoPassword": { flowId: FLOW, questionId: "q1", password: "sudo-password" },
  "hostAdd.retry": { flowId: FLOW, from: "install" },
  "hostAdd.cancel": { flowId: FLOW },
  "hostSignIns.status": { hostId: HOST },
  "hostSignIns.macKeys": undefined,
  "hostSignIns.sendFromThisMac": { hostId: HOST, providerId: "openrouter", confirmed: true },
  "hostSignIns.setApiKey": { hostId: HOST, providerId: "openrouter", key: "sk-sample" },
  "hostSignIns.setGitCredential": {
    hostId: HOST,
    host: "github.com",
    username: "x-access-token",
    password: "token",
  },
  "hostSignIns.run": { hostId: HOST, providerId: "xai" },
  "hostSignIns.answer": { hostId: HOST, providerId: "xai", promptId: "p", value: "" },
  "hostSignIns.cancel": { hostId: HOST, providerId: "xai" },
  "hosts.rename": { hostId: HOST, name: "Build box" },
  "hosts.devices": { hostId: HOST },
  "hostAdd.facts": { flowId: FLOW },
  "hostLink.query": { workspaceId: HOST, path: "board.snapshot", input: { projectId: HOST } },
  "hostLink.mutate": { workspaceId: HOST, path: "board.setPriority", input: { priority: 1 } },
  "hostLink.subscribe": { workspaceId: HOST, path: "board.changes", lastEventId: "7" },
  "ticket.move": { projectId: PROJECT, ticketId: "ticket-1", toStatus: "done" },
  "sessions.create": { operationId: "op", projectId: PROJECT, ticketId: null, title: null },
  "sessions.attach": { operationId: "op", ...SESSION },
  "settings.experiments": undefined,
  "settings.setExperiment": { id: "cloud", enabled: true },
  "modelAccess.inspect": { refresh: false },
  "modelAccess.defaults": undefined,
  "modelAccess.setDefault": { purpose: "ticket", selection: null },
  "modelAccess.hiddenModels": undefined,
  "modelAccess.setHiddenModels": [],
  "modelAccess.compactionPolicy": undefined,
  "modelAccess.setCompactionPolicy": { autoCompaction: true },
  "modelAccess.codeModePolicy": undefined,
  "modelAccess.setCodeModePolicy": { enabled: true, models: {} },
  "modelAccess.pickerView": undefined,
  "modelAccess.setPickerView": "all",
  "session.snapshot": SESSION,
  "session.history": { ...SESSION, before: 2 },
  "session.projection": SESSION,
  "session.subscribe": SESSION,
  "session.subscribeQueue": SESSION,
  "session.command": {
    commandId: "command-1",
    ...SESSION,
    command: { kind: "executor.interrupt" },
  },
  "session.cancelQueued": { commandId: "cancel", ...SESSION, messageId: "m" },
  "session.editQueued": {
    commandId: "edit",
    ...SESSION,
    messageId: "m",
    message: { id: "m", role: "user", parts: [{ type: "text", text: "edited" }] },
  },
  "session.cancelInteraction": { ...SESSION, interactionId: "interaction-1" },
  "session.reconcile": { ...SESSION, attachmentId: "attachment-1" },
  "labDiagnostics.list": undefined,
  "labDiagnostics.subscribe": {},
  "logs.tail": { limit: 10 },
  "logs.follow": {},
  "protocol.welcome": undefined,
  "session.list": { projectId: PROJECT },
  "session.listing": { projectId: PROJECT },
  "session.listingForTicket": { ticketId: "ticket-1" },
  "session.show": { projectId: PROJECT, session: "s-1" },
  "session.peek": { projectId: PROJECT, session: "s-1", lines: 5 },
  "session.answer": { projectId: PROJECT, session: "s-1" },
  "signIns.status": undefined,
  "signIns.setApiKey": { providerId: "anthropic", key: "sk-test-sample" },
  "signIns.signOut": { providerId: "anthropic" },
  "signIns.start": { providerId: "anthropic" },
  "signIns.subscribe": { flowId: "flow-1" },
  "signIns.answer": { flowId: "flow-1", promptId: "prompt-1", value: "pasted" },
  "signIns.cancel": { flowId: "flow-1" },
  "signIns.setGitCredential": { host: "github.com", username: "x", password: "token" },
  "signIns.clearGitCredential": { host: "github.com" },
  "auth.callback.deliver": { flowId: "flow-1", pathAndQuery: "/callback?code=c&state=s" },
  "board.snapshot": { projectId: PROJECT },
  "board.roster": { projectId: PROJECT },
  "board.changes": { projectId: PROJECT },
  "board.projectFolder": { projectId: PROJECT },
  "board.ticketBody": { ticketId: "ticket-1" },
  "board.archivedTickets": { projectId: PROJECT },
  "board.ticketEvents": { ticketId: "ticket-1" },
  "board.latestSignals": { projectId: PROJECT },
  "board.statusEntries": { projectId: PROJECT },
  "board.comments": { ticketId: "ticket-1" },
  "board.updateProject": { commandId: COMMAND, projectId: PROJECT, baseBranch: null },
  "board.setSkillModes": { commandId: COMMAND, projectId: PROJECT, modes: {} },
  "board.setSessionDefaults": { commandId: COMMAND, projectId: PROJECT, model: null },
  "board.createTicket": { commandId: COMMAND, projectId: PROJECT, status: "todo", title: "T" },
  "board.moveTickets": {
    commandId: COMMAND,
    projectId: PROJECT,
    ticketIds: ["ticket-1"],
    toStatus: "done",
    toIndex: 0,
  },
  "board.setPriority": { commandId: COMMAND, ticketId: "ticket-1", priority: "high" },
  "board.updateTicket": { commandId: COMMAND, ticketId: "ticket-1", title: "T" },
  "board.setLabels": { commandId: COMMAND, ticketId: "ticket-1", labels: ["ui"] },
  "board.archiveTicket": { commandId: COMMAND, ticketId: "ticket-1" },
  "board.unarchiveTicket": { commandId: COMMAND, ticketId: "ticket-1" },
  "board.deleteTicket": { commandId: COMMAND, ticketId: "ticket-1" },
  "board.createComment": { commandId: COMMAND, ticketId: "ticket-1", body: "hi" },
  "board.updateComment": { commandId: COMMAND, commentId: "comment-1", body: "hi" },
  "board.removeComment": { commandId: COMMAND, commentId: "comment-1" },
  "board.setLabelColor": { commandId: COMMAND, labelId: "label-1", color: null },
};

class Reached extends Error {}

/** A map that records each key read, and whose every handler stops the call there. */
function recordingHandlers(): { handlers: never; reached: string[] } {
  const reached: string[] = [];
  const handlers = new Proxy(
    {},
    {
      get(_target, key) {
        reached.push(String(key));
        return () => {
          throw new Reached(String(key));
        };
      },
    },
  );
  return { handlers: handlers as never, reached };
}

type Procedure = (input?: unknown) => Promise<unknown>;

function procedureAt(caller: object, path: string): Procedure {
  let at: unknown = caller;
  for (const part of path.split(".")) at = (at as Record<string, unknown>)[part];
  return at as Procedure;
}

async function drive(procedure: Procedure, input: unknown): Promise<void> {
  const result = await procedure(input).catch((error: unknown) => error);
  // A subscription opens lazily: its handler is reached on the first read.
  if (result !== null && typeof result === "object" && Symbol.asyncIterator in result) {
    const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    await iterator.next().catch(() => undefined);
  }
}

function routerCallers(handlers: never) {
  const context = { caller: LOCAL_DESKTOP_CALLER, handlers, diagnostics: new RpcDiagnosticLog() };
  return {
    session: createSessionRouter().createCaller(context),
    board: createBoardRouter().createCaller(context),
    desktop: createDesktopRouter().createCaller(context),
  };
}

describe("every router procedure projects its own handler (VC-668)", () => {
  it("holds no domain port but the map, and a handler for every family key", () => {
    expectTypeOf<SessionRouterContextPorts>().toEqualTypeOf<never>();
    expectTypeOf<BoardRouterContextPorts>().toEqualTypeOf<never>();
    expectTypeOf<ExampleAreaContextPorts>().toEqualTypeOf<never>();
    expectTypeOf<SessionRouterHandlersCoverage>().toEqualTypeOf<never>();
    expectTypeOf<BoardRouterHandlersCoverage>().toEqualTypeOf<never>();
    expectTypeOf<DesktopRouterContextPorts>().toEqualTypeOf<never>();
    expectTypeOf<DesktopRouterHandlersCoverage>().toEqualTypeOf<never>();
  });

  it.each(HOST_HANDLER_KEYS)("%s reaches handlers[%s] and nothing else", async (key) => {
    const { handlers, reached } = recordingHandlers();
    const callers = routerCallers(handlers);
    // Both tiers (D-A1 = (c)): a desktop-only key is projected by the
    // desktop router exactly as a public key is by its area's.
    const caller =
      key === "ticket.move" || key.startsWith("board.")
        ? callers.board
        : (DESKTOP_HANDLER_KEYS as readonly string[]).includes(key)
          ? callers.desktop
          : callers.session;
    await drive(procedureAt(caller, key), SAMPLE_INPUTS[key]);
    expect(reached).toEqual([key]);
  });

  it.each(DOOR_LOCAL_CATALOG_KEYS)("%s is the router's own, and reads no handler", async (key) => {
    const { handlers, reached } = recordingHandlers();
    await drive(procedureAt(routerCallers(handlers).session, key), SAMPLE_INPUTS[key]);
    expect(reached).toEqual([]);
  });
});

describe("a family built over the whole catalog", () => {
  it("binds any catalog key, as a test-only router may", () => {
    const { hostProcedure } = createCatalogBuilders();
    expect(() => hostProcedure("settings.experiments")).not.toThrow();
  });
});

describe("what a handler is told about the call", () => {
  const WORKSPACE = "9f6a2d4e-0b7c-4c1e-8a35-2f6d9e0c7b14";
  const DEVICE = "3c1d8e2a-6f4b-4a9e-b7d0-1e5c9a2f8b36";

  it("names the person, and the desktop's own window, from the door's caller", () => {
    expect(handlerCallOf(LOCAL_DEVICE_ACTOR)).toEqual({
      actor: { kind: "user" },
      origin: "desktop-window",
    });
    expect(handlerCallOf({ kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE })).toEqual({
      actor: { kind: "user" },
    });
    expect(handlerCallOf({ kind: "session", sessionId: "s-1", workspaceId: WORKSPACE })).toEqual({
      actor: { kind: "session", sessionId: "s-1", ticketId: null },
    });
    expect(() =>
      handlerCallOf({ kind: "worker", workerId: DEVICE, workspaceId: WORKSPACE } as HostActor),
    ).toThrow(HostProcedureError);
  });

  it("answers a handler's unavailable as operation-unavailable, in a stream too", async () => {
    await expect(
      hostAnswer(() => {
        throw new OperationUnavailableError("No runtime here");
      }),
    ).rejects.toMatchObject({ reason: "operation-unavailable", message: "No runtime here" });
    // The brand, on something that is not an Error, still keeps its answer.
    await expect(
      hostAnswer(() => {
        throw { [Symbol.for("@volli/operation-unavailable")]: true };
      }),
    ).rejects.toMatchObject({ reason: "operation-unavailable" });
    const other = new Error("boom");
    await expect(
      hostAnswer(() => {
        throw other;
      }),
    ).rejects.toBe(other);
    await expect(hostAnswer(() => 42)).resolves.toBe(42);

    const handlers = {
      "session.subscribe": () => {
        throw new OperationUnavailableError("The Session runtime is unavailable on this host");
      },
      "settings.experiments": () => {
        throw new OperationUnavailableError("Experimental settings are unavailable");
      },
    } as never;
    const { session } = routerCallers(handlers);
    await expect(session.settings.experiments()).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      reason: "operation-unavailable",
    });
    const stream = await session.session.subscribe(SESSION);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      reason: "operation-unavailable",
    });
  });
});

/** What the map throws when a door's policy refuses, before any handler runs. */
function refusedAtMap(): never {
  throw new HandlerRefusedError("settings.experiments is not open to this caller.");
}

describe("a refusal at the map", () => {
  it("answers FORBIDDEN / verb-refused, the router's own refusal, in a stream too", async () => {
    // The map judges the door's policy again before any handler; when it
    // refuses, the router says what its own middleware would have said.
    const { session, board } = routerCallers({
      "settings.experiments": refusedAtMap,
      "session.subscribe": refusedAtMap,
      "ticket.move": refusedAtMap,
    } as never);
    await expect(session.settings.experiments()).rejects.toMatchObject({
      code: "FORBIDDEN",
      reason: "verb-refused",
      message: "settings.experiments is not open to this caller.",
    });
    await expect(
      board.ticket.move({ projectId: PROJECT, ticketId: "ticket-1", toStatus: "done" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
    const stream = await session.session.subscribe(SESSION);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "FORBIDDEN",
      reason: "verb-refused",
    });
  });
});

describe("the board router's ticket.move", () => {
  const WORKSPACE = "9f6a2d4e-0b7c-4c1e-8a35-2f6d9e0c7b14";
  const OTHER = "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081";
  const DEVICE = "3c1d8e2a-6f4b-4a9e-b7d0-1e5c9a2f8b36";
  const device: RouterCaller = {
    actor: { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE },
    current: () => true,
  };
  const moved = { id: "ticket-1", status: "done", order: 3 } as Ticket;

  function board(caller: RouterCaller) {
    const calls: { input: unknown; call: HandlerCall }[] = [];
    const router = createBoardRouter().createCaller({
      caller,
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: (resource) =>
        resource.kind === TICKET_RESOURCE && resource.id === "ticket-1" ? WORKSPACE : null,
      handlers: {
        "ticket.move": (input: unknown, call: HandlerCall) => {
          calls.push({ input, call });
          return [{ id: "ticket-0", status: "todo", order: 0 } as Ticket, moved];
        },
      } as never,
    });
    return { router, calls };
  }

  it("hands a paired device's move to the handler as the person's, and answers the moved ticket", async () => {
    const { router, calls } = board(device);
    await expect(
      router.ticket.move({ projectId: WORKSPACE, ticketId: "ticket-1", toStatus: "done" }),
    ).resolves.toEqual({ ticket: { id: "ticket-1", status: "done", order: 3 } });
    expect(calls).toEqual([
      {
        input: { projectId: WORKSPACE, ticketId: "ticket-1", toStatus: "done" },
        call: { actor: { kind: "user" } },
      },
    ]);
  });

  it("refuses a board the ticket is not on, and a Session, before the handler", async () => {
    const { router, calls } = board(device);
    await expect(
      router.ticket.move({ projectId: OTHER, ticketId: "ticket-1", toStatus: "done" }),
    ).rejects.toMatchObject({ reason: "workspace-unknown" });
    const agent = board({
      actor: { kind: "session", sessionId: "s-1", workspaceId: WORKSPACE },
      current: () => true,
    });
    await expect(
      agent.router.ticket.move({ projectId: WORKSPACE, ticketId: "ticket-1", toStatus: "done" }),
    ).rejects.toMatchObject({ reason: "verb-refused" });
    expect([...calls, ...agent.calls]).toEqual([]);
  });

  it("tells the handler the desktop's own window is calling", async () => {
    const { router, calls } = board(LOCAL_DESKTOP_CALLER);
    await router.ticket.move({ projectId: WORKSPACE, ticketId: "ticket-1", toStatus: "done" });
    expect(calls[0]!.call).toEqual({ actor: { kind: "user" }, origin: "desktop-window" });
  });
});
