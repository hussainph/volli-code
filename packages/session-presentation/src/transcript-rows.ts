import type { UIMessage } from "ai";
import { readSessionToolCallScope, type SessionToolCallScope } from "@volli/shared";
import { transcriptPartKey } from "./activity";
import { readHostNotice, type TranscriptHostNotice } from "./host-notice";
import type {
  TranscriptAuthorityReview,
  TranscriptCompaction,
  TranscriptReasoningDrop,
} from "./transcript";

/** What every Session client draws from the portable transcript projection. */
export type TranscriptRow =
  | {
      kind: "turn";
      messages: readonly UIMessage[];
      authorityReviews?: readonly TranscriptLinkedAuthorityReview[];
    }
  | { kind: "host-notice"; messageId: string; notice: TranscriptHostNotice }
  | { kind: "compaction"; compaction: TranscriptCompaction }
  | { kind: "reasoning-drop"; drop: TranscriptReasoningDrop }
  | { kind: "authority-review"; review: TranscriptAuthorityReview };

/** A resolved call placement. Clients use this row key, never a native call id. */
export interface TranscriptLinkedAuthorityReview extends TranscriptAuthorityReview {
  toolRowKey: string;
}

export function authorityReviewNoticeCopy(review: TranscriptAuthorityReview): string {
  return `${review.mode === "shadow" ? "Would block" : "Blocked"} ${review.tool}: ${review.reason}`;
}

function rowFor(messages: readonly UIMessage[]): TranscriptRow {
  const message = messages.length === 1 ? messages[0] : undefined;
  if (message === undefined) return { kind: "turn", messages };
  const notice = readHostNotice(message);
  return notice === null
    ? { kind: "turn", messages }
    : { kind: "host-notice", messageId: message.id, notice };
}

type AnchoredContextNotice =
  | {
      kind: "compaction";
      sequence: number;
      afterMessageId: string | null;
      value: TranscriptCompaction;
    }
  | {
      kind: "reasoning-drop";
      sequence: number;
      afterMessageId: string | null;
      value: TranscriptReasoningDrop;
    }
  | {
      kind: "authority-review";
      sequence: number;
      afterMessageId: string | null;
      value: TranscriptAuthorityReview;
    };

function noticeRow(notice: AnchoredContextNotice): TranscriptRow {
  switch (notice.kind) {
    case "compaction":
      return { kind: "compaction", compaction: notice.value };
    case "reasoning-drop":
      return { kind: "reasoning-drop", drop: notice.value };
    case "authority-review":
      return { kind: "authority-review", review: notice.value };
  }
}

/**
 * Projects Turns and host-authored messages into rows, then lays durable
 * context notices beside the row they followed. Classifier reviews belong to
 * the exact tool call, not their chronological anchor; only unmatched reviews
 * remain standalone notices (including while a live call is still arriving).
 *
 * Notice lists are already ordered on their own. They are joined by durable
 * Session Event sequence before they are anchored, so different notice kinds
 * cannot overtake each other. A missing anchor places the notice at the end
 * rather than hiding a fact the Session recorded.
 */
export function projectTranscriptRows(
  turns: readonly (readonly UIMessage[])[],
  compactions: readonly TranscriptCompaction[],
  reasoningDrops: readonly TranscriptReasoningDrop[],
  authorityReviews: readonly TranscriptAuthorityReview[] = [],
): readonly TranscriptRow[] {
  const initialRows = turns.map(rowFor);
  const callsById = new Map<
    string,
    Map<string, { rowKey: string; scope: SessionToolCallScope | null }>
  >();
  if (authorityReviews.length > 0) {
    for (const row of initialRows) {
      if (row.kind !== "turn") continue;
      for (const message of row.messages) {
        message.parts.forEach((part, index) => {
          if (part.type !== "dynamic-tool") return;
          const calls = callsById.get(part.toolCallId) ?? new Map();
          // Repeated parts in one message are one logical call. Distinct
          // messages with the same native id must never be conflated.
          if (!calls.has(message.id)) {
            calls.set(message.id, {
              rowKey: transcriptPartKey(message.id, index),
              scope: readSessionToolCallScope(part.toolMetadata),
            });
          }
          callsById.set(part.toolCallId, calls);
        });
      }
    }
  }
  const linked = new Set<TranscriptAuthorityReview>();
  const reviewsByRow = new Map<string, TranscriptLinkedAuthorityReview[]>();
  for (const review of authorityReviews) {
    const candidates = [...(callsById.get(review.toolCallId)?.values() ?? [])].filter(
      (call) =>
        review.scope === undefined ||
        (review.scope !== null &&
          call.scope?.attachmentId === review.scope.attachmentId &&
          call.scope.turnId === review.scope.turnId),
    );
    // A scoped review cannot claim an unscoped old call while its own live
    // call is still arriving. Ambiguous legacy history stays a disclosure.
    if (candidates.length !== 1) continue;
    const target = candidates[0]!;
    const reviews = reviewsByRow.get(target.rowKey) ?? [];
    reviews.push({ ...review, toolRowKey: target.rowKey });
    reviewsByRow.set(target.rowKey, reviews);
    linked.add(review);
  }
  const turnRows = initialRows.map((row) => {
    if (row.kind !== "turn" || reviewsByRow.size === 0) return row;
    const reviews = row.messages.flatMap((message) =>
      message.parts.flatMap(
        (_part, index) => reviewsByRow.get(transcriptPartKey(message.id, index)) ?? [],
      ),
    );
    return reviews.length === 0
      ? row
      : { kind: "turn" as const, messages: row.messages, authorityReviews: reviews };
  });
  const pending: AnchoredContextNotice[] = [
    ...compactions.map((value) => ({
      kind: "compaction" as const,
      sequence: value.sequence,
      afterMessageId: value.afterMessageId,
      value,
    })),
    ...authorityReviews
      .filter((value) => !linked.has(value))
      .map((value) => ({
        kind: "authority-review" as const,
        sequence: value.sequence,
        afterMessageId: value.afterMessageId,
        value,
      })),
    ...reasoningDrops.map((value) => ({
      kind: "reasoning-drop" as const,
      sequence: value.sequence,
      afterMessageId: value.afterMessageId,
      value,
    })),
  ].toSorted((left, right) => left.sequence - right.sequence);
  if (pending.length === 0) return turnRows;

  const rows: TranscriptRow[] = [];
  const takeAnchored = (claims: (notice: AnchoredContextNotice) => boolean) => {
    while (pending.length > 0 && claims(pending[0]!)) {
      const notice = pending.shift()!;
      rows.push(noticeRow(notice));
    }
  };

  takeAnchored((notice) => notice.afterMessageId === null);
  for (const [index, messages] of turns.entries()) {
    rows.push(turnRows[index]!);
    const spoken = new Set(messages.map((message) => message.id));
    takeAnchored((notice) => notice.afterMessageId !== null && spoken.has(notice.afterMessageId));
  }
  for (const notice of pending) {
    rows.push(noticeRow(notice));
  }
  return rows;
}
