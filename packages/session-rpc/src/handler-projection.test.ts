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
  DOOR_LOCAL_CATALOG_KEYS,
  HOST_HANDLER_KEYS,
  OperationUnavailableError,
  type HandlerCall,
  type Ticket,
} from "@volli/shared";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { createBoardRouter, TICKET_RESOURCE, type BoardRouterContextPorts } from "./board-router";
import {
  createCatalogBuilders,
  handlerCallOf,
  hostAnswer,
  HostProcedureError,
  LOCAL_DESKTOP_CALLER,
  type RouterCaller,
} from "./catalog";
import type { ExampleAreaContextPorts } from "./example-area.test-support";
import type { HostRouterPaths } from "./host-router";
import {
  createSessionRouter,
  RpcDiagnosticLog,
  type SessionRouterContextPorts,
  type SessionRouterHandlersCoverage,
} from "./index";

const SESSION = { sessionId: "session-1" };
const PROJECT = "project-1";

/** One valid input per served procedure path. */
const SAMPLE_INPUTS: { readonly [Path in HostRouterPaths]: unknown } = {
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
  "session.projection": SESSION,
  "session.subscribe": SESSION,
  "session.command": {
    commandId: "command-1",
    ...SESSION,
    command: { kind: "executor.interrupt" },
  },
  "session.cancelInteraction": { ...SESSION, interactionId: "interaction-1" },
  "session.reconcile": { ...SESSION, attachmentId: "attachment-1" },
  "labDiagnostics.list": undefined,
  "labDiagnostics.subscribe": {},
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
  const [namespace, name] = path.split(".") as [string, string];
  return (caller as Record<string, Record<string, Procedure>>)[namespace]![name]!;
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
  };
}

describe("every router procedure projects its own handler (VC-668)", () => {
  it("holds no domain port but the map, and a handler for every family key", () => {
    expectTypeOf<SessionRouterContextPorts>().toEqualTypeOf<never>();
    expectTypeOf<BoardRouterContextPorts>().toEqualTypeOf<never>();
    expectTypeOf<ExampleAreaContextPorts>().toEqualTypeOf<never>();
    expectTypeOf<SessionRouterHandlersCoverage>().toEqualTypeOf<never>();
  });

  it.each(HOST_HANDLER_KEYS)("%s reaches handlers[%s] and nothing else", async (key) => {
    const { handlers, reached } = recordingHandlers();
    const callers = routerCallers(handlers);
    const caller = key === "ticket.move" ? callers.board : callers.session;
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
        "ticket.move": (input, call) => {
          calls.push({ input, call });
          return [{ id: "ticket-0", status: "todo", order: 0 } as Ticket, moved];
        },
      },
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
