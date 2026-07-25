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
import { buildLineIndex, type SelRange, spanToRange, type TextRange } from "./text-position";

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

  const edits: OffsetEdit[] = [];
  const spans: SelRange[] = [];
  for (const range of input.selection) {
    const before = text.slice(Math.max(0, range.from - m), range.from);
    const after = text.slice(range.to, Math.min(text.length, range.to + m));
    if (before === mark && after === mark) {
      // Strip the flanking pair; both ends shift left by the removed leading mark.
      edits.push({ from: range.from - m, to: range.from, text: "" });
      edits.push({ from: range.to, to: range.to + m, text: "" });
      spans.push({ from: range.from - m, to: range.to - m });
      continue;
    }
    // Insert the pair; both ends shift right by the leading mark, which — for an
    // empty range — leaves the caret BETWEEN the two inserted marks.
    edits.push({ from: range.from, to: range.from, text: mark });
    edits.push({ from: range.to, to: range.to, text: mark });
    spans.push({ from: range.from + m, to: range.to + m });
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
