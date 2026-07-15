/**
 * Pure range/selection geometry for the live-preview decoration layer
 * (Obsidian-style reveal). Extracted from the CodeMirror plugin so the "when
 * does a node's syntax reveal?" rule is unit-testable without a DOM or an
 * editor instance.
 *
 * The rule, everywhere: a node's formatting marks are hidden until the
 * selection (cursor or range) *touches* the node — for inline nodes that means
 * the node's own [from, to] span; for block nodes it means the block's line
 * span. "Touch" is inclusive of both endpoints, so a bare cursor sitting right
 * against a delimiter counts as inside (this is what makes the marks appear the
 * instant the caret lands next to them, exactly like Obsidian).
 */

/** A single selection range, normalized so `from <= to`. */
export interface SelRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Whether spans [aFrom, aTo] and [bFrom, bTo] overlap or touch. Endpoints are
 * inclusive: adjacency (aTo === bFrom) counts as intersecting, so a zero-width
 * cursor at a node boundary is treated as inside that node.
 */
export function intersects(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

/** Whether any selection range touches the span [from, to] (inclusive). */
export function selectionTouches(
  selection: readonly SelRange[],
  from: number,
  to: number,
): boolean {
  for (const range of selection) {
    if (intersects(range.from, range.to, from, to)) return true;
  }
  return false;
}
