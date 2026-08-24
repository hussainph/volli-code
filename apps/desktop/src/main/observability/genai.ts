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
 * The two `gen_ai.operation.name` values Volli uses, from the convention's
 * well-known list.
 *
 * Named rather than inlined because the attribute is *required* on the two
 * standard-named metrics below as well as on the spans, and a metric that omits
 * it is non-conformant in a way no test of Volli's own would notice.
 */
const OPERATION = {
  chat: "chat",
  executeTool: "execute_tool",
} as const;

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

/**
 * What an attribute may hold: the three scalar shapes the vocabulary produces,
 * plus a list of them. Never an object, and never a free-form string — every
 * value still originates in a closed word, a count, a duration, or a
 * configuration id.
 *
 * The list arm exists for exactly one attribute. `gen_ai.response.finish_reasons`
 * is defined by the convention as `string[]` (`@example ["stop"]`) because a
 * single response can carry several; Volli only ever has one, but emitting a
 * bare string under a name the convention types as a list is the kind of
 * near-miss that makes a dashboard silently skip a series.
 */
export type SpanAttributeValue = string | number | boolean | string[];

export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

/** One counter or histogram update, still independent of OpenTelemetry SDK types. */
export interface ObservabilityMetric {
  name: string;
  instrument: "counter" | "histogram";
  unit: string;
  value: number;
  /** Labels are held to the same metadata-only scalar boundary as span attributes. */
  attributes: SpanAttributes;
  /**
   * Histogram bucket boundaries, where the convention prescribes them.
   *
   * Carried on the measurement rather than known to the transport, for the same
   * reason the attribute names are: this module is the only one that reads the
   * convention, and `otlp.ts` stays a generic forwarder.
   */
  buckets?: readonly number[];
}

/** Drops the absent fields, so an unreported token count is absent, never zero. */
function present(
  attributes: Readonly<Record<string, SpanAttributeValue | undefined>>,
): SpanAttributes {
  const result: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * A span duration the transport can actually turn into a start time.
 *
 * The event vocabulary already guards every duration at the point it is
 * measured. This is the second guard, at the boundary where the number stops
 * being Volli's and becomes a wire format: `otlp.ts` derives `startTime` by
 * subtracting this from the recorded end, so a negative or non-finite value
 * here is an unreadable span rather than a wrong number.
 */
function safeDurationMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
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
 * What to call this tool, in one word both signals agree on.
 *
 * The allowlisted id when Volli has one, the capability class otherwise. Kept
 * in one function so a span and its metric can never disagree about the name.
 */
function toolLabel(event: Extract<ObservabilityEvent, { kind: "tool" }>): string {
  return event.toolId ?? event.activityKind;
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
        durationMs: safeDurationMs(event.durationMs),
        failed: attemptFailed(event.stopReason),
        attributes: present({
          ...runId,
          [GEN_AI.operationName]: OPERATION.chat,
          [GEN_AI.providerName]: event.providerId,
          [GEN_AI.system]: event.providerId,
          [GEN_AI.requestModel]: event.modelId,
          [GEN_AI.responseModel]: event.responseModelId,
          // A list, because that is how the convention types this attribute.
          [GEN_AI.finishReasons]: [event.stopReason],
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
        durationMs: safeDurationMs(event.durationMs),
        // An interrupted turn is a person changing their mind, not a fault.
        failed: false,
        attributes: present({ ...runId, [`${VOLLI}.turn.outcome`]: event.outcome }),
      };
    case "tool":
      return {
        // The convention's recipe again: `execute_tool {tool name}`. The name is
        // Volli's own word for one of the tools it ships, and falls back to the
        // capability class for a call Volli has no name for — never the
        // unbounded name a model asked for. Both are closed vocabularies.
        name: `execute_tool ${toolLabel(event)}`,
        kind: "internal",
        durationMs: safeDurationMs(event.durationMs),
        failed: event.outcome === "failed",
        attributes: present({
          ...runId,
          [GEN_AI.operationName]: OPERATION.executeTool,
          [GEN_AI.toolName]: toolLabel(event),
          [GEN_AI.toolType]: "function",
          // The capability class is kept beside the name rather than replaced by
          // it: it is the axis that stays stable when the tool list changes, and
          // the only one a call with no allowlisted name still has.
          [`${VOLLI}.tool.kind`]: event.activityKind,
          [`${VOLLI}.tool.outcome`]: event.outcome,
          [`${VOLLI}.tool.wait_duration_ms`]: event.waitDurationMs,
          ...(event.outcome === "failed" ? { [ERROR_TYPE]: "tool_failed" } : {}),
        }),
      };
    case "authority":
      return {
        name: "volli.agent.authority",
        kind: "internal",
        durationMs: safeDurationMs(event.waitDurationMs),
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
  buckets?: readonly number[],
): ObservabilityMetric[] {
  const safeValue = metricValue(value);
  if (safeValue === undefined) return [];
  return [
    {
      name,
      instrument,
      unit,
      value: safeValue,
      attributes,
      ...(buckets === undefined ? {} : { buckets }),
    },
  ];
}

/**
 * The bucket boundaries the GenAI convention prescribes for the two metrics
 * whose names Volli borrows.
 *
 * Quoted from the same convention revision as the attribute names. Without
 * them the SDK applies its own default boundaries, which are tuned for
 * sub-second HTTP latency and put every model request and every token count in
 * the overflow bucket.
 */
const TOKEN_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216,
  67_108_864,
] as const;

const DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
] as const;

function providerMetricAttributes(
  event: Extract<ObservabilityEvent, { kind: "provider-attempt" }>,
) {
  return present({
    // Required by the convention on `gen_ai.client.operation.duration`. Volli
    // borrows that metric's name, so it owes the metric's required attributes.
    [GEN_AI.operationName]: OPERATION.chat,
    [GEN_AI.providerName]: event.providerId,
    [GEN_AI.requestModel]: event.modelId,
    [GEN_AI.finishReasons]: [event.stopReason],
    ...(event.stopReason === "error"
      ? { [ERROR_TYPE]: event.providerErrorClass ?? "unknown" }
      : {}),
  });
}

function providerTokenMetrics(
  event: Extract<ObservabilityEvent, { kind: "provider-attempt" }>,
): ObservabilityMetric[] {
  const provider = present({
    // Both required by the convention on `gen_ai.client.token.usage`.
    [GEN_AI.operationName]: OPERATION.chat,
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
      // A histogram, because that is the instrument type the convention defines
      // for this name. Emitting a counter under it would hand a GenAI dashboard
      // a sum where it reads a distribution — worse than picking a custom name,
      // because the mismatch is invisible until somebody trusts the chart.
      METRIC.tokens,
      "histogram",
      "{token}",
      value,
      present({
        ...provider,
        // Required. `input` and `output` are the convention's well-known words;
        // the other three are custom values, which it explicitly permits, and
        // are the split that makes a cache hit rate answerable at all.
        [GEN_AI.tokenType]: type,
      }),
      TOKEN_BUCKETS,
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
        ...metric(
          METRIC.modelDuration,
          "histogram",
          "s",
          seconds(event.durationMs),
          request,
          DURATION_BUCKETS,
        ),
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
        [GEN_AI.toolName]: toolLabel(event),
        [`${VOLLI}.tool.kind`]: event.activityKind,
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
