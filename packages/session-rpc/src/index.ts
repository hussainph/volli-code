import { initTRPC, TRPCError, tracked } from "@trpc/server";
import {
  isSessionStreamOverlay,
  type ModelAccessSnapshot,
  type SessionClientCommand,
  type SessionRuntime,
  type SessionRuntimeCommandResult,
  type SessionRuntimeCommandRequest,
  type SessionRuntimeProjectionSnapshot,
  type SessionRuntimeSnapshot,
  type SessionStreamFrame,
  type SessionStreamOverlay,
  type SessionStartResult,
} from "@volli/session-engine";
import {
  REASONING_LEVELS,
  scrubSessionAttention,
  scrubSessionEvent,
  scrubSessionInteraction,
  type RendererSessionEvent,
  type SessionPresentationProjection,
} from "@volli/shared";
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

/**
 * One durable frame as the renderer receives it. The event type is the
 * codec's {@link RendererSessionEvent} — derived from the scrub return types,
 * so it cannot claim a field survives this edge that never arrives.
 */
export type RendererSessionStreamFrame = Omit<SessionStreamFrame, "event"> & {
  event: RendererSessionEvent;
};

/** A streamed Session emission with executor identity and adapter-native detail removed. */
export type RendererSessionStreamEmission = RendererSessionStreamFrame | SessionStreamOverlay;

/** The durable arm carries no `kind` of its own, mirroring the runtime's own test. */
function isRendererStreamOverlay(
  emission: RendererSessionStreamEmission,
): emission is SessionStreamOverlay {
  return "kind" in emission;
}

export interface TicketSessionStartInput {
  operationId: string;
  projectId: string;
  ticketId: string;
  title: string | null;
  /**
   * Skill slugs to inject at attach time as system-prompt RESOURCE sections.
   * Absent means none — injection is explicit selection, never ambient.
   */
  skills?: readonly string[];
}

export interface SessionAttachInput {
  operationId: string;
  sessionId: string;
}

export interface ProjectSessionStartInput {
  operationId: string;
  projectId: string;
  title: string | null;
  /** See {@link TicketSessionStartInput.skills}. */
  skills?: readonly string[];
}

/** A create-only start's answer: durable identity, nothing about an executor. */
export interface SessionCreateResult {
  sessionId: string;
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
  /** Create-only (no attach): the optimistic chat-open route — see the facades. */
  createTicketSession?: (input: TicketSessionStartInput) => Promise<SessionCreateResult>;
  attachTicketSession?: (input: SessionAttachInput) => Promise<SessionStartResult>;
  startProjectSession?: (input: ProjectSessionStartInput) => Promise<SessionStartResult>;
  createProjectSession?: (input: ProjectSessionStartInput) => Promise<SessionCreateResult>;
  attachProjectSession?: (input: SessionAttachInput) => Promise<SessionStartResult>;
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
 * Display text is prose from someone else's catalog, not an identifier this app
 * minted, so it gets its own bound rather than borrowing the identifier one.
 * The two happen to agree today; they answer to different contracts, and a
 * later change to either must not silently move the other.
 */
const MAX_DISPLAY_LABEL_LENGTH = 512;

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
const displayLabel = z.string().transform((value) => value.trim());
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
const uiMessageSchema = z.custom<RpcUiMessage>(isUiMessage, "Expected an AI SDK UIMessage");
const modelSelectionSchema = z.object({
  providerId: nonEmptyString,
  modelId: nonEmptyString,
  reasoningLevel: z.enum(REASONING_LEVELS),
});
const modelAccessStateSchema = z.enum(["available", "authentication-required", "unavailable"]);
const modelAccessSnapshotSchema = z.object({
  observedAt: z.number().finite(),
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
      })
      .transform((provider) => ({ ...provider, label: usableLabel(provider.label, provider.id) })),
  ),
  models: z.array(
    z
      .object({
        providerId: nonEmptyString,
        modelId: nonEmptyString,
        label: displayLabel,
        state: modelAccessStateSchema,
        reasoningLevels: z.array(z.enum(REASONING_LEVELS)),
      })
      .transform((model) => ({
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
const SUBSCRIPTION_SOURCE_FAILURE_CODE = "SUBSCRIPTION_SOURCE_FAILURE";
const SESSION_SOURCE_FAILURE_MESSAGE =
  "Session stream source failed; resubscribe to resume from the ledger";
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
            skills: skillSlugs,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          if (!ctx.startTicketSession) {
            unavailable("Ticket Sessions are unavailable on this transport");
          }
          return ctx.startTicketSession(input);
        }),
      create: instrumentedProcedure
        .input(
          z.object({
            operationId: nonEmptyString,
            projectId: nonEmptyString,
            ticketId: nonEmptyString,
            title: nullableString,
            // The optimistic-open path mints the Session, so it is the path
            // that has to carry the skills: `attach` composes the prompt from
            // the record `create` wrote, and never sees this input.
            skills: skillSlugs,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          if (!ctx.createTicketSession) {
            unavailable("Ticket Sessions are unavailable on this transport");
          }
          return ctx.createTicketSession(input);
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
            skills: skillSlugs,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          if (!ctx.startProjectSession) {
            unavailable("Project Sessions are unavailable on this transport");
          }
          return ctx.startProjectSession(input);
        }),
      create: instrumentedProcedure
        .input(
          z.object({
            operationId: nonEmptyString,
            projectId: nonEmptyString,
            title: nullableString,
            /** See `ticketSessions.create`. */
            skills: skillSlugs,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          if (!ctx.createProjectSession) {
            unavailable("Project Sessions are unavailable on this transport");
          }
          return ctx.createProjectSession(input);
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
          const queue = new AsyncQueue<RendererSessionStreamEmission>();
          const sourceFailure: { current: { error: unknown } | null } = { current: null };
          const unsubscribe = await ctx.runtime.subscribe(
            { sessionId: input.sessionId, afterSequence },
            // An overlay passes through untouched: `rendererFrame` exists to
            // keep runtime identity and recovery locators behind the server
            // boundary, and a transient message part carries neither.
            (emission) =>
              queue.push(isSessionStreamOverlay(emission) ? emission : rendererFrame(emission)),
            // The runtime's drain died behind this subscription. Ended like an
            // overflow — buffered contiguous frames still drain, then the
            // stream closes with an error instead of a clean `done`, because a
            // clean end here is the one thing the client must never see: it
            // reads as a stream with nothing left to say, not one that lost
            // `turn.completed` mid-turn.
            (error) => {
              sourceFailure.current = { error };
              queue.close(false);
            },
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
              yield isRendererStreamOverlay(emission)
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
            // A source failure ends the same way an overflow does, and for the
            // same reason: whatever this stream still owed its consumer is now
            // only in the ledger, and only an error makes the client go back
            // for it.
            if (sourceFailure.current !== null) {
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: SESSION_SOURCE_FAILURE_MESSAGE,
                cause: sourceFailure.current.error,
              });
            }
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
            if (sourceFailure.current !== null) {
              ctx.diagnostics.record({
                procedure: "session.subscribe",
                phase: "error",
                transport: ctx.transport ?? "unknown",
                code: SUBSCRIPTION_SOURCE_FAILURE_CODE,
                message: SESSION_SOURCE_FAILURE_MESSAGE,
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

function rendererCommandResult(result: SessionRuntimeCommandResult): RendererSessionCommandResult {
  return {
    sessionId: result.sessionId,
    receipt: result.receipt,
    throughSequence: result.throughSequence,
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
  frames: RendererSessionStreamFrame[];
  throughSequence: number;
} {
  return {
    ...rendererProjection(snapshot),
    frames: snapshot.frames.map(rendererFrame),
  };
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
