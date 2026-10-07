import type { AnyMiddlewareFunction } from "@trpc/server/unstable-core-do-not-import";
/**
 * The host-protocol command catalog's tRPC projection (VC-564; HP § Command
 * catalog).
 *
 * The declaration half of every command is a Verb Registry entry in
 * `@volli/shared`: its key, router actor, scope and idempotency. This module
 * is the only place a catalog procedure can be built, and it builds each one
 * FROM its entry. {@link createCatalogBuilders} makes one family of builders
 * for one router context (the Session router's, an area router's):
 *
 * - `hostProcedure` and `workspaceProcedure` take the entry's key, typed to
 *   the catalog's keys of that scope, so a procedure with no entry, or a
 *   workspace procedure with no resources to authorize, does not compile;
 * - every call is then judged by the entry, at dispatch: the caller's grant is
 *   still current, its actor is admitted, any withheld intent is refused, and
 *   every workspace resource the call names is authorized (and, for a
 *   `session-own` entry called by a Session, every subject is one the area's
 *   policy lets it act on) before the handler runs;
 * - `catalogRouter` refuses, at construction, a procedure whose middleware
 *   chain does not begin with the exact chain one of ITS builders minted for
 *   the entry at its path (private provenance, never metadata a caller can
 *   set), whose tRPC type contradicts the entry's idempotency, or that binds
 *   no output validator without being a named legacy exception;
 * - {@link CatalogMismatch} fails `pnpm typecheck` until the routers'
 *   procedure paths and the catalog's keys are one set (D2).
 *
 * Each family's tRPC instance never leaves its factory call, so there is no
 * bare procedure builder to reach for.
 */
import {
  initTRPC,
  TRPCError,
  type AnyProcedure,
  type AnyRouter,
  type TRPCDefaultErrorShape,
  type TRPCCreateRouterOptions,
} from "@trpc/server";
import {
  HOST_ERROR_REASON_CODES,
  isHostConnectionActor,
  isHostScopeActor,
  isHostErrorCode,
  isLocalDeviceActor,
  LOCAL_DEVICE_ACTOR,
  type CallerActor,
  type HostConnectionActor,
  type HostActorKind,
  type HostError,
  type HostErrorReason,
  type HostConnectionWelcome,
  type LocalDeviceActor,
  type SessionId,
  type SubscriptionReplayBounds,
  type WorkspaceId,
} from "@volli/host-protocol";
import {
  CATALOG_ENTRIES,
  catalogActorAdmits,
  catalogActorOf,
  catalogEntriesFrom,
  catalogLookup,
  HOST_ACTOR_POLICY,
  isCommandIntentConflict,
  isQueueRevisionConflict,
  isHandlerRefused,
  isOperationUnavailable,
  isSignInRefused,
  isolatePerformanceObserver,
  readOptionalPerformanceClock,
  type CatalogEntry,
  type CatalogKey,
  type CatalogKeyOf,
  type CatalogKeyOfScope,
  type CatalogKeyRefusingIntents,
  type HandlerCall,
  type HandlerConnection,
  type HostActorKindName,
  type SignInRefusalReason,
  type SignInRefusedError,
  type VerbEntry,
  type VerbRegistryEntry,
  type VerbScope,
} from "@volli/shared";
import { z } from "zod";

import { sanitizeDiagnosticText } from "./diagnostic-text";
import type {
  RpcDiagnosticEntry,
  RpcProcedurePerformanceObserver,
  RpcProcedurePerformanceSample,
} from "./index";

/**
 * Who is calling, as the door that accepted the connection authenticated it.
 * The router reads it from context only; no input field can name or widen it
 * (HP § Auth and workspace authorization).
 */
export type RouterCaller = LocalRouterCaller | NetworkRouterCaller;

/** The desktop's own window, which every Workspace on its host authorizes (D7). */
export interface LocalRouterCaller {
  readonly actor: LocalDeviceActor;
  /** Nothing can revoke the in-process desktop, so it alone may omit the check. */
  readonly current?: () => boolean;
}

/** A network actor, bound to one Workspace by the credential its door verified. */
export interface NetworkRouterCaller {
  readonly actor: HostConnectionActor;
  /**
   * Asked again at every dispatch, never only at connect, and required: a
   * network caller is admitted only while this answers `true`. `false`, or a
   * door that supplied no checker at all, is `UNAUTHORIZED` /
   * `credential-invalid` before the actor, the input or the handler is read.
   */
  readonly current: () => boolean;
}

/** The desktop's own window over in-process IPC: the person, in every Workspace (D7). */
export const LOCAL_DESKTOP_CALLER: RouterCaller = Object.freeze({ actor: LOCAL_DEVICE_ACTOR });

/**
 * One resource a workspace-scoped call names: an area's noun and its id.
 *
 * `kind` is open, so an area adds its own (`ticket`, `terminal`, …) without
 * editing a closed union here; its router context's `resourceWorkspace` port
 * and `sessionMayAct` predicate answer for the kinds that area names. A
 * Workspace is a project (HI § Workspace), so `project` is answered here: a
 * project id is its own Workspace. A kind no port answers resolves to no
 * Workspace, which is refused exactly as a foreign or absent resource is.
 */
export interface WorkspaceResource {
  readonly kind: string;
  readonly id: string;
  /**
   * What the command does to it. A `subject` (the default) is what it acts
   * on, judged by `sessionMayAct` for a Session on a `session-own` entry. A
   * `reference` is only pointed at (the ticket a move lands after): it gets
   * the same Workspace check, but no Session needs authority over it.
   */
  readonly relation?: ResourceRelation;
}

/** A named resource is acted on, or only pointed at. */
export type ResourceRelation = "subject" | "reference";

/** The kind this module answers itself: a project is its own Workspace. */
export const PROJECT_RESOURCE = "project";

/** What a resolver names: every resource the input addresses, or nothing. */
export type WorkspaceResources = readonly WorkspaceResource[] | WorkspaceResource | null;

/** Where the instrumentation records a procedure's route, never its payload. */
export interface CatalogDiagnostics {
  record(entry: Omit<RpcDiagnosticEntry, "id" | "timestamp">): unknown;
}

/**
 * What every router context carries for its catalog builders: the caller, the
 * two resource ports Workspace authorization reads, and instrumentation. An
 * area router's context extends it with that area's own ports.
 */
export interface CatalogCallerContext {
  /**
   * Who is calling and what it is authorized for, as the door authenticated
   * it (VC-564). Every procedure's policy reads it; no input can override it.
   * The desktop's own window is {@link LOCAL_DESKTOP_CALLER}.
   */
  caller: RouterCaller;
  /**
   * The Workspace (project) a named resource belongs to, or null when there
   * is no such resource: the one read a workspace-scoped call makes before
   * its handler, and only for a caller bound to one Workspace. Absent, such a
   * caller is refused every resource but a project (`NOT_FOUND` /
   * `workspace-unknown`).
   */
  resourceWorkspace?: (
    resource: WorkspaceResource,
  ) => WorkspaceId | null | Promise<WorkspaceId | null>;
  /**
   * Whether the area's policy lets this Session act on a subject resource:
   * the one question a `session-own` entry asks, after the Workspace check,
   * when a Session calls it. The area implements it from its real policy
   * (ticket coordination rules, per-project authority), never a single owner
   * field: several Sessions may work one ticket. Absent, no Session may act.
   */
  sessionMayAct?: (resource: WorkspaceResource, sessionId: SessionId) => boolean | Promise<boolean>;
  diagnostics: CatalogDiagnostics;
  transport?: RouterTransport;
  performanceObserver?: RpcProcedurePerformanceObserver;
  /**
   * The catalog keys this connection's negotiated features grant
   * (`operationsGrantedBy`, `@volli/host-protocol`). A door with a handshake
   * always sets it, and a call to any other key is `FORBIDDEN` /
   * `verb-refused` before its input is read. Absent: the door negotiates no
   * features (the desktop's in-process IPC).
   */
  operations?: ReadonlySet<string>;
  /** The welcome the door's handshake negotiated; `protocol.welcome` answers it. */
  welcome?: HostConnectionWelcome;
  /**
   * The door refused this connection's handshake (VC-663): every call answers
   * this refusal before anything else about it is read, so each operation a
   * client queued behind its hello learns the reason, and the door then
   * closes the connection. Such a context carries no caller a handler could
   * use.
   */
  refused?: HandshakeRefusal;
  /**
   * How much history one subscription may replay before it answers
   * `subscription-resnapshot-required` instead. The WebSocket listener sets
   * `SUBSCRIPTION_REPLAY_BOUNDS`; absent (IPC), replay is unbounded (D9).
   */
  replayBounds?: SubscriptionReplayBounds;
  /**
   * A network door's hold on this connection (VC-663): what every in-flight
   * call and open stream answers to. Absent: a door with no connection to
   * lose (the desktop's in-process IPC), whose calls behave exactly as before.
   */
  admission?: ConnectionAdmission;
  /**
   * The largest answer, in UTF-8 bytes of its JSON, the door will send. A
   * query or mutation whose answer is larger is refused with
   * `PAYLOAD_TOO_LARGE` / `response-too-large`, never truncated. Absent (IPC):
   * unbounded.
   */
  maxResponseBytes?: number;
  /**
   * The network connection this call arrived on: a random id the door minted
   * for it (HP § The Client is a connection, F2). Set by the WebSocket
   * listener with `admission`; absent on the desktop's in-process IPC. A
   * handler sees it, with the admission's signal and the welcome's features,
   * as `HandlerCall.connection`, and keys per-connection state (a sign-in
   * flow, VC-702) by it.
   */
  connectionId?: string;
}

/**
 * One network connection's admission, as its door holds it (VC-663). The
 * catalog reads it at three points: immediately before a resolver runs (a
 * call whose authorization was still being awaited when the grant was revoked
 * never reaches its handler), before a successful answer is released, and
 * around every stream the connection opens (each one counts against its
 * budget and ends, with `credential-invalid`, the moment `signal` aborts).
 */
export interface ConnectionAdmission {
  /**
   * Aborted, never to be restored, once the connection's grant is revoked or
   * lapses, or the connection ends. Every resolver on the connection receives
   * a signal that aborts with it.
   */
  readonly signal: AbortSignal;
  /** Takes one of the connection's stream slots; `false` at its budget. */
  openStream(): boolean;
  /** Gives a slot back: a stream ended, however it ended. */
  closeStream(): void;
}

/** Why a door refused a handshake: a host-protocol reason, never a bare message. */
export interface HandshakeRefusal {
  readonly reason: HostErrorReason;
  readonly message: string;
}

/** Which door a call came through, as diagnostics record it. */
export type RouterTransport = "electron-ipc" | "websocket" | "unknown";

/**
 * The context keys an area's router may add to {@link CatalogCallerContext}:
 * exactly one, `handlers`, the slice of the host's handler map
 * (`@volli/host-core/handlers`) the area projects, keyed by catalog key. A
 * router reaches domain behaviour only through it (VC-668): no other port, so
 * a composition root wires one object, and every door that projects a key
 * reaches the same function.
 */
export type RouterContextPorts<Ctx> = Exclude<keyof Ctx, keyof CatalogCallerContext | "handlers">;

/**
 * What a procedure's handler is told about the call, from the caller the door
 * authenticated: the person (the desktop's own window, or a paired device),
 * or a Session. Never from input.
 */
export function handlerCallOf(actor: CallerActor, connection?: HandlerConnection): HandlerCall {
  if (isLocalDeviceActor(actor)) return { actor: { kind: "user" }, origin: "desktop-window" };
  const on = connection === undefined ? {} : { connection };
  switch (actor.kind) {
    case "device":
      return { actor: { kind: "user" }, ...on };
    case "session":
      // A router names the Session, never its ticket: no entry admits a
      // Session to an attributed write yet. VC-565 resolves the ticket when
      // the board's `session-own` entries land.
      return { actor: { kind: "session", sessionId: actor.sessionId, ticketId: null }, ...on };
    case "worker":
      // HOST_ACTOR_POLICY admits no worker to any entry.
      throw new HostProcedureError("verb-refused", "No catalog entry is open to a worker.");
  }
}

/**
 * The connection a network door's call arrived on, as a handler may see it
 * (F2): its id, the admission's signal, and the features its welcome granted.
 * Undefined for a door with no connection (the desktop's in-process IPC).
 */
export function handlerConnectionOf(ctx: CatalogCallerContext): HandlerConnection | undefined {
  if (ctx.connectionId === undefined || ctx.admission === undefined) return undefined;
  return {
    id: ctx.connectionId,
    closed: ctx.admission.signal,
    features: ctx.welcome?.features ?? [],
  };
}

/** A sign-in refusal (VC-702) as the reason the host protocol names. */
function signInRefusal(error: SignInRefusedError): HostProcedureError {
  return new HostProcedureError(error.reason, error.message, error);
}

/**
 * Runs a handler outside the policy middleware (a subscription's body, which
 * tRPC starts after the chain has returned) and maps its "unavailable" and a
 * refusal at the map the way the middleware maps a query's or mutation's.
 */
export async function hostAnswer<Answer>(run: () => Answer | Promise<Answer>): Promise<Answer> {
  try {
    return await run();
  } catch (error) {
    if (isHandlerRefused(error)) {
      throw new HostProcedureError("verb-refused", error.message, error);
    }
    if (isSignInRefused(error)) throw signInRefusal(error);
    if (isOperationUnavailable(error)) {
      throw new HostProcedureError(
        "operation-unavailable",
        error instanceof Error ? error.message : "This operation is unavailable on this host",
        error,
      );
    }
    throw error;
  }
}

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

export const CREDENTIAL_INVALID_MESSAGE = "This connection's credential is no longer valid.";

/** Same message for a foreign and an absent resource, so neither reveals the other. */
export const WORKSPACE_UNKNOWN_MESSAGE = "Not found in this Workspace.";

/** Every sign-in refusal a handler may throw is a reason the host protocol names. */
export type SignInRefusalReasonCoverage = AssertNever<
  Exclude<SignInRefusalReason, HostErrorReason>
>;

/** Pins host-protocol's actor kinds to the shared mapping's, in both directions. */
type AssertNever<Type extends never> = Type;
export type CallerActorKindCoverage = AssertNever<
  Exclude<HostActorKind, HostActorKindName> | Exclude<HostActorKindName, HostActorKind>
>;

/** What a withholding entry's input must carry, so its builder can read the intent's kind. */
export interface CommandKindEnvelope {
  readonly command: { readonly kind: string };
}

/** The input schema a key's builder accepts: a `command.kind` envelope for a withholding entry. */
type InputSchemaFor<Key, Entry extends VerbEntry> =
  Key extends CatalogKeyRefusingIntents<Entry> ? z.ZodType<CommandKindEnvelope> : z.ZodType;

/** Whether a schema parses to a `{ command: { kind } }` envelope a builder can read at dispatch. */
function carriesCommandKind(schema: z.ZodType): boolean {
  const command = schema instanceof z.ZodObject ? schema.shape.command : undefined;
  if (command instanceof z.ZodObject) return command.shape.kind !== undefined;
  return command instanceof z.ZodDiscriminatedUnion && command.def.discriminator === "kind";
}

/**
 * Whether the caller is one this router can judge and its grant is current
 * now. Only the local desktop may come without a checker; a network caller
 * that lacks one is refused, never waved through (the type demands it too,
 * and this holds for a door that cast its way past the type).
 */
function callerAffirmed({ actor, current }: { actor: CallerActor; current?: unknown }): boolean {
  if (!isLocalDeviceActor(actor) && !isHostConnectionActor(actor)) return false;
  return typeof current === "function" ? current() === true : isLocalDeviceActor(actor);
}

/**
 * Whether a call may still run, or release what it ran: asked again at the
 * resolver and at the answer, after every awaited authorization step, so a
 * revocation that lands mid-authorization wins. The desktop's own window is
 * never revoked, and its calls are never re-judged (flag off is unchanged).
 */
function stillAdmitted(ctx: CatalogCallerContext): boolean {
  if (isLocalDeviceActor(ctx.caller.actor)) return true;
  return ctx.admission?.signal.aborted !== true && callerAffirmed(ctx.caller);
}

function credentialInvalid(): HostProcedureError {
  return new HostProcedureError("credential-invalid", CREDENTIAL_INVALID_MESSAGE);
}

const encoder = new TextEncoder();

/** UTF-8 bytes of a value's JSON, as the wire would carry it; `undefined` is nothing. */
export function jsonByteLength(value: unknown): number {
  const json = JSON.stringify(value) as string | undefined;
  return json === undefined ? 0 : encoder.encode(json).byteLength;
}

export const RESPONSE_TOO_LARGE_MESSAGE =
  "This answer is larger than the connection's frame bound; read it in bounded pages instead.";

export const SUBSCRIPTION_LIMIT_MESSAGE =
  "This connection already holds as many open subscriptions as it may; stop one first.";

/** A promise that rejects with `credential-invalid` the moment the admission ends. */
function unlessRevoked<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(credentialInvalid());
  return new Promise<Value>((resolve, reject) => {
    const revoked = (): void => reject(credentialInvalid());
    signal.addEventListener("abort", revoked, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", revoked);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", revoked);
        reject(error);
      },
    );
  });
}

/**
 * One stream on a connection with an admission: it takes a slot before its
 * source is opened (refused with `subscription-limit` at the budget), gives
 * it back however it ends, and ends with `credential-invalid` the moment the
 * admission does. The source sees the same abort through its own signal, so
 * one parked on its own await unparks and releases what it holds; it is not
 * awaited here, so a source that ignored its signal could not hold the
 * revocation answer back.
 */
async function* admittedStream(
  admission: ConnectionAdmission,
  open: () => unknown,
): AsyncGenerator<unknown, void, unknown> {
  if (admission.signal.aborted) throw credentialInvalid();
  if (!admission.openStream()) {
    throw new HostProcedureError("subscription-limit", SUBSCRIPTION_LIMIT_MESSAGE);
  }
  let iterator: AsyncIterator<unknown> | undefined;
  try {
    iterator = (open() as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    for (;;) {
      const next = await unlessRevoked(iterator.next(), admission.signal);
      if (admission.signal.aborted) throw credentialInvalid();
      if (next.done === true) return;
      yield next.value;
    }
  } finally {
    admission.closeStream();
    void iterator?.return?.()?.catch(() => {});
  }
}

type AnyResolver = (opts: {
  ctx: CatalogCallerContext;
  signal?: AbortSignal | undefined;
}) => unknown;

/** Every resolver a catalog builder wrapped; `catalogRouter` refuses any other. */
const guardedResolvers = new WeakSet<object>();

/**
 * Wraps a resolver in the connection's admission: re-judged immediately
 * before it runs, handed a signal that aborts with the connection, and, for
 * a stream, counted and ended with it. A caller with no admission (the
 * desktop's IPC, a router test) reaches its resolver unchanged.
 */
function guardResolver(resolver: AnyResolver, type: ResolverType): AnyResolver {
  const guarded: AnyResolver = (opts) => {
    const { ctx } = opts;
    if (!stillAdmitted(ctx)) throw credentialInvalid();
    const { admission } = ctx;
    if (admission === undefined || isLocalDeviceActor(ctx.caller.actor)) return resolver(opts);
    const signal =
      opts.signal === undefined
        ? admission.signal
        : AbortSignal.any([opts.signal, admission.signal]);
    if (type !== "subscription") return resolver({ ...opts, signal });
    return admittedStream(admission, () => resolver({ ...opts, signal }));
  };
  guardedResolvers.add(guarded);
  return guarded;
}

type ResolverType = "query" | "mutation" | "subscription";
const RESOLVER_TYPES: ReadonlySet<string> = new Set(["query", "mutation", "subscription"]);

/**
 * A builder whose every descendant resolves through {@link guardResolver}:
 * `.input()`, `.output()`, `.use()` and the rest return guarded builders, and
 * `.query()`, `.mutation()` and `.subscription()` wrap the resolver they are
 * given. A Proxy rather than a re-listing of tRPC's builder methods, so one
 * tRPC adds later cannot slip a resolver past the guard.
 */
interface BuilderWithOutputChain {
  // oxlint-disable-next-line no-underscore-dangle -- tRPC's newly built output middleware chain.
  readonly _def: { middlewares: AnyMiddlewareFunction[] };
}

function guardedBuilder<Builder extends object>(builder: Builder): Builder {
  return new Proxy(builder, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (typeof property === "string" && RESOLVER_TYPES.has(property)) {
        return (resolver: AnyResolver) =>
          method.call(target, guardResolver(resolver, property as ResolverType));
      }
      // Output schemas remain bound/published on every door. Only the trusted,
      // in-process desktop IPC skips their parser; network doors and direct
      // router tests keep tRPC's ordinary validation/error semantics. Input
      // middleware is never bypassed.
      if (property === "output") {
        return (...args: unknown[]) => {
          const next = method.apply(target, args) as BuilderWithOutputChain;
          // oxlint-disable-next-line no-underscore-dangle -- the same pinned tRPC introspection seam as catalogRouter.
          const chain = next._def.middlewares;
          const output = chain.at(-1)!;
          /* v8 ignore next 3 -- pinned tRPC's output() appends exactly this middleware; fail closed on a framework change. */
          if (Reflect.get(output, "_type") !== "output") {
            throw new Error("tRPC output middleware layout changed");
          }
          chain[chain.length - 1] = (opts) => {
            const ctx = opts.ctx as CatalogCallerContext;
            return ctx.transport === "electron-ipc" && isLocalDeviceActor(ctx.caller.actor)
              ? opts.next()
              : output(opts);
          };
          return guardedBuilder(next);
        };
      }
      // Every other builder method returns the next builder.
      return (...args: unknown[]) => guardedBuilder(method.apply(target, args) as object);
    },
  });
}

function namedResources(named: WorkspaceResources): readonly WorkspaceResource[] {
  if (named === null) return [];
  return "kind" in named ? [named] : named;
}

/**
 * Authorizes every resource a call names, before its handler reads anything:
 * each must resolve to the caller's Workspace, or the call is `NOT_FOUND` /
 * `workspace-unknown`, the one answer for foreign, absent and unanswerable
 * alike, subjects and references both. Then, for a Session calling a
 * `session-own` entry, the area's `sessionMayAct` must answer `true` for every
 * subject, or the call is `FORBIDDEN` / `verb-refused`; with no subject or no
 * predicate it is refused too (fail closed). Each resource is already known
 * to be in the Session's Workspace, so saying so reveals nothing.
 */
async function authorizeWorkspace(
  ctx: CatalogCallerContext,
  entry: CatalogEntry,
  named: WorkspaceResources,
): Promise<void> {
  const { actor } = ctx.caller;
  // Every Workspace on this host is the desktop window's, so there is nothing
  // to authorize and nothing new to read: with the flag off, a call answers
  // exactly as it did before the catalog existed.
  if (isLocalDeviceActor(actor)) return;
  if (isHostScopeActor(actor))
    throw new HostProcedureError(
      "workspace-scope-required",
      "This operation requires a Workspace connection.",
    );
  const resources = namedResources(named);
  // A call that names nothing names nothing this caller could own.
  if (resources.length === 0) {
    throw new HostProcedureError("workspace-unknown", WORKSPACE_UNKNOWN_MESSAGE);
  }
  for (const resource of resources) {
    if ((await workspaceOf(ctx, resource)) !== actor.workspaceId) {
      throw new HostProcedureError("workspace-unknown", WORKSPACE_UNKNOWN_MESSAGE);
    }
  }
  if (actor.kind !== "session" || catalogActorOf(entry) !== "session-own") return;
  const subjects = resources.filter((resource) => (resource.relation ?? "subject") === "subject");
  const mayAct = ctx.sessionMayAct;
  let admitted = mayAct !== undefined && subjects.length > 0;
  for (const subject of subjects) {
    if (!admitted) break;
    admitted = (await mayAct!(subject, actor.sessionId)) === true;
  }
  if (!admitted) {
    throw new HostProcedureError(
      "verb-refused",
      `${entry.key} is open to a Session only on what its policy lets it act on.`,
    );
  }
}

async function workspaceOf(
  ctx: CatalogCallerContext,
  resource: WorkspaceResource,
): Promise<WorkspaceId | null> {
  if (resource.kind === PROJECT_RESOURCE) return resource.id;
  // No port, no proof: a network caller is refused every resource it names.
  return ctx.resourceWorkspace === undefined ? null : ctx.resourceWorkspace(resource);
}

function refuseWithheldIntent(entry: CatalogEntry, input: unknown): void {
  const refused = entry.catalog.refusedIntents;
  if (refused === undefined) return;
  // The builder refused any schema without this envelope at construction.
  const { kind } = (input as CommandKindEnvelope).command;
  if (refused.includes(kind)) {
    throw new HostProcedureError(
      "verb-refused",
      `${entry.key} does not carry ${kind}; it has a catalog entry of its own.`,
    );
  }
}

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
 * The one error envelope every catalog router answers with: the code, the
 * sanitized message, and `data.hostError`. One function for every family, so
 * the families compose into one served router (`host-router.ts`).
 */
export function catalogErrorFormatter({
  shape,
  error,
}: {
  shape: TRPCDefaultErrorShape;
  error: TRPCError;
}) {
  return {
    code: shape.code,
    message: sanitizeDiagnosticText(shape.message),
    data: {
      code: shape.data.code,
      httpStatus: shape.data.httpStatus,
      ...(shape.data.path === undefined ? {} : { path: shape.data.path }),
      hostError: hostErrorOf(error),
    },
  };
}

/** How one family of builders is configured. */
export interface CatalogBuildersOptions<Entry extends VerbEntry> {
  /**
   * The entries these builders bind, checked by `catalogEntriesFrom`. Absent:
   * the Verb Registry's catalog, which every production router uses. A test
   * passes its own, so an example router needs no registry row.
   */
  readonly entries?: readonly Entry[];
  /**
   * The queries and mutations that bind no output validator yet, named so the
   * list can only shrink: one that gains a validator is refused until struck
   * from it. Every new command binds `.output(zod)`.
   */
  readonly legacyUnvalidatedOutputs?: readonly CatalogKeyOf<Entry>[];
}

/** Which builder made a procedure, recorded where no caller can forge it. */
interface Provenance {
  readonly key: string;
  readonly chain: readonly object[];
}

interface BuilderWithChain {
  // oxlint-disable-next-line no-underscore-dangle -- tRPC's builder state.
  readonly _def: { readonly middlewares: readonly object[] };
}

/**
 * One family of catalog builders for one router context (HP § Command
 * catalog, "Where area routers live"). Each call has its own tRPC instance
 * and its own private provenance, so a family's `catalogRouter` accepts only
 * procedures its own builders made.
 *
 * `Ctx` is the router's context: {@link CatalogCallerContext} plus the area's
 * ports. `Entry` types the keys; it defaults to the Verb Registry.
 */
export function createCatalogBuilders<
  Ctx extends CatalogCallerContext,
  Entry extends VerbEntry = VerbRegistryEntry,
>(options: CatalogBuildersOptions<Entry> = {}) {
  const entries =
    options.entries === undefined ? CATALOG_ENTRIES : catalogEntriesFrom(options.entries);
  const entryOf = catalogLookup(entries);
  const legacyOutputs: readonly string[] = options.legacyUnvalidatedOutputs ?? [];
  for (const key of legacyOutputs) entryOf(key);

  const t = initTRPC.context<Ctx>().create({
    // Never ship a stack, whatever NODE_ENV says.
    isDev: false,
    errorFormatter: catalogErrorFormatter,
  });

  /**
   * Each builder call registers the middleware that completes its entry's
   * policy (admission for a host entry; Workspace authorization for a
   * workspace entry), keyed to that entry and to the exact middleware chain
   * built up to and including it. `assertCatalogBound` accepts a procedure
   * only when its chain begins with that chain, at that entry's path. tRPC
   * metadata proves nothing: any module can `initTRPC` and set it.
   */
  const provenance = new WeakMap<object, Provenance>();

  function stamped<Builder extends BuilderWithChain>(builder: Builder, key: string): Builder {
    // oxlint-disable-next-line no-underscore-dangle -- as above.
    const chain = [...builder._def.middlewares];
    provenance.set(chain.at(-1)!, { key, chain });
    return guardedBuilder(builder);
  }

  /** The named entry, refused unless it is declared with the scope the builder serves. */
  function entryScopedTo(key: string, scope: VerbScope): CatalogEntry {
    const entry = entryOf(key);
    if (entry.catalog.scope !== scope) {
      throw new Error(`Catalog entry ${key} is ${entry.catalog.scope}-scoped, not ${scope}-scoped`);
    }
    return entry;
  }

  /** Records route metadata and a payload-free timing for every procedure. */
  const instrumented = t.procedure.use(async function instrument({ ctx, path, next }) {
    const transport = ctx.transport ?? "unknown";
    ctx.diagnostics.record({
      procedure: path,
      phase: "start",
      transport,
      code: null,
      message: null,
    });
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

  /**
   * The base every catalog procedure is built on: instrumented, then admitted
   * by its entry before input is even parsed.
   */
  function policed(entry: CatalogEntry) {
    const requirement = catalogActorOf(entry);
    return instrumented.use(async function admit({ ctx, type, next }) {
      if (ctx.refused !== undefined) {
        throw new HostProcedureError(ctx.refused.reason, ctx.refused.message);
      }
      if (!callerAffirmed(ctx.caller)) {
        throw new HostProcedureError("credential-invalid", CREDENTIAL_INVALID_MESSAGE);
      }
      const { actor } = ctx.caller;
      if (isHostScopeActor(actor) && entry.catalog.scope !== "host") {
        throw new HostProcedureError(
          "workspace-scope-required",
          "This operation requires a Workspace connection.",
        );
      }
      const policyActor = HOST_ACTOR_POLICY[actor.kind];
      const admitted =
        policyActor !== null &&
        // `per-subject` is admitted here and judged per subject after the
        // Workspace check, in `authorizeWorkspace`.
        catalogActorAdmits(requirement, policyActor) !== "refused" &&
        // The desktop's own window reaches every declared entry; a network
        // actor only the ones the WebSocket projects.
        (isLocalDeviceActor(actor) || entry.accessModes.includes("hostApi"));
      if (!admitted) {
        throw new HostProcedureError("verb-refused", `${entry.key} is not open to this caller.`);
      }
      if (ctx.operations !== undefined && !ctx.operations.has(entry.key)) {
        throw new HostProcedureError(
          "verb-refused",
          `${entry.key} is not among the features this connection negotiated.`,
        );
      }
      // The handler learns who is calling from the door, never from input.
      const result = await next({ ctx: { call: handlerCallOf(actor, handlerConnectionOf(ctx)) } });
      // A command id reused for a different intent is the client's conflict,
      // and the one the wire names; every other ledger conflict stays what it
      // was. Any area's ledger opts in by the shared brand.
      if (!result.ok && isQueueRevisionConflict(result.error.cause)) {
        throw new HostProcedureError(
          "queue-revision-conflict",
          result.error.message,
          result.error.cause,
        );
      }
      if (!result.ok && isCommandIntentConflict(result.error.cause)) {
        throw new HostProcedureError("command-conflict", result.error.message, result.error.cause);
      }
      if (!result.ok && isSignInRefused(result.error.cause)) {
        throw signInRefusal(result.error.cause);
      }
      // The map judged the call again under the door's policy and refused it
      // before its handler ran (VC-668): the same refusal this middleware gives.
      if (!result.ok && isHandlerRefused(result.error.cause)) {
        throw new HostProcedureError("verb-refused", result.error.message, result.error.cause);
      }
      // What this host cannot do now is the handler's answer (VC-668).
      if (!result.ok && isOperationUnavailable(result.error.cause)) {
        throw new HostProcedureError(
          "operation-unavailable",
          result.error.message,
          result.error.cause,
        );
      }
      if (!result.ok) return result;
      // Nothing is released to a caller whose grant ended while it ran.
      if (!stillAdmitted(ctx)) throw credentialInvalid();
      if (
        ctx.maxResponseBytes !== undefined &&
        type !== "subscription" &&
        jsonByteLength(result.data) > ctx.maxResponseBytes
      ) {
        throw new HostProcedureError("response-too-large", RESPONSE_TOO_LARGE_MESSAGE);
      }
      return result;
    });
  }

  /** A host-scoped procedure: host-level state, no Workspace resource to resolve (D8). */
  function hostProcedure<Key extends CatalogKeyOfScope<Entry, "host">>(key: Key) {
    return stamped(policed(entryScopedTo(key, "host")), key);
  }

  /**
   * A workspace-scoped procedure. `resources` names EVERY resource the parsed
   * input addresses; the router authorizes each one's Workspace before the
   * handler runs, and a resource in another Workspace answers exactly as an
   * absent one does (`NOT_FOUND` / `workspace-unknown`). A withholding entry's
   * input must be a `command.kind` envelope, at the type and at construction.
   */
  function workspaceProcedure<
    Key extends CatalogKeyOfScope<Entry, "workspace">,
    Schema extends InputSchemaFor<Key, Entry>,
  >(key: Key, input: Schema, resources: (input: z.output<Schema>) => WorkspaceResources) {
    const entry = entryScopedTo(key, "workspace");
    if (entry.catalog.refusedIntents !== undefined && !carriesCommandKind(input)) {
      throw new Error(`Catalog entry ${key} withholds intents, but its input has no command.kind`);
    }
    return stamped(
      policed(entry)
        .input(input)
        .use(async function authorize({ ctx, input: parsed, next }) {
          refuseWithheldIntent(entry, parsed);
          await authorizeWorkspace(ctx, entry, resources(parsed as z.output<Schema>));
          return next();
        }),
      key,
    );
  }

  /**
   * Every procedure is its entry's, at its entry's path, with its entry's
   * shape: its middleware chain begins with the chain one of these builders
   * minted for that entry, so its policy and (for a workspace entry) its
   * Workspace authorization run before anything else.
   */
  function assertCatalogBound(router: AnyRouter): void {
    // oxlint-disable-next-line no-underscore-dangle -- tRPC's only introspection door.
    const procedures = router._def.procedures as Readonly<Record<string, AnyProcedure>>;
    for (const [path, procedure] of Object.entries(procedures)) {
      // oxlint-disable-next-line no-underscore-dangle -- as above.
      const { middlewares, type, output, resolver } = procedure._def as unknown as {
        middlewares: readonly object[];
        type: string;
        output?: unknown;
        resolver?: object;
      };
      const completes = middlewares.findIndex((middleware) => provenance.has(middleware));
      const minted = completes === -1 ? undefined : provenance.get(middlewares[completes]!);
      if (
        minted?.key !== path ||
        minted.chain.length !== completes + 1 ||
        minted.chain.some((middleware, index) => middlewares[index] !== middleware)
      ) {
        throw new Error(`Procedure ${path} was not built from its catalog entry`);
      }
      // Built from the entry's chain, but resolved past the admission guard.
      if (!guardedResolvers.has(resolver!)) {
        throw new Error(`Procedure ${path} resolves outside its connection's admission`);
      }
      const reads = entryOf(minted.key).catalog.idempotency === "read";
      if (reads !== (type !== "mutation")) {
        throw new Error(
          `Procedure ${path} is a ${type}, but its catalog entry ${reads ? "reads" : "writes"}`,
        );
      }
      // tRPC's `.output()` does not validate a subscription's yields, so the
      // rule covers queries and mutations.
      const legacy = legacyOutputs.includes(path);
      if (type !== "subscription" && legacy === (output !== undefined)) {
        throw new Error(
          legacy
            ? `Procedure ${path} binds an output validator; strike it from the legacy exceptions`
            : `Procedure ${path} binds no output validator`,
        );
      }
    }
  }

  /**
   * Builds a router from these builders' procedures, refusing at construction
   * a procedure they did not build or the catalog does not describe. The
   * type-level half is {@link CatalogMismatch}; this half catches what a type
   * cannot see.
   */
  function catalogRouter<Procedures extends TRPCCreateRouterOptions>(record: Procedures) {
    const built = t.router(record);
    assertCatalogBound(built);
    return built;
  }

  return { hostProcedure, workspaceProcedure, catalogRouter, assertCatalogBound };
}

/**
 * Every procedure path of a router record, dotted the way the catalog keys
 * them. Distributive: a union of records (several routers' records) yields
 * every path of each, never only the namespaces they happen to share.
 */
export type ProcedurePaths<Record> = Record extends unknown
  ? {
      [Key in keyof Record & string]: Record[Key] extends AnyProcedure
        ? Key
        : `${Key}.${ProcedurePaths<Record[Key]>}`;
    }[keyof Record & string]
  : never;

/** Every procedure path of some routers: each router's paths, together. */
export type RouterProcedurePaths<Routers extends AnyRouter> = Routers extends AnyRouter
  ? ProcedurePaths<Routers["_def"]["record"]>
  : never;

/**
 * The keys on which the routers' procedures and the catalog disagree: a
 * procedure with no entry, or an entry with no procedure (D2). A router seam
 * asserts this is `never`, so either drift fails `pnpm typecheck` and names
 * the key. `Paths` is the union over every router the host serves (the
 * composition root's assertion), and `Keys` the catalog's keys: the Verb
 * Registry's by default, an example's own in a test.
 */
export type CatalogMismatch<Paths extends string, Keys extends string = CatalogKey> =
  | Exclude<Paths, Keys>
  | Exclude<Keys, Paths>;
