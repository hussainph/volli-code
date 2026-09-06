import type { UIMessage } from "ai";
import type { TranscriptCompaction, TranscriptReasoningDrop } from "./transcript";

/** What the transcript draws, in durable order. */
export type TranscriptRow =
  | { kind: "turn"; messages: readonly UIMessage[] }
  | { kind: "compaction"; compaction: TranscriptCompaction }
  | { kind: "reasoning-drop"; drop: TranscriptReasoningDrop };

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
    };

/**
 * Lays each durable context notice beside the Turn it followed.
 *
 * Notice lists are already ordered on their own. They are joined by durable
 * Session Event sequence before they are anchored, so different notice kinds
 * cannot overtake each other. A missing anchor places the notice at the end
 * rather than hiding a fact the Session recorded.
 */
export function weaveContextNotices(
  turns: readonly (readonly UIMessage[])[],
  compactions: readonly TranscriptCompaction[],
  reasoningDrops: readonly TranscriptReasoningDrop[],
): readonly TranscriptRow[] {
  const pending: AnchoredContextNotice[] = [
    ...compactions.map((value) => ({
      kind: "compaction" as const,
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
  if (pending.length === 0) return turns.map((messages) => ({ kind: "turn", messages }));

  const rows: TranscriptRow[] = [];
  const takeAnchored = (claims: (notice: AnchoredContextNotice) => boolean) => {
    while (pending.length > 0 && claims(pending[0]!)) {
      const notice = pending.shift()!;
      rows.push(
        notice.kind === "compaction"
          ? { kind: "compaction", compaction: notice.value }
          : { kind: "reasoning-drop", drop: notice.value },
      );
    }
  };

  takeAnchored((notice) => notice.afterMessageId === null);
  for (const messages of turns) {
    rows.push({ kind: "turn", messages });
    const spoken = new Set(messages.map((message) => message.id));
    takeAnchored((notice) => notice.afterMessageId !== null && spoken.has(notice.afterMessageId));
  }
  for (const notice of pending) {
    rows.push(
      notice.kind === "compaction"
        ? { kind: "compaction", compaction: notice.value }
        : { kind: "reasoning-drop", drop: notice.value },
    );
  }
  return rows;
}
