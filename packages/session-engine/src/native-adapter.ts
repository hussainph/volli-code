import type {
  ModelSelection,
  RuntimeObservation,
  SessionAttachmentContinuity,
  SessionInteraction,
  SessionInteractionResolution,
  SessionNativeDetail,
  SessionNativeReference,
} from "@volli/shared";
import type { UIMessage } from "ai";

export interface NativeRuntimeIdentity {
  path: string;
  version: string;
  fingerprint: string;
}

export interface NativeAttachmentSpec {
  sessionId: string;
  attachmentId: string;
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
      kind: "model.select";
      commandId: string;
      sessionId: string;
      attachmentId: string;
      selection: ModelSelection;
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

export interface ObservationSink {
  /** Resolves only after the observation's durable Session facts commit. */
  emit(observation: RuntimeObservation): Promise<void>;
}

export interface Reconciliation {
  cursor: SessionNativeDetail | null;
  observations: readonly RuntimeObservation[];
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

/**
 * The one structured executor a Session runtime holds.
 *
 * `id` is durable: it is written onto every attachment this adapter opens, as
 * the discriminator between a terminal companion and the structured executor,
 * and history outlives the build that wrote it — so it is read back from disk
 * long after the adapter that wrote it is gone. `adapterVersion` and `runtime`
 * are the identity every durable fact this adapter produces is stamped with,
 * and `runtime` in particular is recorded inside each binding envelope.
 */
export interface NativeHarnessAdapter {
  readonly id: string;
  /**
   * The leading segment of every durable observation id derived from this
   * adapter's observations — the `pi:` in `pi:turn:…`.
   *
   * Frozen, and stated here rather than in the Session Engine because the ids
   * belong to whoever's events they are. The Engine mints them, since it is the
   * layer that decides what a Session writes down, but it must not invent the
   * name they are minted under: every relaunch re-derives these ids from live
   * data and dedupes them by exact string match, so a changed namespace does not
   * fail — it writes a second copy of every fact in the Session's history.
   */
  readonly durableIdNamespace: string;
  readonly adapterVersion: string;
  readonly runtime: NativeRuntimeIdentity;
  attach(spec: NativeAttachmentSpec, sink: ObservationSink): Promise<BindingHandle>;
}
