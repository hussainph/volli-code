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
  tokenType: "gen_ai.token.type",
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

/** One counter or histogram update, still independent of OpenTelemetry SDK types. */
export interface ObservabilityMetric {
  name: string;
  instrument: "counter" | "histogram";
  unit: string;
  value: number;
  /** Labels are held to the same metadata-only scalar boundary as span attributes. */
  attributes: SpanAttributes;
}

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
          ...(attemptFailed(event.stopReason)
            ? { [ERROR_TYPE]: event.providerErrorClass ?? event.stopReason }
            : {}),
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
          [`${VOLLI}.tool.wait_duration_ms`]: event.waitDurationMs,
          ...(event.outcome === "failed" ? { [ERROR_TYPE]: "tool_failed" } : {}),
        }),
      };
    case "authority":
      return {
        name: "volli.agent.authority",
        kind: "internal",
        durationMs: event.waitDurationMs ?? 0,
        // An allowance or refusal is the policy working. Neither is a fault.
        failed: false,
        attributes: present({
          ...runId,
          [`${VOLLI}.authority.outcome`]: event.outcome,
          ...(event.outcome === "denied" ? { [`${VOLLI}.authority.cause`]: event.cause } : {}),
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

const METRIC = {
  modelRequests: "volli.agent.model.request.count",
  modelDuration: "gen_ai.client.operation.duration",
  tokens: "gen_ai.client.token.usage",
  cost: "volli.agent.cost.usage",
  toolCalls: "volli.agent.tool.call.count",
  toolExecutionDuration: "volli.agent.tool.execution.duration",
  toolWaitDuration: "volli.agent.tool.wait.duration",
  authorityDecisions: "volli.agent.authority.decision.count",
  compactions: "volli.agent.compaction.count",
  dropped: "volli.observability.dropped.count",
} as const;

/** A scalar metric value must be a finite non-negative count or duration. */
function metricValue(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function seconds(value: number | undefined): number | undefined {
  const milliseconds = metricValue(value);
  return milliseconds === undefined ? undefined : milliseconds / 1000;
}

function metric(
  name: string,
  instrument: ObservabilityMetric["instrument"],
  unit: string,
  value: number | undefined,
  attributes: SpanAttributes,
): ObservabilityMetric[] {
  const safeValue = metricValue(value);
  return safeValue === undefined ? [] : [{ name, instrument, unit, value: safeValue, attributes }];
}

function providerMetricAttributes(
  event: Extract<ObservabilityEvent, { kind: "provider-attempt" }>,
) {
  return present({
    [GEN_AI.providerName]: event.providerId,
    [GEN_AI.requestModel]: event.modelId,
    [GEN_AI.finishReasons]: event.stopReason,
    ...(event.stopReason === "error"
      ? { [ERROR_TYPE]: event.providerErrorClass ?? "unknown" }
      : {}),
  });
}

function providerTokenMetrics(
  event: Extract<ObservabilityEvent, { kind: "provider-attempt" }>,
): ObservabilityMetric[] {
  const provider = present({
    [GEN_AI.providerName]: event.providerId,
    [GEN_AI.requestModel]: event.modelId,
  });
  const tokens = [
    ["input", event.inputTokens],
    ["output", event.outputTokens],
    ["cache-read", event.cacheReadTokens],
    ["cache-write", event.cacheWriteTokens],
    ["reasoning", event.reasoningTokens],
  ] as const;
  return tokens.flatMap(([type, value]) =>
    metric(
      METRIC.tokens,
      "counter",
      "{token}",
      value,
      present({
        ...provider,
        [`${VOLLI}.token.type`]: type,
        // The convention's token type has only input/output words today. Volli's
        // cache and reasoning splits remain in its own namespace rather than
        // claiming those words are standardized.
        ...(type === "input" || type === "output" ? { [GEN_AI.tokenType]: type } : {}),
      }),
    ),
  );
}

/**
 * One canonical event as the metric updates it implies.
 *
 * This is deliberately beside {@link observabilitySpan}: the reducer and this
 * mapper are the only places that know the event vocabulary. OTLP transport
 * code receives generic instruments and labels, so adding a future signal does
 * not reach back into the Agent Runtime.
 */
export function observabilityMetrics(event: ObservabilityEvent): readonly ObservabilityMetric[] {
  switch (event.kind) {
    case "provider-attempt": {
      const request = providerMetricAttributes(event);
      return [
        ...metric(METRIC.modelRequests, "counter", "{request}", 1, request),
        ...metric(METRIC.modelDuration, "histogram", "s", seconds(event.durationMs), request),
        ...providerTokenMetrics(event),
        ...metric(
          METRIC.cost,
          "counter",
          "USD",
          event.costUsd,
          present({
            [GEN_AI.providerName]: event.providerId,
            [GEN_AI.requestModel]: event.modelId,
          }),
        ),
      ];
    }
    case "tool": {
      const attributes = present({
        [GEN_AI.toolName]: event.activityKind,
        [`${VOLLI}.tool.outcome`]: event.outcome,
      });
      return [
        ...metric(METRIC.toolCalls, "counter", "{call}", 1, attributes),
        ...metric(
          METRIC.toolExecutionDuration,
          "histogram",
          "s",
          seconds(event.durationMs),
          attributes,
        ),
        ...metric(
          METRIC.toolWaitDuration,
          "histogram",
          "s",
          seconds(event.waitDurationMs),
          attributes,
        ),
      ];
    }
    case "authority":
      return metric(
        METRIC.authorityDecisions,
        "counter",
        "{decision}",
        1,
        present({
          [`${VOLLI}.authority.outcome`]: event.outcome,
          ...(event.outcome === "denied" ? { [`${VOLLI}.authority.cause`]: event.cause } : {}),
        }),
      );
    case "compaction":
      return metric(
        METRIC.compactions,
        "counter",
        "{compaction}",
        1,
        present({
          [`${VOLLI}.compaction.outcome`]: event.outcome,
          [`${VOLLI}.compaction.reason`]: event.reason,
        }),
      );
    case "dropped":
      return metric(
        METRIC.dropped,
        "counter",
        "{event}",
        event.count,
        present({ [`${VOLLI}.dropped.reason`]: event.reason }),
      );
    case "turn":
    case "attachment":
    case "attention":
      return [];
    /* v8 ignore next 4 -- unreachable while the union is exhausted above; it exists to stop being so at compile time. */
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}
