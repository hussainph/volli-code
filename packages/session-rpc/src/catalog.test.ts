import { getTRPCErrorShape, initTRPC, TRPCError } from "@trpc/server";
import type { HostActor } from "@volli/host-protocol";
import {
  SessionRuntimeCommandConflictError,
  SessionRuntimeConflictError,
  type SessionRuntime,
} from "@volli/session-engine";
import {
  createSessionProjectionCheckpoint,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  QUEUE_REVISION_CONFLICT,
  type BoardEntry,
  type HostWorkspaceEntry,
  type VerbEntry,
  type CatalogKeyOf,
} from "@volli/shared";
import { describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  createCatalogBuilders,
  hostErrorOf,
  HostProcedureError,
  jsonByteLength,
  LOCAL_DESKTOP_CALLER,
  type CatalogCallerContext,
  type ConnectionAdmission,
  type CatalogMismatch,
  type ProcedurePaths,
  type RouterCaller,
} from "./catalog";
import {
  assertCatalogBound,
  catalogRouter,
  hostProcedure,
  workspaceProcedure,
  type SessionRouterEntry,
} from "./session-catalog";
import type {
  HostRouterCatalogBinding,
  HostRouterPaths,
  HostRouterPathsDisjoint,
} from "./host-router";
import {
  createSessionRouter,
  RpcDiagnosticLog,
  type AppRouter,
  type SessionRouterCatalogBinding,
  type SessionRouterContext,
} from "./index";
import { sessionContext } from "./session-handlers.test-support";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_WORKSPACE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";

const session = {
  id: "session-1",
  projectId: WORKSPACE,
  ticketId: null,
  role: "project" as const,
  parentSessionId: null,
  title: null,
  createdAt: 10,
};

/** Which Workspace owns each Session the fixture knows; anything else is absent. */
const OWNERS: Readonly<Record<string, string>> = {
  "session-1": WORKSPACE,
  "foreign-session": OTHER_WORKSPACE,
};

function fixture(caller: RouterCaller) {
  const projection = createSessionProjectionCheckpoint(session, []).projection;
  const runtime = {
    snapshot: vi.fn(async () => ({
      projection,
      throughSequence: 1,
      frames: [],
      before: null,
      transcript: [],
      latestReply: null,
    })),
    history: vi.fn(async () => ({ frames: [], before: null })),
    projection: vi.fn(async () => ({ projection, throughSequence: 1 })),
    command: vi.fn<SessionRuntime["command"]>(async () => {
      throw new Error("not reached");
    }),
    subscribe: vi.fn(async () => () => {}),
    cancelInteraction: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    close: async () => {},
  } satisfies SessionRuntime;
  const createSession = vi.fn(async () => ({ sessionId: "created" }));
  const context: SessionRouterContext = sessionContext({
    caller,
    runtime,
    diagnostics: new RpcDiagnosticLog(),
    resourceWorkspace: ({ id }) => OWNERS[id] ?? null,
    readModelAccessDefaults: () => EMPTY_MODEL_ACCESS_DEFAULTS,
    createSession,
  });
  return { runtime, createSession, caller: createSessionRouter().createCaller(context) };
}

/** A network caller, whose door supplies the grant check every network caller must carry. */
function as(actor: HostActor, current: () => boolean = () => true): RouterCaller {
  return { actor, current };
}

const device = as({ kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE });
const sessionActor = as({ kind: "session", sessionId: "agent", workspaceId: WORKSPACE });
const worker = as({ kind: "worker", workerId: DEVICE, workspaceId: WORKSPACE });

async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the router to refuse this call");
}

describe("output validation doors", () => {
  it("skips the parser only on trusted local IPC; network actors cannot forge that bypass", async () => {
    const parse = vi.fn((value: string) => value);
    const output = z.string().transform(parse);
    const router = catalogRouter({
      session: {
        projection: workspaceProcedure(
          "session.projection",
          z.object({ sessionId: z.string().min(1) }),
          ({ sessionId }) => ({ kind: "session", id: sessionId }),
        )
          .output(output)
          .use(({ next }) => next())
          .output(output)
          .query(() => "answer"),
      },
    });
    const call = (caller: RouterCaller, transport?: CatalogCallerContext["transport"]) =>
      router.createCaller(
        sessionContext({
          caller,
          transport,
          runtime: {},
          diagnostics: new RpcDiagnosticLog(),
          resourceWorkspace: () => WORKSPACE,
        }),
      );
    const input = { sessionId: "session-1" };
    await expect(
      call(LOCAL_DESKTOP_CALLER, "electron-ipc").session.projection(input),
    ).resolves.toBe("answer");
    expect(parse).not.toHaveBeenCalled();
    await expect(
      call(LOCAL_DESKTOP_CALLER, "electron-ipc").session.projection({ sessionId: "" }),
    ).rejects.toThrow();
    expect(parse).not.toHaveBeenCalled();
    await call(device, "electron-ipc").session.projection(input);
    await call(device, "websocket").session.projection(input);
    await call(LOCAL_DESKTOP_CALLER).session.projection(input);
    expect(parse).toHaveBeenCalledTimes(6);
  });
});

describe("the actor matrix (VC-564)", () => {
  it("admits the desktop's own window to every entry, the lab's included", async () => {
    const { caller } = fixture(LOCAL_DESKTOP_CALLER);
    await expect(caller.session.projection({ sessionId: "session-1" })).resolves.toBeDefined();
    await expect(caller.modelAccess.defaults()).resolves.toEqual(EMPTY_MODEL_ACCESS_DEFAULTS);
    await expect(caller.labDiagnostics.list()).resolves.toBeDefined();
  });

  it("admits a paired device as the person, to what the WebSocket projects", async () => {
    const { caller } = fixture(device);
    await expect(caller.session.projection({ sessionId: "session-1" })).resolves.toBeDefined();
    await expect(caller.modelAccess.defaults()).resolves.toEqual(EMPTY_MODEL_ACCESS_DEFAULTS);
    // No access mode: the router keeps it for the in-process lab only.
    expect(await refusal(caller.labDiagnostics.list())).toMatchObject({
      code: "FORBIDDEN",
      reason: "verb-refused",
    });
  });

  it("refuses a Session every person-only entry, before the handler", async () => {
    const { caller, runtime } = fixture(sessionActor);
    for (const call of [
      caller.session.snapshot({ sessionId: "session-1" }),
      caller.session.cancelQueued({ commandId: "cancel", sessionId: "session-1", messageId: "m" }),
      caller.session.editQueued({
        commandId: "edit",
        sessionId: "session-1",
        messageId: "m",
        message: { id: "m", role: "user", parts: [{ type: "text", text: "edited" }] },
      }),
      caller.modelAccess.defaults(),
    ]) {
      expect(await refusal(call)).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
    }
    expect(runtime.snapshot).not.toHaveBeenCalled();
  });

  it("refuses every worker until it can act for a hosted Session (D10)", async () => {
    const { caller, runtime } = fixture(worker);
    expect(await refusal(caller.session.snapshot({ sessionId: "session-1" }))).toMatchObject({
      code: "FORBIDDEN",
      reason: "verb-refused",
    });
    expect(await refusal(caller.settings.experiments())).toMatchObject({ reason: "verb-refused" });
    expect(runtime.snapshot).not.toHaveBeenCalled();
  });

  it("refuses a network caller whose door supplied no grant check, before the handler", async () => {
    // Only the type stands between a door and this caller; the router holds too.
    const unchecked = {
      actor: { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE },
    } as unknown as RouterCaller;
    const { caller, runtime } = fixture(unchecked);
    const readExperiments = vi.fn(() => ({ cloud: { enabled: false, source: "default" } }));
    const settings = createSessionRouter().createCaller(
      sessionContext({
        caller: unchecked,
        runtime,
        diagnostics: new RpcDiagnosticLog(),
        readExperiments: readExperiments as never,
      }),
    );
    for (const call of [
      caller.session.projection({ sessionId: "session-1" }),
      settings.settings.experiments(),
    ]) {
      expect(hostErrorOf(await refusal(call))).toEqual({
        code: "UNAUTHORIZED",
        message: "This connection's credential is no longer valid.",
        reason: "credential-invalid",
      });
    }
    expect(runtime.projection).not.toHaveBeenCalled();
    expect(readExperiments).not.toHaveBeenCalled();
  });

  it("refuses a caller whose actor no verifier could have minted", async () => {
    for (const actor of [
      { kind: "device", deviceId: DEVICE },
      { kind: "session", sessionId: "agent" },
      { kind: "device", deviceId: "local", workspaceId: WORKSPACE },
    ]) {
      const { caller, runtime } = fixture({
        actor,
        current: () => true,
      } as unknown as RouterCaller);
      expect(await refusal(caller.session.projection({ sessionId: "session-1" }))).toMatchObject({
        code: "UNAUTHORIZED",
        reason: "credential-invalid",
      });
      expect(runtime.projection).not.toHaveBeenCalled();
    }
  });

  // VC-564 re-check B3: the desktop's exemptions belong to its one actor
  // object, never to a lookalike some caller built.
  it("refuses a local-shaped actor that is not the desktop's own, before any read", async () => {
    for (const actor of [
      { kind: "device", deviceId: "local" },
      { kind: "device", deviceId: "local", network: true, workerId: DEVICE },
    ]) {
      const { caller, runtime } = fixture({ actor } as unknown as RouterCaller);
      const lookup = vi.fn(() => OTHER_WORKSPACE);
      const lookalike = createSessionRouter().createCaller(
        sessionContext({
          caller: { actor } as unknown as RouterCaller,
          runtime,
          diagnostics: new RpcDiagnosticLog(),
          resourceWorkspace: lookup,
        }),
      );
      for (const call of [
        caller.session.projection({ sessionId: "foreign-session" }),
        lookalike.session.projection({ sessionId: "foreign-session" }),
      ]) {
        expect(hostErrorOf(await refusal(call))).toEqual({
          code: "UNAUTHORIZED",
          message: "This connection's credential is no longer valid.",
          reason: "credential-invalid",
        });
      }
      expect(lookup).not.toHaveBeenCalled();
      expect(runtime.projection).not.toHaveBeenCalled();
    }
  });

  it("honors a checker the desktop's own window chooses to carry", async () => {
    const { caller, runtime } = fixture({ ...LOCAL_DESKTOP_CALLER, current: () => false });
    expect(await refusal(caller.session.projection({ sessionId: "session-1" }))).toMatchObject({
      reason: "credential-invalid",
    });
    expect(runtime.projection).not.toHaveBeenCalled();
  });

  it("re-checks the grant at every dispatch, not only at connect", async () => {
    let current = true;
    const { caller, runtime } = fixture(
      as({ kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE }, () => current),
    );
    await caller.session.projection({ sessionId: "session-1" });
    current = false;
    expect(await refusal(caller.session.projection({ sessionId: "session-1" }))).toMatchObject({
      code: "UNAUTHORIZED",
      reason: "credential-invalid",
    });
    expect(runtime.projection).toHaveBeenCalledTimes(1);
  });
});

describe("follow-up feature compatibility", () => {
  it("does not widen sessions: edits/cancels require the new queue feature", async () => {
    const runtime = {
      command: vi.fn<SessionRuntime["command"]>(async () => {
        throw new Error("not reached");
      }),
    };
    const caller = createSessionRouter().createCaller({
      ...sessionContext({
        caller: device,
        runtime,
        diagnostics: new RpcDiagnosticLog(),
        resourceWorkspace: () => WORKSPACE,
      }),
      operations: new Set(["session.command"]),
    });
    await expect(
      caller.session.cancelQueued({ commandId: "cancel", sessionId: "session-1", messageId: "m" }),
    ).rejects.toMatchObject({ reason: "verb-refused" });
    await expect(
      caller.session.editQueued({
        commandId: "edit",
        sessionId: "session-1",
        messageId: "m",
        message: { id: "m", role: "user", parts: [{ type: "text", text: "edited" }] },
      }),
    ).rejects.toMatchObject({ reason: "verb-refused" });
    expect(runtime.command).not.toHaveBeenCalled();
  });
});

describe("workspace scope, before any read", () => {
  it("answers a Session in another Workspace exactly as an absent one, and reads neither", async () => {
    const { caller, runtime } = fixture(device);
    const foreign = await refusal(caller.session.snapshot({ sessionId: "foreign-session" }));
    const absent = await refusal(caller.session.snapshot({ sessionId: "no-such-session" }));
    expect(hostErrorOf(foreign)).toEqual({
      code: "NOT_FOUND",
      message: "Not found in this Workspace.",
      reason: "workspace-unknown",
    });
    expect(hostErrorOf(absent)).toEqual(hostErrorOf(foreign));
    expect(runtime.snapshot).not.toHaveBeenCalled();
  });

  it("scopes every Session procedure, the stream and the writes included", async () => {
    const { caller, runtime } = fixture(device);
    const sessionId = "foreign-session";
    const calls = [
      () => caller.session.projection({ sessionId }),
      () => caller.session.subscribe({ sessionId }),
      () =>
        caller.session.command({
          commandId: "c",
          sessionId,
          command: { kind: "executor.interrupt" },
        }),
      () => caller.session.cancelQueued({ commandId: "cancel", sessionId, messageId: "m" }),
      () =>
        caller.session.editQueued({
          commandId: "edit",
          sessionId,
          messageId: "m",
          message: { id: "m", role: "user", parts: [{ type: "text", text: "edited" }] },
        }),
      () => caller.session.cancelInteraction({ sessionId, interactionId: "i" }),
      () => caller.session.reconcile({ sessionId, attachmentId: "a" }),
      () => caller.sessions.attach({ operationId: "o", sessionId }),
    ];
    for (const call of calls) {
      expect(await refusal(call())).toMatchObject({ reason: "workspace-unknown" });
    }
    for (const spy of Object.values(runtime)) {
      if (vi.isMockFunction(spy)) expect(spy).not.toHaveBeenCalled();
    }
  });

  it("authorizes a create by the project it names", async () => {
    const { caller, createSession } = fixture(device);
    const create = (projectId: string) =>
      caller.sessions.create({ operationId: "o", projectId, ticketId: null, title: null });
    expect(await refusal(create(OTHER_WORKSPACE))).toMatchObject({
      code: "NOT_FOUND",
      reason: "workspace-unknown",
    });
    expect(createSession).not.toHaveBeenCalled();
    await expect(create(WORKSPACE)).resolves.toEqual({ sessionId: "created" });
  });

  it("refuses a call that names no resource this caller could own", async () => {
    const router = catalogRouter({
      session: {
        projection: workspaceProcedure("session.projection", z.object({}), () => null)
          .output(z.string())
          .query(() => "read"),
      },
    });
    const call = (caller: RouterCaller) =>
      router
        .createCaller(sessionContext({ caller, runtime: {}, diagnostics: new RpcDiagnosticLog() }))
        .session.projection({});
    expect(await refusal(call(device))).toMatchObject({ reason: "workspace-unknown" });
    await expect(call(LOCAL_DESKTOP_CALLER)).resolves.toBe("read");
  });

  it("refuses a network caller every Session when no port can say whose it is", async () => {
    const projection = createSessionProjectionCheckpoint(session, []).projection;
    const caller = createSessionRouter().createCaller(
      sessionContext({
        caller: device,
        runtime: { projection: async () => ({ projection, throughSequence: 1 }) } as never,
        diagnostics: new RpcDiagnosticLog(),
      }),
    );
    expect(await refusal(caller.session.projection({ sessionId: "session-1" }))).toMatchObject({
      reason: "workspace-unknown",
    });
  });
});

describe("the error envelope", () => {
  it("maps stale queue mutations to a typed CONFLICT / queue-revision-conflict", async () => {
    const { caller, runtime } = fixture(device);
    class StaleQueue extends Error {
      readonly [QUEUE_REVISION_CONFLICT] = true as const;
    }
    for (const kind of ["cancel", "edit"] as const) {
      runtime.command.mockRejectedValueOnce(new StaleQueue("Queue revision changed"));
      const input = {
        commandId: kind,
        sessionId: "session-1",
        messageId: "m",
        expectedRevision: 0,
      };
      const result =
        kind === "cancel"
          ? caller.session.cancelQueued(input)
          : caller.session.editQueued({
              ...input,
              message: { id: "m", role: "user", parts: [{ type: "text", text: "edited" }] },
            });
      expect(hostErrorOf(await refusal(result))).toEqual({
        code: "CONFLICT",
        reason: "queue-revision-conflict",
        message: "Queue revision changed",
      });
    }
  });

  it("maps a command id reused for another intent to CONFLICT / command-conflict", async () => {
    const { caller, runtime } = fixture(device);
    runtime.command.mockRejectedValueOnce(
      new SessionRuntimeCommandConflictError(
        "Command c is already in flight with different intent",
      ),
    );
    const request = {
      commandId: "c",
      sessionId: "session-1",
      command: { kind: "executor.interrupt" as const },
    };
    expect(hostErrorOf(await refusal(caller.session.command(request)))).toEqual({
      code: "CONFLICT",
      message: "Command c is already in flight with different intent",
      reason: "command-conflict",
    });
    // Any other ledger conflict is not the caller's, and keeps no reason.
    runtime.command.mockRejectedValueOnce(new SessionRuntimeConflictError("ledger fact"));
    expect(hostErrorOf(await refusal(caller.session.command(request)))).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "ledger fact",
    });
  });

  it("sanitizes what crosses: no stack, no cause, no secret, whatever NODE_ENV says", () => {
    // oxlint-disable-next-line no-underscore-dangle -- the formatter tRPC itself calls.
    const config = createSessionRouter()._def._config;
    const error = new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "token=super-secret at /Users/alice/private.txt",
      cause: new Error("inner"),
    });
    const shape = getTRPCErrorShape({
      config,
      error,
      type: "query",
      path: "session.snapshot",
      input: undefined,
      ctx: undefined,
    });
    expect(shape).toEqual({
      code: -32603,
      message: "token: [REDACTED] at [HOME]",
      data: {
        code: "INTERNAL_SERVER_ERROR",
        httpStatus: 500,
        path: "session.snapshot",
        hostError: { code: "INTERNAL_SERVER_ERROR", message: "token: [REDACTED] at [HOME]" },
      },
    });
    expect(JSON.stringify(shape)).not.toMatch(/stack|inner|super-secret/);
    const unpathed = getTRPCErrorShape({
      config,
      error: new HostProcedureError("verb-refused", "refused"),
      type: "unknown",
      path: undefined,
      input: undefined,
      ctx: undefined,
    });
    expect(unpathed.data).toEqual({
      code: "FORBIDDEN",
      httpStatus: 403,
      hostError: { code: "FORBIDDEN", message: "refused", reason: "verb-refused" },
    });
  });

  it("reads one envelope from whatever a link caught", () => {
    expect(hostErrorOf(new HostProcedureError("subscription-overflow", "behind"))).toEqual({
      code: "TOO_MANY_REQUESTS",
      message: "behind",
      reason: "subscription-overflow",
    });
    expect(hostErrorOf(new Error("password=hunter2"))).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "password: [REDACTED]",
    });
    expect(hostErrorOf("thrown string", "Session subscription failed")).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "Session subscription failed",
    });
    expect(hostErrorOf(Object.assign(new Error("gone"), { code: "NOT_FOUND" }))).toEqual({
      code: "NOT_FOUND",
      message: "gone",
    });
    expect(hostErrorOf(Object.assign(new Error("odd"), { code: "ENOENT" }))).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "odd",
    });
    expect(hostErrorOf(undefined)).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "Session RPC request failed",
    });
  });
});

describe("binding procedures to the catalog (D2)", () => {
  it("binds the Session router to its family's entries exactly, at compile time", () => {
    expectTypeOf<SessionRouterCatalogBinding>().toEqualTypeOf<never>();
    expectTypeOf<
      CatalogMismatch<ProcedurePaths<AppRouter["_def"]["record"]>, CatalogKeyOf<SessionRouterEntry>>
    >().toEqualTypeOf<never>();
    // Alone, the Session router leaves the board's commands unserved; the union
    // over every router (host-router.ts) is the catalog exactly.
    expectTypeOf<CatalogMismatch<ProcedurePaths<AppRouter["_def"]["record"]>>>().toEqualTypeOf<
      CatalogKeyOf<BoardEntry | HostWorkspaceEntry>
    >();
    expectTypeOf<HostRouterCatalogBinding>().toEqualTypeOf<never>();
    expectTypeOf<HostRouterPathsDisjoint>().toEqualTypeOf<never>();
  });

  it("fails to compile a procedure with no catalog entry, or a scope it does not have", () => {
    // @ts-expect-error -- no Verb Registry entry declares `rogue.verb`: no policy, no procedure.
    expect(() => hostProcedure("rogue.verb")).toThrow("No catalog entry declares rogue.verb");
    // @ts-expect-error -- a workspace entry cannot be built without its resource resolver.
    expect(() => hostProcedure("session.snapshot")).toThrow(
      "Catalog entry session.snapshot is workspace-scoped, not host-scoped",
    );
    expect(() =>
      // @ts-expect-error -- a host entry has no Workspace resource to authorize.
      workspaceProcedure("settings.experiments", z.object({}), () => null),
    ).toThrow("Catalog entry settings.experiments is host-scoped, not workspace-scoped");
    const rogue = initTRPC.create().procedure.query(() => "unpoliced");
    type WithRogue = ProcedurePaths<AppRouter["_def"]["record"] & { rogue: typeof rogue }>;
    expectTypeOf<CatalogMismatch<WithRogue | HostRouterPaths>>().toEqualTypeOf<"rogue">();
    // @ts-expect-error -- a router carrying it fails the binding assertion.
    expectTypeOf<CatalogMismatch<WithRogue | HostRouterPaths>>().toEqualTypeOf<never>();
  });

  it("refuses at construction a procedure the catalog did not build", () => {
    const rogue = initTRPC.context<SessionRouterContext>().create().procedure;
    expect(() => catalogRouter({ settings: { experiments: rogue.query(() => null) } })).toThrow(
      "Procedure settings.experiments was not built from its catalog entry",
    );
  });

  it("refuses a procedure at another entry's path", () => {
    const misplaced = hostProcedure("settings.experiments").query(() => null);
    expect(() => catalogRouter({ settings: { setExperiment: misplaced } })).toThrow(
      "Procedure settings.setExperiment was not built from its catalog entry",
    );
  });

  // VC-564 review B1: metadata anyone can set is not provenance.
  it("refuses a bare procedure that only claims its entry in metadata", () => {
    const readExperiments = vi.fn();
    const forged = initTRPC
      .context<SessionRouterContext>()
      .meta<{ catalogKey: "settings.experiments" }>()
      .create()
      .procedure.meta({ catalogKey: "settings.experiments" })
      .query(readExperiments);
    expect(() => catalogRouter({ settings: { experiments: forged } })).toThrow(
      "Procedure settings.experiments was not built from its catalog entry",
    );
    expect(readExperiments).not.toHaveBeenCalled();
  });

  it("refuses a host procedure retagged as a workspace entry, before any read", () => {
    const snapshot = vi.fn();
    const retagged = hostProcedure("modelAccess.inspect")
      .meta({ catalogKey: "session.snapshot" } as never)
      .input(z.object({ sessionId: z.string() }))
      .query(snapshot);
    expect(() => catalogRouter({ session: { snapshot: retagged } })).toThrow(
      "Procedure session.snapshot was not built from its catalog entry",
    );
    expect(snapshot).not.toHaveBeenCalled();
  });

  // VC-663 B1: the entry's chain alone is not enough; its resolver must answer to the admission.
  it("refuses a procedure built on its entry's chain but resolved past the admission guard", () => {
    const resolver = vi.fn();
    const unguarded = initTRPC
      .context<SessionRouterContext>()
      .create()
      .procedure.concat(hostProcedure("settings.experiments"))
      .output(z.null())
      .query(resolver);
    expect(() => catalogRouter({ settings: { experiments: unguarded } })).toThrow(
      "Procedure settings.experiments resolves outside its connection's admission",
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it("refuses a chain that runs anything before the entry's policy", () => {
    const resolver = vi.fn();
    const prefixed = initTRPC
      .context<SessionRouterContext>()
      .create()
      .procedure.use(({ next }) => next())
      .concat(hostProcedure("settings.experiments"))
      .query(resolver);
    expect(() => catalogRouter({ settings: { experiments: prefixed } })).toThrow(
      "Procedure settings.experiments was not built from its catalog entry",
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it("demands an output validator of every command but the named legacy ones", () => {
    expect(() =>
      catalogRouter({
        settings: { experiments: hostProcedure("settings.experiments").query(() => null) },
      }),
    ).toThrow("Procedure settings.experiments binds no output validator");
    expect(() =>
      catalogRouter({
        labDiagnostics: {
          list: hostProcedure("labDiagnostics.list")
            .output(z.null())
            .query(() => null),
        },
      }),
    ).toThrow(
      "Procedure labDiagnostics.list binds an output validator; strike it from the legacy exceptions",
    );
  });

  it("refuses a procedure whose type contradicts its entry's idempotency", () => {
    expect(() =>
      catalogRouter({
        settings: { experiments: hostProcedure("settings.experiments").mutation(() => null) },
      }),
    ).toThrow("Procedure settings.experiments is a mutation, but its catalog entry reads");
    expect(() =>
      assertCatalogBound(
        catalogRouter({
          settings: {
            setExperiment: hostProcedure("settings.setExperiment")
              .output(z.null())
              .mutation(() => null),
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      catalogRouter({
        settings: { setExperiment: hostProcedure("settings.setExperiment").query(() => null) },
      }),
    ).toThrow("Procedure settings.setExperiment is a query, but its catalog entry writes");
  });
});

// ---- A connection's admission (VC-663) ------------------------------------

const PROBE_ENTRIES = [
  {
    key: "probe.stream",
    accessModes: ["hostApi"],
    actor: "any",
    handler: { site: "main", id: "probe.stream" },
    listed: false,
    group: "Read",
    summary: "A stream a test drives frame by frame.",
    options: [],
    catalog: { actor: "user", scope: "host", idempotency: "read" },
  },
  {
    key: "probe.read",
    accessModes: ["hostApi"],
    actor: "any",
    handler: { site: "main", id: "probe.read" },
    listed: false,
    group: "Read",
    summary: "A read that answers nothing at all.",
    options: [],
    catalog: { actor: "user", scope: "host", idempotency: "read" },
  },
] as const satisfies readonly VerbEntry[];

/** One connection's admission, with the levers a door pulls. */
function admission(maxStreams = 1) {
  const controller = new AbortController();
  let open = 0;
  const held: ConnectionAdmission = {
    signal: controller.signal,
    openStream: () => (open < maxStreams ? ((open += 1), true) : false),
    closeStream: () => void (open -= 1),
  };
  return {
    held,
    end: () => controller.abort(),
    get open() {
      return open;
    },
  };
}

/** A router whose stream yields what the test hands its `next`. */
function probeRouter(next: (signal: AbortSignal | undefined) => Promise<IteratorResult<number>>) {
  const { hostProcedure: probe, catalogRouter: route } = createCatalogBuilders<
    CatalogCallerContext,
    (typeof PROBE_ENTRIES)[number]
  >({ entries: PROBE_ENTRIES, legacyUnvalidatedOutputs: ["probe.read"] });
  return route({
    probe: {
      stream: probe("probe.stream").subscription(({ signal }) => ({
        [Symbol.asyncIterator]: () => ({
          next: () => next(signal),
          // A source whose own cleanup fails: the stream's end must not surface it.
          return: () => Promise.reject(new Error("cleanup failed")),
        }),
      })),
      read: probe("probe.read").query(() => undefined),
    },
  });
}

function probeCaller(
  router: ReturnType<typeof probeRouter>,
  held: ConnectionAdmission,
  current: () => boolean = () => true,
) {
  return router.createCaller({
    caller: as({ kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE }, current),
    diagnostics: new RpcDiagnosticLog(),
    admission: held,
    maxResponseBytes: 1024,
  });
}

describe("a connection's admission (VC-663)", () => {
  it("ends a stream that resumes after its admission ended, and gives its slot back", async () => {
    const lever = admission();
    let seen: AbortSignal | undefined;
    const router = probeRouter(async (signal) => {
      seen = signal;
      return { done: false, value: 1 };
    });
    const stream = (await probeCaller(router, lever.held).probe.stream()) as AsyncIterable<number>;
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toStrictEqual({ done: false, value: 1 });
    expect(lever.open).toBe(1);
    // The source was handed a signal that aborts with the connection.
    expect(seen?.aborted).toBe(false);
    lever.end();
    expect(seen?.aborted).toBe(true);
    expect(hostErrorOf(await refusal(iterator.next()))).toMatchObject({
      reason: "credential-invalid",
    });
    expect(lever.open).toBe(0);
  });

  it("never opens a stream once the admission ended, nor past its budget", async () => {
    const source = vi.fn(async () => ({ done: true as const, value: undefined }));
    const router = probeRouter(source);
    const ended = admission();
    const late = (await probeCaller(router, ended.held).probe.stream()) as AsyncIterable<number>;
    ended.end();
    expect(hostErrorOf(await refusal(late[Symbol.asyncIterator]().next()))).toMatchObject({
      reason: "credential-invalid",
    });
    const full = admission(0);
    const over = (await probeCaller(router, full.held).probe.stream()) as AsyncIterable<number>;
    expect(hostErrorOf(await refusal(over[Symbol.asyncIterator]().next()))).toMatchObject({
      code: "TOO_MANY_REQUESTS",
      reason: "subscription-limit",
    });
    expect(source).not.toHaveBeenCalled();
    expect([ended.open, full.open]).toStrictEqual([0, 0]);
  });

  it("withholds a frame its source produced in the instant the admission ended", async () => {
    const lever = admission();
    const router = probeRouter(() => {
      const frame = Promise.resolve({ done: false as const, value: 1 });
      // Ends the admission after the frame resolved, before the stream resumes with it.
      void frame.then(() => queueMicrotask(lever.end));
      return frame;
    });
    const stream = (await probeCaller(router, lever.held).probe.stream()) as AsyncIterable<number>;
    expect(hostErrorOf(await refusal(stream[Symbol.asyncIterator]().next()))).toMatchObject({
      reason: "credential-invalid",
    });
    expect(lever.open).toBe(0);
  });

  it("refuses a call before its resolver once the grant lapsed, and answers nothing at all as empty", async () => {
    let valid = true;
    const router = probeRouter(async () => ({ done: true, value: undefined }));
    const caller = probeCaller(router, admission().held, () => valid);
    await expect(caller.probe.read()).resolves.toBeUndefined();
    expect(jsonByteLength(undefined)).toBe(0);
    valid = false;
    expect(hostErrorOf(await refusal(caller.probe.read()))).toMatchObject({
      reason: "credential-invalid",
    });
  });
});
