/**
 * Metadata-only observability vocabulary for the Agent Runtime (VC-119).
 *
 * The Agent Runtime emits almost all of it. The one exception is
 * {@link TurnQueueEvent}, which only the Session runtime can measure (VC-455).
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
 * than by redaction.
 */

import type { ActivityKind } from "./session-activity";
import { NON_CODING_TOOL_IDS } from "./authority";
import type {
  CompactionReason,
  ReasoningDropCause,
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
 * Why a provider request failed, reduced without retaining the provider's prose.
 *
 * A provider error frequently includes a request id, a model-generated fragment,
 * or a credential-shaped string. The runtime classifies it locally and exports
 * only one of these fixed words.
 */
export const PROVIDER_ERROR_CLASSES = [
  "auth",
  "rate-limit",
  "overloaded",
  "timeout",
  "transport",
  "invalid-request",
  "unknown",
] as const;

export type ProviderErrorClass = (typeof PROVIDER_ERROR_CLASSES)[number];

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
  /** Present only for a provider error, never provider diagnostic prose. */
  providerErrorClass?: ProviderErrorClass;
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

/**
 * How long one submitted message waited before the turn it started opened
 * (VC-455).
 *
 * {@link TurnEvent.durationMs} starts when the executor opens the turn, so
 * everything in front of that — waiting behind the Session's previous message,
 * a Session attach, the executor's own pre-turn work — was invisible. The
 * Session runtime is the one layer that sees both ends on one clock: it
 * receives the message into its per-Session admission queue, and it records
 * the executor's `turn.started` fact that releases that admission. So it, not
 * the executor, emits this.
 *
 * "Received" is the Session runtime receiving the Command, which is not a
 * Receipt's `accepted` outcome, and once clients and the runtime run apart it
 * is not the moment a person pressed send either.
 *
 * A separate envelope rather than a field on {@link TurnEvent} because the two
 * are measured by different layers: the executor's reducer never sees the
 * Command arrive, and the Session runtime never sees the executor's run id.
 * That is also why `runId` is normally absent here — the envelope is an
 * aggregate measurement, not a span of a specific run.
 *
 * Emitted only when the runtime measured it: a message that joined a turn
 * already running, a turn replayed from recovery, or a turn nobody's admission
 * was waiting on produces no event at all. Absent means unknown, never zero.
 */
export interface TurnQueueEvent {
  kind: "turn-queue";
  /** Message received by the Session runtime → the turn it started opened. */
  queuedMs: number;
  runId?: string;
}

/**
 * The queue envelope for one measured admission, or nothing.
 *
 * Both readings come from one caller's clock; this function exists so the rule
 * — a backwards clock or a non-finite reading is unmeasured, not zero — has one
 * definition, which the Session runtime uses and the VC-441 fixture reuses.
 */
export function turnQueueEvent(input: {
  receivedAt: number;
  turnStartedAt: number;
}): TurnQueueEvent | null {
  const queuedMs = measuredDuration(input.turnStartedAt - input.receivedAt);
  return queuedMs === undefined ? null : { kind: "turn-queue", queuedMs };
}

/**
 * The tools Volli is willing to name, as a closed vocabulary.
 *
 * `ActivityKind` answers "what capability class" but not "which tool" — it
 * collapses `web_fetch` and `web_search` into `fetch-url`, and everything
 * unclassified into `other`. That is too coarse for the per-tool call rates and
 * failure rates this side channel exists to report.
 *
 * The honest fix is not to export the harness's `nativeToolName`: that value is
 * sanitized and length-capped, but it is not bounded — a model can ask for a
 * tool that does not exist, and a future Pi or an MCP surface can introduce
 * names nobody here has seen. Exporting it would put an unbounded string into a
 * union whose whole safety property is that it contains none.
 *
 * So the tools Volli ships are listed, and only a name on this list is spoken.
 * Anything else is absent, and the capability class still carries the call — and
 * until somebody adds a new tool's name here, that tool is counted without being
 * named, which is the failure direction worth having.
 *
 * The non-coding half is derived rather than retyped, so those three names
 * cannot drift. The coding half cannot be: {@link CodingToolId} is Volli's
 * policy vocabulary (`execute`) while the name the model actually calls is Pi's
 * (`bash`), and only the latter ever appears on an activity. Those four are
 * therefore quoted from Pi, and `agent-runtime` owns a test that fails if its
 * own tool-name map ever disagrees with this list.
 */
const PI_CODING_TOOL_NAMES = ["read", "edit", "write", "bash"] as const;

export const OBSERVED_TOOL_IDS = [...PI_CODING_TOOL_NAMES, ...NON_CODING_TOOL_IDS] as const;

export type ObservedToolId = (typeof OBSERVED_TOOL_IDS)[number];

/** The allowlist as a lookup, so narrowing is a set membership and not a scan. */
const OBSERVED_TOOL_ID_SET: ReadonlySet<string> = new Set(OBSERVED_TOOL_IDS);

/**
 * A harness tool name as Volli's own word for it, or nothing.
 *
 * The narrowing IS the privacy boundary: an unrecognised name does not degrade
 * to a truncated or hashed string, it is simply not reported.
 */
export function observedToolId(nativeToolName: unknown): ObservedToolId | undefined {
  return typeof nativeToolName === "string" && OBSERVED_TOOL_ID_SET.has(nativeToolName)
    ? (nativeToolName as ObservedToolId)
    : undefined;
}

/** One executed tool call, reduced to its kind, outcome, and two kinds of time. */
export interface ToolEvent {
  kind: "tool";
  activityKind: ActivityKind;
  /** Volli's own name for the tool, when it is one Volli ships. Never a raw harness name. */
  toolId?: ObservedToolId;
  outcome: "completed" | "failed";
  /** Time Pi spent executing the tool, excluding a wait for a person. */
  durationMs?: number;
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
  /**
   * The reducer's first `compaction-progress` for this reason → this outcome
   * (VC-455). Compaction is synchronous-heavy work on the same event loop as
   * every other Session's turn, so it is worth seeing apart from the turn it
   * sits inside. A compaction whose work threw closes its progress before its
   * failure is recorded, so its span ends at that `finished` marker instead.
   * Absent when no progress was seen — a `checkpoint` failure runs no work, a
   * failure before the work started has none, and a reducer attached after the
   * work began saw only its end.
   */
  durationMs?: number;
  runId?: string;
}

/**
 * A provider dropped reasoning from a request, and the turn succeeded anyway.
 *
 * A count and a closed vocabulary word: no path, because a structural pointer
 * like `messages.1.content.0` describes the shape of a specific conversation,
 * and this side channel carries nothing about one. The product observation
 * keeps the paths; this keeps the fact that it happened and how often, which
 * is what makes the rate visible without making the conversation visible.
 */
export interface ProviderReasoningDroppedEvent {
  kind: "provider-reasoning-dropped";
  cause: ReasoningDropCause;
  /** Blocks dropped across every request in this Turn. */
  count: number;
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
  reason: "auth" | "configuration" | "context" | "runtime-failure" | "partial-turn" | "transport";
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
  | TurnQueueEvent
  | ToolEvent
  | CompactionEvent
  | ProviderReasoningDroppedEvent
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
  /**
   * When the first `compaction-progress` for each reason arrived. Keyed by
   * reason because that is all a progress observation carries, and the runtime
   * runs at most one compaction at a time.
   */
  #compactionStartedAt = new Map<CompactionReason, number>();
  /**
   * Work that ended with a `finished` progress instead of an outcome.
   *
   * Two runtime paths do that: Pi found nothing to compact (no outcome
   * follows), and the work threw (the failure is recorded right after, by the
   * caller that caught it). Only the second has an outcome to attach the span
   * to, and it is the very next observation — so the span is offered to
   * exactly that one and discarded by anything else, rather than being kept
   * around for some later, unrelated failure to claim.
   */
  #finishedCompaction: { reason: CompactionReason; durationMs: number } | null = null;

  /**
   * An explicit field, not a constructor parameter property.
   *
   * `@volli/shared` exports raw TypeScript, and the repo's build and check
   * scripts import it under Node's type-stripping loader, which refuses a
   * parameter property outright (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) because
   * stripping one would have to emit an assignment rather than erase a type.
   * One here takes down every script that touches this package's barrel.
   */
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  reduce(observation: RuntimeObservation): ObservabilityEvent | null {
    const finishedCompaction = this.#finishedCompaction;
    this.#finishedCompaction = null;
    switch (observation.kind) {
      case "turn": {
        if (observation.state === "started") {
          this.#turnStartedAt.set(observation.turnId, this.#now());
          return null;
        }
        const startedAt = this.#turnStartedAt.get(observation.turnId);
        this.#turnStartedAt.delete(observation.turnId);
        // Through the same guard as every other duration: a clock that stepped
        // backwards between the two readings must not become a negative span.
        const durationMs =
          startedAt === undefined ? undefined : measuredDuration(this.#now() - startedAt);
        return {
          kind: "turn",
          outcome: observation.state,
          ...(durationMs === undefined ? {} : { durationMs }),
        };
      }
      case "activity": {
        if (observation.state === "started" || observation.state === "progress") return null;
        const { startedAt, endedAt } = observation.descriptor;
        const elapsed =
          startedAt === null || endedAt === null
            ? undefined
            : measuredDuration(endedAt - startedAt);
        const toolId = observedToolId(observation.descriptor.nativeToolName);
        return {
          kind: "tool",
          activityKind: observation.descriptor.kind,
          ...(toolId === undefined ? {} : { toolId }),
          outcome: observation.state,
          ...(elapsed === undefined ? {} : { durationMs: elapsed }),
        };
      }
      case "compaction": {
        const startedAt = this.#compactionStartedAt.get(observation.reason);
        this.#compactionStartedAt.delete(observation.reason);
        const durationMs =
          startedAt !== undefined
            ? measuredDuration(this.#now() - startedAt)
            : finishedCompaction?.reason === observation.reason
              ? finishedCompaction.durationMs
              : undefined;
        const measured = durationMs === undefined ? {} : { durationMs };
        if (observation.state === "failed") {
          return { kind: "compaction", outcome: "failed", reason: observation.reason, ...measured };
        }
        return {
          kind: "compaction",
          outcome: "compacted",
          reason: observation.reason,
          tokensBefore: observation.tokensBefore,
          tokensAfter: observation.tokensAfter,
          ...measured,
        };
      }
      // Transient progress is timed, never exported: the duration rides on the
      // compaction outcome it belongs to.
      case "compaction-progress":
        if (observation.state === "started") {
          if (!this.#compactionStartedAt.has(observation.reason)) {
            this.#compactionStartedAt.set(observation.reason, this.#now());
          }
        } else {
          const startedAt = this.#compactionStartedAt.get(observation.reason);
          this.#compactionStartedAt.delete(observation.reason);
          const durationMs =
            startedAt === undefined ? undefined : measuredDuration(this.#now() - startedAt);
          if (durationMs !== undefined) {
            this.#finishedCompaction = { reason: observation.reason, durationMs };
          }
        }
        return null;
      case "attachment":
        return {
          kind: "attachment",
          phase: observation.state,
          ...(observation.failure === undefined
            ? {}
            : { failureReason: observation.failure.reason }),
        };
      // The worst cause in the turn, not each one: a turn that lost blocks to
      // a prefix mismatch AND to a model fallback is first of all a prefix
      // mismatch, because that is the one that says the integration edited
      // history. One event per turn either way.
      case "provider-reasoning-dropped":
        return {
          kind: "provider-reasoning-dropped",
          cause: observation.causes.includes("prefix-mismatch")
            ? "prefix-mismatch"
            : (observation.causes[0] ?? "unknown"),
          count: observation.count,
        };
      case "attention":
        return { kind: "attention", phase: observation.state, reason: observation.reason };
      case "delta":
      case "message-settled":
      case "interaction":
        return null;
      // Usage is a Session Semantic Fact and reaches the ledger on its own
      // path. It is not reduced here even though it could be: this exporter is
      // opt-in, best-effort and droppable, and every token it would carry is
      // already on the neighbouring `provider-attempt` event, which measures
      // the same call from the transport's side. A second copy would only give
      // two channels something to disagree about.
      case "usage":
        return null;
      /* v8 ignore next 4 -- unreachable while the union is exhausted above; it exists to stop being so at compile time. */
      default: {
        const unhandled: never = observation;
        return unhandled;
      }
    }
  }
}

/**
 * A duration is a non-negative finite count, never an unchecked clock result.
 *
 * Exported because it is the single definition of that rule: every duration on
 * an {@link ObservabilityEvent} passes through here, including the two that are
 * computed by subtracting one clock reading from another in other packages.
 */
export function measuredDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
