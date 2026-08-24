/**
 * The compaction boundary: where the transcript and the model stop agreeing.
 *
 * Nothing was hidden by a compaction. The transcript is folded from the Session
 * ledger and compaction never touched a ledger event — it changes only what the
 * runtime sends the provider — so every message is exactly where it was, and
 * there is no history here to expand back into view. What there IS, and what
 * this module exists to say, is a DIVERGENCE: from this point down, the model is
 * working from a summary of what is above rather than from the words themselves.
 * A person scrolling up after a compaction is reading a conversation their model
 * is no longer having, and until this row existed nothing on screen said so.
 *
 * Three decisions, because each is a place a second author would land elsewhere.
 *
 * **Only the measured count is drawn.** The durable event carries a before and
 * an after, and they are not the same kind of number: `tokensBefore` is the
 * provider's own accounting of the context it was holding, and `tokensAfter` is
 * a character heuristic over a context nothing has measured — nothing *can*
 * measure it until the model next answers. Drawn as `182k → 24k` those two read
 * as one before-and-after, and the reader would subtract them. So the after is
 * not drawn at all, here or anywhere. The hedge this app already owns (the `~`
 * in the context meter's split) would mark it honestly enough in isolation, but
 * not here: the meter sits a few hundred pixels below this row still reporting
 * the last MEASURED occupancy, which after a compaction is the pre-compaction
 * one until the next reply lands. An estimate beside it would be a second,
 * softer number for the same question, disagreeing with the measurement for
 * exactly as long as it was the only thing anyone had.
 *
 * **The reason is worth a phrase, not a word.** `CompactionReason` is closed and
 * its three members are three different stories — the window filled on its own,
 * the provider refused a turn outright, or a person typed `/compact`. A reader
 * debugging a Session wants to know which one they are in, and "threshold" is
 * the executor's word for it rather than theirs.
 *
 * **A failure is a record, not a boundary.** It divides nothing: the summary was
 * never written and the context is exactly as it was. So it earns a line and not
 * a rule, and it is on screen at all because the silence is what hurts — the
 * turn that paid for the attempt was delivered on the old context, and the
 * refusal that may follow reads as arbitrary unless something says the summary
 * was tried first.
 *
 * Pure over its arguments, like every other chat projection: the words and the
 * placement are testable without mounting a session.
 */
import type { CompactionReason } from "@volli/shared";
import type { UIMessage } from "ai";

import { formatTokens } from "./context-usage";
import type { TranscriptCompaction } from "./transcript";

/**
 * What the transcript draws, in order: the turns it always drew, and the
 * boundaries between them.
 *
 * A turn row carries the very array {@link weaveCompactionBoundaries} was
 * handed, never a copy — the turn list is held to its identity upstream so a
 * settled reply does not re-render every turn above it, and a copy here would
 * throw that away for every row on screen.
 */
export type TranscriptRow =
  | { kind: "turn"; messages: readonly UIMessage[] }
  | { kind: "compaction"; compaction: TranscriptCompaction };

/**
 * Lays each compaction into the turn list at the point it happened.
 *
 * A boundary goes after the whole turn its anchor message belongs to, never
 * inside one. Compaction genuinely can land mid-turn — the threshold path runs
 * at the head of a message and the overflow path runs after a refused reply —
 * but a turn is one utterance, and a rule drawn through the middle of one would
 * claim a seam the reader has no way to act on. The turn boundary is the
 * nearest place the division is legible.
 *
 * Total over anything the fold can hand it, which is the property that matters:
 * an anchor no turn claims (a message the projection dropped, a list already
 * scrolled past) still draws its boundary, at the end, rather than vanishing.
 * A compaction that reports itself is worth more misplaced than lost.
 */
export function weaveCompactionBoundaries(
  turns: readonly (readonly UIMessage[])[],
  compactions: readonly TranscriptCompaction[],
): readonly TranscriptRow[] {
  if (compactions.length === 0) return turns.map((messages) => ({ kind: "turn", messages }));

  const rows: TranscriptRow[] = [];
  // Consumed left to right. The fold appends in frame order, so this list is
  // already in the order the boundaries have to be drawn in.
  const pending = [...compactions];
  const takeAnchored = (claims: (compaction: TranscriptCompaction) => boolean) => {
    while (pending.length > 0 && claims(pending[0]!)) {
      rows.push({ kind: "compaction", compaction: pending.shift()! });
    }
  };

  // An unanchored compaction happened before anything had been said, so it can
  // only be a prefix: once a message has a position, no later anchor is null.
  takeAnchored((compaction) => compaction.afterMessageId === null);
  for (const messages of turns) {
    rows.push({ kind: "turn", messages });
    const spoken = new Set(messages.map((message) => message.id));
    takeAnchored(
      (compaction) => compaction.afterMessageId !== null && spoken.has(compaction.afterMessageId),
    );
  }
  for (const compaction of pending) rows.push({ kind: "compaction", compaction });
  return rows;
}

/**
 * What the boundary says, in the reader's words rather than the executor's.
 *
 * Split from the component so the phrasing is pinned by tests rather than by a
 * screenshot — this is the surface that has to stay in step with the context
 * meter's vocabulary, and drift in a string is drift nothing would catch.
 */
export interface CompactionBoundaryCopy {
  /** The row's claim, and the only thing on it set in the foreground ink. */
  headline: string;
  /** Why it happened, as one of three phrases. */
  reason: string;
  /**
   * What the context held before, formatted the way every other token count in
   * the app is. Null on a failure, which has no count to report and must not
   * borrow one.
   */
  before: string | null;
  /** The one line that explains what the reader is looking at. */
  note: string;
  /** The executor's own sanitized words, when it had any. Failures only. */
  detail: string | null;
  /** The whole row as one sentence, for assistive technology and for hover. */
  description: string;
}

/**
 * The closed vocabulary, spelled out. Three reasons, three sentences a person
 * would actually say — "threshold" is a rule's name, not an explanation.
 */
const REASON_PHRASE: Record<CompactionReason, string> = {
  threshold: "the window filled",
  overflow: "the provider refused this turn",
  manual: "you asked",
};

/**
 * What a compaction summarized is no longer sent as itself. Said in the
 * present tense because it is a standing fact about the Session, not something
 * that happened once — and about "older messages" rather than "everything
 * above", because a compaction keeps a tail of recent messages verbatim and
 * that tail is above this line too.
 */
const COMPACTED_NOTE =
  "Older messages above are no longer sent to the model; a summary of them is.";

/** The fact a failed attempt actually leaves behind: nothing moved. */
const FAILED_NOTE = "The context was left as it was.";

export function compactionBoundaryCopy(compaction: TranscriptCompaction): CompactionBoundaryCopy {
  const reason = REASON_PHRASE[compaction.reason];
  if (compaction.outcome === "failed") {
    // Empty counts as absent: a diagnostic carrying no text would otherwise
    // draw a blank line under the row, and the sentence would end mid-air.
    const detail = compaction.detail.trim() === "" ? null : compaction.detail;
    return {
      headline: "Compaction failed",
      reason,
      before: null,
      note: FAILED_NOTE,
      detail,
      description: sentence([`Compaction failed — ${reason}.`, FAILED_NOTE, detail]),
    };
  }
  const before = formatTokens(compaction.tokensBefore);
  return {
    headline: "Context compacted",
    reason,
    before: `${before} before`,
    note: COMPACTED_NOTE,
    detail: null,
    description: sentence([
      `Context compacted — ${reason}.`,
      COMPACTED_NOTE,
      `The context held ${before} tokens before.`,
    ]),
  };
}

function sentence(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(" ");
}
