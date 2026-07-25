/**
 * ⌘B / ⌘I emphasis wrapping, as a plan a Monaco editor can apply.
 *
 * This restores CodeMirror-era behaviour: the live-preview keymap bound `Mod-b`
 * to `**bold**` and `Mod-i` to `*italic*` through a pure `wrapTransaction`, and
 * the Document Mode migration dropped both bindings (issue #107). The rule is
 * unchanged; only the coordinate system it speaks is.
 *
 * It is a pure module for the same reason the rest of the engine is: renderer
 * tests run in Node with no DOM, so anything decided inside a live editor is
 * untestable. Everything that decides where the caret lands lives here; the
 * contribution's half is one `executeEdits` plus one `setSelections`.
 *
 * ## The caret rule
 *
 * An EMPTY range (a bare cursor) lands BETWEEN the two inserted marks (`**|**`),
 * so typing continues inside them rather than after both. A non-empty range
 * stays wrapped around the same text (`**|selected|**`) — the selection follows
 * the words, never the syntax. Stripping mirrors this, shifting both ends back
 * by the removed leading mark.
 *
 * ## Two coordinate systems, on purpose
 *
 * `edits` are ranges in the ORIGINAL document, because that is what
 * `executeEdits` takes: Monaco applies a batch of non-overlapping edits itself,
 * so no caller ever has to pre-shift them. `selections` are ranges in the
 * RESULTING document, because that is where the caret has to end up — and that
 * is the one place multi-cursor arithmetic is unavoidable, since every earlier
 * range's insert or strip moves a later one.
 */
import type { SelRange } from "./reveal";
import { buildLineIndex, spanToRange, type TextRange } from "./text-position";

/** The marks the two bindings toggle. The math below is length-generic. */
export type EmphasisMark = "**" | "*";

export interface EmphasisWrapInput {
  /** The document as it stands. */
  readonly text: string;
  /**
   * Every selection range, normalized (`from <= to`) and non-overlapping — which
   * is what Monaco's cursor collection guarantees. Order is irrelevant: the plan
   * comes back in the order given, whatever that is.
   */
  readonly selection: readonly SelRange[];
  readonly mark: EmphasisMark;
}

/** One edit, in original-document coordinates. Empty `text` strips the range. */
export interface EmphasisEdit {
  readonly range: TextRange;
  readonly text: string;
}

export interface EmphasisWrapPlan {
  /** Applied as one batch; safe to hand straight to `executeEdits`. */
  readonly edits: readonly EmphasisEdit[];
  /** Where each input range ends up, in resulting-document coordinates. */
  readonly selections: readonly TextRange[];
  /** The document after `edits` — the plan's own statement of what it does. */
  readonly text: string;
}

/** An edit in offsets, before it is turned into a Monaco range. */
interface OffsetEdit {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/**
 * Plan the toggle for every selection range. Each range is decided in isolation
 * against the original text, exactly as CodeMirror's `changeByRange` did.
 */
export function planEmphasisWrap(input: EmphasisWrapInput): EmphasisWrapPlan {
  const { text, mark } = input;
  const m = mark.length;

  // Decide each range against the ORIGINAL text, then walk them in document
  // order: `getSelections()` is primary-first, not sorted, and both the running
  // shift and the linear text build below need ascending positions to be right.
  const planned = input.selection.map((range, index) => planRange(text, range, mark, m, index));
  const ordered = planned.toSorted((a, b) => a.opening.from - b.opening.from);

  const edits: OffsetEdit[] = [];
  // Indexed by the range's position in the INPUT, so the answer comes back in
  // the order the caller asked — Monaco's first selection is its primary one.
  const spans: SelRange[] = Array.from<SelRange>({ length: planned.length });
  // How far the EARLIER ranges' edits have moved the rest of the document. Edits
  // keep original coordinates (Monaco re-bases the batch itself); resulting
  // positions do not, so this is the one running total the plan has to carry.
  let shift = 0;
  for (const item of ordered) {
    edits.push(item.opening, item.closing);
    spans[item.index] = { from: item.span.from + shift, to: item.span.to + shift };
    shift += item.delta;
  }

  const resulting = applyEdits(text, edits);
  const before = buildLineIndex(text);
  const after = buildLineIndex(resulting);
  return {
    edits: edits.map((edit) => ({
      range: spanToRange(before, edit.from, edit.to),
      text: edit.text,
    })),
    selections: spans.map((span) => spanToRange(after, span.from, span.to)),
    text: resulting,
  };
}

/** One range's decision, before the other ranges' shifts are folded in. */
interface RangePlan {
  /** Where this range sat in the input, so the answer keeps that order. */
  readonly index: number;
  readonly opening: OffsetEdit;
  readonly closing: OffsetEdit;
  /** Resulting span, shifted by this range's own edit only. */
  readonly span: SelRange;
  /** How much this range lengthens (insert) or shortens (strip) the document. */
  readonly delta: number;
}

/**
 * Toggle one range, decided in isolation against the original text — exactly as
 * CodeMirror's `changeByRange` decided each of its ranges.
 */
function planRange(
  text: string,
  range: SelRange,
  mark: string,
  m: number,
  index: number,
): RangePlan {
  const before = text.slice(Math.max(0, range.from - m), range.from);
  const after = text.slice(range.to, Math.min(text.length, range.to + m));
  if (before === mark && after === mark) {
    // Strip the flanking pair; both ends shift left by the removed leading mark.
    return {
      index,
      opening: { from: range.from - m, to: range.from, text: "" },
      closing: { from: range.to, to: range.to + m, text: "" },
      span: { from: range.from - m, to: range.to - m },
      delta: -2 * m,
    };
  }
  // Insert the pair; both ends shift right by the leading mark, which — for an
  // empty range — leaves the caret BETWEEN the two inserted marks.
  return {
    index,
    opening: { from: range.from, to: range.from, text: mark },
    closing: { from: range.to, to: range.to, text: mark },
    span: { from: range.from + m, to: range.to + m },
    delta: 2 * m,
  };
}

/** Apply ascending, non-overlapping offset edits in one linear pass. */
function applyEdits(text: string, edits: readonly OffsetEdit[]): string {
  let result = "";
  let cursor = 0;
  for (const edit of edits) {
    result += text.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  return result + text.slice(cursor);
}
