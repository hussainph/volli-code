/**
 * The observability side channel at the Pi runtime boundary (VC-119).
 *
 * Two seams, both passive. The observation tee reduces every accepted
 * `RuntimeObservation` to a metadata-only event before the consumer sees it;
 * the stream instrument measures each physical provider request at the
 * `streamSimple` boundary and emits one attempt envelope when it settles.
 *
 * The envelope is derived here rather than through Pi's `telemetryContext`
 * deliberately: at the pinned versions, `pi-ai` threads that context through
 * provider request options but records nothing to it — span emission lives in
 * Pi's separate harness layer, which this runtime does not use. Deriving from
 * the stream keeps the envelope truthful at these pins while mirroring the
 * field vocabulary of Pi's `pi.ai.request` span, so a future Pi that records
 * natively is an exporter change, not a vocabulary migration.
 *
 * Nothing in this module may disturb a run. Every failure path — a sink that
 * throws, a reducer that throws, a stream that refuses instrumentation —
 * swallows the error and costs the run nothing but a lost measurement.
 */

import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  StopReason,
} from "@earendil-works/pi-ai";
import {
  measuredDuration,
  ObservabilityReducer,
  type AttemptStopReason,
  type ObservabilitySink,
  type ProviderAttemptEvent,
  type ProviderErrorClass,
  type RuntimeObservation,
  type SessionRuntimeSpec,
} from "@volli/shared";

type PiStreamFn = AgentOptions["streamFn"];

/** What the stream instrument needs from the attachment that owns it. */
export interface StreamObservability {
  sink: ObservabilitySink;
  /** Opaque per-attachment correlation id; never derived from Session identity. */
  runId: string;
  now: () => number;
}

/**
 * Volli's word for how one attempt ended. The `switch` is the in-step check
 * with Pi's `StopReason`: a member Pi adds becomes a compile error here, and a
 * value outside the type at runtime degrades to `"unknown"` instead of leaking
 * a new string into the bounded vocabulary.
 */
export function attemptStopReason(reason: StopReason): AttemptStopReason {
  switch (reason) {
    case "stop":
    case "length":
    case "toolUse":
    case "error":
    case "aborted":
    case "deferred":
      return reason;
    case "pending":
      return "unknown";
    default: {
      const unhandled: never = reason;
      void unhandled;
      return "unknown";
    }
  }
}

/**
 * The local-only classification input Pi leaves on a failed message.
 *
 * Each provider formats diagnostics differently and some formats include user
 * material. These patterns are deliberately broad only in the direction of a
 * fixed class; the source text is never stored on an observability event.
 */
const PROVIDER_ERROR_PATTERNS: readonly [ProviderErrorClass, RegExp][] = [
  [
    "auth",
    /\b(?:401|403|api[ _-]?key|auth(?:entication)?|credential|forbidden|unauthori[sz]ed)\b/i,
  ],
  ["rate-limit", /\b(?:429|rate[ _-]?limit|too many requests|quota|usage[ _-]?limit)\b/i],
  ["overloaded", /\b(?:503|529|capacity|overload(?:ed|ing)?|service unavailable)\b/i],
  ["timeout", /\b(?:deadline exceeded|timed? out|timeout)\b/i],
  [
    "transport",
    /\b(?:connection|dns|econn\w*|fetch failed|network|socket|stream closed|websocket)\b/i,
  ],
  [
    "invalid-request",
    /\b(?:400|bad request|invalid (?:argument|parameter|request)|malformed|validation)\b/i,
  ],
];

/**
 * Reduces provider prose to a bounded class only for an actual provider error.
 *
 * An aborted attempt is a local interruption, not a provider failure; adding a
 * class there would make a person pressing Stop look like a model outage.
 */
export function providerErrorClass(
  stopReason: AttemptStopReason,
  message: string | undefined,
): ProviderErrorClass | undefined {
  if (stopReason !== "error") return undefined;
  if (message === undefined) return "unknown";
  for (const [errorClass, pattern] of PROVIDER_ERROR_PATTERNS) {
    if (pattern.test(message)) return errorClass;
  }
  return "unknown";
}

/**
 * Reduces and records one observation without delivering it to the Session.
 *
 * This is the observability-only path for a fact that must not become durable
 * history, such as an allowed authority decision. It shares the reducer with
 * the normal tee so ephemeral local correlation can join it to a later tool
 * result, but it never awaits or calls the runtime observer.
 */
export function recordObservationToSink(
  reducer: ObservabilityReducer,
  sink: ObservabilitySink,
  runId: string,
  observation: RuntimeObservation,
): void {
  try {
    const event = reducer.reduce(observation);
    if (event !== null) sink.record({ ...event, runId });
  } catch {
    // A lost measurement, never a lost observation or authority decision.
  }
}

/**
 * Wraps the observer an attachment was given so every accepted observation is
 * reduced and recorded before delivery — and so neither reduction nor the sink
 * can reject, delay, or reorder what the consumer receives. The tee is
 * synchronous on purpose: it runs inside the ordered delivery queue, so events
 * reach the sink in exactly the order observations reach the Session Engine.
 */
export function teeObservationsToSink(
  observer: SessionRuntimeSpec["observer"],
  reducer: ObservabilityReducer,
  sink: ObservabilitySink,
  runId: string,
): SessionRuntimeSpec["observer"] {
  return (observation) => {
    recordObservationToSink(reducer, sink, runId, observation);
    return observer(observation);
  };
}

/**
 * Wraps the Agent's stream function so each provider request settles into one
 * `provider-attempt` envelope: identity from the requested model, usage and
 * stop reason from the terminal message, timing measured here.
 *
 * The stream's consumer contract is untouched — the same stream instance the
 * inner function produced is what the Agent iterates. Enrichment (time to
 * first event, event count) rides on the producer's own `push`, and a stream
 * that refuses the patch still yields an envelope from `result()`.
 */
export function instrumentStreamFn(
  inner: PiStreamFn,
  observability: StreamObservability,
): PiStreamFn {
  return (model, context, options) => {
    const produced = inner(model, context, options);
    // Read off the request before the stream settles, and once: the identity is
    // the same whichever way the inner function chose to hand the stream back.
    const identity: AttemptIdentity = {
      providerId: model.provider,
      modelId: model.id,
      api: model.api,
      reasoningLevel: options?.reasoning,
    };
    if (produced instanceof Promise) {
      return produced.then((stream) => {
        observeAttempt(stream, observability, identity);
        return stream;
      });
    }
    observeAttempt(produced, observability, identity);
    return produced;
  };
}

interface AttemptIdentity {
  providerId: string;
  modelId: string;
  api: string;
  reasoningLevel: ProviderAttemptEvent["reasoningLevel"] | undefined;
}

function observeAttempt(
  stream: AssistantMessageEventStream,
  observability: StreamObservability,
  identity: AttemptIdentity,
): void {
  const startedAt = observability.now();
  let firstEventAt: number | undefined;
  let eventCount = 0;
  try {
    const push = stream.push.bind(stream);
    stream.push = (event) => {
      try {
        if (firstEventAt === undefined) firstEventAt = observability.now();
        eventCount += 1;
      } catch {
        // A broken clock forfeits enrichment, not the event.
      }
      push(event);
    };
  } catch {
    // A stream that pins `push` still settles; only enrichment is lost.
  }
  try {
    void stream.result().then(
      (message) => {
        recordAttempt(message, observability, identity, {
          startedAt,
          firstEventAt,
          eventCount: () => eventCount,
        });
      },
      () => {
        // `result()` resolves by construction; a violation must not surface.
      },
    );
  } catch {
    // A stream without a working `result()` yields no envelope, nothing more.
  }
}

function recordAttempt(
  message: AssistantMessage,
  observability: StreamObservability,
  identity: AttemptIdentity,
  timing: { startedAt: number; firstEventAt: number | undefined; eventCount: () => number },
): void {
  try {
    const usage = message.usage;
    const eventCount = timing.eventCount();
    const stopReason = attemptStopReason(message.stopReason);
    const errorClass = providerErrorClass(stopReason, message.errorMessage);
    // Both clock readings are taken here, but not necessarily from a clock that
    // moved forwards between them; the shared guard is what stops a backwards
    // step from becoming a span that ends before it starts.
    const durationMs = measuredDuration(observability.now() - timing.startedAt) ?? 0;
    const ttftMs =
      timing.firstEventAt === undefined
        ? undefined
        : measuredDuration(timing.firstEventAt - timing.startedAt);
    const event: ProviderAttemptEvent = {
      kind: "provider-attempt",
      providerId: identity.providerId,
      modelId: identity.modelId,
      api: identity.api,
      ...(identity.reasoningLevel === undefined ? {} : { reasoningLevel: identity.reasoningLevel }),
      stopReason,
      ...(errorClass === undefined ? {} : { providerErrorClass: errorClass }),
      durationMs,
      ...(ttftMs === undefined ? {} : { ttftMs }),
      ...(eventCount === 0 ? {} : { chunkCount: eventCount }),
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
      totalTokens: usage.totalTokens,
      costUsd: usage.cost.total,
      ...(message.responseModel === undefined ? {} : { responseModelId: message.responseModel }),
      runId: observability.runId,
    };
    observability.sink.record(event);
  } catch {
    // A malformed message or a throwing sink drops the envelope, not the turn.
  }
}
