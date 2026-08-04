import { initTRPC, TRPCError, tracked } from "@trpc/server";
import {
  MAX_RUNTIME_PREFERENCE_MODELS,
  type RuntimeCatalog,
  type SessionClientCommand,
  type SessionRuntime,
  type SessionRuntimeCommandRequest,
  type SessionRuntimeProjectionSnapshot,
  type SessionRuntimeSnapshot,
  type SessionStreamFrame,
} from "@volli/session-engine";
import { z } from "zod";

type RpcUiMessage = Extract<SessionClientCommand, { kind: "message.submit" }>["message"];

/**
 * The server-side composition root supplies this context. It deliberately
 * carries the deep runtime rather than leaking its ports to individual RPCs.
 */
export interface SessionRouterContext {
  runtime: SessionRuntime;
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
  z.object({ kind: z.literal("executor.interrupt"), attachmentId: nonEmptyString.optional() }),
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
    runtimeCatalog: t.router({
      inspect: instrumentedProcedure
        .input(
          z.object({
            projectId: z.string().optional(),
            adapterId: nonEmptyString,
            providerId: nonEmptyString.optional(),
            query: z.string().max(200).optional(),
            offset: nonNegativeSafeInteger.optional(),
            limit: z.number().int().min(1).max(100).optional(),
            refresh: z.boolean().optional(),
          }),
        )
        .query(async ({ ctx, input }) => {
          const { projectId, ...rest } = input;
          const catalog = await requireRuntimeCatalog(ctx, projectId);
          return catalog.inspect(rest);
        }),
      save: instrumentedProcedure
        .input(
          z.object({
            projectId: z.string().optional(),
            adapterId: nonEmptyString,
            preferences: runtimePreferencesSchema,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const { projectId, ...rest } = input;
          const catalog = await requireRuntimeCatalog(ctx, projectId);
          return catalog.save(rest);
        }),
      resolve: instrumentedProcedure
        .input(z.object({ adapterId: nonEmptyString }))
        .query(async ({ ctx, input }) => {
          const catalog = await requireRuntimeCatalog(ctx, undefined);
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
          const queue = new AsyncQueue<SessionStreamFrame>();
          const unsubscribe = await ctx.runtime.subscribe(
            { sessionId: input.sessionId, afterSequence },
            (frame) => queue.push(rendererFrame(frame)),
          );
          if (signal?.aborted) {
            unsubscribe();
            return;
          }
          const abort = () => queue.close();
          signal?.addEventListener("abort", abort, { once: true });
          try {
            for await (const frame of queue) yield tracked(String(frame.sequence), frame);
          } finally {
            signal?.removeEventListener("abort", abort);
            unsubscribe();
            if (queue.overflowed) {
              ctx.diagnostics.record({
                procedure: "session.subscribe",
                phase: "error",
                transport: ctx.transport ?? "unknown",
                code: "SUBSCRIPTION_OVERFLOW",
                message: "Session subscription fell behind; resume from the last event id",
              });
            }
          }
        }),
      command: instrumentedProcedure
        .input(commandRequestSchema)
        .mutation(({ ctx, input }) => ctx.runtime.command(toSessionRuntimeCommandRequest(input))),
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
          } finally {
            signal?.removeEventListener("abort", abort);
            unsubscribe();
            if (queue.overflowed) {
              ctx.diagnostics.record({
                procedure: "labDiagnostics.subscribe",
                phase: "error",
                transport: ctx.transport ?? "unknown",
                code: "SUBSCRIPTION_OVERFLOW",
                message: "Diagnostics subscription fell behind; resume from the last event id",
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
  return { ...snapshot, catalog: [] };
}

function rendererFrame(frame: SessionStreamFrame): SessionStreamFrame {
  if (frame.event.payload.kind !== "capabilities.updated") return frame;
  return {
    ...frame,
    event: {
      ...frame.event,
      payload: {
        kind: "capabilities.updated",
        snapshot: rendererCapabilitySnapshot(frame.event.payload.snapshot),
      },
    },
  };
}

function rendererProjection(
  snapshot: SessionRuntimeProjectionSnapshot,
): SessionRuntimeProjectionSnapshot {
  return {
    projection: {
      ...snapshot.projection,
      capabilities: snapshot.projection.capabilities.map(rendererCapabilitySnapshot),
    },
    throughSequence: snapshot.throughSequence,
  };
}

function rendererSnapshot(snapshot: SessionRuntimeSnapshot): SessionRuntimeSnapshot {
  return {
    ...snapshot,
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

  get overflowed(): boolean {
    return this.#overflowed;
  }

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else if (this.#values.length < this.#capacity) this.#values.push(value);
    else {
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
