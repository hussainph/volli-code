import type { UIMessage } from "ai";
import { readHostNotice, type TranscriptHostNotice } from "./host-notice";
import type { TranscriptCompaction, TranscriptReasoningDrop } from "./transcript";

/** What every Session client draws from the portable transcript projection. */
export type TranscriptRow =
  | {
      kind: "turn";
      messages: readonly UIMessage[];
    }
  | { kind: "host-notice"; messageId: string; notice: TranscriptHostNotice }
  | { kind: "compaction"; compaction: TranscriptCompaction }
  | { kind: "reasoning-drop"; drop: TranscriptReasoningDrop };

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
    };

function noticeRow(notice: AnchoredContextNotice): TranscriptRow {
  switch (notice.kind) {
    case "compaction":
      return { kind: "compaction", compaction: notice.value };
    case "reasoning-drop":
      return { kind: "reasoning-drop", drop: notice.value };
  }
}

/**
 * Projects Turns and host-authored messages into rows, then lays durable
 * context notices beside the row they followed.
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
): readonly TranscriptRow[] {
  const turnRows = turns.map(rowFor);
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
