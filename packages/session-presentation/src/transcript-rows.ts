import type { UIMessage } from "ai";
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
      authorityReviews?: readonly TranscriptAuthorityReview[];
    }
  | { kind: "host-notice"; messageId: string; notice: TranscriptHostNotice }
  | { kind: "compaction"; compaction: TranscriptCompaction }
  | { kind: "reasoning-drop"; drop: TranscriptReasoningDrop }
  | { kind: "authority-review"; review: TranscriptAuthorityReview };

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
  const reviewsByCall = new Map<string, TranscriptAuthorityReview[]>();
  for (const review of authorityReviews) {
    const reviews = reviewsByCall.get(review.toolCallId) ?? [];
    reviews.push(review);
    reviewsByCall.set(review.toolCallId, reviews);
  }
  const linked = new Set<TranscriptAuthorityReview>();
  const turnRows = turns.map((messages) => {
    const row = rowFor(messages);
    if (row.kind !== "turn" || reviewsByCall.size === 0) return row;
    const reviews = messages.flatMap((message) =>
      message.parts.flatMap((part) => {
        if (!("toolCallId" in part) || typeof part.toolCallId !== "string") return [];
        return (reviewsByCall.get(part.toolCallId) ?? []).filter((review) => {
          if (linked.has(review)) return false;
          linked.add(review);
          return true;
        });
      }),
    );
    return reviews.length === 0 ? row : { ...row, authorityReviews: reviews };
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
