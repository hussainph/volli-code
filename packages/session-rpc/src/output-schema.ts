/** JSON-wire schemas for the Session edge. Keep product envelopes explicit;
 * only AI SDK part payloads and JSON Schema documents are extensible JSON.
 * No transforms/custom parsers: these validators also publish with z.toJSONSchema.
 * x-volli-open-union marks only HP's tolerant-read output extension points;
 * x-volli-open-enum marks scalar reader tolerance (before nullable wrappers).
 * Writers still validate exhaustively, and unmarked vocabularies stay closed.
 */
import { z } from "zod";
import {
  CODE_MODE_MODES,
  COMPACTION_REASONS,
  COMPACTION_WORK_REASONS,
  COST_BASES,
  MODEL_TIERS,
  REASONING_DROP_CAUSES,
  REASONING_LEVELS,
  SCHEDULED_RESUME_SKIP_REASONS,
  SESSION_ATTACHMENT_CONTINUITIES,
  SESSION_ATTENTION_KINDS,
  SESSION_INTERACTION_CANCEL_REASONS,
  SESSION_ROLES,
  SESSION_STOP_CATEGORIES,
  SESSION_USAGE_CAUSES,
  TODO_STATUSES,
  TOOL_ROUTES,
} from "@volli/shared";
import type { RendererSessionEventPayload, SessionPresentationProjection } from "@volli/shared";
import type {
  RendererSessionCommandResult,
  RendererSessionProjection,
  RendererSessionStreamFrame,
} from "./index";

const text = z.string();
const nullableText = text.nullable();
const integer = z.number().int();
const sequence = integer.nonnegative();
const jsonObject = z.record(text, z.json());
const native = z.object({ id: z.null(), detail: z.null() });
const venue = z.object({ id: text, kind: z.enum(["local", "cloud", "remote", "unknown"]) });
export const sessionSchema = z.object({
  id: text,
  projectId: text,
  ticketId: nullableText,
  role: z.enum(SESSION_ROLES),
  parentSessionId: nullableText,
  title: nullableText,
  createdAt: integer,
});
const model = z.object({
  providerId: text,
  modelId: text,
  reasoningLevel: z.enum(REASONING_LEVELS),
});
const auto = z.object({
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.object({ selection: model, probability: z.number().min(0).max(1) })),
});
const reference = z.object({ id: text, mediaType: nullableText, digest: nullableText });
const todoList = z.array(z.object({ content: text, status: z.enum(TODO_STATUSES) }));
/** What a settled message means for current state (VC-315); absent before it. */
const transcriptDigest = z.object({
  role: z.enum(["user", "assistant", "system"]),
  reply: z.literal(true).optional(),
  todoList: todoList.optional(),
});
const stopActor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), sessionId: text }),
  z.object({ kind: z.enum(["user", "watchdog"]) }),
]);
const stopDetail = z.object({
  category: z.enum(SESSION_STOP_CATEGORIES),
  message: nullableText,
  providerType: nullableText,
  httpStatus: integer.nullable(),
  retry: z.enum(["not-retried", "exhausted"]),
  resetsAt: integer.nullable(),
});
const attentionBase = {
  id: text,
  attachmentId: nullableText,
  detail: nullableText,
  diagnostic: z.null(),
  stopDetail: stopDetail.optional(),
};
export const attentionSchema = z.discriminatedUnion("kind", [
  z.object({ ...attentionBase, kind: z.literal("rate_limited"), retryAt: integer.nullable() }),
  z.object({ ...attentionBase, kind: z.literal("quota_exhausted"), resetAt: integer.nullable() }),
  z.object({
    ...attentionBase,
    kind: z.literal("adapter_unrecoverable"),
    resetsAt: integer.nullable(),
  }),
  z.object({
    ...attentionBase,
    kind: z.enum(
      SESSION_ATTENTION_KINDS.filter(
        (kind) =>
          kind !== "rate_limited" && kind !== "quota_exhausted" && kind !== "adapter_unrecoverable",
      ),
    ),
  }),
]);
// Attention kinds stay closed: today's N−1 reader rejects unknown kinds.
const option = z.object({ id: text, label: text, description: nullableText });
const prompt = z.object({
  id: text,
  label: text,
  detail: nullableText,
  options: z.array(option),
  multiple: z.boolean(),
  custom: z.boolean(),
});
export const interactionResolutionWireSchema = z.object({
  optionIds: z.array(text),
  response: nullableText,
  answers: z
    .array(z.object({ promptId: text, optionIds: z.array(text), response: nullableText }))
    .optional(),
});
const interaction = z.object({
  id: text,
  attachmentId: text,
  kind: z.enum(["permission", "question"]),
  title: text,
  detail: nullableText,
  options: z.array(option),
  multiple: z.boolean(),
  prompts: z.array(prompt).optional(),
  credential: z
    .object({
      id: text,
      name: text,
      sessionId: text,
      sessionLabel: text,
      projectId: text,
      projectLabel: text,
      agentSays: nullableText,
    })
    .optional(),
  native,
});
const attachment = z.object({
  id: text,
  sessionId: text,
  venue,
  continuity: z.enum(SESSION_ATTACHMENT_CONTINUITIES),
});
const failure = z.object({ code: text, detail: nullableText, diagnostic: z.null() });
const receiptResult = z.object({
  kind: z.enum([
    "session.created",
    "session.archived",
    "session.retitled",
    "session.signaled",
    "session.stopped",
    "model.selected",
    "executor.start.requested",
    "executor.stop.requested",
    "executor.interrupted",
    "executor.retried",
    "context.compacted",
    "message.submitted",
    "interaction.resolved",
    "resume.scheduled",
    "resume.cancelled",
    "resume.settled",
  ]),
  sessionId: text,
});
const receiptBase = { id: text, commandId: text, sequence, recordedAt: integer };
export const receiptSchema = z.discriminatedUnion("status", [
  z.object({
    ...receiptBase,
    status: z.literal("accepted"),
    acceptedAt: integer,
    result: receiptResult,
  }),
  z.object({ ...receiptBase, status: z.literal("rejected"), code: text, detail: nullableText }),
  z.object({ ...receiptBase, status: z.literal("completed"), result: receiptResult }),
  z.object({ ...receiptBase, status: z.literal("unreconciled"), detail: nullableText }),
]);
// Receipt statuses stay closed: an unknown status can be misreported as success.
const outcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resumed"), retryCommandId: text }),
  z.object({
    kind: z.literal("skipped"),
    reason: z.enum(SCHEDULED_RESUME_SKIP_REASONS),
    detail: nullableText,
  }),
]);
const intent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session.create"),
    projectId: text,
    ticketId: nullableText,
    role: z.enum(SESSION_ROLES),
    parentSessionId: nullableText,
    title: nullableText,
  }),
  z.object({ kind: z.literal("session.archive") }),
  z.object({ kind: z.literal("session.retitle"), title: nullableText }),
  z.object({
    kind: z.literal("session.signal"),
    signal: z.enum(["done", "blocked"]),
    reason: nullableText,
  }),
  z.object({ kind: z.literal("session.stop"), reason: nullableText, by: stopActor }),
  z.object({
    kind: z.literal("model.select"),
    selection: model,
    tier: z.enum(MODEL_TIERS).optional(),
    auto: auto.optional(),
  }),
  z.object({
    kind: z.literal("executor.start"),
    continuity: z.enum(SESSION_ATTACHMENT_CONTINUITIES),
  }),
  z.object({
    kind: z.enum(["executor.stop", "executor.interrupt", "executor.retry"]),
    attachmentId: text,
  }),
  z.object({ kind: z.literal("context.compact"), attachmentId: text, instructions: nullableText }),
  z.object({ kind: z.literal("message.submit"), reference }),
  z.object({
    kind: z.literal("interaction.resolve"),
    attachmentId: text,
    interactionId: text,
    resolution: interactionResolutionWireSchema,
    reference,
  }),
  z.object({
    kind: z.literal("resume.schedule"),
    attentionId: text,
    attachmentId: text,
    resumeAt: integer,
  }),
  z.object({ kind: z.literal("resume.cancel"), scheduleId: text }),
  z.object({ kind: z.literal("resume.settle"), scheduleId: text, outcome }),
]);
const command = z.object({
  id: text,
  sessionId: text,
  createdAt: integer,
  intent,
  route: z.object({ attachmentId: nullableText }).nullable(),
});
const codeMode = z.object({
  routes: z.record(text, z.enum(TOOL_ROUTES)),
  limits: z.object({
    timeoutMs: integer,
    memoryLimitBytes: integer,
    maxOutputBytes: integer,
    maxNestedCalls: integer,
    maxConcurrency: integer,
    declarationBudgetTokens: integer,
  }),
  mode: z.enum(CODE_MODE_MODES).optional(),
  nudge: z.literal(true).optional(),
});
const sessionInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runtime-brief"), text }),
  z.object({
    kind: z.literal("prompt-resources"),
    resources: z.array(z.object({ name: text, text })),
  }),
  z.object({
    kind: z.literal("tool-surface"),
    tools: z.array(text),
    mcpManagementNames: z.literal("server").optional(),
    mcpTools: z
      .array(
        z.object({
          serverId: text,
          toolName: text,
          providerName: text,
          description: text,
          inputSchema: jsonObject,
          outputSchema: jsonObject.optional(),
          parallelRead: z.literal(true).optional(),
        }),
      )
      .optional(),
    codeMode: codeMode.optional(),
  }),
]);
const usage = z.object({
  cause: z.enum(SESSION_USAGE_CAUSES),
  providerId: text,
  modelId: text,
  inputTokens: integer.nullable(),
  outputTokens: integer.nullable(),
  cacheReadTokens: integer.nullable(),
  cacheWriteTokens: integer.nullable(),
  costUsd: z.number().nullable(),
  costBasis: z.enum(COST_BASES),
});
/** One table per payload kind: a new durable kind cannot quietly fall through an opaque schema. */
const payloads = {
  "command.recorded": z.object({ kind: z.literal("command.recorded"), command }),
  "session.created": z.object({ kind: z.literal("session.created"), session: sessionSchema }),
  "session.archived": z.object({ kind: z.literal("session.archived") }),
  "session.retitled": z.object({ kind: z.literal("session.retitled"), title: nullableText }),
  "model.selected": z.object({
    kind: z.literal("model.selected"),
    selection: model,
    tier: z.enum(MODEL_TIERS).optional(),
    auto: auto.optional(),
  }),
  "session.input.recorded": z.object({
    kind: z.literal("session.input.recorded"),
    input: sessionInput,
  }),
  "session.signaled": z.object({
    kind: z.literal("session.signaled"),
    signal: z.enum(["done", "blocked"]),
    reason: nullableText,
  }),
  "session.stopped": z.object({
    kind: z.literal("session.stopped"),
    reason: nullableText,
    by: stopActor,
  }),
  "attachment.opened": z.object({ kind: z.literal("attachment.opened"), attachment }),
  "attachment.native_referenced": z.object({
    kind: z.literal("attachment.native_referenced"),
    attachmentId: text,
    native,
  }),
  "attachment.failed": z.object({ kind: z.literal("attachment.failed"), attachment, failure }),
  "attachment.closed": z.object({
    kind: z.literal("attachment.closed"),
    attachmentId: text,
    outcome: z.enum(["completed", "failed", "interrupted"]),
  }),
  "attachment.exited": z.object({
    kind: z.literal("attachment.exited"),
    attachmentId: text,
    exitCode: integer,
  }),
  "run.started": z.object({ kind: z.literal("run.started"), attachmentId: text, runId: text }),
  "run.completed": z.object({ kind: z.literal("run.completed"), attachmentId: text, runId: text }),
  "turn.started": z.object({ kind: z.literal("turn.started"), attachmentId: text, turnId: text }),
  "turn.completed": z.object({
    kind: z.literal("turn.completed"),
    attachmentId: text,
    turnId: text,
  }),
  "turn.interrupted": z.object({
    kind: z.literal("turn.interrupted"),
    attachmentId: text,
    turnId: text,
    stopDetail: stopDetail.optional(),
  }),
  "context.compacted": z.object({
    kind: z.literal("context.compacted"),
    attachmentId: text,
    reason: z.enum(COMPACTION_WORK_REASONS),
    entryId: text,
    tokensBefore: integer,
    tokensAfter: integer,
  }),
  "context.compaction_failed": z.object({
    kind: z.literal("context.compaction_failed"),
    attachmentId: text,
    reason: z.enum(COMPACTION_REASONS),
    detail: text,
  }),
  "context.reasoning_dropped": z.object({
    kind: z.literal("context.reasoning_dropped"),
    attachmentId: text,
    turnId: text,
    count: integer.positive(),
    causes: z.array(z.enum(REASONING_DROP_CAUSES)),
  }),
  "transcript.referenced": z.object({
    kind: z.literal("transcript.referenced"),
    attachmentId: nullableText,
    turnId: nullableText,
    reference,
    digest: transcriptDigest.optional(),
  }),
  "attention.raised": z.object({ kind: z.literal("attention.raised"), attention: attentionSchema }),
  "attention.cleared": z.object({ kind: z.literal("attention.cleared"), attentionId: text }),
  "interaction.opened": z.object({ kind: z.literal("interaction.opened"), interaction }),
  "interaction.resolved": z.object({
    kind: z.literal("interaction.resolved"),
    attachmentId: text,
    interactionId: text,
    resolution: interactionResolutionWireSchema,
  }),
  "interaction.cancelled": z.object({
    kind: z.literal("interaction.cancelled"),
    attachmentId: text,
    interactionId: text,
    reason: z.enum(SESSION_INTERACTION_CANCEL_REASONS),
  }),
  "command.receipt.recorded": z.object({
    kind: z.literal("command.receipt.recorded"),
    receipt: receiptSchema,
  }),
  "adapter.observed": z.object({
    kind: z.literal("adapter.observed"),
    attachmentId: nullableText,
    name: text,
    native: z.null(),
  }),
  "usage.recorded": z.object({
    kind: z.literal("usage.recorded"),
    attachmentId: nullableText,
    turnId: nullableText,
    attribution: z.object({ projectId: text, ticketId: nullableText }),
    usage,
  }),
} satisfies {
  // Keep the inferred wire vocabulary (notably open tool ids) intact. Recursive
  // key completeness and domain-to-wire assignability are compile-checked in
  // output-schema-exactness.test-d.ts, before any public boundary casts.
  [Kind in RendererSessionEventPayload["kind"]]: z.ZodType<
    Kind extends "session.input.recorded"
      ? { kind: Kind; input: z.output<typeof sessionInput> }
      : Extract<RendererSessionEventPayload, { kind: Kind }>
  >;
};
const payloadOptions = Object.values(payloads);
const payload = z
  .discriminatedUnion("kind", [payloadOptions[0]!, ...payloadOptions.slice(1)])
  .meta({ "x-volli-open-union": "kind" });
const origin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("session"), sessionId: text }),
  z.object({ kind: z.literal("automation"), automationRunId: text, automationName: nullableText }),
  z.object({
    kind: z.literal("volli"),
    reason: z.enum([
      "watch-notice",
      "subagent-notice",
      "relaunch-recovery",
      "scheduled-resume",
      "supervision",
      "browser-notice",
      "shell-notice",
      "worktree-notice",
      "auto-title",
    ]),
  }),
]);
export const eventSchema = z.object({
  id: text,
  sessionId: text,
  sequence: integer.positive(),
  occurredAt: integer,
  recordedAt: integer,
  attachmentId: nullableText.optional(),
  commandId: nullableText.optional(),
  commandOrigin: origin.nullable().optional(),
  provenance: z.object({
    source: z.object({ kind: z.enum(["user", "system"]), id: text, detail: z.json() }),
    venue: venue.nullable(),
  }),
  payload,
});
/** AI SDK parts are open, but their discriminator and JSON-safe payload are not. */
export const uiPartWireSchema = z.object({ type: text }).catchall(z.json());
export const uiMessageWireSchema = z.object({
  id: text,
  role: z.enum(["system", "user", "assistant"]),
  metadata: z.json().optional(),
  parts: z.array(uiPartWireSchema),
});
/**
 * One host-owned follow-up (VC-675): the complete queued UIMessage, the command
 * that queued it, and whether it is still editable or already being released.
 * Delivery bookkeeping (origin, model, steer target) stays behind the edge.
 */
export const followUpItemWireSchema = z.object({
  id: text,
  message: uiMessageWireSchema,
  commandId: text,
  state: z.enum(["queued", "releasing"]),
});
/** Queue order is by this revision, never by the event cursor; safe-integer bounded. */
export const queueRevisionWireSchema = sequence;
export const followUpQueueWireSchema = z.array(followUpItemWireSchema);
export const transcriptWireSchema = z.object({
  version: z.literal(1),
  threadId: text,
  branchId: text,
  attemptId: text,
  turnId: nullableText,
  message: uiMessageWireSchema,
});
// Keep inferred wire schemas available for recursive key-completeness assertions.
// The SDK's part union, tool ids and MCP names have richer TypeScript vocabularies
// than their open JSON wire grammar. Keep those types at the transport boundary;
// validation above still checks every envelope and every opaque value for JSON safety.
export const frameWireSchema = z.object({
  sessionId: text,
  sequence,
  event: eventSchema,
  transcript: transcriptWireSchema.nullable(),
});
export const frameSchema = frameWireSchema as unknown as z.ZodType<
  RendererSessionStreamFrame,
  RendererSessionStreamFrame
>;
export const fullProjectionSchema = z.object({
  session: sessionSchema,
  status: z.enum(["open", "archived"]),
  attention: z.object({ active: z.array(attentionSchema), primary: attentionSchema.nullable() }),
  interactions: z.object({
    active: z.array(interaction),
    resolved: z.array(
      z.object({
        interaction,
        resolution: interactionResolutionWireSchema,
        resolvedAt: integer,
      }),
    ),
  }),
  signal: z
    .object({ signal: z.enum(["done", "blocked"]), reason: nullableText, occurredAt: integer })
    .nullable(),
  modelSelection: model.nullable(),
  modelTier: z.enum(MODEL_TIERS).nullable(),
  modelAuto: auto.optional(),
  turnActive: z.boolean(),
  lastActivityAt: integer,
  bornTicketless: z.boolean(),
  todoList: todoList.optional(),
  liveExecutor: z.object({ id: text }).nullable(),
  scheduledResume: z.object({ id: text, attentionId: text, resumeAt: integer }).nullable(),
}) satisfies z.ZodType<SessionPresentationProjection>;
// rendererProjection deliberately carries only fields its source contains (the
// established minimal-projection contract). Retain the existing published TS
// type, but describe that absence faithfully rather than inventing defaults.
// The host's follow-up queue and its revision ride beside the presentation
// projection (VC-675); both stay optional, so a host without a queue is valid.
export const projectionWireSchema = fullProjectionSchema.partial().extend({
  queue: followUpQueueWireSchema.optional(),
  queueRevision: queueRevisionWireSchema.optional(),
});
export const projectionSchema = projectionWireSchema as unknown as z.ZodType<
  RendererSessionProjection,
  RendererSessionProjection
>;
export const sessionProjectionOutputSchema = z.object({
  projection: projectionSchema,
  throughSequence: sequence,
});
/**
 * VC-315's two snapshot fields ride only when they say something: `before`
 * the cursor for history above the window (absent: it reaches the first
 * event, or the host predates the bound), `latestReply` the current turn's
 * reply (absent: it has said nothing, or the host predates it).
 */
export const sessionSnapshotOutputSchema = sessionProjectionOutputSchema.extend({
  frames: z.array(frameSchema),
  before: integer.positive().optional(),
  latestReply: z.object({ sequence, text }).optional(),
});
/** One page of older transcript (VC-315): frames in order, and the cursor above them. */
export const sessionHistoryOutputSchema = z.object({
  frames: z.array(frameSchema),
  before: integer.positive().nullable(),
});
export const sessionCommandWireSchema = z.object({
  sessionId: text,
  receipt: receiptSchema.nullable(),
  throughSequence: sequence,
  // commandRefusal's reader maps unknown severities to failure (wire.ts),
  // without discarding the receipt or treating the command as a success.
  refusal: z.enum(["benign", "failure"]).meta({ "x-volli-open-enum": true }).nullable(),
  stop: z
    .object({
      sessionId: text,
      handle: text,
      title: nullableText,
      previouslyStopped: z.boolean(),
      interrupted: z.boolean(),
      released: z.boolean(),
      failures: z.array(text),
    })
    .optional(),
}) satisfies z.ZodType<RendererSessionCommandResult>;
export const sessionCommandOutputSchema: z.ZodType<
  RendererSessionCommandResult,
  RendererSessionCommandResult
> = sessionCommandWireSchema;
export const sessionAttachOutputSchema = z.object({
  sessionId: text,
  state: z.enum(["ready", "needs-recovery"]),
  receipt: receiptSchema.nullable(),
  throughSequence: sequence,
});
export const diagnosticEntrySchema = z.object({
  id: integer.positive(),
  timestamp: z.number(),
  procedure: text,
  phase: z.enum(["start", "success", "error"]),
  transport: z.enum(["electron-ipc", "unknown"]),
  code: nullableText,
  message: nullableText,
});
export const streamEmissionWireSchema = z.union([
  frameWireSchema,
  z.object({
    kind: z.literal("overlay"),
    sessionId: text,
    throughSequence: sequence,
    messageId: text,
    delta: z
      .discriminatedUnion("op", [
        z.object({
          op: z.literal("reset"),
          message: z.object({
            id: text,
            role: z.enum(["system", "user", "assistant"]),
            metadata: z.json().optional(),
            parts: z.array(z.object({ key: text, part: uiPartWireSchema })),
          }),
        }),
        z.object({
          op: z.literal("part.upsert"),
          key: text,
          index: integer,
          part: uiPartWireSchema,
        }),
        z.object({ op: z.literal("part.append"), key: text, text }),
        z.object({ op: z.literal("part.remove"), key: text }),
        z.object({ op: z.literal("metadata"), metadata: z.json() }),
        z.object({ op: z.literal("message.remove") }),
      ])
      .meta({ "x-volli-open-union": "op" }),
  }),
  z.object({
    kind: z.literal("compaction"),
    sessionId: text,
    throughSequence: sequence,
    state: z.enum(["started", "finished"]),
    reason: z.enum(COMPACTION_WORK_REASONS),
  }),
  // The whole host queue after a change. It does not advance the event
  // cursor: `throughSequence` is the durable history it was emitted beside,
  // and consumers order queue snapshots by `revision`.
  z.object({
    kind: z.literal("queue"),
    sessionId: text,
    throughSequence: sequence,
    revision: queueRevisionWireSchema,
    queue: followUpQueueWireSchema,
  }),
]);
export const streamEmissionSchema = z.union([
  frameSchema,
  streamEmissionWireSchema.options[1],
  streamEmissionWireSchema.options[2],
  streamEmissionWireSchema.options[3],
]);
/**
 * The VC-669 frozen vocabulary: a published operation's closed output union
 * never gains an arm, so the pre-queue stream keeps exactly these three and a
 * queue-aware peer reads {@link streamEmissionSchema} through its own feature.
 */
export const legacyStreamEmissionWireSchema = z.union([
  streamEmissionWireSchema.options[0],
  streamEmissionWireSchema.options[1],
  streamEmissionWireSchema.options[2],
]);
export const legacyStreamEmissionSchema = z.union([
  frameSchema,
  streamEmissionWireSchema.options[1],
  streamEmissionWireSchema.options[2],
]);
