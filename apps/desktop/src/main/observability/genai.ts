/**
 * The one place Volli's observability vocabulary is spoken in somebody else's
 * words (VC-119, Phase 2).
 *
 * `@volli/shared`'s {@link ObservabilityEvent} is canonical and versioned with
 * the product. OpenTelemetry's GenAI semantic conventions are Development-status
 * and rename attributes between releases. Those two facts only stay compatible
 * if the translation happens exactly once, at the edge, in a module that owns
 * nothing else — so this file is the whole of Volli's dependence on the
 * convention, and a convention rename is an edit here rather than a migration of
 * anything durable.
 *
 * **The attribute names are inlined string literals, deliberately.**
 * `@opentelemetry/semantic-conventions` ships them, but only from its
 * `/incubating` entrypoint, whose contents are explicitly unstable — importing
 * them would mean a patch bump could silently change what Volli emits, which is
 * the opposite of the property this module exists to have. The names below are
 * quoted from semantic-conventions 1.43.0; each is a frozen literal Volli chose,
 * not a symbol it follows.
 *
 * **Nothing here can widen what leaves the process.** Every value written onto a
 * span comes from a closed vocabulary word, a count, a duration, or a
 * configuration identifier, because that is all {@link ObservabilityEvent}
 * carries — there is no free-form string in the union to leak, and this module
 * adds none of its own. `status.message` is left unset for that reason: it is
 * the one span field that invites prose, and the bounded `error.type` says the
 * same thing without it.
 */

import type { ObservabilityEvent } from "@volli/shared";

/**
 * Volli's own attribute namespace.
 *
 * Everything the GenAI convention has no word for lives under `volli.`, rather
 * than being forced into an approximate `gen_ai.` name. Cost is the clearest
 * case: providers report it, Pi reports it, the convention has no attribute for
 * it, and inventing `gen_ai.usage.cost` would be Volli asserting a convention
 * that does not exist.
 */
const VOLLI = "volli";

/**
 * GenAI convention attribute names, quoted from semantic-conventions 1.43.0.
 *
 * `gen_ai.system` is emitted beside `gen_ai.provider.name` because the ecosystem
 * has not finished the rename: current viewers and dashboards (OpenLIT, Langfuse
 * importers, most Jaeger saved searches) still key on the older name, and a
 * duplicated bounded catalog id costs nothing in cardinality. It is the only
 * deliberate duplication here.
 */
const GEN_AI = {
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  /** Superseded by `provider.name`; kept for viewers that have not caught up. */
  system: "gen_ai.system",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  finishReasons: "gen_ai.response.finish_reasons",
  timeToFirstChunk: "gen_ai.response.time_to_first_chunk",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cacheReadTokens: "gen_ai.usage.cache_read.input_tokens",
  cacheWriteTokens: "gen_ai.usage.cache_creation.input_tokens",
  reasoningTokens: "gen_ai.usage.reasoning.output_tokens",
  toolName: "gen_ai.tool.name",
  toolType: "gen_ai.tool.type",
} as const;

/** The general convention's error attribute, used wherever a span failed. */
const ERROR_TYPE = "error.type";

/**
 * What a span looks like before any OpenTelemetry type is involved.
 *
 * A plain record on purpose: this module stays testable — and reviewable as a
 * privacy boundary — without constructing a tracer, and the OTLP adapter beside
 * it is the only thing that ever touches an SDK class.
 */
export interface ObservabilitySpan {
  name: string;
  /** `client` for a call that left the process; `internal` for everything else. */
  kind: "client" | "internal";
  /** Zero for a point-in-time fact, which most of the vocabulary is. */
  durationMs: number;
  failed: boolean;
  attributes: SpanAttributes;
}

/** Only the three scalar shapes the vocabulary can produce. Never an object. */
export type SpanAttributes = Readonly<Record<string, string | number | boolean>>;

/** Drops the absent fields, so an unreported token count is absent, never zero. */
function present(
  attributes: Readonly<Record<string, string | number | boolean | undefined>>,
): SpanAttributes {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * The stop reasons that mean the attempt did not produce an answer.
 *
 * `length` is deliberately not one of them: a reply cut off at the token limit
 * is a complete provider response that Volli's own layers decide what to do
 * with, and marking the span failed would put a red row in Jaeger for something
 * that worked.
 */
function attemptFailed(stopReason: string): boolean {
  return stopReason === "error" || stopReason === "aborted";
}

/**
 * One Volli event, as one span.
 *
 * The `switch` is exhaustive over the vocabulary and the `never` arm makes it
 * stay that way: an event kind added in `@volli/shared` is a compile error here,
 * which is the check that stops a new event from being exported as an untyped
 * blob or silently dropped.
 */
export function observabilitySpan(event: ObservabilityEvent): ObservabilitySpan {
  const runId = event.runId === undefined ? {} : { [`${VOLLI}.run.id`]: event.runId };
  switch (event.kind) {
    case "provider-attempt":
      return {
        // The convention's span-name recipe: `{operation} {request model}`.
        name: `chat ${event.modelId}`,
        kind: "client",
        durationMs: event.durationMs,
        failed: attemptFailed(event.stopReason),
        attributes: present({
          ...runId,
          [GEN_AI.operationName]: "chat",
          [GEN_AI.providerName]: event.providerId,
          [GEN_AI.system]: event.providerId,
          [GEN_AI.requestModel]: event.modelId,
          [GEN_AI.responseModel]: event.responseModelId,
          [GEN_AI.finishReasons]: event.stopReason,
          [GEN_AI.timeToFirstChunk]: event.ttftMs,
          [GEN_AI.inputTokens]: event.inputTokens,
          [GEN_AI.outputTokens]: event.outputTokens,
          [GEN_AI.cacheReadTokens]: event.cacheReadTokens,
          [GEN_AI.cacheWriteTokens]: event.cacheWriteTokens,
          [GEN_AI.reasoningTokens]: event.reasoningTokens,
          // No convention attribute exists for any of these four.
          [`${VOLLI}.provider.api`]: event.api,
          [`${VOLLI}.request.reasoning_level`]: event.reasoningLevel,
          [`${VOLLI}.usage.total_tokens`]: event.totalTokens,
          [`${VOLLI}.usage.cost_usd`]: event.costUsd,
          [`${VOLLI}.stream.chunks`]: event.chunkCount,
          ...(attemptFailed(event.stopReason) ? { [ERROR_TYPE]: event.stopReason } : {}),
        }),
      };
    case "turn":
      return {
        name: "volli.agent.turn",
        kind: "internal",
        durationMs: event.durationMs ?? 0,
        // An interrupted turn is a person changing their mind, not a fault.
        failed: false,
        attributes: present({ ...runId, [`${VOLLI}.turn.outcome`]: event.outcome }),
      };
    case "tool":
      return {
        // The convention's recipe again: `execute_tool {tool name}`. Volli's
        // `ActivityKind` IS the tool name here — the bounded capability class,
        // never the unbounded name a model asked for.
        name: `execute_tool ${event.activityKind}`,
        kind: "internal",
        durationMs: event.durationMs ?? 0,
        failed: event.outcome === "failed",
        attributes: present({
          ...runId,
          [GEN_AI.operationName]: "execute_tool",
          [GEN_AI.toolName]: event.activityKind,
          [GEN_AI.toolType]: "function",
          [`${VOLLI}.tool.outcome`]: event.outcome,
          ...(event.outcome === "failed" ? { [ERROR_TYPE]: "tool_failed" } : {}),
        }),
      };
    case "authority-denied":
      return {
        name: "volli.agent.authority",
        kind: "internal",
        durationMs: 0,
        // A refusal is the policy working. Marking it failed would make a
        // correctly-blocked call look like a broken one.
        failed: false,
        attributes: present({
          ...runId,
          [`${VOLLI}.authority.outcome`]: "denied",
          [`${VOLLI}.authority.cause`]: event.cause,
        }),
      };
    case "compaction":
      return {
        name: "volli.agent.compaction",
        kind: "internal",
        durationMs: 0,
        failed: event.outcome === "failed",
        attributes: present({
          ...runId,
          [`${VOLLI}.compaction.outcome`]: event.outcome,
          [`${VOLLI}.compaction.reason`]: event.reason,
          [`${VOLLI}.compaction.tokens_before`]: event.tokensBefore,
          [`${VOLLI}.compaction.tokens_after`]: event.tokensAfter,
          ...(event.outcome === "failed" ? { [ERROR_TYPE]: "compaction_failed" } : {}),
        }),
      };
    case "attachment":
      return {
        name: "volli.agent.attachment",
        kind: "internal",
        durationMs: 0,
        failed: event.phase === "failed",
        attributes: present({
          ...runId,
          [`${VOLLI}.attachment.phase`]: event.phase,
          [`${VOLLI}.attachment.failure_reason`]: event.failureReason,
          ...(event.phase === "failed"
            ? { [ERROR_TYPE]: event.failureReason ?? "attachment_failed" }
            : {}),
        }),
      };
    case "attention":
      return {
        name: "volli.agent.attention",
        kind: "internal",
        durationMs: 0,
        // Attention is a state a Session enters and leaves; the reason says
        // whether it was a fault, and the span status should not double-count it.
        failed: false,
        attributes: present({
          ...runId,
          [`${VOLLI}.attention.phase`]: event.phase,
          [`${VOLLI}.attention.reason`]: event.reason,
        }),
      };
    case "dropped":
      return {
        // Telemetry about telemetry, under its own name so a query for lost
        // measurements cannot be confused with a query for agent behaviour.
        name: "volli.observability.dropped",
        kind: "internal",
        durationMs: 0,
        // Not a failed span: this IS the successful report of a loss, and a red
        // row would make an overflowing queue look like a broken exporter.
        failed: false,
        attributes: present({
          ...runId,
          [`${VOLLI}.dropped.reason`]: event.reason,
          [`${VOLLI}.dropped.count`]: event.count,
        }),
      };
    /* v8 ignore next 4 -- unreachable while the union is exhausted above; it exists to stop being so at compile time. */
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}
