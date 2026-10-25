/** Follow-up intent and live queue vocabulary. Execution still belongs to the runner. */
import type { SessionCommandIntent, TranscriptReference } from "../session-ledger";
import { decodeSessionCommandIntent } from "../session-event-codec";

export const FOLLOW_UP_QUEUE_MAX = 32;
export const FOLLOW_UP_MIRROR_MAX_BYTES = 64 * 1024;
export const FOLLOW_UP_MESSAGE_MAX_BYTES = 8 * 1024;

export type FollowUpIntent =
  | {
      kind: "message.submit";
      delivery: "queue";
      messageId: string;
      reference: TranscriptReference;
    }
  | {
      kind: "message.submit";
      delivery: "steer";
      messageId: string;
      /** Optional: the runner steers its canonical queued body, not a reconstructed mirror. */
      reference?: TranscriptReference;
    }
  | {
      kind: "message.edit";
      messageId: string;
      reference: TranscriptReference;
      expectedRevision?: number;
    }
  | { kind: "message.cancel"; messageId: string; expectedRevision?: number };

/** These runtime controls deliberately do not extend the immutable event command vocabulary. */
export function decodeCloudSessionIntent(value: unknown): SessionCommandIntent | FollowUpIntent {
  if (value === null || typeof value !== "object")
    return decodeSessionCommandIntent(value, "intent");
  const raw = value as Record<string, unknown>;
  if (
    raw.kind !== "message.edit" &&
    raw.kind !== "message.cancel" &&
    !(raw.kind === "message.submit" && raw.delivery !== undefined)
  )
    return decodeSessionCommandIntent(value, "intent");
  if (typeof raw.messageId !== "string" || raw.messageId.length === 0 || raw.messageId.length > 512)
    throw new Error("A follow-up needs its message id.");
  const revision = raw.expectedRevision;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || (revision as number) < 0))
    throw new Error("A queue revision must be a nonnegative integer.");
  if (raw.kind === "message.cancel")
    return {
      kind: raw.kind,
      messageId: raw.messageId,
      ...(revision === undefined ? {} : { expectedRevision: revision as number }),
    };
  if (raw.kind === "message.submit" && raw.delivery === "steer" && raw.reference === undefined)
    return { kind: "message.submit", delivery: "steer", messageId: raw.messageId };
  const submit = decodeSessionCommandIntent(
    { kind: "message.submit", reference: raw.reference },
    "intent",
  ) as Extract<SessionCommandIntent, { kind: "message.submit" }>;
  if (raw.kind === "message.edit")
    return {
      kind: raw.kind,
      messageId: raw.messageId,
      reference: submit.reference,
      ...(revision === undefined ? {} : { expectedRevision: revision as number }),
    };
  if (raw.delivery !== "queue" && raw.delivery !== "steer")
    throw new Error("Unknown message delivery.");
  return {
    kind: "message.submit",
    delivery: raw.delivery,
    messageId: raw.messageId,
    reference: submit.reference,
  };
}

export function isFollowUpIntent(
  intent: SessionCommandIntent | FollowUpIntent,
): intent is FollowUpIntent {
  return (
    intent.kind === "message.edit" ||
    intent.kind === "message.cancel" ||
    (intent.kind === "message.submit" && "delivery" in intent)
  );
}

export interface FollowUpMirrorItem {
  messageId: string;
  commandId: string;
  state: "queued" | "releasing";
  afterCurrentStep?: boolean;
  refused?: boolean;
  refusedDetail?: string;
  /** JSON message, or null when too large for this live view. Never a new artifact identity. */
  message: string | null;
  messageDigest: string;
}
export interface FollowUpQueueJob {
  commandId: string;
  intent: FollowUpIntent;
  status: string;
  neverLeased: boolean;
}
export interface FollowUpQueueViewItem extends FollowUpMirrorItem {
  waitingForRunner: boolean;
  pending: "edit" | "cancel" | null;
}

/** Mirror order wins; unacknowledged intake follows. Terminal jobs never resurrect released items. */
export function followUpQueueView(
  mirror: readonly FollowUpMirrorItem[],
  jobs: readonly FollowUpQueueJob[],
  runnerStatus: string | null,
): FollowUpQueueViewItem[] {
  const items = mirror.map(
    (item) => ({ ...item, waitingForRunner: false, pending: null }) as FollowUpQueueViewItem,
  );
  for (const job of jobs) {
    if (job.status !== "queued" && job.status !== "leased") continue;
    const intent = job.intent;
    const existing = items.find((item) => item.messageId === intent.messageId);
    if (intent.kind === "message.submit" && intent.delivery === "queue") {
      if (existing === undefined)
        items.push({
          messageId: intent.messageId,
          commandId: job.commandId,
          state: "queued",
          message: null,
          messageDigest: intent.reference.digest ?? intent.reference.id,
          waitingForRunner: job.neverLeased && runnerStatus !== "online",
          pending: null,
        });
    } else if (existing !== undefined) {
      if (intent.kind === "message.edit") existing.pending = "edit";
      if (intent.kind === "message.cancel") existing.pending = "cancel";
    }
  }
  return items;
}
