/**
 * The host-protocol command catalog's tRPC projection (VC-564; HP § Command
 * catalog).
 *
 * The declaration half of every command is a Verb Registry entry in
 * `@volli/shared`: its key, actor requirement, scope and idempotency. This
 * module is the only place a Session-router procedure can be built, and it
 * builds each one FROM its entry:
 *
 * - {@link hostProcedure} and {@link workspaceProcedure} take the entry's key,
 *   typed to the catalog's keys of that scope, so a procedure with no entry, or
 *   a workspace procedure with no resource to authorize, does not compile;
 * - every call is then judged by the entry, at dispatch: the caller's grant is
 *   still current, its actor is admitted, any withheld intent is refused, and a
 *   workspace resource is authorized before the handler runs;
 * - {@link catalogRouter} refuses, at construction, a procedure that was not
 *   built here, sits at a path other than its entry's key, or whose tRPC type
 *   contradicts the entry's idempotency;
 * - {@link CatalogMismatch} fails `pnpm typecheck` until the routers' procedure
 *   paths and the catalog's keys are one set (D2).
 *
 * The tRPC instance `t` never leaves this file, so there is no bare procedure
 * builder to reach for.
 */
import {
  initTRPC,
  TRPCError,
  type AnyProcedure,
  type AnyRouter,
  type TRPCCreateRouterOptions,
} from "@trpc/server";
import {
  HOST_ERROR_REASON_CODES,
  isHostErrorCode,
  isLocalDeviceActor,
  LOCAL_DEVICE_ACTOR,
  type CallerActor,
  type HostActorKind,
  type HostError,
  type HostErrorReason,
  type WorkspaceId,
} from "@volli/host-protocol";
import { isSessionCommandConflict } from "@volli/session-engine";
import {
  actorRequirementAdmits,
  catalogEntry,
  HOST_ACTOR_POLICY,
  isolatePerformanceObserver,
  readOptionalPerformanceClock,
  type CatalogEntry,
  type CatalogKey,
  type CatalogKeyScopedTo,
  type HostActorKindName,
} from "@volli/shared";
import type { z } from "zod";

import { sanitizeDiagnosticText } from "./diagnostic-text";
import type {
  RpcProcedurePerformanceObserver,
  RpcProcedurePerformanceSample,
  SessionRouterContext,
} from "./index";

/**
 * Who is calling, as the door that accepted the connection authenticated it.
 * The router reads it from context only; no input field can name or widen it
 * (HP § Auth and workspace authorization).
 */
export interface RouterCaller {
  /**
   * A network actor, bound to one Workspace by its credential, or the
   * desktop's own window, which every Workspace on its host authorizes (D7).
   */
  readonly actor: CallerActor;
  /**
   * Asked again at every dispatch, never only at connect: `false` once the
   * credential behind this connection is revoked or expired, and the call is
   * refused `UNAUTHORIZED` / `credential-invalid`. Absent for a caller nothing
   * can revoke, which today is only the in-process desktop.
   */
  readonly current?: () => boolean;
}

/** The desktop's own window over in-process IPC: the person, in every Workspace (D7). */
export const LOCAL_DESKTOP_CALLER: RouterCaller = Object.freeze({ actor: LOCAL_DEVICE_ACTOR });

/**
 * What a workspace-scoped call names, for the router to authorize before the
 * handler reads anything. A Workspace is a project (HI § Workspace), so a
 * project id is its own Workspace; a Session is resolved through the
 * context's `sessionWorkspace` port. `null`: the call names nothing this
 * caller could own.
 */
export type WorkspaceResource = { readonly sessionId: string } | { readonly projectId: string };

/** A refusal the host protocol names: the reason travels to every client as `data.hostError`. */
export class HostProcedureError extends TRPCError {
  readonly reason: HostErrorReason;

  constructor(reason: HostErrorReason, message: string, cause?: unknown) {
    super({ code: HOST_ERROR_REASON_CODES[reason], message, cause });
    this.reason = reason;
  }
}

/**
 * The one client-visible error, built the same way for every link: the tRPC
 * `errorFormatter` attaches it as `data.hostError`, and the Electron bridge
 * sends it as its failure payload. The message is sanitized and nothing else of
 * the error crosses: no stack, no cause, no secret.
 */
export function hostErrorOf(error: unknown, fallback = "Session RPC request failed"): HostError {
  // A subscription's generator throws through the Electron bridge raw, so a
  // code is read from the error itself, and only a code tRPC knows survives.
  const code =
    error instanceof TRPCError
      ? error.code
      : typeof error === "object" && error !== null && isHostErrorCode(Reflect.get(error, "code"))
        ? (Reflect.get(error, "code") as HostError["code"])
        : "INTERNAL_SERVER_ERROR";
  const message = error instanceof Error ? sanitizeDiagnosticText(error.message) : fallback;
  return error instanceof HostProcedureError
    ? { code, message, reason: error.reason }
    : { code, message };
}

/** Same message for a foreign and an absent resource, so neither reveals the other. */
const WORKSPACE_UNKNOWN_MESSAGE = "Not found in this Workspace.";

/** Pins host-protocol's actor kinds to the shared mapping's, in both directions. */
type AssertNever<Type extends never> = Type;
export type CallerActorKindCoverage = AssertNever<
  Exclude<HostActorKind, HostActorKindName> | Exclude<HostActorKindName, HostActorKind>
>;

interface CatalogMeta {
  readonly catalogKey: CatalogKey;
}

const t = initTRPC
  .context<SessionRouterContext>()
  .meta<CatalogMeta>()
  .create({
    // Never ship a stack, whatever NODE_ENV says.
    isDev: false,
    errorFormatter: ({ shape, error }) => ({
      code: shape.code,
      message: sanitizeDiagnosticText(shape.message),
      data: {
        code: shape.data.code,
        httpStatus: shape.data.httpStatus,
        ...(shape.data.path === undefined ? {} : { path: shape.data.path }),
        hostError: hostErrorOf(error),
      },
    }),
  });

/** Records route metadata and a payload-free timing for every procedure. */
const instrumented = t.procedure.use(async ({ ctx, path, next }) => {
  const transport = ctx.transport ?? "unknown";
  ctx.diagnostics.record({ procedure: path, phase: "start", transport, code: null, message: null });
  const performanceStartedAt = readOptionalPerformanceClock(ctx.performanceObserver);
  const result = await next();
  if (result.ok) {
    ctx.diagnostics.record({
      procedure: path,
      phase: "success",
      transport,
      code: null,
      message: null,
    });
  } else {
    ctx.diagnostics.record({
      procedure: path,
      phase: "error",
      transport,
      code: result.error.code,
      message: result.error.message,
    });
  }
  const performanceEndedAt = readOptionalPerformanceClock(ctx.performanceObserver);
  recordProcedurePerformance(ctx.performanceObserver, {
    procedure: path,
    startedAt: performanceStartedAt,
    endedAt: performanceEndedAt,
    outcome: result.ok ? "success" : "error",
  });
  return result;
});

function recordProcedurePerformance(
  observer: RpcProcedurePerformanceObserver | undefined,
  input: {
    procedure: string;
    startedAt: number | null;
    endedAt: number | null;
    outcome: RpcProcedurePerformanceSample["outcome"];
  },
): void {
  // A missing clock endpoint means this sample has no trustworthy duration.
  // Skipping it is preferable to publishing a plausible-looking zero.
  if (!observer || input.startedAt === null || input.endedAt === null) return;
  const durationMs = Math.max(0, input.endedAt - input.startedAt);
  isolatePerformanceObserver(() => {
    observer.record({ procedure: input.procedure, durationMs, outcome: input.outcome });
  });
}

/**
 * The base every catalog procedure is built on: instrumented, tagged with its
 * key, and admitted by its entry before input is even parsed.
 */
function policed(entry: CatalogEntry) {
  return instrumented.meta({ catalogKey: entry.key as CatalogKey }).use(async ({ ctx, next }) => {
    const { actor } = ctx.caller;
    if (ctx.caller.current?.() === false) {
      throw new HostProcedureError(
        "credential-invalid",
        "This connection's credential is no longer valid.",
      );
    }
    const policyActor = HOST_ACTOR_POLICY[actor.kind];
    const admitted =
      policyActor !== null &&
      actorRequirementAdmits(entry.actor, policyActor) &&
      // The desktop's own window reaches every declared entry; a network
      // actor only the ones the WebSocket projects.
      (isLocalDeviceActor(actor) || entry.accessModes.includes("hostApi"));
    if (!admitted) {
      throw new HostProcedureError("verb-refused", `${entry.key} is not open to this caller.`);
    }
    const result = await next();
    // A command id reused for a different intent is the client's conflict, and
    // the one the wire names; every other ledger conflict stays what it was.
    if (!result.ok && isSessionCommandConflict(result.error.cause)) {
      throw new HostProcedureError("command-conflict", result.error.message, result.error.cause);
    }
    return result;
  });
}

/** A host-scoped procedure: host-level state, no Workspace resource to resolve (D8). */
export function hostProcedure<Key extends CatalogKeyScopedTo<"host">>(key: Key) {
  return policed(catalogEntry(key));
}

/**
 * A workspace-scoped procedure. `resource` names what the parsed input
 * addresses; the router authorizes its Workspace before the handler runs, and
 * a resource in another Workspace answers exactly as an absent one does
 * (`NOT_FOUND` / `workspace-unknown`).
 */
export function workspaceProcedure<
  Key extends CatalogKeyScopedTo<"workspace">,
  Schema extends z.ZodType,
>(key: Key, input: Schema, resource: (input: z.output<Schema>) => WorkspaceResource | null) {
  const entry = catalogEntry(key);
  return policed(entry)
    .input(input)
    .use(async ({ ctx, input: parsed, next }) => {
      refuseWithheldIntent(entry, parsed);
      await authorizeWorkspace(ctx, resource(parsed as z.output<Schema>));
      return next();
    });
}

function refuseWithheldIntent(entry: CatalogEntry, input: unknown): void {
  const refused = entry.catalog.refusedIntents;
  if (refused === undefined) return;
  const kind = (input as { command: { kind: string } }).command.kind;
  if (refused.includes(kind)) {
    throw new HostProcedureError(
      "verb-refused",
      `${entry.key} does not carry ${kind}; it has a catalog entry of its own.`,
    );
  }
}

async function authorizeWorkspace(
  ctx: SessionRouterContext,
  resource: WorkspaceResource | null,
): Promise<void> {
  const { actor } = ctx.caller;
  // Every Workspace on this host is the desktop window's, so there is nothing
  // to authorize and nothing new to read: with the flag off, a call answers
  // exactly as it did before the catalog existed.
  if (isLocalDeviceActor(actor)) return;
  const owner = resource === null ? null : await workspaceOf(ctx, resource);
  if (owner === null || owner !== actor.workspaceId) {
    throw new HostProcedureError("workspace-unknown", WORKSPACE_UNKNOWN_MESSAGE);
  }
}

async function workspaceOf(
  ctx: SessionRouterContext,
  resource: WorkspaceResource,
): Promise<WorkspaceId | null> {
  if ("projectId" in resource) return resource.projectId;
  // No port, no proof: a network caller is refused every Session.
  return ctx.sessionWorkspace === undefined ? null : ctx.sessionWorkspace(resource.sessionId);
}

/**
 * Builds a router from catalog procedures, refusing at construction a
 * procedure the catalog did not build or does not describe. The type-level
 * half is {@link CatalogMismatch}; this half catches what a type cannot see.
 */
export function catalogRouter<Procedures extends TRPCCreateRouterOptions>(record: Procedures) {
  const built = t.router(record);
  assertCatalogBound(built);
  return built;
}

/** Every procedure is its entry's, at its entry's path, with its entry's shape. */
export function assertCatalogBound(router: AnyRouter): void {
  // oxlint-disable-next-line no-underscore-dangle -- tRPC's only introspection door.
  const procedures = router._def.procedures as Readonly<Record<string, AnyProcedure>>;
  for (const [path, procedure] of Object.entries(procedures)) {
    // oxlint-disable-next-line no-underscore-dangle -- as above.
    const { meta, type } = procedure._def as { meta?: Partial<CatalogMeta>; type: string };
    if (meta?.catalogKey !== path) {
      throw new Error(`Procedure ${path} was not built from its catalog entry`);
    }
    const reads = catalogEntry(meta.catalogKey).catalog.idempotency === "read";
    if (reads !== (type !== "mutation")) {
      throw new Error(
        `Procedure ${path} is a ${type}, but its catalog entry ${reads ? "reads" : "writes"}`,
      );
    }
  }
}

/** Every procedure path of a router record, dotted the way the catalog keys them. */
export type ProcedurePaths<Record> = {
  [Key in keyof Record & string]: Record[Key] extends AnyProcedure
    ? Key
    : `${Key}.${ProcedurePaths<Record[Key]>}`;
}[keyof Record & string];

/**
 * The keys on which the routers' procedures and the catalog disagree: a
 * procedure with no entry, or an entry with no procedure (D2). A router seam
 * asserts this is `never`, so either drift fails `pnpm typecheck` and names
 * the key. `Paths` is the union over every router the host serves; today that
 * is the Session router alone, and an area router adds its paths to the union.
 */
export type CatalogMismatch<Paths extends string> =
  | Exclude<Paths, CatalogKey>
  | Exclude<CatalogKey, Paths>;
