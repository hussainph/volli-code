import type {
  AuthoritySnapshot,
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
      kind: "context.compact";
      commandId: string;
      sessionId: string;
      attachmentId: string;
      /** Free text for the summarizer, or null. Prose, never arguments. */
      instructions: string | null;
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
  /**
   * The Authority Snapshot this binding runs under, for the Session Engine to
   * record onto the attachment (VC-44).
   *
   * Read the same way and at the same moment as {@link BindingHandle.native}:
   * once, straight after `attach` resolves, on the way to writing
   * `attachment.opened`. That is what makes the Snapshot durable without giving
   * this package any part in constructing one — the Engine owns Session history
   * and the adapter owns policy, and neither has to learn the other's job.
   *
   * Optional on the interface and null-able in the answer, which are two
   * different absences. An adapter that predates authority (a terminal
   * companion) does not implement the field at all; an adapter that implements
   * it answers `null` for a Session whose project turned the gate off. Both
   * record as `null`, because both mean the same thing about the attachment.
   */
  readonly authority?: AuthoritySnapshot | null;
  dispatch(command: HarnessCommand): Promise<DeliveryReceipt>;
  reconcile(cursor: SessionNativeDetail | null): Promise<Reconciliation>;
  /** Called only after every fact in the returned reconciliation batch commits durably. */
  acknowledgeReconciliation?(cursor: SessionNativeDetail | null): Promise<void>;
  /**
   * Tells an executor still parked on an ask to stop waiting for an answer.
   *
   * Optional, because only an executor that raises interactions has anything to
   * withdraw. Best-effort, because the Session's `interaction.cancelled` fact is
   * already durable when this is called: a refusal here leaves a harness waiting
   * on a question that is over — which its own release settles either way — and
   * must never turn a cancel that already happened into a failure.
   *
   * The withdrawal carries no resolution and takes none. Every way to answer
   * carries a disposition, so a withdrawal that resolved would let something
   * downstream read back a decision the person never made. The ask stops; what
   * it was asking stays unanswered, and nothing may conclude otherwise.
   */
  withdrawInteraction?(interactionId: string): Promise<void>;
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
