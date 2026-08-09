import type {
  SessionAttachmentContinuity,
  SessionCapabilityCatalogItem,
  SessionCapabilityFeature,
  SessionInteraction,
  SessionInteractionResolution,
  SessionNativeDetail,
  SessionNativeReference,
} from "@volli/shared";
import type { UIMessage } from "ai";
import type { TranscriptDelta } from "./transcript-overlay";

export interface NativeHarnessProfile {
  id: string;
  label: string;
  transport: "native" | "terminal";
}

export interface NativeHarnessManifest {
  id: string;
  displayName: string;
  adapterVersion: string;
  profiles: readonly NativeHarnessProfile[];
}

export interface NativeProbeContext {
  profileId: string;
  directory: string;
}

export interface NativeRuntimeIdentity {
  path: string;
  version: string;
  fingerprint: string;
}

export interface NativeCapabilityReport {
  features: readonly SessionCapabilityFeature[];
  catalog: readonly SessionCapabilityCatalogItem[];
}

export type NativeProbeResult =
  | {
      status: "available";
      runtime: NativeRuntimeIdentity;
      capabilities: NativeCapabilityReport;
    }
  | {
      status: "unavailable" | "incompatible";
      runtime: NativeRuntimeIdentity | null;
      reason: string;
    };

export interface NativeAttachmentSpec {
  sessionId: string;
  attachmentId: string;
  profileId: string;
  directory: string;
  continuity: SessionAttachmentContinuity;
  native: SessionNativeReference | null;
}

export type NativeMessageDelivery = "queue" | "steer" | "replace";

/** Typed attach refusal whose user-actionable blocker must survive as Attention. */
export class NativeAttachmentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly attentionKind: "configuration_invalid" | "adapter_unrecoverable",
  ) {
    super(message);
    this.name = "NativeAttachmentError";
  }
}

export type HarnessCommand =
  | {
      kind: "message.submit";
      commandId: string;
      sessionId: string;
      attachmentId: string;
      message: UIMessage;
      delivery: NativeMessageDelivery;
      model: { providerId: string; modelId: string } | null;
      agent: string | null;
      variant: string | null;
    }
  | {
      kind: "executor.interrupt";
      commandId: string;
      sessionId: string;
      attachmentId: string;
    }
  | {
      kind: "executor.retry";
      commandId: string;
      sessionId: string;
      attachmentId: string;
    }
  | {
      kind: "interaction.resolve";
      commandId: string;
      sessionId: string;
      attachmentId: string;
      interaction: SessionInteraction;
      resolution: SessionInteractionResolution;
    };

export type DeliveryReceipt =
  | {
      commandId: string;
      status: "accepted";
      acceptedAt: number;
      native: SessionNativeReference | null;
    }
  | {
      commandId: string;
      status: "rejected";
      code: string;
      detail: string | null;
      native: SessionNativeReference | null;
    }
  | {
      commandId: string;
      status: "unknown";
      detail: string | null;
      native: SessionNativeReference | null;
    };

interface HarnessObservationBase {
  /** Stable native event identity; repeats must retain the same id and content. */
  id: string;
  occurredAt: number;
  cursor?: SessionNativeDetail | null;
}

/**
 * The envelope for a fact that is never made durable, and deliberately not
 * {@link HarnessObservationBase}.
 *
 * The base carries `cursor`, and the runtime advances the reconcile cursor for
 * any observation that has one. A transient delta that moved it would make a
 * later reconcile ask the provider for events *after* content this Session
 * never wrote down — so the arm has no cursor to advance, and the runtime's
 * handling of it returns before the advance.
 */
interface TransientObservationBase {
  id: string;
  occurredAt: number;
}

export type HarnessObservation =
  | (HarnessObservationBase & {
      /** The native binding ended after it was already attached. */
      kind: "attachment.closed";
      outcome: "completed" | "failed" | "interrupted";
    })
  | (HarnessObservationBase & {
      /** Native failure after attachment; it closes the durable binding as failed. */
      kind: "attachment.failed";
      detail: string | null;
    })
  | (HarnessObservationBase & {
      /** The durable record: a message as it stands at a settle point. */
      kind: "transcript.message";
      threadId: string;
      branchId: string;
      attemptId: string;
      turnId: string | null;
      message: UIMessage;
    })
  | (TransientObservationBase & {
      /**
       * A message mid-word. View state, not a Session fact: it is folded into an
       * in-memory overlay and published to live subscribers, and nothing about
       * it is written down. The durable record of the same message arrives as
       * `transcript.message` when it settles.
       */
      kind: "transcript.delta";
      threadId: string;
      branchId: string;
      attemptId: string;
      turnId: string | null;
      messageId: string;
      delta: TranscriptDelta;
    })
  | (HarnessObservationBase & { kind: "turn.started"; turnId: string })
  | (HarnessObservationBase & { kind: "turn.completed"; turnId: string })
  | (HarnessObservationBase & { kind: "turn.interrupted"; turnId: string })
  | (HarnessObservationBase & {
      kind: "interaction.opened";
      interaction: Omit<SessionInteraction, "attachmentId">;
    })
  | (HarnessObservationBase & {
      kind: "interaction.resolved";
      interactionId: string;
      resolution: SessionInteractionResolution;
    })
  | (HarnessObservationBase & {
      kind: "attention.raised";
      attention: {
        id: string;
        kind:
          | "auth_required"
          | "configuration_invalid"
          | "rate_limited"
          | "quota_exhausted"
          | "context_limit_reached"
          | "transport_retrying"
          | "partial_turn_interrupted"
          | "adapter_disconnected"
          | "adapter_unrecoverable";
        detail: string | null;
        diagnostic: SessionNativeDetail | null;
        retryAt?: number | null;
        resetAt?: number | null;
      };
    })
  | (HarnessObservationBase & { kind: "attention.cleared"; attentionId: string });

/**
 * The reconcile cursor an observation carries, for a caller holding one whose
 * kind it has not narrowed yet.
 *
 * `undefined` means the observation names no position to resume from — either
 * because its kind has no cursor at all, or because a durable kind left it
 * unset — and a caller that stores cursors must leave the one it has alone.
 */
export function observationCursor(
  observation: HarnessObservation,
): SessionNativeDetail | null | undefined {
  return "cursor" in observation ? observation.cursor : undefined;
}

export interface ObservationSink {
  /** Resolves only after the observation's durable Session facts commit. */
  emit(observation: HarnessObservation): Promise<void>;
}

export interface Reconciliation {
  cursor: SessionNativeDetail | null;
  observations: readonly HarnessObservation[];
  receipts: readonly DeliveryReceipt[];
}

export type ReleaseReason = "requested" | "shutdown" | "replaced" | "adapter_failure";

export interface BindingHandle {
  readonly native: SessionNativeReference;
  dispatch(command: HarnessCommand): Promise<DeliveryReceipt>;
  reconcile(cursor: SessionNativeDetail | null): Promise<Reconciliation>;
  /** Called only after every fact in the returned reconciliation batch commits durably. */
  acknowledgeReconciliation?(cursor: SessionNativeDetail | null): Promise<void>;
  release(reason: ReleaseReason): Promise<void>;
}

export interface NativeHarnessAdapter {
  readonly manifest: NativeHarnessManifest;
  probe(context: NativeProbeContext, signal: AbortSignal): Promise<NativeProbeResult>;
  attach(spec: NativeAttachmentSpec, sink: ObservationSink): Promise<BindingHandle>;
}

export interface NativeAdapterRegistry {
  get(adapterId: string): NativeHarnessAdapter | null;
  list(): readonly NativeHarnessAdapter[];
}

export function createNativeAdapterRegistry(
  adapters: readonly NativeHarnessAdapter[],
): NativeAdapterRegistry {
  const byId = new Map<string, NativeHarnessAdapter>();
  for (const adapter of adapters) {
    if (!adapter.manifest.id) throw new Error("Native adapter id cannot be empty");
    if (byId.has(adapter.manifest.id)) {
      throw new Error(`Native adapter ${adapter.manifest.id} is registered more than once`);
    }
    byId.set(adapter.manifest.id, adapter);
  }
  return {
    get: (adapterId) => byId.get(adapterId) ?? null,
    list: () => [...byId.values()],
  };
}
