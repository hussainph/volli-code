/**
 * Metadata-only observability vocabulary for the Agent Runtime (VC-119).
 *
 * A side channel, never a participant: an {@link ObservabilitySink} may watch a
 * Session run, but nothing it does — or fails to do — can decide whether an
 * observation is persisted, whether a tool is allowed, or whether a turn
 * completes. The runtime treats a sink that throws as a dropped event, not as
 * an error.
 *
 * Every field in {@link ObservabilityEvent} is one of four safe shapes: a
 * closed vocabulary word, a count, a duration, or a configuration identifier
 * (provider, model, API family). There is deliberately no free-form string
 * anywhere in the union — no prompt, no path, no command, no tool argument, no
 * diagnostic prose — so the privacy policy is enforced by construction rather
 * than by redaction. See docs/research/agent-observability-oss-options.md for
 * the boundary this implements.
 */

import type { ActivityKind } from "./session-activity";
import type { AuthorityDenialCause } from "./authority";
import type {
  CompactionReason,
  ReasoningLevel,
  RuntimeFailure,
  RuntimeObservation,
} from "./agent-runtime";

/**
 * How one provider attempt ended, in Volli's own words.
 *
 * Mirrors Pi's terminal `StopReason` values, spelled out rather than imported
 * because this package depends on nothing. The Pi adapter maps its type onto
 * this list exhaustively — a stop reason Volli has no word for arrives as
 * `"unknown"` instead of leaking a new string into the vocabulary.
 */
export const ATTEMPT_STOP_REASONS = [
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
  "unknown",
] as const;

export type AttemptStopReason = (typeof ATTEMPT_STOP_REASONS)[number];

/**
 * One physical provider request, measured at the runtime's stream boundary.
 *
 * The closest local equivalent of Pi's `pi.ai.request` telemetry span, derived
 * by Volli because the pinned Pi records spans only in its harness layer,
 * which this runtime does not use. Token fields are the provider's own report;
 * absent means the provider did not say, never zero.
 */
export interface ProviderAttemptEvent {
  kind: "provider-attempt";
  /** Bounded configuration vocabulary — a catalog id, never user content. */
  providerId: string;
  modelId: string;
  /** Provider API family, such as `anthropic-messages`. */
  api: string;
  /** Absent when the request was made without reasoning. */
  reasoningLevel?: ReasoningLevel;
  stopReason: AttemptStopReason;
  /** Call to terminal stream event. */
  durationMs: number;
  /** Call to first stream event, when one arrived before settlement. */
  ttftMs?: number;
  /** Protocol events observed on the stream, including the terminal one. */
  chunkCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** The concrete model that answered, when it differs from the request. */
  responseModelId?: string;
  runId?: string;
}

/** One finished runtime turn. Started turns are timed, not reported. */
export interface TurnEvent {
  kind: "turn";
  outcome: "completed" | "interrupted";
  /** Absent when the reducer never saw this turn start. */
  durationMs?: number;
  runId?: string;
}

/** One executed tool call, reduced to its kind, outcome, and cost in time. */
export interface ToolEvent {
  kind: "tool";
  activityKind: ActivityKind;
  outcome: "completed" | "failed";
  /** From the activity descriptor's own clock, when the adapter reported one. */
  durationMs?: number;
  runId?: string;
}

/**
 * The Session's authority refused a call before it ran.
 *
 * Carries the rule that refused and nothing else: the tool name a model asked
 * for is unbounded input, and the refusal reason is prose.
 */
export interface AuthorityDeniedEvent {
  kind: "authority-denied";
  cause: AuthorityDenialCause;
  runId?: string;
}

/** A context compaction that landed, or the attempt that failed to. */
export interface CompactionEvent {
  kind: "compaction";
  outcome: "compacted" | "failed";
  reason: CompactionReason;
  /** Only the compacted arm measured anything. */
  tokensBefore?: number;
  tokensAfter?: number;
  runId?: string;
}

/** Attachment lifecycle, with failures reduced to their bounded reason. */
export interface AttachmentEvent {
  kind: "attachment";
  phase: "started" | "recovered" | "closed" | "failed";
  failureReason?: RuntimeFailure["reason"];
  runId?: string;
}

/** Attention raised or cleared, reduced to its frozen reason vocabulary. */
export interface AttentionEvent {
  kind: "attention";
  phase: "raised" | "cleared";
  reason: "auth" | "configuration" | "context" | "runtime-failure" | "partial-turn";
  runId?: string;
}

/**
 * Telemetry the pipeline itself lost. Reserved for the exporter stage: a
 * bounded queue that overflows or a sink that throws drops the event and
 * counts the drop, rather than back-pressuring a model stream or a tool call.
 */
export interface DroppedEvent {
  kind: "dropped";
  reason: "queue-full" | "sink-error";
  count: number;
  runId?: string;
}

export type ObservabilityEvent =
  | ProviderAttemptEvent
  | TurnEvent
  | ToolEvent
  | AuthorityDeniedEvent
  | CompactionEvent
  | AttachmentEvent
  | AttentionEvent
  | DroppedEvent;

/**
 * Where observability events go. `record` must return quickly and never
 * throw; a sink that does either anyway costs the run nothing — the caller
 * swallows the failure and drops the event.
 */
export interface ObservabilitySink {
  record(event: ObservabilityEvent): void;
}

/** The disabled state, as a value rather than an `undefined` check. */
export const NOOP_OBSERVABILITY_SINK: ObservabilitySink = {
  record: () => {},
};

/**
 * Reduces the runtime's observation stream to metadata-only events.
 *
 * One instance per attachment: turn timing pairs a `started` observation with
 * its terminal sibling by turn id, and the id itself never leaves this class —
 * events carry durations, not identifiers. Observation kinds that exist to
 * carry content (deltas, settled messages, attachments-as-resources,
 * interactions) reduce to `null` on purpose; their safe facts are already
 * covered by the attempt envelope and the lifecycle events.
 */
export class ObservabilityReducer {
  #turnStartedAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  reduce(observation: RuntimeObservation): ObservabilityEvent | null {
    switch (observation.kind) {
      case "turn": {
        if (observation.state === "started") {
          this.#turnStartedAt.set(observation.turnId, this.now());
          return null;
        }
        const startedAt = this.#turnStartedAt.get(observation.turnId);
        this.#turnStartedAt.delete(observation.turnId);
        return {
          kind: "turn",
          outcome: observation.state,
          ...(startedAt === undefined ? {} : { durationMs: this.now() - startedAt }),
        };
      }
      case "activity": {
        if (observation.state === "started" || observation.state === "progress") return null;
        const { startedAt, endedAt } = observation.descriptor;
        const measured = startedAt !== null && endedAt !== null && endedAt >= startedAt;
        return {
          kind: "tool",
          activityKind: observation.descriptor.kind,
          outcome: observation.state,
          ...(measured ? { durationMs: endedAt - startedAt } : {}),
        };
      }
      case "authority":
        return { kind: "authority-denied", cause: observation.cause };
      case "compaction": {
        if (observation.state === "failed") {
          return { kind: "compaction", outcome: "failed", reason: observation.reason };
        }
        return {
          kind: "compaction",
          outcome: "compacted",
          reason: observation.reason,
          tokensBefore: observation.tokensBefore,
          tokensAfter: observation.tokensAfter,
        };
      }
      case "attachment":
        return {
          kind: "attachment",
          phase: observation.state,
          ...(observation.failure === undefined
            ? {}
            : { failureReason: observation.failure.reason }),
        };
      case "attention":
        return { kind: "attention", phase: observation.state, reason: observation.reason };
      case "delta":
      case "message-settled":
      case "compaction-progress":
      case "interaction":
        return null;
      /* v8 ignore next 4 -- unreachable while the union is exhausted above; it exists to stop being so at compile time. */
      default: {
        const unhandled: never = observation;
        return unhandled;
      }
    }
  }
}
