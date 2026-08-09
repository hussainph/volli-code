import { initTRPC, TRPCError, tracked } from "@trpc/server";
import {
  isSessionStreamOverlay,
  MAX_RUNTIME_PREFERENCE_MODELS,
  REASONING_LEVELS,
  type ModelAccessSnapshot,
  type RuntimeCatalog,
  type SessionClientCommand,
  type SessionRuntime,
  type SessionRuntimeCommandResult,
  type SessionRuntimeCommandRequest,
  type SessionRuntimeProjectionSnapshot,
  type SessionRuntimeSnapshot,
  type SessionPresentationProjection,
  type SessionStreamEmission,
  type SessionStreamFrame,
  type SessionStartResult,
} from "@volli/session-engine";
import { z } from "zod";

type RpcUiMessage = Extract<SessionClientCommand, { kind: "message.submit" }>["message"];
type RpcModelSelection = Extract<SessionClientCommand, { kind: "model.select" }>["selection"];

export type RendererSessionCommand =
  | Pick<Extract<SessionClientCommand, { kind: "message.submit" }>, "kind" | "message" | "delivery">
  | Extract<
      SessionClientCommand,
      | { kind: "model.select" }
      | { kind: "executor.interrupt" }
      | { kind: "executor.retry" }
      | { kind: "interaction.resolve" }
    >;

export interface RendererSessionCommandRequest {
  commandId: string;
  sessionId: string;
  command: RendererSessionCommand;
}

export type RendererSessionCommandResult = Pick<
  SessionRuntimeCommandResult,
  "sessionId" | "receipt" | "throughSequence"
>;

type RendererSafeValue<Value> = Value extends readonly (infer Item)[]
  ? readonly RendererSafeValue<Item>[]
  : Value extends object
    ? {
        [Key in keyof Value as Key extends "adapterId" | "profileId"
          ? never
          : Key]: RendererSafeValue<Value[Key]>;
      }
    : Value;

/** A streamed Session emission with executor routing identity removed. */
export type RendererSessionStreamEmission = RendererSafeValue<SessionStreamEmission>;

export interface TicketSessionStartInput {
  operationId: string;
  projectId: string;
  ticketId: string;
  title: string | null;
}

export interface SessionAttachInput {
  operationId: string;
  sessionId: string;
}

export interface ProjectSessionStartInput {
  operationId: string;
  projectId: string;
  title: string | null;
}

/**
 * The server-side composition root supplies this context. It deliberately
 * carries the deep runtime rather than leaking its ports to individual RPCs.
 */
export interface SessionRouterContext {
  runtime: SessionRuntime;
  inspectModelAccess?: (input: { refresh?: boolean }) => Promise<ModelAccessSnapshot>;
  readDefaultModelSelection?: () => RpcModelSelection | null;
  writeDefaultModelSelection?: (selection: RpcModelSelection) => void | Promise<void>;
  startTicketSession?: (input: TicketSessionStartInput) => Promise<SessionStartResult>;
  attachTicketSession?: (input: SessionAttachInput) => Promise<SessionStartResult>;
  startProjectSession?: (input: ProjectSessionStartInput) => Promise<SessionStartResult>;
  attachProjectSession?: (input: SessionAttachInput) => Promise<SessionStartResult>;
  resolveRuntimeCatalog?: (projectId?: string) => RuntimeCatalog | Promise<RuntimeCatalog>;
  diagnostics: RpcDiagnosticLog;
  transport?: "electron-ipc" | "lab-http" | "unknown";
}

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

const MAX_DIAGNOSTIC_FIELD_LENGTH = 1_000;
const MAX_IDENTIFIER_LENGTH = 512;

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

/** Removes values that could expose credentials, prompts, provider bodies, or local paths. */
export function sanitizeDiagnosticText(value: string): string {
  return truncateDiagnostic(
    value
      .replace(
        /\b(authorization)\b\s*(?:[:=]\s*|\s+)[^\r\n,;)}\]]+/gi,
        (_match, label: string) => `${label}: [REDACTED]`,
      )
      .replace(
        /\b(bearer|token|api[_-]?key|password|secret)\b\s*(?:[:=]\s*|\s+)[^\s,;)}\]]+/gi,
        (_match, label: string) => `${label}: [REDACTED]`,
      )
      .replace(
        /\b(prompt|messages?|parts?|provider(?:[_-]?payload)?)\b\s*[:=]\s*(?:\[[^\]]*\]|\{[^}]*\}|"[^"]*"|'[^']*'|\S+)/gi,
        (_match, label: string) => `${label}: [REDACTED]`,
      )
      .replace(/(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|~)(?:\/[^\s,;)}\]]*)?/g, "[HOME]"),
  );
}

const nonEmptyString = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .refine(
    (value) => value.trim() === value,
    "Expected an identifier without surrounding whitespace",
  );
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
const uiMessageSchema = z.custom<RpcUiMessage>(isUiMessage, "Expected an AI SDK UIMessage");
const runtimeModelRefSchema = z.object({ providerId: nonEmptyString, modelId: nonEmptyString });
const modelSelectionSchema = z.object({
  providerId: nonEmptyString,
  modelId: nonEmptyString,
  reasoningLevel: z.enum(REASONING_LEVELS),
});
const modelAccessStateSchema = z.enum(["available", "authentication-required", "unavailable"]);
const modelAccessSnapshotSchema = z.object({
  observedAt: z.number().finite(),
  providers: z.array(
    z.object({
      id: nonEmptyString,
      label: nonEmptyString,
      state: modelAccessStateSchema,
      accountLabel: nullableString,
      billingSource: z.enum(["subscription", "api-key", "gateway", "local", "ambient", "unknown"]),
      recovery: z.union([z.object({ kind: z.enum(["external-sign-in", "retry"]) }), z.null()]),
    }),
  ),
  models: z.array(
    z.object({
      providerId: nonEmptyString,
      modelId: nonEmptyString,
      label: nonEmptyString,
      state: modelAccessStateSchema,
      reasoningLevels: z.array(z.enum(REASONING_LEVELS)),
    }),
  ),
});
const runtimeSelectionSchema = z.object({
  providerId: z.string().max(MAX_IDENTIFIER_LENGTH),
  modelId: z.string().max(MAX_IDENTIFIER_LENGTH),
  variant: z.string().max(MAX_IDENTIFIER_LENGTH),
  agent: z.string().max(MAX_IDENTIFIER_LENGTH),
});
const runtimePreferencesSchema = z.object({
  version: z.literal(1),
  enabledModels: z.array(runtimeModelRefSchema).max(MAX_RUNTIME_PREFERENCE_MODELS),
  defaults: runtimeSelectionSchema,
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
const interactionResolutionSchema = z
  .object({
    optionIds: z.array(nonEmptyString),
    response: nullableString,
    answers: z.array(interactionAnswerSchema).optional(),
  })
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
    kind: z.literal("session.create"),
    projectId: nonEmptyString,
    ticketId: nullableString,
    title: nullableString,
  }),
  z.object({
    kind: z.literal("adapter.attach"),
    adapterId: nonEmptyString,
    profileId: nonEmptyString,
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
    kind: z.literal("interaction.resolve"),
    interactionId: nonEmptyString,
    resolution: interactionResolutionSchema,
  }),
  z.object({ kind: z.literal("adapter.release"), attachmentId: nonEmptyString }),
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

const sessionSubscriptionSchema = z.object({
  sessionId: nonEmptyString,
  afterSequence: nonNegativeSafeInteger.optional(),
  lastEventId: sseCursor.optional(),
});

const diagnosticsSubscriptionSchema = z.object({
  afterId: nonNegativeSafeInteger.optional(),
  lastEventId: sseCursor.optional(),
});

/** The domain reason recorded in diagnostics when a bounded queue drops frames. */
const SUBSCRIPTION_OVERFLOW_CODE = "SUBSCRIPTION_OVERFLOW";
/**
 * One message per subscription arm, shared by the diagnostic and the terminal
 * error so the two cannot drift. Both name the recovery rather than the fault,
 * because resuming from the last event id is the only thing the caller can do.
 */
const SESSION_OVERFLOW_MESSAGE = "Session subscription fell behind; resume from the last event id";
const DIAGNOSTICS_OVERFLOW_MESSAGE =
  "Diagnostics subscription fell behind; resume from the last event id";

/**
 * The terminal error a subscription ends on once its bounded queue has dropped
 * frames. Ending normally is what this replaces, and a normal end is a lie the
 * client cannot detect: over Electron IPC the pump sends `{kind:"done"}` and the
 * renderer link calls `observer.complete()`, so a surface that registered only
 * `onData`/`onError` — the lab chat controller is one — simply stops updating,
 * with the loss visible solely in a main-process diagnostic no user can read.
 * This matters more now that one runtime tick emits several deltas instead of a
 * single snapshot: the queue fills faster, and holding up under concurrent
 * sessions is the point of emitting deltas at all.
 *
 * `TOO_MANY_REQUESTS` is the 429 slot, where gRPC's `RESOURCE_EXHAUSTED` also
 * lands, and it is the only bucket in tRPC's vocabulary that means flow control
 * rather than a malformed request or a broken server. The retryable codes
 * (`INTERNAL_SERVER_ERROR`, `BAD_GATEWAY`, `SERVICE_UNAVAILABLE`,
 * `GATEWAY_TIMEOUT`) are avoided deliberately: `httpSubscriptionLink` reconnects
 * on those by itself, which would re-arm the same losing race on the lab
 * transport without the consumer ever learning it fell behind — the exact
 * silence this error exists to break.
 */
function subscriptionOverflowError(message: string): TRPCError {
  return new TRPCError({ code: "TOO_MANY_REQUESTS", message });
}

const t = initTRPC.context<SessionRouterContext>().create();

const instrumentedProcedure = t.procedure.use(async ({ ctx, path, next }) => {
  const transport = ctx.transport ?? "unknown";
  ctx.diagnostics.record({ procedure: path, phase: "start", transport, code: null, message: null });
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
  return result;
});

/** Creates the reusable Session API used by both Electron IPC and Lab HTTP/SSE adapters. */
export function createSessionRouter() {
  return t.router({
    ticketSessions: t.router({
      start: instrumentedProcedure
        .input(
          z.object({
            operationId: nonEmptyString,
            projectId: nonEmptyString,
            ticketId: nonEmptyString,
            title: nullableString,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          if (!ctx.startTicketSession) {
            unavailable("Ticket Sessions are unavailable on this transport");
          }
          return ctx.startTicketSession(input);
        }),
      attach: instrumentedProcedure
        .input(z.object({ operationId: nonEmptyString, sessionId: nonEmptyString }))
        .mutation(async ({ ctx, input }) => {
          if (!ctx.attachTicketSession) {
            unavailable("Ticket Sessions are unavailable on this transport");
          }
          return ctx.attachTicketSession(input);
        }),
    }),
    projectSessions: t.router({
      start: instrumentedProcedure
        .input(
          z.object({
            operationId: nonEmptyString,
            projectId: nonEmptyString,
            title: nullableString,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          if (!ctx.startProjectSession) {
            unavailable("Project Sessions are unavailable on this transport");
          }
          return ctx.startProjectSession(input);
        }),
      attach: instrumentedProcedure
        .input(z.object({ operationId: nonEmptyString, sessionId: nonEmptyString }))
        .mutation(async ({ ctx, input }) => {
          if (!ctx.attachProjectSession) {
            unavailable("Project Sessions are unavailable on this transport");
          }
          return ctx.attachProjectSession(input);
        }),
    }),
    modelAccess: t.router({
      inspect: instrumentedProcedure
        .input(z.object({ refresh: z.boolean().optional() }))
        .query(async ({ ctx, input }) => {
          if (!ctx.inspectModelAccess) {
            unavailable("Model Access is unavailable on this transport");
          }
          return modelAccessSnapshotSchema.parse(await ctx.inspectModelAccess(input));
        }),
      defaultSelection: instrumentedProcedure.query(({ ctx }) => {
        if (!ctx.readDefaultModelSelection) {
          unavailable("Model Access preferences are unavailable on this transport");
        }
        const selection = ctx.readDefaultModelSelection();
        return selection === null ? null : modelSelectionSchema.parse(selection);
      }),
      setDefault: instrumentedProcedure
        .input(modelSelectionSchema)
        .mutation(async ({ ctx, input }) => {
          if (!ctx.writeDefaultModelSelection) {
            unavailable("Model Access preferences are unavailable on this transport");
          }
          await ctx.writeDefaultModelSelection(input);
          return input;
        }),
    }),
    /**
     * `projectId` says WHICH PROJECT is asking, and it decides two separate
     * things at once. It picks the catalog INSTANCE — the host keeps one per
     * project directory — so it decides which checkout gets probed for models;
     * and it travels into the call as the SCOPE, so it decides whether the
     * project's own stored preferences answer or the global ones do. Omitting it
     * asks the host's fallback directory against the global record, which is
     * what a Session with no project yet wants and what a project-scoped
     * Settings screen never does.
     *
     * **Send `save` the same `projectId` the preceding `inspect` used.** A
     * catalog persists models out of the discovery snapshot it is holding, and
     * that snapshot belongs to the one instance that produced it — so a save
     * routed to a different (or omitted) `projectId` reaches an instance that
     * has discovered nothing and is refused, however recently the user
     * inspected. This holds at BOTH scopes and for the same reason: a
     * project-scoped inspect and save carrying the same `projectId` route
     * through `resolveRuntimeCatalog` to the same instance, so the pairing is
     * kept by sending the same id twice — and broken by sending it once.
     * Nothing here can enforce it: the two are independent requests and
     * `resolveRuntimeCatalog` is free to answer each with a different instance.
     * A client that lets a form default one and drop the other earns a refusal
     * whose message ("inspect before saving") describes a state the user cannot
     * see they are in.
     *
     * `clear` pairs with nothing — it drops a project's override and requires no
     * snapshot at all — so it takes a required `projectId` and may be sent on
     * its own.
     */
    runtimeCatalog: t.router({
      inspect: instrumentedProcedure
        .input(
          z.object({
            projectId: nonEmptyString.optional(),
            adapterId: nonEmptyString,
            providerId: nonEmptyString.optional(),
            query: z.string().max(200).optional(),
            offset: nonNegativeSafeInteger.optional(),
            limit: z.number().int().min(1).max(100).optional(),
            refresh: z.boolean().optional(),
          }),
        )
        .query(async ({ ctx, input }) => {
          const catalog = await requireRuntimeCatalog(ctx, input.projectId);
          return catalog.inspect(input);
        }),
      save: instrumentedProcedure
        .input(
          z.object({
            projectId: nonEmptyString.optional(),
            adapterId: nonEmptyString,
            preferences: runtimePreferencesSchema,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const catalog = await requireRuntimeCatalog(ctx, input.projectId);
          return catalog.save(input);
        }),
      clear: instrumentedProcedure
        .input(z.object({ projectId: nonEmptyString, adapterId: nonEmptyString }))
        .mutation(async ({ ctx, input }) => {
          const catalog = await requireRuntimeCatalog(ctx, input.projectId);
          await catalog.clear(input);
        }),
      resolve: instrumentedProcedure
        .input(z.object({ projectId: nonEmptyString.optional(), adapterId: nonEmptyString }))
        .query(async ({ ctx, input }) => {
          const catalog = await requireRuntimeCatalog(ctx, input.projectId);
          return catalog.resolve(input);
        }),
    }),
    session: t.router({
      snapshot: instrumentedProcedure
        .input(z.object({ sessionId: nonEmptyString }))
        .query(async ({ ctx, input }) => rendererSnapshot(await ctx.runtime.snapshot(input))),
      // The same durable state without the transcript replay beside it. A
      // surface that already holds the stream re-reads Session state often and
      // the frames never — and shipping them anyway costs an artifact read per
      // transcript event and a structured clone of the whole transcript, per
      // read. `snapshot` above stays for the callers that replay history.
      projection: instrumentedProcedure
        .input(z.object({ sessionId: nonEmptyString }))
        .query(async ({ ctx, input }) => rendererProjection(await ctx.runtime.projection(input))),
      subscribe: instrumentedProcedure
        .input(sessionSubscriptionSchema)
        .subscription(async function* ({ ctx, input, signal }) {
          if (signal?.aborted) return;
          const afterSequence = maxCursor(input.afterSequence, input.lastEventId);
          const queue = new AsyncQueue<SessionStreamEmission>();
          const unsubscribe = await ctx.runtime.subscribe(
            { sessionId: input.sessionId, afterSequence },
            // An overlay passes through untouched: `rendererFrame` exists to
            // keep a durable capability inventory behind the server boundary,
            // and a transient message part carries none.
            (emission) =>
              queue.push(isSessionStreamOverlay(emission) ? emission : rendererFrame(emission)),
          );
          if (signal?.aborted) {
            unsubscribe();
            return;
          }
          const abort = () => queue.close();
          signal?.addEventListener("abort", abort, { once: true });
          try {
            // A transient emission is tracked by the durable sequence it was
            // emitted beside, never by a suffixed id: `sseCursor` rejects one on
            // resubscribe, and duplicate ids are safe on both transports. A
            // reconnect from an overlay id therefore replays durable history and
            // is served a fresh baseline.
            for await (const emission of queue) {
              yield isSessionStreamOverlay(emission)
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
            if (queue.overflowed) throw subscriptionOverflowError(SESSION_OVERFLOW_MESSAGE);
          } finally {
            signal?.removeEventListener("abort", abort);
            unsubscribe();
            if (queue.overflowed) {
              ctx.diagnostics.record({
                procedure: "session.subscribe",
                phase: "error",
                transport: ctx.transport ?? "unknown",
                code: SUBSCRIPTION_OVERFLOW_CODE,
                message: SESSION_OVERFLOW_MESSAGE,
              });
            }
          }
        }),
      command: instrumentedProcedure
        .input(commandRequestSchema)
        .mutation(async ({ ctx, input }) => {
          if (
            ctx.transport === "electron-ipc" &&
            (input.command.kind === "session.create" || input.command.kind === "adapter.attach")
          ) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Use the product Session start and recovery routes.",
            });
          }
          return rendererCommandResult(
            await ctx.runtime.command(toSessionRuntimeCommandRequest(input)),
          );
        }),
      // A pending interaction the user walked away from. The reason is fixed
      // here rather than taken as input: this transport is the user seam, and
      // the only thing it can honestly report is that they left it undecided.
      cancelInteraction: instrumentedProcedure
        .input(z.object({ sessionId: nonEmptyString, interactionId: nonEmptyString }))
        .mutation(({ ctx, input }) =>
          ctx.runtime.cancelInteraction({ ...input, reason: "abandoned" }),
        ),
      refreshCapabilities: instrumentedProcedure
        .input(z.object({ sessionId: nonEmptyString, attachmentId: nonEmptyString }))
        .mutation(async ({ ctx, input }) =>
          rendererCapabilitySnapshot(await ctx.runtime.refreshCapabilities(input)),
        ),
      reconcile: instrumentedProcedure
        .input(z.object({ sessionId: nonEmptyString, attachmentId: nonEmptyString }))
        .mutation(({ ctx, input }) => ctx.runtime.reconcile(input)),
    }),
    labDiagnostics: t.router({
      list: instrumentedProcedure
        .input(
          z
            .object({
              afterId: nonNegativeSafeInteger.optional(),
              limit: positiveSafeInteger.optional(),
            })
            .optional(),
        )
        .query(({ ctx, input }) => ctx.diagnostics.list(input)),
      subscribe: instrumentedProcedure
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
    }),
  });
}

/**
 * Capability inventories remain durable server evidence. Renderer clients get
 * feature state only; model and tool discovery belongs to Runtime Catalog Settings.
 */
function rendererCapabilitySnapshot(
  snapshot: SessionRuntimeSnapshot["projection"]["capabilities"][number],
): SessionRuntimeSnapshot["projection"]["capabilities"][number] {
  const { adapterId: _adapterId, profileId: _profileId, ...presentation } = snapshot;
  return {
    ...presentation,
    catalog: [],
  } as unknown as SessionRuntimeSnapshot["projection"]["capabilities"][number];
}

/** Runtime identity and recovery locators stay behind the product edge. */
function rendererAttachment<
  Attachment extends {
    adapterId: string;
    native: SessionRuntimeSnapshot["projection"]["attachments"][number]["native"];
  },
>(attachment: Attachment): Attachment {
  const { adapterId: _adapterId, native: _native, ...presentation } = attachment;
  return presentation as Attachment;
}

function rendererCommand(
  command: SessionRuntimeSnapshot["projection"]["commands"][number],
): SessionRuntimeSnapshot["projection"]["commands"][number] {
  const intent =
    command.intent.kind === "executor.start"
      ? (({ adapterId: _adapterId, ...presentation }) => presentation)(command.intent)
      : command.intent;
  const route = command.route === null ? null : { attachmentId: command.route.attachmentId };
  return {
    ...command,
    intent,
    route,
  } as SessionRuntimeSnapshot["projection"]["commands"][number];
}

function rendererCommandResult(result: SessionRuntimeCommandResult): RendererSessionCommandResult {
  return {
    sessionId: result.sessionId,
    receipt: result.receipt,
    throughSequence: result.throughSequence,
  };
}

function rendererInteraction<
  Interaction extends {
    native: SessionRuntimeSnapshot["projection"]["interactions"]["active"][number]["native"];
  },
>(interaction: Interaction): Interaction {
  return { ...interaction, native: { id: null, detail: null } };
}

function rendererAttention<
  Attention extends {
    diagnostic: SessionRuntimeSnapshot["projection"]["attention"]["active"][number]["diagnostic"];
  },
>(attention: Attention): Attention {
  return { ...attention, diagnostic: null };
}

function rendererFrame(frame: SessionStreamFrame): SessionStreamFrame {
  const payload = frame.event.payload;
  const safeFrame: SessionStreamFrame = {
    ...frame,
    event: {
      ...frame.event,
      provenance: {
        ...frame.event.provenance,
        source:
          frame.event.provenance.source.kind === "adapter"
            ? { kind: "system", id: "session-runtime", detail: null }
            : frame.event.provenance.source,
      },
    },
  };
  switch (payload.kind) {
    case "command.recorded":
      return {
        ...safeFrame,
        event: {
          ...safeFrame.event,
          payload: { ...payload, command: rendererCommand(payload.command) },
        },
      };
    case "attachment.opened":
    case "attachment.failed":
      return {
        ...safeFrame,
        event: {
          ...safeFrame.event,
          payload:
            payload.kind === "attachment.failed"
              ? {
                  ...payload,
                  attachment: rendererAttachment(payload.attachment),
                  failure: { ...payload.failure, diagnostic: null },
                }
              : { ...payload, attachment: rendererAttachment(payload.attachment) },
        },
      };
    case "attachment.native_referenced":
      return {
        ...safeFrame,
        event: {
          ...safeFrame.event,
          payload: { ...payload, native: { id: null, detail: null } },
        },
      };
    case "attention.raised":
      return {
        ...safeFrame,
        event: {
          ...safeFrame.event,
          payload: { ...payload, attention: rendererAttention(payload.attention) },
        },
      };
    case "capabilities.updated":
      return {
        ...safeFrame,
        event: {
          ...safeFrame.event,
          payload: {
            kind: "capabilities.updated",
            snapshot: rendererCapabilitySnapshot(payload.snapshot),
          },
        },
      };
    case "interaction.opened":
      return {
        ...safeFrame,
        event: {
          ...safeFrame.event,
          payload: { ...payload, interaction: rendererInteraction(payload.interaction) },
        },
      };
    case "adapter.observed":
      return {
        ...safeFrame,
        event: { ...safeFrame.event, payload: { ...payload, native: null } },
      };
    default:
      return safeFrame;
  }
}

function rendererProjection(snapshot: SessionRuntimeProjectionSnapshot): {
  projection: SessionPresentationProjection;
  throughSequence: number;
} {
  const source = snapshot.projection;
  const projection: Partial<SessionPresentationProjection> = {};
  if (source.session !== undefined) projection.session = source.session;
  if (source.status !== undefined) projection.status = source.status;
  if (source.attention !== undefined) {
    projection.attention = {
      active: source.attention.active.map(rendererAttention),
      primary:
        source.attention.primary === null ? null : rendererAttention(source.attention.primary),
    };
  }
  if (source.interactions !== undefined) {
    projection.interactions = {
      active: source.interactions.active.map(rendererInteraction),
      resolved: source.interactions.resolved.map((entry) => ({
        ...entry,
        interaction: rendererInteraction(entry.interaction),
      })),
    };
  }
  if (source.signal !== undefined) projection.signal = source.signal;
  if (source.modelSelection !== undefined) projection.modelSelection = source.modelSelection;
  if (source.turnActive !== undefined) projection.turnActive = source.turnActive;
  if (source.lastActivityAt !== undefined) projection.lastActivityAt = source.lastActivityAt;
  if (source.bornTicketless !== undefined) projection.bornTicketless = source.bornTicketless;
  if (source.liveExecutor !== undefined) {
    projection.liveExecutor = source.liveExecutor === null ? null : { id: source.liveExecutor.id };
  }
  return {
    projection: projection as SessionPresentationProjection,
    throughSequence: snapshot.throughSequence,
  };
}

function rendererSnapshot(snapshot: SessionRuntimeSnapshot): {
  projection: SessionPresentationProjection;
  frames: SessionStreamFrame[];
  throughSequence: number;
} {
  return {
    ...rendererProjection(snapshot),
    frames: snapshot.frames.map(rendererFrame),
  };
}

async function requireRuntimeCatalog(
  context: SessionRouterContext,
  projectId: string | undefined,
): Promise<RuntimeCatalog> {
  if (!context.resolveRuntimeCatalog) {
    throw new Error("Runtime Catalog is unavailable on this transport");
  }
  try {
    return await context.resolveRuntimeCatalog(projectId);
  } catch (error) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function unavailable(message: string): never {
  throw new TRPCError({ code: "NOT_IMPLEMENTED", message });
}

export type AppRouter = ReturnType<typeof createSessionRouter>;

export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  readonly #capacity: number;
  #closed = false;
  #overflowed = false;

  constructor(capacity = 4_096) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("AsyncQueue capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  /**
   * True once a push found the buffer full. **A consumer must convert this into
   * a terminal error rather than letting the iteration end.** An overflowed
   * queue ends exactly like an exhausted one, and a normal end is the single
   * thing this stream must never claim after dropping frames: downstream it
   * becomes a `done` frame, then `observer.complete()`, then a surface that
   * silently stops updating while its own state is already stale.
   */
  get overflowed(): boolean {
    return this.#overflowed;
  }

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else if (this.#values.length < this.#capacity) this.#values.push(value);
    else {
      // Closed without discarding: what the queue did hold is still contiguous
      // history the consumer can use, and the gap only starts after it. Dropping
      // it would widen the hole the consumer then has to resume across.
      this.#overflowed = true;
      this.close(false);
    }
  }

  close(discard = true): void {
    if (this.#closed) return;
    this.#closed = true;
    if (discard) this.#values.length = 0;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.#values.length > 0) return { done: false, value: this.#values.shift()! };
    if (this.#closed) return { done: true, value: undefined };
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

function maxCursor(cursor: number | undefined, lastEventId: string | undefined): number {
  const restored = lastEventId === undefined ? 0 : Number.parseInt(lastEventId, 10);
  return Math.max(cursor ?? 0, restored);
}

function toSessionRuntimeCommandRequest(
  input: z.infer<typeof commandRequestSchema>,
): SessionRuntimeCommandRequest {
  if (input.command.kind === "session.create") {
    return { commandId: input.commandId, command: input.command };
  }
  return {
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

function isUiRole(value: unknown): value is RpcUiMessage["role"] {
  return value === "system" || value === "user" || value === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDiagnostic(entry: RpcDiagnosticEntry): RpcDiagnosticEntry {
  return { ...entry };
}

function truncateDiagnostic(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_FIELD_LENGTH
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_FIELD_LENGTH - 1)}…`;
}
