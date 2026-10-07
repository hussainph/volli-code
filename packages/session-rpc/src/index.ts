import { procedureSchemas, type ProcedureSchema } from "./procedure-schema";
export type { ProcedureSchema } from "./procedure-schema";
import { TRPCError, tracked } from "@trpc/server";
import { isHostActor, type HostActor, type JsonUnsafeProcedures } from "@volli/host-protocol";
export type { IsJsonSafe, JsonUnsafeProcedures } from "@volli/host-protocol";
export type { SessionReadInput } from "./session-reads";
import {
  isSessionStreamFrame,
  SuperviseSessionError,
  type ModelAccessSnapshot,
  type SessionClientCommand,
  type SessionRuntimeCommandResult,
  type SessionRuntimeCommandRequest,
  type SessionRuntimeProjectionSnapshot,
  type SessionHistoryPage,
  type SessionLatestReply,
  type SessionRuntimeSnapshot,
  type SessionStreamCompactionProgress,
  type SessionStreamQueue,
  type SessionStreamFrame,
  type SessionStreamEmission,
  type SessionStreamOverlay,
  type SessionStartResult,
} from "@volli/session-engine";
import {
  CODE_MODE_MODES,
  CODE_MODE_POLICY_MODELS_MAX,
  EXPERIMENTS,
  LOG_LEVELS,
  MODEL_PICKER_VIEWS,
  MODEL_PURPOSES,
  presentedScheduledResume,
  REASONING_LEVELS,
  SESSION_ROLES,
  scrubSessionAttention,
  scrubSessionEvent,
  scrubSessionInteraction,
  type AgentResponse,
  type CodeModePolicy,
  type CompactionPolicy,
  type ExperimentId,
  type ExperimentSnapshot,
  type HandlerCall,
  type HiddenModelRef,
  type HostHandler,
  type HostLogsBatch,
  type HostLogsQuery,
  type CatalogKeyOf,
  type HostHandlerKeyOf,
  type ModelAccessDefaults,
  type ModelPickerView,
  type ModelPurpose,
  type ReasoningLevel,
  type RendererSessionEvent,
  type SessionPresentationProjection,
} from "@volli/shared";
import { z } from "zod";

import {
  hostAnswer,
  HostProcedureError,
  jsonByteLength,
  PROJECT_RESOURCE,
  type CatalogCallerContext,
  type CatalogMismatch,
  type ProcedurePaths,
  type RouterTransport,
  type RouterContextPorts,
} from "./catalog";
import { AsyncQueue } from "./async-queue";
import { sanitizeDiagnosticText } from "./diagnostic-text";
import {
  SIGN_IN_VOID_OUTPUTS,
  signInProcedures,
  signInSupplementalOutputs,
  type SignInRouterHandlers,
} from "./sign-ins";
export {
  hostAuthCallbackDeliverResultSchema,
  hostSignInAckSchema,
  hostSignInFlowSchema,
  hostSignInStatusSchema,
  hostSignInUpdateSchema,
  type SignInRouterHandlers,
} from "./sign-ins";
import { replayExceedsEvents, ReplayMeter, resnapshotRequired } from "./replay-bound";
import {
  readSession,
  readWorkspace,
  sessionHandleInput,
  sessionListInput,
  sessionListOutput,
  sessionPeekInput,
  sessionReadOutput,
  type SessionReadInput,
} from "./session-reads";
import {
  diagnosticEntrySchema,
  sessionAttachOutputSchema,
  sessionCommandOutputSchema,
  sessionHistoryOutputSchema,
  sessionProjectionOutputSchema,
  sessionSnapshotOutputSchema,
  streamEmissionSchema,
  legacyStreamEmissionSchema,
  uiMessageWireSchema,
} from "./output-schema";
export {
  sessionCommandOutputSchema,
  sessionHistoryOutputSchema,
  sessionProjectionOutputSchema,
  sessionSnapshotOutputSchema,
} from "./output-schema";
import {
  catalogRouter,
  hostProcedure,
  sessionResource,
  workspaceProcedure,
  type SessionRouterEntry,
} from "./session-catalog";

export {
  createCatalogBuilders,
  handlerCallOf,
  hostErrorOf,
  HostProcedureError,
  LOCAL_DESKTOP_CALLER,
  PROJECT_RESOURCE,
  type CatalogBuildersOptions,
  type CatalogCallerContext,
  type CatalogDiagnostics,
  type CatalogMismatch,
  type CommandKindEnvelope,
  type LocalRouterCaller,
  type NetworkRouterCaller,
  type ProcedurePaths,
  type RouterProcedurePaths,
  type RouterCaller,
  type RouterContextPorts,
  type WorkspaceResource,
  type ResourceRelation,
  type RouterTransport,
  type WorkspaceResources,
} from "./catalog";
export { SESSION_RESOURCE, type SessionRouterEntry } from "./session-catalog";
export {
  createBoardRouter,
  TICKET_RESOURCE,
  type BoardRouter,
  type BoardRouterContext,
  type BoardRouterHandlers,
  type BoardTicketMoveInput,
} from "./board-router";
export {
  createHostRouter,
  type HostRouter,
  type HostRouterCatalogBinding,
  type HostRouterContext,
  type HostRouterFeatureBinding,
  type HostRouterPaths,
} from "./host-router";
export {
  createDesktopRouter,
  desktopProcedureSchemas,
  type DesktopRouter,
  type DesktopRouterContext,
  type DesktopRouterHandlers,
} from "./desktop-router";
export {
  DESKTOP_IPC_EXPOSURE,
  DESKTOP_IPC_PATHS,
  type DesktopIpcExposure,
  type DesktopIpcPath,
  type DesktopIpcRouter,
  type DesktopIpcRouterPath,
  type DesktopIpcRouters,
  type IpcExposureTable,
} from "./desktop-ipc";
export { AsyncQueue } from "./async-queue";
export { sanitizeDiagnosticText } from "./diagnostic-text";

type RpcUiMessage = Extract<SessionClientCommand, { kind: "message.submit" }>["message"];
type RpcModelSelection = Extract<SessionClientCommand, { kind: "model.select" }>["selection"];

export type RendererSessionCommand =
  | Pick<Extract<SessionClientCommand, { kind: "message.submit" }>, "kind" | "message" | "delivery">
  | Extract<
      SessionClientCommand,
      | { kind: "session.stop" }
      | { kind: "model.select" }
      | { kind: "executor.interrupt" }
      | { kind: "executor.retry" }
      | { kind: "context.compact" }
      | { kind: "interaction.resolve" }
      | { kind: "resume.schedule" }
      | { kind: "resume.cancel" }
    >;

export interface RendererSessionCommandRequest {
  commandId: string;
  sessionId: string;
  command: RendererSessionCommand;
}

export type RendererSessionCommandResult = Pick<
  SessionRuntimeCommandResult,
  "sessionId" | "receipt" | "throughSequence" | "refusal" | "stop"
>;

/**
 * One durable frame as the renderer receives it. The event type is the
 * codec's {@link RendererSessionEvent} — derived from the scrub return types,
 * so it cannot claim a field survives this edge that never arrives.
 */
export type RendererSessionStreamFrame = Omit<SessionStreamFrame, "event"> & {
  event: RendererSessionEvent;
};

/** A streamed Session emission with executor identity and adapter-native detail removed. */
export type RendererSessionStreamEmission =
  | RendererSessionStreamFrame
  | SessionStreamOverlay
  | SessionStreamCompactionProgress
  | SessionStreamQueue;

/** The durable arm carries no `kind` of its own, mirroring the runtime's own test. */
function isRendererStreamTransient(
  emission: RendererSessionStreamEmission,
): emission is SessionStreamOverlay | SessionStreamCompactionProgress | SessionStreamQueue {
  return "kind" in emission;
}

export interface SessionCreateInput {
  operationId: string;
  projectId: string;
  /** The Role: a Ticket Session when set, a Board Session when null. */
  ticketId: string | null;
  title: string | null;
  /**
   * A client-minted UUIDv4 the durable Session takes as its own id (VC-358),
   * so a provisional chat can be promoted under the id it carried all along.
   * Absent — every caller that has not opted in — keeps the ledger's own id
   * derivation. Format-checked here (v4 only, per `docs/BOUNDARIES.md` rule 1);
   * the ledger refuses an id already in use, and the engine refuses a replay
   * that names a different id than the one its command was accepted under.
   */
  requestedSessionId?: string;
  /**
   * Skill slugs to inject at attach time as system-prompt RESOURCE sections.
   * Absent means none — injection is explicit selection, never ambient.
   */
  skills?: readonly string[];
  /**
   * An invocation-time model policy for THIS Session, merged onto the app
   * default by the server and validated against Model Access before anything
   * durable exists.
   *
   * The same parameter the `session_start` tool carries as `model`/`reasoning`,
   * reaching the create door because a UI can now state it too: the New-ticket
   * composer's Create & start picks a model and an effort for the Session it is
   * about to open (VC-56). Absent means the configured default for the Role,
   * which is what every other chat start still sends.
   */
  modelOverride?: {
    model?: { providerId: string; modelId: string };
    reasoningLevel?: ReasoningLevel;
  };
  /**
   * The first message this chat is being born to carry (VC-432), offered to
   * the decision model that may choose its model. Used only when the create
   * names no `modelOverride` and a decision model is configured and permitted;
   * otherwise ignored. Never stored.
   */
  autoSelect?: { request: string };
}

export interface SessionAttachInput {
  operationId: string;
  sessionId: string;
}

/** A create-only start's answer: durable identity, nothing about an executor. */
export interface SessionCreateResult {
  sessionId: string;
}

/**
 * The server-side composition root supplies this context. It deliberately
 * carries the deep runtime rather than leaking its ports to individual RPCs.
 */
export interface RpcProcedurePerformanceSample {
  procedure: string;
  durationMs: number;
  outcome: "success" | "error";
}

/** Optional payload-free timer used by the Electron performance harness. */
export interface RpcProcedurePerformanceObserver {
  now?(): number;
  record(sample: RpcProcedurePerformanceSample): void;
}

/**
 * The slice of the host's handler map (`@volli/host-core/handlers`) the
 * Session router projects, keyed by catalog key (VC-668). Declared here
 * structurally because this package cannot import host-core (D2); a
 * composition root hands it the host's one map, and that assignment is the
 * check that the two agree. Properties, not methods, so an input drift is a
 * type error rather than a bivariant pass.
 */
export interface SessionRouterHandlers extends SignInRouterHandlers {
  readonly "sessions.create": HostHandler<SessionCreateInput, SessionCreateResult>;
  readonly "sessions.attach": HostHandler<SessionAttachInput, SessionStartResult>;
  readonly "settings.experiments": HostHandler<void, ExperimentSnapshot>;
  readonly "settings.setExperiment": HostHandler<
    { id: ExperimentId; enabled: boolean },
    ExperimentSnapshot
  >;
  readonly "modelAccess.inspect": HostHandler<{ refresh?: boolean }, ModelAccessSnapshot>;
  readonly "modelAccess.defaults": HostHandler<void, ModelAccessDefaults>;
  readonly "modelAccess.setDefault": HostHandler<
    { purpose: ModelPurpose; selection: RpcModelSelection | null },
    ModelAccessDefaults
  >;
  readonly "modelAccess.hiddenModels": HostHandler<void, readonly HiddenModelRef[]>;
  readonly "modelAccess.setHiddenModels": HostHandler<readonly HiddenModelRef[], void>;
  readonly "modelAccess.compactionPolicy": HostHandler<void, CompactionPolicy>;
  readonly "modelAccess.setCompactionPolicy": HostHandler<CompactionPolicy, CompactionPolicy>;
  readonly "modelAccess.codeModePolicy": HostHandler<void, CodeModePolicy>;
  readonly "modelAccess.setCodeModePolicy": HostHandler<CodeModePolicy, CodeModePolicy>;
  readonly "modelAccess.pickerView": HostHandler<void, ModelPickerView>;
  readonly "modelAccess.setPickerView": HostHandler<ModelPickerView, ModelPickerView>;
  readonly "session.snapshot": HostHandler<{ sessionId: string }, SessionRuntimeSnapshot>;
  readonly "session.history": HostHandler<
    { sessionId: string; before: number },
    SessionHistoryPage
  >;
  readonly "session.projection": HostHandler<
    { sessionId: string },
    SessionRuntimeProjectionSnapshot
  >;
  /**
   * A bounded door (the WebSocket's replay bounds, VC-663) passes `signal`
   * to cancel a replay it has refused before the subscribe call returns.
   */
  readonly "session.subscribe": (
    input: { sessionId: string; afterSequence: number; signal?: AbortSignal },
    call: HandlerCall,
    sink: {
      emit(emission: SessionStreamEmission): void | Promise<void>;
      fail(error: unknown): void;
    },
  ) => Promise<() => void>;
  readonly "session.subscribeQueue": SessionRouterHandlers["session.subscribe"];
  readonly "session.command": HostHandler<
    SessionRuntimeCommandRequest,
    SessionRuntimeCommandResult
  >;
  readonly "session.cancelQueued": HostHandler<
    { commandId: string; sessionId: string; messageId: string; expectedRevision?: number },
    SessionRuntimeCommandResult
  >;
  readonly "session.editQueued": HostHandler<
    {
      commandId: string;
      sessionId: string;
      messageId: string;
      message: RpcUiMessage;
      expectedRevision?: number;
    },
    SessionRuntimeCommandResult
  >;
  readonly "session.cancelInteraction": HostHandler<
    { sessionId: string; interactionId: string },
    void
  >;
  readonly "session.reconcile": HostHandler<{ sessionId: string; attachmentId: string }, void>;
  /** The host's recent log (VC-699): a page after a cursor. */
  readonly "logs.tail": HostHandler<HostLogsQuery, HostLogsBatch>;
  /** The host's log as it is written, after a cursor's backlog. */
  readonly "logs.follow": (
    input: HostLogsQuery,
    call: HandlerCall,
    sink: { emit(batch: HostLogsBatch): void | Promise<void>; fail(error: unknown): void },
  ) => Promise<() => void>;
  /**
   * The socket's Session reads, Workspace-scoped (VC-663, D4): the map runs
   * the socket verb's own handler with its roster forced to `workspaceId`
   * (`SOCKET_DELEGATED_HANDLER_KEYS`). The answer is the socket's envelope.
   */
  readonly "session.list": HostHandler<SessionReadInput, AgentResponse>;
  readonly "session.show": HostHandler<SessionReadInput, AgentResponse>;
  readonly "session.peek": HostHandler<SessionReadInput, AgentResponse>;
  readonly "session.answer": HostHandler<SessionReadInput, AgentResponse>;
}

type AssertNever<Type extends never> = Type;

/** The Session family's keys and the slice's keys are one set: a missing handler fails here. */
export type SessionRouterHandlersCoverage = AssertNever<
  CatalogMismatch<keyof SessionRouterHandlers & string, HostHandlerKeyOf<SessionRouterEntry>>
>;

/**
 * The Session router's context: the catalog's caller and resource ports
 * ({@link CatalogCallerContext}; its `resourceWorkspace` answers `session`
 * resources), plus the one handler map it projects. No other port: every
 * procedure reaches the host through `handlers` (VC-668).
 */
export interface SessionRouterContext extends CatalogCallerContext {
  handlers: SessionRouterHandlers;
  diagnostics: RpcDiagnosticLog;
  transport?: RouterTransport;
  performanceObserver?: RpcProcedurePerformanceObserver;
}

/** The context adds no port but the map. */
export type SessionRouterContextPorts = AssertNever<RouterContextPorts<SessionRouterContext>>;

export interface RpcDiagnosticEntry {
  id: number;
  timestamp: number;
  procedure: string;
  phase: "start" | "success" | "error";
  transport: NonNullable<SessionRouterContext["transport"]>;
  code: string | null;
  message: string | null;
}

export interface RpcDiagnosticLogOptions {
  capacity?: number;
  now?: () => number;
}

interface DiagnosticSubscriber {
  cursor: number;
  active: boolean;
  entries: Map<number, RpcDiagnosticEntry>;
  listener: (entry: RpcDiagnosticEntry) => void;
}

const MAX_IDENTIFIER_LENGTH = 512;
/**
 * Display text is prose from someone else's catalog, not an identifier this app
 * minted, so it gets its own bound rather than borrowing the identifier one.
 * The two happen to agree today; they answer to different contracts, and a
 * later change to either must not silently move the other.
 */
const MAX_DISPLAY_LABEL_LENGTH = 512;

/** Where {@link logRpcDiagnostics} writes: a host's structured logger, by level. */
export interface RpcDiagnosticLogger {
  debug(msg: string, fields: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields: Readonly<Record<string, unknown>>): void;
}

/**
 * Forwards every route diagnostic from now on into a host's structured log
 * (VC-699): a call's start and success at `debug`, its failure at `warn` with
 * the code and the sanitized message. The diagnostic is recorded inside the
 * call, so a host whose door opened a trace scope gets the call's trace on
 * each line. Returns the unsubscribe.
 */
export function logRpcDiagnostics(
  diagnostics: RpcDiagnosticLog,
  logger: RpcDiagnosticLogger,
): () => void {
  const afterId = diagnostics.list({ limit: 1 }).at(-1)?.id ?? 0;
  return diagnostics.subscribe({ afterId }, (entry) => {
    const fields = { operation: entry.procedure, transport: entry.transport };
    if (entry.phase === "error") {
      logger.warn("rpc call failed", { ...fields, code: entry.code, reason: entry.message });
    } else {
      logger.debug(entry.phase === "start" ? "rpc call" : "rpc call answered", fields);
    }
  });
}

/**
 * Small in-process, lossless-within-capacity diagnostic log. It records route
 * metadata only: procedure inputs and provider payloads never enter the log.
 */
export class RpcDiagnosticLog {
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #entries: RpcDiagnosticEntry[] = [];
  readonly #subscribers = new Set<DiagnosticSubscriber>();
  #nextId = 1;

  constructor(options: RpcDiagnosticLogOptions = {}) {
    this.#capacity = options.capacity ?? 200;
    if (!Number.isInteger(this.#capacity) || this.#capacity < 1) {
      throw new Error("RpcDiagnosticLog capacity must be a positive integer");
    }
    this.#now = options.now ?? Date.now;
  }

  list(input: { afterId?: number; limit?: number } = {}): readonly RpcDiagnosticEntry[] {
    const afterId = input.afterId ?? 0;
    const limit = input.limit ?? this.#capacity;
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new Error("Rpc diagnostic cursor must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Rpc diagnostic limit must be a positive integer");
    }
    return this.#entries
      .filter((entry) => entry.id > afterId)
      .slice(-limit)
      .map(cloneDiagnostic);
  }

  record(input: Omit<RpcDiagnosticEntry, "id" | "timestamp">): RpcDiagnosticEntry {
    const entry: RpcDiagnosticEntry = {
      id: this.#nextId++,
      timestamp: this.#now(),
      procedure: sanitizeDiagnosticText(input.procedure),
      phase: input.phase,
      transport: input.transport,
      code: input.code === null ? null : sanitizeDiagnosticText(input.code),
      message: input.message === null ? null : sanitizeDiagnosticText(input.message),
    };
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) this.#entries.shift();
    for (const subscriber of this.#subscribers) this.#enqueue(subscriber, entry);
    return cloneDiagnostic(entry);
  }

  subscribe(input: { afterId: number }, listener: (entry: RpcDiagnosticEntry) => void): () => void {
    if (!Number.isSafeInteger(input.afterId) || input.afterId < 0) {
      throw new Error("Rpc diagnostic cursor must be a non-negative integer");
    }
    const subscriber: DiagnosticSubscriber = {
      cursor: Math.max(input.afterId, (this.#entries[0]?.id ?? this.#nextId) - 1),
      active: true,
      entries: new Map(),
      listener,
    };
    this.#subscribers.add(subscriber);
    for (const entry of this.#entries) this.#enqueue(subscriber, entry);
    return () => {
      subscriber.active = false;
      this.#subscribers.delete(subscriber);
    };
  }

  #enqueue(subscriber: DiagnosticSubscriber, entry: RpcDiagnosticEntry): void {
    if (!subscriber.active || entry.id <= subscriber.cursor) return;
    subscriber.entries.set(entry.id, entry);
    while (subscriber.entries.has(subscriber.cursor + 1)) {
      const nextId = ++subscriber.cursor;
      const next = subscriber.entries.get(nextId);
      subscriber.entries.delete(nextId);
      subscriber.listener(cloneDiagnostic(next!));
    }
  }
}

const nonEmptyString = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .refine(
    (value) => value.trim() === value,
    "Expected an identifier without surrounding whitespace",
  );
/**
 * Free-text display text from a catalog Volli does not control (a Model
 * Access provider's or model's own `label`) — sanitized, never rejected.
 * `nonEmptyString`'s "no surrounding whitespace" refinement is an identifier
 * contract for values THIS app mints (`providerId`, `modelId`, session/operation
 * ids); a live upstream model catalog is under no such obligation, and a
 * genuinely large one (Pi's `builtinModels()` currently lists 1000+ entries) has
 * already been observed shipping a handful of whitespace-padded display names.
 * Rejecting the whole snapshot over one cosmetic label crashes every Model
 * Access caller — the composer's catalog, Settings, and
 * `modelAccess.setDefault`'s own availability check.
 *
 * So this schema only trims: it neither bounds nor refuses, because either
 * would put the whole catalog back at the mercy of one entry. The bound and
 * the answer to an unusable label live in {@link usableLabel}, which the
 * enclosing objects apply once they can see the ids to fall back to.
 */
const displayLabel = z.string().trim();
/**
 * The label to show, or the entry's own identity when the catalog's is unusable.
 *
 * Empty, whitespace-only and absurdly long all mean the same thing here — there
 * is no display text worth showing — and all three answer the same way. A
 * provider/model identity pair is not pretty, but it names the exact thing the
 * row selects, which is the property a label has to keep.
 */
function usableLabel(label: string, fallback: string): string {
  return label.length > 0 && label.length <= MAX_DISPLAY_LABEL_LENGTH ? label : fallback;
}
const nonNegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Expected a safe non-negative integer");
const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "Expected a safe positive integer");
const sseCursor = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)), "Expected a safe non-negative integer");
const nullableString = z.string().nullable();

/**
 * The skill slugs a start may name. The count cap is a sanity bound, not a
 * product rule — nobody scrolls twenty system-prompt documents — and the slug
 * grammar is the `/name` character class from `@volli/shared`, checked here so
 * a slug main could never have loaded is refused at the edge rather than
 * surfacing as a missing-skill start failure.
 */
const skillSlugs = z
  .array(nonEmptyString.refine((value) => /^[A-Za-z0-9_:-]+$/.test(value), "Expected a skill slug"))
  .max(20)
  .optional();
const uiMessageSchema = z
  .custom<RpcUiMessage>(isUiMessage, "Expected an AI SDK UIMessage")
  .refine(isJsonSafeUiMessage, "UIMessage payloads must contain only JSON-safe values");
const modelSelectionSchema = z.object({
  providerId: nonEmptyString,
  modelId: nonEmptyString,
  reasoningLevel: z.enum(REASONING_LEVELS),
});
/**
 * Both halves optional and both meaningful alone: a bare model keeps the
 * default's level where the chosen model can run it, a bare level keeps the
 * default model. The server owns that merge (`resolveModelSelection`) and the
 * availability check behind it, so this edge only states the grammar.
 */
const modelOverrideSchema = z
  .object({
    model: z.object({ providerId: nonEmptyString, modelId: nonEmptyString }).optional(),
    reasoningLevel: z.enum(REASONING_LEVELS).optional(),
  })
  .optional();
const modelPurposeSchema = z.enum(MODEL_PURPOSES);
// One nullable selection per tier, keyed off the shared list so a tier added
// there cannot be silently stripped at this edge (z.object drops unknown keys).
const modelAccessDefaultsSchema = z.object(
  Object.fromEntries(
    MODEL_PURPOSES.map((tier) => [tier, modelSelectionSchema.nullable()]),
  ) as Record<ModelPurpose, z.ZodNullable<typeof modelSelectionSchema>>,
);
/**
 * A hidden-model entry is an identity pair, never a whole model row: the list
 * is user curation persisted app-wide, and anything beyond the two ids would
 * be catalog state masquerading as preference. The count cap is a sanity bound
 * — the catalog itself is ~1000 entries.
 */
const hiddenModelsSchema = z
  .array(z.object({ providerId: nonEmptyString, modelId: nonEmptyString }))
  .max(2000);
/**
 * The compaction policy, whole in both directions: the one global switch,
 * never a delta. Per-model reserve budgets used to cross here too and were
 * retired with the policy that carried them (VC-155).
 */
const compactionPolicySchema = z.object({
  autoCompaction: z.boolean(),
});
/**
 * Code Mode's policy (VC-471), whole in both directions like compaction's:
 * the switch and every per-model pin, never a delta.
 *
 * A pin is keyed `providerId/modelId` (`codeModeModelKey`). The key shape and
 * the count cap are the ones main's tolerant reader holds a stored policy to,
 * stated here so the edge REFUSES what storage would otherwise drop without a
 * word — a pin the renderer saved and main silently discarded is a setting
 * that lies about what is configured.
 */
const codeModeModelKeySchema = nonEmptyString.refine((key) => {
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1;
}, "Expected a providerId/modelId key");
const codeModePolicySchema = z.object({
  enabled: z.boolean(),
  models: z
    .record(codeModeModelKeySchema, z.enum(CODE_MODE_MODES))
    .refine(
      (models) => Object.keys(models).length <= CODE_MODE_POLICY_MODELS_MAX,
      `At most ${CODE_MODE_POLICY_MODELS_MAX} models may have their own Code Mode`,
    ),
});
const modelPickerViewSchema = z.enum(MODEL_PICKER_VIEWS);
const experimentIdSchema = z.enum(EXPERIMENTS.map(({ id }) => id));
const experimentFlagSchema = z.object({
  enabled: z.boolean(),
  source: z.enum(["default", "storage", "environment"]),
});
const experimentSnapshotSchema = z.object(
  Object.fromEntries(EXPERIMENTS.map(({ id }) => [id, experimentFlagSchema])) as Record<
    ExperimentId,
    typeof experimentFlagSchema
  >,
);
const modelAccessStateSchema = z.enum(["available", "authentication-required", "unavailable"]);
/**
 * One account's subscription windows (VC-263). Every field is a number the
 * runtime already clamped or a label it composed; nothing here is a credential
 * or a provider's free text. `resetsAt` stays a string because the wire is
 * JSON and a `Date` would not survive a non-Electron transport.
 */
const usageLimitsSchema = z.object({
  checkedAt: z.number().finite(),
  windows: z
    .array(
      z.object({
        id: nonEmptyString,
        kind: z.enum(["session", "weekly", "monthly", "other"]),
        label: displayLabel,
        usedPercent: z.number().finite().min(0).max(100),
        resetsAt: z.string().optional(),
        // A length is the one field here a provider's own unit can spoil: it
        // is derived, not reported, and the runtime clamps it. `.catch` makes
        // this schema's own opinion cost the FIELD rather than the snapshot —
        // a window whose length we cannot vouch for draws no hairline, where a
        // throw would take the whole Model Access page down with it.
        windowDurationMins: positiveSafeInteger.optional().catch(undefined),
      }),
    )
    .max(50),
  unavailable: z.object({ reason: z.enum(["unsupported", "probeFailed"]) }).optional(),
});
const modelCatalogRefreshReportSchema = z.object({
  added: nonNegativeSafeInteger,
  removed: nonNegativeSafeInteger,
  rejected: nonNegativeSafeInteger,
  refreshedProviderIds: z.array(nonEmptyString).max(100),
  failedProviderIds: z.array(nonEmptyString).max(100),
});
const modelAccessSnapshotSchema = z.object({
  observedAt: z.number().finite(),
  refresh: modelCatalogRefreshReportSchema.optional(),
  providers: z.array(
    z
      .object({
        id: nonEmptyString,
        label: displayLabel,
        state: modelAccessStateSchema,
        accountLabel: nullableString,
        billingSource: z.enum([
          "subscription",
          "api-key",
          "gateway",
          "local",
          "ambient",
          "unknown",
        ]),
        recovery: z.union([z.object({ kind: z.enum(["sign-in", "retry"]) }), z.null()]),
        // The provider's own wording for each method it offers, carried rather
        // than re-derived: "Sign in with SuperGrok or X Premium" names which
        // subscription is about to be billed, and no label this edge could
        // invent would. `displayLabel` trims it under the same policy as every
        // other upstream string here.
        signIn: z.array(
          z.object({
            type: z.enum(["api-key", "oauth"]),
            label: displayLabel,
            isSubscription: z.boolean(),
          }),
        ),
        hasStoredCredential: z.boolean(),
        usageLimits: usageLimitsSchema.optional(),
      })
      .overwrite((provider) => ({ ...provider, label: usableLabel(provider.label, provider.id) })),
  ),
  models: z.array(
    z
      .object({
        providerId: nonEmptyString,
        modelId: nonEmptyString,
        label: displayLabel,
        state: modelAccessStateSchema,
        reasoningLevels: z.array(z.enum(REASONING_LEVELS)),
        // Absent when the catalog reports no usable size; the renderer's
        // context meter divides by this, so zero is not allowed through.
        contextWindow: positiveSafeInteger.optional(),
        // Whether the attach affordance may offer images (VC-50). Defaults to
        // permitting them: an older main process that does not send the field
        // should not silently disable attachments across the whole catalog.
        acceptsImageInput: z.boolean().optional().default(true),
      })
      .overwrite((model) => ({
        ...model,
        label: usableLabel(model.label, `${model.providerId}/${model.modelId}`),
      })),
  ),
});
/** One prompt's answer, as `SessionInteractionAnswer` declares it. */
const interactionAnswerSchema = z.object({
  promptId: nonEmptyString,
  optionIds: z.array(nonEmptyString),
  response: nullableString,
});
/**
 * `answers` is optional in both directions. A resolution without it is the flat
 * single-prompt shape `readInteractionAnswers` projects, so the edge neither
 * invents an empty array nor keeps a key it was handed empty-handed.
 */
const interactionResolutionInputSchema = z.object({
  optionIds: z.array(nonEmptyString),
  response: nullableString,
  answers: z.array(interactionAnswerSchema).optional(),
});
const interactionResolutionSchema = interactionResolutionInputSchema
  // An optional key that arrives explicitly `undefined` parses as a key that is
  // present and unserialisable — Electron's structured clone keeps one where
  // JSON would have dropped it. The ledger encodes a command intent behind a
  // strict JSON assertion, so carrying that key through turns an ordinary flat
  // resolution into a throw at the persistence boundary.
  .transform(({ optionIds, response, answers }) =>
    answers === undefined ? { optionIds, response } : { optionIds, response, answers },
  );

const commandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session.stop"),
    reason: z.string().trim().min(1).max(4000).optional(),
  }),
  z.object({
    kind: z.literal("session.create"),
    projectId: nonEmptyString,
    ticketId: nullableString,
    // Stated, never derived from `ticketId` (VC-9). This raw command is the
    // lab transport's door only; the product `sessions.create` route below
    // states the two Roles a person can choose through `roleImpliedByTicket`.
    role: z.enum(SESSION_ROLES),
    // The lab transport can only ever mint a root Session: the field is
    // stated, never derived, and pinned null at this door.
    parentSessionId: z.null(),
    title: nullableString,
  }),
  z.object({
    kind: z.literal("adapter.attach"),
    continuity: z.enum(["fresh", "native_resume", "context_replay", "recreate"]),
  }),
  z.object({
    kind: z.literal("message.submit"),
    message: uiMessageSchema,
    delivery: z.enum(["queue", "steer", "replace"]).optional(),
    model: z.object({ providerId: nonEmptyString, modelId: nonEmptyString }).nullable().optional(),
    agent: nullableString.optional(),
    variant: nullableString.optional(),
  }),
  z.object({
    kind: z.literal("model.select"),
    selection: modelSelectionSchema,
  }),
  z.object({ kind: z.literal("executor.interrupt"), attachmentId: nonEmptyString.optional() }),
  z.object({ kind: z.literal("executor.retry"), attachmentId: nonEmptyString.optional() }),
  z.object({
    kind: z.literal("context.compact"),
    attachmentId: nonEmptyString.optional(),
    // Bounded like every other free string this edge takes: these words are
    // headed for a summarization prompt, and an unbounded one is a way to
    // spend a Session's whole window on the call meant to reclaim it.
    instructions: z.string().max(4000).nullable().optional(),
  }),
  z.object({
    kind: z.literal("interaction.resolve"),
    interactionId: nonEmptyString,
    resolution: interactionResolutionSchema,
  }),
  z.object({ kind: z.literal("adapter.release"), attachmentId: nonEmptyString }),
  // A person's schedule and its withdrawal. `resume.settle` is deliberately
  // absent: what became of a schedule is the host's to record, never a client's.
  z.object({
    kind: z.literal("resume.schedule"),
    attentionId: nonEmptyString,
    attachmentId: nonEmptyString,
    resumeAt: positiveSafeInteger,
  }),
  z.object({ kind: z.literal("resume.cancel"), scheduleId: nonEmptyString }),
  z.object({
    kind: z.literal("message.cancel"),
    messageId: nonEmptyString,
    expectedRevision: nonNegativeSafeInteger.optional(),
  }),
  z.object({
    kind: z.literal("message.edit"),
    messageId: nonEmptyString,
    message: uiMessageSchema,
    expectedRevision: nonNegativeSafeInteger.optional(),
  }),
]);

const commandRequestSchema = z
  .object({
    commandId: nonEmptyString,
    sessionId: nonEmptyString.optional(),
    command: commandSchema,
  })
  .superRefine((request, context) => {
    if (request.command.kind === "session.create" && request.sessionId !== undefined) {
      context.addIssue({ code: "custom", message: "session.create must not include sessionId" });
    }
    if (request.command.kind !== "session.create" && request.sessionId === undefined) {
      context.addIssue({ code: "custom", message: "Session command requires sessionId" });
    }
  });

/**
 * The welcome as `protocol.welcome` answers it: the grammar `isHostWelcome`
 * checks, stated in zod so the JSON Schema a non-TypeScript client reads can
 * be derived from it (D2). The actor is the one field left to its guard,
 * which also refuses the reserved local device.
 */
const hostWelcomeSchema = z.object({
  protocolVersion: positiveSafeInteger,
  host: z.object({ id: z.uuidv4(), version: z.string().max(128) }),
  workspace: z.object({ id: z.uuidv4(), epoch: nonNegativeSafeInteger }),
  actor: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("device"), deviceId: z.uuidv4(), workspaceId: z.uuidv4() }),
      z.object({ kind: z.literal("session"), sessionId: nonEmptyString, workspaceId: z.uuidv4() }),
      z.object({ kind: z.literal("worker"), workerId: z.uuidv4(), workspaceId: z.uuidv4() }),
    ])
    .refine(isHostActor, "Expected a network actor") satisfies z.ZodType<HostActor>,
  features: z.array(z.string().max(128)).max(256).readonly(),
  proof: z.object({ scheme: z.string(), value: z.string() }).nullable(),
});

const sessionSubscriptionSchema = z.object({
  sessionId: nonEmptyString,
  afterSequence: nonNegativeSafeInteger.optional(),
  lastEventId: sseCursor.optional(),
});

/**
 * `host.logs` (VC-699; HP § Tracing and logs). A cursor is the host's opaque
 * `<instance>:<seq>`; a page holds at most 500 lines of at most 16 KiB each,
 * so an answer stays well inside the frame bound.
 */
const logCursor = z.string().min(1).max(64);
const logsQuerySchema = z.object({
  after: logCursor.optional(),
  limit: z.number().int().min(1).max(500).optional(),
  minLevel: z.enum(LOG_LEVELS).optional(),
});
/** tRPC hands a resume's tracked id back as `lastEventId`: it wins over `after`. */
const logsFollowSchema = logsQuerySchema.extend({ lastEventId: logCursor.optional() });
const logRecordSchema = z
  .object({
    ts: z.string(),
    level: z.enum(LOG_LEVELS),
    component: z.string(),
    msg: z.string(),
  })
  .catchall(z.json());
const logsBatchSchema = z.object({
  entries: z.array(z.object({ cursor: z.string(), record: logRecordSchema })),
  gap: z.boolean(),
  cursor: z.string(),
});
/** Batches one log stream may hold unsent before it ends `subscription-overflow`. */
const LOGS_QUEUE_CAPACITY = 256;
const LOGS_OVERFLOW_MESSAGE = "The log stream fell behind the host's log";
const LOGS_SOURCE_FAILURE_MESSAGE = "The host's log stopped";

/** `before` is an event sequence: the page holds frames strictly below it (VC-315). */
const sessionHistorySchema = z.object({
  sessionId: nonEmptyString,
  before: nonNegativeSafeInteger.min(1),
});

const diagnosticsSubscriptionSchema = z.object({
  afterId: nonNegativeSafeInteger.optional(),
  lastEventId: sseCursor.optional(),
});

/** The domain reason recorded in diagnostics when a bounded queue drops frames. */
const SUBSCRIPTION_OVERFLOW_CODE = "SUBSCRIPTION_OVERFLOW";
const SUBSCRIPTION_SOURCE_FAILURE_CODE = "SUBSCRIPTION_SOURCE_FAILURE";
const SESSION_SOURCE_FAILURE_MESSAGE =
  "Session stream source failed; resubscribe to resume from the ledger";
/**
 * One message per subscription arm, shared by the diagnostic and the terminal
 * error so the two cannot drift. Both name the recovery rather than the fault,
 * because resuming from the last event id is the only thing the caller can do.
 */
const SESSION_OVERFLOW_MESSAGE = "Session subscription fell behind; resume from the last event id";
const SESSION_FRAME_TOO_LARGE_MESSAGE =
  "A Session stream frame is larger than this connection's frame bound; read the Session in bounded pages instead";
/** Frames one Session stream may hold unsent to its consumer, on every door. */
const SESSION_STREAM_QUEUE_CAPACITY = 4_096;
const DIAGNOSTICS_OVERFLOW_MESSAGE =
  "Diagnostics subscription fell behind; resume from the last event id";

/**
 * The terminal error a subscription ends on once its bounded queue has dropped
 * frames. Ending normally is what this replaces, and a normal end is a lie the
 * client cannot detect: over Electron IPC the pump sends `{kind:"done"}` and the
 * renderer link calls `observer.complete()`, so a surface that registered only
 * `onData`/`onError` simply stops updating, with the loss visible solely in a
 * main-process diagnostic no user can read. This matters more now that one
 * runtime tick emits several deltas instead of a single snapshot: the queue
 * fills faster, and holding up under concurrent sessions is the point of
 * emitting deltas at all.
 *
 * `TOO_MANY_REQUESTS` is the 429 slot, where gRPC's `RESOURCE_EXHAUSTED` also
 * lands, and it is the only bucket in tRPC's vocabulary that means flow control
 * rather than a malformed request or a broken server. The retryable codes
 * (`INTERNAL_SERVER_ERROR`, `BAD_GATEWAY`, `SERVICE_UNAVAILABLE`,
 * `GATEWAY_TIMEOUT`) are avoided deliberately: on a future HTTP transport,
 * `httpSubscriptionLink` reconnects on those by itself. That would re-arm the
 * same losing race without the consumer ever learning it fell behind — the
 * exact silence this error exists to break.
 */
function subscriptionOverflowError(message: string): HostProcedureError {
  return new HostProcedureError("subscription-overflow", message);
}

/** Creates the transport-independent Session API, currently hosted over Electron IPC. */
export function createSessionRouter() {
  const subscription = (key: "session.subscribe" | "session.subscribeQueue") =>
    workspaceProcedure(key, sessionSubscriptionSchema, sessionResource).subscription(
      async function* ({ ctx, input, signal }) {
        if (signal?.aborted) return;
        const afterSequence = maxCursor(input.afterSequence, input.lastEventId);
        // A bounded door (the WebSocket, D9) refuses a resume it would have
        // to replay too much for, before the source is opened at all.
        const bounds = ctx.replayBounds;
        if (
          bounds !== undefined &&
          replayExceedsEvents(
            bounds,
            afterSequence,
            (
              await hostAnswer(() =>
                ctx.handlers["session.projection"]({ sessionId: input.sessionId }, ctx.call),
              )
            ).throughSequence,
          )
        ) {
          throw resnapshotRequired();
        }
        const replay = bounds === undefined ? null : new ReplayMeter(bounds);
        const frameBound = ctx.maxResponseBytes;
        // Bounded in bytes too on a bounded door: twice the replay bound holds a
        // whole admitted replay and the live frames that arrive behind it.
        const queue = new AsyncQueue<RendererSessionStreamEmission>(
          SESSION_STREAM_QUEUE_CAPACITY,
          bounds === undefined ? undefined : 2 * bounds.bytes,
        );
        const sourceFailure: { current: { error: unknown } | null } = { current: null };
        // What this stream ends with instead of a frame it refused to stage:
        // resnapshot past the replay bounds, response-too-large past the frame
        // bound. Set once; the source is cancelled with it.
        const refused: { current: HostProcedureError | null } = { current: null };
        // Cancels the runtime's side even while its subscribe call is still
        // replaying: a refused replay is not read any further.
        const source = new AbortController();
        const abort = (): void => {
          source.abort();
          queue.close();
        };
        signal?.addEventListener("abort", abort, { once: true });
        // A subscription's handler runs inside the stream, past the policy
        // middleware, so its "unavailable" is mapped here.
        const unsubscribe = await hostAnswer(() =>
          ctx.handlers[key](
            {
              sessionId: input.sessionId,
              afterSequence,
              ...(replay === null ? {} : { signal: source.signal }),
            },
            ctx.call,
            {
              // Live emissions pass through untouched: `rendererFrame` exists to
              // keep runtime identity and recovery locators behind the server
              // boundary, and no transient arm carries either. Asked as the
              // negation of the durable arm so a third transient arm needs no
              // edit here.
              emit: (emission) => {
                if (refused.current !== null) return;
                // The old network operation's closed output cannot gain a new
                // union arm. Queue-aware peers opt into the new feature's path;
                // the private desktop IPC stream keeps its existing vocabulary.
                if (
                  key === "session.subscribe" &&
                  ctx.transport !== "electron-ipc" &&
                  "kind" in emission &&
                  emission.kind === "queue"
                )
                  return;
                const durable = isSessionStreamFrame(emission);
                const sent = durable ? rendererFrame(emission) : emission;
                if (replay === null) {
                  queue.push(sent);
                  return;
                }
                // Judged before it is staged: nothing past a bound is ever held.
                const bytes = jsonByteLength(sent);
                if (frameBound !== undefined && bytes > frameBound) {
                  refused.current = new HostProcedureError(
                    "response-too-large",
                    SESSION_FRAME_TOO_LARGE_MESSAGE,
                  );
                } else if (!replay.admit(bytes, durable)) {
                  refused.current = resnapshotRequired();
                } else {
                  queue.push(sent, bytes);
                  return;
                }
                // A refused replay sends nothing of itself; a live refusal still
                // drains what came before it.
                queue.close(replay.replaying);
                source.abort();
              },
              // The runtime's drain died behind this subscription. Ended like an
              // overflow — buffered contiguous frames still drain, then the
              // stream closes with an error instead of a clean `done`, because a
              // clean end here is the one thing the client must never see: it
              // reads as a stream with nothing left to say, not one that lost
              // `turn.completed` mid-turn.
              fail: (error) => {
                sourceFailure.current = { error };
                queue.close(false);
              },
            },
          ),
        );
        // The runtime replays history before its subscribe call returns, so
        // a refusal so far was a replay's: nothing of it is sent.
        replay?.end();
        if (refused.current !== null) {
          signal?.removeEventListener("abort", abort);
          unsubscribe();
          throw refused.current;
        }
        if (signal?.aborted) {
          unsubscribe();
          return;
        }
        try {
          // A transient emission is tracked by the durable sequence it was
          // emitted beside, never by a suffixed id: `sseCursor` rejects one on
          // resubscribe, and duplicate ids are safe on both transports. A
          // reconnect from an overlay id therefore replays durable history and
          // is served a fresh baseline.
          for await (const emission of queue) {
            yield isRendererStreamTransient(emission)
              ? tracked(String(emission.throughSequence), emission)
              : tracked(String(emission.sequence), emission);
          }
          // The loop ends the same way on a clean close and on an overflow, so
          // this throw is the only thing that tells them apart downstream. It
          // sits inside the `try` on purpose: `finally` still runs on the way
          // out, so `unsubscribe()` fires before the error leaves the
          // generator and no runtime listener outlives the stream it fed.
          // A consumer that tears the iterator down instead resumes at the
          // `yield` with a return completion and never reaches this line —
          // an overflow the client already walked away from stays a diagnostic.
          // A frame refused after the replay ended the stream, once what
          // came before it drained.
          if (refused.current !== null) throw refused.current;
          if (queue.overflowed) throw subscriptionOverflowError(SESSION_OVERFLOW_MESSAGE);
          // A source failure ends the same way an overflow does, and for the
          // same reason: whatever this stream still owed its consumer is now
          // only in the ledger, and only an error makes the client go back
          // for it.
          if (sourceFailure.current !== null) {
            throw new HostProcedureError(
              "subscription-source-failed",
              SESSION_SOURCE_FAILURE_MESSAGE,
              sourceFailure.current.error,
            );
          }
        } finally {
          signal?.removeEventListener("abort", abort);
          unsubscribe();
          if (queue.overflowed) {
            ctx.diagnostics.record({
              procedure: key,
              phase: "error",
              transport: ctx.transport ?? "unknown",
              code: SUBSCRIPTION_OVERFLOW_CODE,
              message: SESSION_OVERFLOW_MESSAGE,
            });
          }
          if (sourceFailure.current !== null) {
            ctx.diagnostics.record({
              procedure: key,
              phase: "error",
              transport: ctx.transport ?? "unknown",
              code: SUBSCRIPTION_SOURCE_FAILURE_CODE,
              message: SESSION_SOURCE_FAILURE_MESSAGE,
            });
          }
        }
      },
    );
  return catalogRouter({
    // Sign-ins on a host (VC-702): their own module, this router's family.
    ...signInProcedures(),
    protocol: {
      // The v1 bootstrap read: base, in no feature, so a client can always
      // ask what its handshake negotiated before anything else.
      welcome: hostProcedure("protocol.welcome")
        .output(hostWelcomeSchema)
        .query(({ ctx }) => {
          if (ctx.welcome === undefined) {
            throw new HostProcedureError(
              "operation-unavailable",
              "This connection negotiated no welcome",
            );
          }
          return ctx.welcome;
        }),
    },
    sessions: {
      create: workspaceProcedure(
        "sessions.create",
        z.object({
          operationId: nonEmptyString,
          projectId: nonEmptyString,
          // The Role, stated once: a Ticket Session when set, a project
          // Session when null — the same nullable field `session.create`
          // records durably.
          ticketId: nonEmptyString.nullable(),
          title: nullableString,
          // A client-minted UUID the durable Session adopts (VC-358), so a
          // provisional chat needs no id swap on promotion. Checked at this
          // edge: a malformed id must never reach the ledger.
          //
          // v4 SPECIFICALLY, not any UUID. `docs/BOUNDARIES.md` rule 1 bars a
          // durable id built from anything machine-local, and a v1 UUID
          // embeds the minting machine's MAC address. `z.string().uuid()`
          // admits v1 (and the nil/max ids), so it is the wrong shape for an
          // id a CLIENT proposes. A durable id derivation is frozen the
          // moment it ships, which makes this the one line that cannot be
          // tightened later.
          requestedSessionId: z.uuidv4().optional(),
          // The optimistic-open path mints the Session, so it is the path
          // that has to carry the skills: `attach` composes the prompt from
          // the record `create` wrote, and never sees this input.
          skills: skillSlugs,
          // Same reason, for the same door: a Session's model policy is
          // recorded by the create and never revisited by the attach.
          modelOverride: modelOverrideSchema,
          // The first message, for automatic model choice (VC-432). The
          // decision clips what it reads; this bounds what crosses the edge.
          autoSelect: z.object({ request: z.string().max(200_000) }).optional(),
        }),
        // The Workspace is the project the Session is born in.
        (input) => ({ kind: PROJECT_RESOURCE, id: input.projectId }),
      ).mutation(({ ctx, input }) => ctx.handlers["sessions.create"](input, ctx.call)),
      attach: workspaceProcedure(
        "sessions.attach",
        z.object({ operationId: nonEmptyString, sessionId: nonEmptyString }),
        sessionResource,
      ).mutation(({ ctx, input }) => ctx.handlers["sessions.attach"](input, ctx.call)),
    },
    settings: {
      experiments: hostProcedure("settings.experiments")
        .output(experimentSnapshotSchema)
        .query(async ({ ctx }) =>
          experimentSnapshotSchema.parse(
            await ctx.handlers["settings.experiments"](undefined, ctx.call),
          ),
        ),
      setExperiment: hostProcedure("settings.setExperiment")
        .input(z.object({ id: experimentIdSchema, enabled: z.boolean() }))
        .output(experimentSnapshotSchema)
        .mutation(async ({ ctx, input }) =>
          experimentSnapshotSchema.parse(
            await ctx.handlers["settings.setExperiment"](input, ctx.call),
          ),
        ),
    },
    modelAccess: {
      inspect: hostProcedure("modelAccess.inspect")
        .input(z.object({ refresh: z.boolean().optional() }))
        .output(modelAccessSnapshotSchema)
        .query(async ({ ctx, input }) =>
          modelAccessSnapshotSchema.parse(
            await ctx.handlers["modelAccess.inspect"](input, ctx.call),
          ),
        ),
      defaults: hostProcedure("modelAccess.defaults")
        .output(modelAccessDefaultsSchema)
        .query(async ({ ctx }) =>
          modelAccessDefaultsSchema.parse(
            await ctx.handlers["modelAccess.defaults"](undefined, ctx.call),
          ),
        ),
      setDefault: hostProcedure("modelAccess.setDefault")
        .input(
          z
            .object({ purpose: modelPurposeSchema, selection: modelSelectionSchema.nullable() })
            // Clearing ticket/utility means "use the Board default"; clearing
            // global would leave every purpose resolving to nothing, which is a
            // state the UI never offers and this edge refuses to mint.
            .refine(
              (input) => input.purpose !== "global" || input.selection !== null,
              "The Board default cannot be cleared — choose a model instead",
            ),
        )
        .output(modelAccessDefaultsSchema)
        .mutation(async ({ ctx, input }) =>
          modelAccessDefaultsSchema.parse(
            await ctx.handlers["modelAccess.setDefault"](input, ctx.call),
          ),
        ),
      hiddenModels: hostProcedure("modelAccess.hiddenModels")
        .output(hiddenModelsSchema)
        .query(async ({ ctx }) =>
          hiddenModelsSchema.parse(
            await ctx.handlers["modelAccess.hiddenModels"](undefined, ctx.call),
          ),
        ),
      setHiddenModels: hostProcedure("modelAccess.setHiddenModels")
        .input(hiddenModelsSchema)
        .output(hiddenModelsSchema)
        .mutation(async ({ ctx, input }) => {
          await ctx.handlers["modelAccess.setHiddenModels"](input, ctx.call);
          return input;
        }),
      compactionPolicy: hostProcedure("modelAccess.compactionPolicy")
        .output(compactionPolicySchema)
        .query(async ({ ctx }) =>
          compactionPolicySchema.parse(
            await ctx.handlers["modelAccess.compactionPolicy"](undefined, ctx.call),
          ),
        ),
      setCompactionPolicy: hostProcedure("modelAccess.setCompactionPolicy")
        .input(compactionPolicySchema)
        .output(compactionPolicySchema)
        .mutation(async ({ ctx, input }) =>
          compactionPolicySchema.parse(
            await ctx.handlers["modelAccess.setCompactionPolicy"](input, ctx.call),
          ),
        ),
      codeModePolicy: hostProcedure("modelAccess.codeModePolicy")
        .output(codeModePolicySchema)
        .query(async ({ ctx }) =>
          codeModePolicySchema.parse(
            await ctx.handlers["modelAccess.codeModePolicy"](undefined, ctx.call),
          ),
        ),
      setCodeModePolicy: hostProcedure("modelAccess.setCodeModePolicy")
        .input(codeModePolicySchema)
        .output(codeModePolicySchema)
        .mutation(async ({ ctx, input }) =>
          codeModePolicySchema.parse(
            await ctx.handlers["modelAccess.setCodeModePolicy"](input, ctx.call),
          ),
        ),
      pickerView: hostProcedure("modelAccess.pickerView")
        .output(modelPickerViewSchema)
        .query(async ({ ctx }) =>
          modelPickerViewSchema.parse(
            await ctx.handlers["modelAccess.pickerView"](undefined, ctx.call),
          ),
        ),
      setPickerView: hostProcedure("modelAccess.setPickerView")
        .input(modelPickerViewSchema)
        .output(modelPickerViewSchema)
        .mutation(async ({ ctx, input }) =>
          modelPickerViewSchema.parse(
            await ctx.handlers["modelAccess.setPickerView"](input, ctx.call),
          ),
        ),
    },
    session: {
      // The socket's Session reads, forced to the caller's Workspace (D4).
      list: workspaceProcedure("session.list", sessionListInput, readWorkspace)
        .output(sessionListOutput)
        .query(({ ctx, input: { projectId, ...filters } }) =>
          readSession(
            (read) => ctx.handlers["session.list"](read, ctx.call),
            projectId,
            filters,
            sessionListOutput,
          ),
        ),
      show: workspaceProcedure("session.show", sessionHandleInput, readWorkspace)
        .output(sessionReadOutput)
        .query(({ ctx, input }) =>
          readSession(
            (read) => ctx.handlers["session.show"](read, ctx.call),
            input.projectId,
            { id: input.session },
            sessionReadOutput,
          ),
        ),
      peek: workspaceProcedure("session.peek", sessionPeekInput, readWorkspace)
        .output(sessionReadOutput)
        .query(({ ctx, input }) =>
          readSession(
            (read) => ctx.handlers["session.peek"](read, ctx.call),
            input.projectId,
            { id: input.session, lines: input.lines },
            sessionReadOutput,
          ),
        ),
      answer: workspaceProcedure("session.answer", sessionHandleInput, readWorkspace)
        .output(sessionReadOutput)
        .query(({ ctx, input }) =>
          readSession(
            (read) => ctx.handlers["session.answer"](read, ctx.call),
            input.projectId,
            { id: input.session },
            sessionReadOutput,
          ),
        ),
      snapshot: workspaceProcedure(
        "session.snapshot",
        z.object({ sessionId: nonEmptyString }),
        sessionResource,
      )
        .output(sessionSnapshotOutputSchema)
        .query(async ({ ctx, input }) =>
          rendererSnapshot(
            await ctx.handlers["session.snapshot"](input, ctx.call),
            ctx.operations === undefined || ctx.operations.has("session.cancelQueued"),
          ),
        ),
      // Older transcript, a bounded page at a time, for a surface scrolling
      // back past the snapshot's tail (VC-315). The engine owns the bound.
      history: workspaceProcedure("session.history", sessionHistorySchema, sessionResource)
        .output(sessionHistoryOutputSchema)
        .query(async ({ ctx, input }) =>
          rendererHistoryPage(await ctx.handlers["session.history"](input, ctx.call)),
        ),
      // The same durable state without the transcript replay beside it. A
      // surface that already holds the stream re-reads Session state often and
      // the frames never — and shipping them anyway costs an artifact read per
      // transcript event and a structured clone of the whole transcript, per
      // read. `snapshot` above stays for the callers that replay history.
      projection: workspaceProcedure(
        "session.projection",
        z.object({ sessionId: nonEmptyString }),
        sessionResource,
      )
        .output(sessionProjectionOutputSchema)
        .query(async ({ ctx, input }) =>
          rendererProjection(
            await ctx.handlers["session.projection"](input, ctx.call),
            ctx.operations === undefined || ctx.operations.has("session.cancelQueued"),
          ),
        ),
      subscribe: subscription("session.subscribe"),
      subscribeQueue: subscription("session.subscribeQueue"),
      command: workspaceProcedure(
        "session.command",
        commandRequestSchema,
        // `session.create`, the one kind that names no Session, is withheld
        // before this resolves; every other kind requires `sessionId`.
        (input) => sessionResource({ sessionId: input.sessionId! }),
      )
        .output(sessionCommandOutputSchema)
        .mutation(async ({ ctx, input }) => {
          // Start and queue-mutation kinds have their own entries and are
          // withheld here (`refusedIntents`), whoever asks.
          try {
            return rendererCommandResult(
              await ctx.handlers["session.command"](
                toSessionRuntimeCommandRequest(input),
                ctx.call,
              ),
            );
          } catch (error) {
            if (error instanceof SuperviseSessionError) {
              throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
            }
            throw error;
          }
        }),
      cancelQueued: workspaceProcedure(
        "session.cancelQueued",
        z.object({
          commandId: nonEmptyString,
          sessionId: nonEmptyString,
          messageId: nonEmptyString,
          expectedRevision: nonNegativeSafeInteger.optional(),
        }),
        sessionResource,
      )
        .output(sessionCommandOutputSchema)
        .mutation(async ({ ctx, input }) =>
          rendererCommandResult(await ctx.handlers["session.cancelQueued"](input, ctx.call)),
        ),
      editQueued: workspaceProcedure(
        "session.editQueued",
        z.object({
          commandId: nonEmptyString,
          sessionId: nonEmptyString,
          messageId: nonEmptyString,
          message: uiMessageSchema,
          expectedRevision: nonNegativeSafeInteger.optional(),
        }),
        sessionResource,
      )
        .output(sessionCommandOutputSchema)
        .mutation(async ({ ctx, input }) =>
          rendererCommandResult(await ctx.handlers["session.editQueued"](input, ctx.call)),
        ),
      // A pending interaction the user walked away from. The handler fixes the
      // reason rather than taking it as input: a person's door can honestly
      // report only that they left it undecided.
      cancelInteraction: workspaceProcedure(
        "session.cancelInteraction",
        z.object({ sessionId: nonEmptyString, interactionId: nonEmptyString }),
        sessionResource,
      ).mutation(({ ctx, input }) => ctx.handlers["session.cancelInteraction"](input, ctx.call)),
      reconcile: workspaceProcedure(
        "session.reconcile",
        z.object({ sessionId: nonEmptyString, attachmentId: nonEmptyString }),
        sessionResource,
      ).mutation(({ ctx, input }) => ctx.handlers["session.reconcile"](input, ctx.call)),
    },
    logs: {
      tail: hostProcedure("logs.tail")
        .input(logsQuerySchema)
        .output(logsBatchSchema)
        .query(async ({ ctx, input }) => {
          const page = await ctx.handlers["logs.tail"](input, ctx.call);
          return { ...page, entries: [...page.entries] };
        }),
      follow: hostProcedure("logs.follow")
        .input(logsFollowSchema)
        .subscription(async function* ({ ctx, input, signal }) {
          if (signal?.aborted) return;
          const { lastEventId, ...query } = input;
          const after = lastEventId ?? query.after;
          const queue = new AsyncQueue<HostLogsBatch>(LOGS_QUEUE_CAPACITY);
          const failure: { current: { error: unknown } | null } = { current: null };
          const abort = (): void => queue.close();
          signal?.addEventListener("abort", abort, { once: true });
          const unsubscribe = await hostAnswer(() =>
            ctx.handlers["logs.follow"](
              { ...query, ...(after === undefined ? {} : { after }) },
              ctx.call,
              {
                emit: (batch) => queue.push(batch),
                fail: (error) => {
                  failure.current = { error };
                  queue.close(false);
                },
              },
            ),
          );
          try {
            // Each batch is tracked by its newest line: a resume asks for what follows it.
            for await (const batch of queue) yield tracked(batch.cursor, batch);
            if (queue.overflowed) throw subscriptionOverflowError(LOGS_OVERFLOW_MESSAGE);
            // A source that died never reads as a log with nothing more to say.
            if (failure.current !== null) {
              throw new HostProcedureError(
                "subscription-source-failed",
                LOGS_SOURCE_FAILURE_MESSAGE,
                failure.current.error,
              );
            }
          } finally {
            signal?.removeEventListener("abort", abort);
            unsubscribe();
          }
        }),
    },
    labDiagnostics: {
      list: hostProcedure("labDiagnostics.list")
        .input(
          z
            .object({
              afterId: nonNegativeSafeInteger.optional(),
              limit: positiveSafeInteger.optional(),
            })
            .optional(),
        )
        .query(({ ctx, input }) => ctx.diagnostics.list(input)),
      subscribe: hostProcedure("labDiagnostics.subscribe")
        .input(diagnosticsSubscriptionSchema)
        .subscription(async function* ({ ctx, input, signal }) {
          if (signal?.aborted) return;
          const queue = new AsyncQueue<RpcDiagnosticEntry>();
          const unsubscribe = ctx.diagnostics.subscribe(
            { afterId: maxCursor(input.afterId, input.lastEventId) },
            (entry) => queue.push(entry),
          );
          if (signal?.aborted) {
            unsubscribe();
            return;
          }
          const abort = () => queue.close();
          signal?.addEventListener("abort", abort, { once: true });
          try {
            for await (const entry of queue) yield tracked(String(entry.id), entry);
            // Same shape, same reasoning as `session.subscribe` above: a dropped
            // diagnostic that ends the stream normally reads to the lab panel as
            // "nothing more happened", which is the one thing a diagnostics
            // surface must never say.
            if (queue.overflowed) throw subscriptionOverflowError(DIAGNOSTICS_OVERFLOW_MESSAGE);
          } finally {
            signal?.removeEventListener("abort", abort);
            unsubscribe();
            if (queue.overflowed) {
              ctx.diagnostics.record({
                procedure: "labDiagnostics.subscribe",
                phase: "error",
                transport: ctx.transport ?? "unknown",
                code: SUBSCRIPTION_OVERFLOW_CODE,
                message: DIAGNOSTICS_OVERFLOW_MESSAGE,
              });
            }
          }
        }),
    },
  });
}

function rendererCommandResult(result: SessionRuntimeCommandResult): RendererSessionCommandResult {
  return {
    sessionId: result.sessionId,
    receipt: result.receipt,
    throughSequence: result.throughSequence,
    // Nullable rather than optional, so the field survives every transport
    // rather than only the one that carries `undefined` (BOUNDARIES.md rule 3).
    refusal: result.refusal,
    ...(result.stop === undefined ? {} : { stop: result.stop }),
  };
}

/**
 * Runtime identity and recovery locators stay behind the product edge. The
 * per-kind knowledge lives in the codec's scrub table, where a new payload
 * kind without an entry fails to compile — this edge only composes it.
 */
function rendererFrame(frame: SessionStreamFrame): RendererSessionStreamFrame {
  return { ...frame, event: scrubSessionEvent(frame.event) };
}

export type RendererSessionProjection = SessionPresentationProjection &
  Pick<SessionRuntimeProjectionSnapshot["projection"], "queue" | "queueRevision">;

function rendererProjection(
  snapshot: SessionRuntimeProjectionSnapshot,
  includeQueue: boolean,
): {
  projection: RendererSessionProjection;
  throughSequence: number;
} {
  const source = snapshot.projection;
  // A builder, filled field by field from whichever ones the snapshot carried,
  // so it drops the `readonly` the published type wears (VC-393). The value
  // leaves here as that type and nothing mutates it afterwards.
  const projection: {
    -readonly [K in keyof RendererSessionProjection]?: RendererSessionProjection[K];
  } = {};
  // Old peers did not negotiate these optional output fields. Keep their
  // strict JSON readers on the frozen projection shape, even if work exists.
  if (includeQueue) {
    if (source.queue !== undefined) projection.queue = source.queue;
    if (source.queueRevision !== undefined) projection.queueRevision = source.queueRevision;
  }
  if (source.session !== undefined) projection.session = source.session;
  if (source.status !== undefined) projection.status = source.status;
  if (source.attention !== undefined) {
    projection.attention = {
      active: source.attention.active.map(scrubSessionAttention),
      primary:
        source.attention.primary === null ? null : scrubSessionAttention(source.attention.primary),
    };
  }
  if (source.interactions !== undefined) {
    projection.interactions = {
      active: source.interactions.active.map(scrubSessionInteraction),
      resolved: source.interactions.resolved.map((entry) => ({
        ...entry,
        interaction: scrubSessionInteraction(entry.interaction),
      })),
    };
  }
  if (source.signal !== undefined) projection.signal = source.signal;
  if (source.modelSelection !== undefined) projection.modelSelection = source.modelSelection;
  if (source.modelTier !== undefined) projection.modelTier = source.modelTier;
  if (source.modelAuto !== undefined) projection.modelAuto = source.modelAuto;
  if (source.turnActive !== undefined) projection.turnActive = source.turnActive;
  if (source.lastActivityAt !== undefined) projection.lastActivityAt = source.lastActivityAt;
  if (source.bornTicketless !== undefined) projection.bornTicketless = source.bornTicketless;
  // The plan as it stands, whatever part of the transcript a surface holds (VC-315).
  if (source.todoList !== undefined) projection.todoList = source.todoList;
  if (source.liveExecutor !== undefined) {
    projection.liveExecutor = source.liveExecutor === null ? null : { id: source.liveExecutor.id };
    // Derived from the same attachment in the same branch, so the identity a
    // surface shows and the policy it shows beside it can never be about two
    // different attachments (VC-285). The codec owns what may cross; this edge
    // only composes it, as it does for every other scrubbed field here.
  }
  // Derived from the Session's own commands and receipts, which never cross
  // this edge themselves: the surface gets the one schedule it may draw.
  if (source.commands !== undefined && source.receipts !== undefined) {
    projection.scheduledResume = presentedScheduledResume(source);
  }
  return {
    projection: projection as RendererSessionProjection,
    throughSequence: snapshot.throughSequence,
  };
}

/** One window of transcript as the renderer receives it: scrubbed frames, then the older cursor. */
export interface RendererSessionHistoryPage {
  frames: RendererSessionStreamFrame[];
  before: number | null;
}

function rendererHistoryPage(page: SessionHistoryPage): RendererSessionHistoryPage {
  return { frames: page.frames.map(rendererFrame), before: page.before };
}

/**
 * The projection checkpoint plus the newest window of frames (VC-315). The
 * window's own artifact list stays behind: every one of them is already inlined
 * on its frame.
 *
 * `before` and `latestReply` ride only when they say something, like the
 * projection's own fields: a window that reaches the first event and a turn
 * with no reply read the same absent as present-and-null, and a snapshot that
 * says neither is the exact reply an older Client already parses (VC-669's
 * N−1 recording).
 */
function rendererSnapshot(
  snapshot: SessionRuntimeSnapshot,
  includeQueue: boolean,
): {
  projection: RendererSessionProjection;
  throughSequence: number;
  frames: RendererSessionStreamFrame[];
  before?: number;
  latestReply?: SessionLatestReply;
} {
  return {
    ...rendererProjection(snapshot, includeQueue),
    frames: snapshot.frames.map(rendererFrame),
    ...(snapshot.before === null ? {} : { before: snapshot.before }),
    ...(snapshot.latestReply === null ? {} : { latestReply: snapshot.latestReply }),
  };
}

export type AppRouter = ReturnType<typeof createSessionRouter>;

/**
 * Publishable wire grammar for every catalog procedure, including subscriptions
 * (their output is one untracked emission, not the transport's SSE envelope).
 * No-input and void-result calls have no JSON value: null is the document
 * sentinel, explicitly distinguished by the booleans, never a runtime rewrite.
 * The two command-input adapters describe custom/transform parsers without
 * weakening their runtime checks. Refinements remain runtime-only constraints.
 */
function publishCommandInput(input: z.ZodType | undefined): z.ZodType {
  if (
    !(input instanceof z.ZodObject) ||
    !(input.shape.command instanceof z.ZodDiscriminatedUnion)
  ) {
    throw new Error("session.command needs a structural command envelope for publication");
  }
  const commandWireSchema = z.union(
    input.shape.command.options.map((option) => {
      if (!(option instanceof z.ZodObject) || !(option.shape.kind instanceof z.ZodLiteral)) {
        throw new Error("session.command needs object alternatives with literal kinds");
      }
      if (
        option.shape.kind.value === "message.submit" ||
        option.shape.kind.value === "message.edit"
      ) {
        return option.extend({
          message: uiMessageWireSchema.extend({
            id: nonEmptyString,
            parts: uiMessageWireSchema.shape.parts.min(1),
          }),
        });
      }
      if (option.shape.kind.value === "interaction.resolve") {
        return option.extend({ resolution: interactionResolutionInputSchema });
      }
      return option;
    }),
  );
  // Preserve the actual envelope's required fields, bounds and refinements.
  // Rebuilding it here would hide a breaking router change from the CI diff.
  return input.safeExtend({ command: commandWireSchema });
}

export function sessionProcedureSchemas(
  router: AppRouter = createSessionRouter(),
): Record<string, ProcedureSchema> {
  const supplementalOutputs: Record<string, z.ZodType> = {
    "sessions.create": z.object({ sessionId: z.string() }),
    "sessions.attach": sessionAttachOutputSchema,
    "session.subscribe": legacyStreamEmissionSchema,
    "session.subscribeQueue": streamEmissionSchema,
    "session.cancelInteraction": z.null(),
    "session.reconcile": z.null(),
    "labDiagnostics.list": z.array(diagnosticEntrySchema),
    "labDiagnostics.subscribe": diagnosticEntrySchema,
    ...signInSupplementalOutputs,
    "logs.follow": logsBatchSchema,
  };
  return procedureSchemas(
    router,
    supplementalOutputs,
    (key, input) => {
      if (key === "session.command") return publishCommandInput(input);
      if (key === "session.editQueued") {
        if (!(input instanceof z.ZodObject))
          throw new Error("session.editQueued needs a structural message envelope for publication");
        return input.safeExtend({
          message: uiMessageWireSchema.extend({
            id: nonEmptyString,
            parts: uiMessageWireSchema.shape.parts.min(1),
          }),
        });
      }
      return input ?? z.null();
    },
    ["session.cancelInteraction", "session.reconcile", ...SIGN_IN_VOID_OUTPUTS],
  );
}

/**
 * Every Session-router procedure is one of the family's catalog entries and
 * every such entry is one procedure (VC-564, D2). A procedure added here
 * without a Verb Registry entry, or an entry with no procedure, fails
 * `pnpm typecheck` on this line and names the key. The union over every
 * router is `HostRouterCatalogBinding` (`host-router.ts`).
 */
export type SessionRouterCatalogBinding = AssertNever<
  CatalogMismatch<ProcedurePaths<AppRouter["_def"]["record"]>, CatalogKeyOf<SessionRouterEntry>>
>;

/**
 * The Session RPC seam, checked in one place. If a procedure starts carrying a
 * value that changes across a JSON wire, this alias fails here and names the
 * procedure plus `input` or `output`.
 */
export type SessionRouterJsonSafety = AssertNever<JsonUnsafeProcedures<AppRouter>>;

function maxCursor(cursor: number | undefined, lastEventId: string | undefined): number {
  const restored = lastEventId === undefined ? 0 : Number.parseInt(lastEventId, 10);
  return Math.max(cursor ?? 0, restored);
}

function toSessionRuntimeCommandRequest(
  input: z.infer<typeof commandRequestSchema>,
): SessionRuntimeCommandRequest {
  /* v8 ignore next 3 -- unreachable: the `session.command` catalog entry withholds
     `session.create` before any handler runs; the arm keeps this mapping total. */
  if (input.command.kind === "session.create") {
    return { origin: { kind: "user" }, commandId: input.commandId, command: input.command };
  }
  return {
    origin: { kind: "user" },
    commandId: input.commandId,
    sessionId: input.sessionId!,
    command: input.command,
  };
}

function isUiMessage(value: unknown): value is RpcUiMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > MAX_IDENTIFIER_LENGTH ||
    value.id.trim() !== value.id ||
    !isUiRole(value.role) ||
    !Array.isArray(value.parts) ||
    value.parts.length === 0
  ) {
    return false;
  }
  return value.parts.every((part) => isRecord(part) && typeof part.type === "string");
}

/** Preserve transcript serialization's established undefined-slot semantics while checking opaque values. */
function isJsonSafeUiMessage(value: unknown): boolean {
  return isJsonSafeValue(value, new Set());
}

function isJsonSafeValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.keys(value).every((key) => {
        const index = Number(key);
        return (
          Number.isInteger(index) &&
          index >= 0 &&
          index < value.length &&
          `${index}` === key &&
          isJsonSafeValue(value[index], ancestors)
        );
      });
    }
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.keys(value).every((key) =>
        isJsonSafeValue((value as Record<string, unknown>)[key], ancestors),
      )
    );
  } finally {
    ancestors.delete(value);
  }
}

function isUiRole(value: unknown): value is RpcUiMessage["role"] {
  return value === "system" || value === "user" || value === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDiagnostic(entry: RpcDiagnosticEntry): RpcDiagnosticEntry {
  return { ...entry };
}
