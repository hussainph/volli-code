/** Follow-up intent and live queue vocabulary. Execution still belongs to the runner. */
import type { SessionCommandIntent, TranscriptReference } from "../session-ledger";

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
