/**
 * Which slice of a board column is actually mounted (VC-316).
 *
 * `board-column.tsx` used to render one `TicketCard` per ticket with no bound
 * at all, and a card is not a cheap thing: each one is a dnd-kit `useSortable`
 * registration, a Radix context-menu root with its whole item tree built as
 * elements on every render, and two store subscriptions. At the owner's 391
 * tickets that is the board's whole mount cost, and the board is re-mounted
 * from scratch on every return from a Ticket.
 *
 * This module is the ARITHMETIC of the bound, deliberately separated from the
 * DOM: it takes a scroll offset and a viewport and answers which indices a
 * column has to hold. Everything here is a pure function of its input so the
 * rules that matter — a selected card is always mounted, a window never
 * shrinks mid-drag — are asserted directly rather than through a rendered
 * column and a fake ResizeObserver.
 *
 * The bound is on WHAT IS MOUNTED, never on what the column HOLDS. A column's
 * count badge, its filter results, its sort order and its `SortableContext`
 * item list all stay the complete list; only the cards between the spacers
 * change. That distinction is the whole safety argument for this feature.
 */

/** A half-open index range, `[first, last)`. */
export interface ColumnWindow {
  first: number;
  last: number;
}

/**
 * Rows kept mounted beyond each edge of the viewport.
 *
 * Six is about a screenful of a board card's height either way: enough that an
 * ordinary flick of the wheel never outruns the window between a scroll event
 * and the next paint, and small enough that the bound still means something on
 * a 2,000-card column.
 */
export const COLUMN_WINDOW_OVERSCAN = 6;

/**
 * The shortest window this ever produces, whatever the viewport says.
 *
 * A column measured before its first layout reports a zero-height viewport,
 * and a zero-height viewport would otherwise mount one card and leave the
 * scroller with nothing to give it a scroll range — a column that could never
 * grow out of its own first frame. It is also the floor that keeps every
 * board small enough to fit on a screen completely unwindowed, which is what
 * keeps the e2e board smokes (and any hand test on an ordinary project)
 * looking at exactly the DOM they looked at before.
 */
export const COLUMN_WINDOW_MINIMUM = 40;

/** A card's height plus the column's `gap-2`, used before anything is measured. */
export const COLUMN_ROW_STRIDE_FALLBACK = 84;

export interface ColumnWindowInput {
  /** Tickets the column holds — not the number it mounts. */
  count: number;
  scrollTop: number;
  viewportHeight: number;
  /** Measured average row height including the gap below it. */
  rowStride: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Clamp a candidate range into `[0, count]` and spend {@link
 * COLUMN_WINDOW_MINIMUM} on it — the tail both windows below end with.
 *
 * Shared rather than written twice because the two callers have to agree: one
 * decides what the SCROLLER asks for and the other what the RENDER may show,
 * and a column whose two answers disagreed would mount a different slice than
 * the one it had measured itself against.
 *
 * Extends DOWNWARD first and only then upward, because a column is read from
 * the top: when the minimum is what binds, the rows a reader is about to reach
 * matter more than the ones they have already passed.
 *
 * Both callers return early when `count <= COLUMN_WINDOW_MINIMUM`, so the
 * minimum is always satisfiable by the time this runs.
 */
function honourMinimum(candidateFirst: number, candidateLast: number, count: number): ColumnWindow {
  let first = clamp(candidateFirst, 0, count);
  let last = clamp(candidateLast, first, count);
  if (last - first < COLUMN_WINDOW_MINIMUM) last = Math.min(count, first + COLUMN_WINDOW_MINIMUM);
  if (last - first < COLUMN_WINDOW_MINIMUM) first = Math.max(0, last - COLUMN_WINDOW_MINIMUM);
  return { first, last };
}

/** The window a column at this scroll offset needs. */
export function columnWindow({
  count,
  scrollTop,
  viewportHeight,
  rowStride,
}: ColumnWindowInput): ColumnWindow {
  if (count <= COLUMN_WINDOW_MINIMUM) return { first: 0, last: count };
  // A non-finite or non-positive stride is a column that has not been measured
  // yet, never a reason to divide by zero.
  const stride =
    Number.isFinite(rowStride) && rowStride > 0 ? rowStride : COLUMN_ROW_STRIDE_FALLBACK;
  const top = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  return honourMinimum(
    Math.floor(top / stride) - COLUMN_WINDOW_OVERSCAN,
    Math.ceil((top + height) / stride) + COLUMN_WINDOW_OVERSCAN,
    count,
  );
}

/**
 * The window to actually RENDER, given the one tracked against the scroller and
 * the column's count right now.
 *
 * The tracked window is state, and state is always one commit behind the props
 * that moved: a drop grows `tickets` in the render that the effects only get to
 * correct afterwards. That gap is not cosmetic. It shipped as a real bug — a
 * multi-card drop rendered its destination column with the PRE-drop window, so
 * the cards that had just landed were not in the DOM when `board.tsx`'s layout
 * effect went looking for their slots to run the drop's FLIP animation, and the
 * flourish was silently skipped (`board-smoke.mjs` check 8.5).
 *
 * So the render heals itself rather than trusting the state: a column that fits
 * is whole THIS render, and a column that does not still mounts at least the
 * minimum. Same two rules as {@link columnWindow}, applied to a window that has
 * already been computed.
 */
export function boundedWindow(window: ColumnWindow, count: number): ColumnWindow {
  if (count <= COLUMN_WINDOW_MINIMUM) return { first: 0, last: count };
  return honourMinimum(window.first, window.last, count);
}

/**
 * The smallest window containing both — how a window is prevented from ever
 * shrinking while a drag is in flight.
 *
 * dnd-kit measures a droppable when it registers and keeps the rect in a map
 * the sorting strategy indexes by position. A card that UNMOUNTS mid-gesture
 * takes its rect out of that map underneath the strategy, and this board has
 * already been taken out once by measurement churn during a drag (the VC-221
 * `Maximum update depth exceeded` crash, recorded in `board-column.tsx`). So a
 * drag only ever ADDS to what is mounted: auto-scrolling toward an unmounted
 * card still brings it in, and nothing the gesture has already measured can go
 * away underneath it. The union is discarded on drop, when the scroll-derived
 * window takes over again.
 *
 * The cost of that rule is that ONE GESTURE CAN SUSPEND THE BOUND. A drag
 * carried the length of a ten-thousand-card column — by dnd-kit's
 * `KeyboardSensor`, which walks the sorted rects a step per arrow press, or by
 * a long pointer auto-scroll — mounts everything it passes and holds it until
 * the card lands. That is accepted rather than overlooked: the alternative is
 * unmounting a rect mid-gesture, which is the crash above, and the exposure is
 * one gesture long rather than the whole time the board is open. If it ever
 * needs bounding, bound it by RELEASING rects dnd-kit no longer indexes, not
 * by shrinking the window underneath it.
 */
export function mergeColumnWindows(a: ColumnWindow, b: ColumnWindow): ColumnWindow {
  return { first: Math.min(a.first, b.first), last: Math.max(a.last, b.last) };
}

/**
 * Where a column has to be scrolled for row `index` to be on screen, or `null`
 * when it already is.
 *
 * This is how a windowed column keeps the ticket's "selected-item visibility"
 * promise, and it is deliberately a SCROLL rather than a widened window. A
 * window widened to reach row 1,500 mounts fifteen hundred cards, which is the
 * cost this whole module exists to avoid — and it would still leave the card
 * off screen, so it would buy an `aria-pressed` node nobody can see. Scrolling
 * to it mounts it through the ordinary path and actually shows it.
 *
 * Centred rather than nudged to the nearest edge: a card arriving from a
 * selection made somewhere else on screen has no travel direction to preserve,
 * and the middle of the column is where it is easiest to find.
 */
export function scrollOffsetForRow({
  index,
  window,
  rowStride,
  viewportHeight,
  maxScrollTop,
}: {
  index: number;
  window: ColumnWindow;
  rowStride: number;
  viewportHeight: number;
  maxScrollTop: number;
}): number | null {
  if (index < 0) return null;
  if (index >= window.first && index < window.last) return null;
  const centred = index * rowStride - Math.max(0, viewportHeight - rowStride) / 2;
  return clamp(centred, 0, Math.max(0, maxScrollTop));
}

/**
 * The average stride over a set of card heights, or `null` when there is
 * nothing to learn.
 *
 * Averaged rather than taken from the first card: cards are one or two title
 * lines tall and may or may not carry a label row, so any single card is the
 * wrong estimate for its neighbours. The spacers this feeds decide the
 * column's scroll range, and a range that disagrees with the content is what
 * makes a windowed list feel like it is sliding under the hand. Which heights
 * to average is {@link learnRowStride}'s decision, not this one's — and it is
 * NOT the mounted slice alone.
 */
export function measuredRowStride(heights: readonly number[], gap: number): number | null {
  const usable = heights.filter((height) => Number.isFinite(height) && height > 0);
  if (usable.length === 0) return null;
  return usable.reduce((sum, height) => sum + height, 0) / usable.length + gap;
}

/**
 * Whether a newly measured stride is worth adopting.
 *
 * Every adoption is a state write, and this is measured in a layout effect on
 * every commit of a column that re-renders whenever anything on the board
 * moves. Without a deadband a column whose average card height wobbles by a
 * fraction of a pixel — which it does, because the mounted SET changes as you
 * scroll — would write state, re-render, re-measure and write again.
 */
export function shouldAdoptRowStride(current: number, next: number): boolean {
  return Math.abs(next - current) > 1;
}

/**
 * Record what the mounted cards measure in `ledger`, forget tickets the column
 * no longer holds, and answer the stride over every card the column has EVER
 * measured — never over the mounted slice alone (VC-451).
 *
 * The stride chooses the window, and the window chooses which cards are
 * mounted. An average over the mounted slice therefore made the stride a
 * function of the window it chose: with cards of mixed height one slice
 * measured 70.5 and its neighbour 68, and at a scroll offset where those two
 * strides named different windows, each measurement moved the window to the
 * other. Every hop was a layout-effect state write, so React nested them until
 * it threw #185 (`Maximum update depth exceeded`). A ledger answers the same
 * for a window it has already seen, so revisiting a window adopts nothing and
 * the chain stops.
 *
 * A height that is not a positive number is a card not laid out yet; it is
 * skipped rather than allowed to overwrite a real measurement. Mutates
 * `ledger`, which the caller owns for the life of the column; pruning to
 * `held` keeps it bounded by what the column holds.
 */
export function learnRowStride(
  ledger: Map<string, number>,
  measured: Iterable<readonly [id: string, height: number]>,
  held: { has(id: string): boolean },
  gap: number,
): number | null {
  for (const [id, height] of measured) {
    if (Number.isFinite(height) && height > 0) ledger.set(id, height);
  }
  for (const id of ledger.keys()) if (!held.has(id)) ledger.delete(id);
  return measuredRowStride([...ledger.values()], gap);
}

/** How {@link scrollOffsetInRows} reads the mounted cards, in DOM order. */
export interface MountedRows {
  /** How many cards are mounted. */
  count: number;
  /** Card `i`'s top and bottom edges, in the same coordinates as `fold`. */
  edgesAt(i: number): { top: number; bottom: number };
  /** Card `i`'s index in the column's FULL list, or `undefined` if it has none. */
  indexAt(i: number): number | undefined;
}

/**
 * Where the column is scrolled, in {@link columnWindow}'s own coordinates
 * (row × stride), read from the card actually at the top of the viewport
 * rather than divided out of `scrollTop` (VC-451).
 *
 * The two disagree whenever the spacers' estimate and the real cards do, and
 * the browser is what makes that matter. When a window change swaps a spacer
 * for real cards above the fold, Chromium's scroll anchoring moves `scrollTop`
 * to keep the card in view exactly where it was, and fires `scroll`. Divided
 * by the stride, that moved offset names a DIFFERENT row, so the window moved
 * again, anchoring moved `scrollTop` back, and the column re-rendered every
 * frame at rest with its top cards remounting too often to be picked up.
 * Anchoring holds the card in view still by definition, so reading THAT card
 * is a reading anchoring cannot move.
 *
 * Falls back to `rawScrollTop` when no mounted card is at the fold — a jump
 * that landed inside a spacer, or a column not laid out yet — the one case
 * where the estimate is all there is. A binary search, so a scroll event costs
 * a handful of edge reads; it relies on mounted cards being laid out top to
 * bottom in DOM order, which the column's slots are (the sortable transform
 * sits on each slot's child, never on the slot).
 */
export function scrollOffsetInRows({
  rawScrollTop,
  fold,
  rows,
  rowStride,
}: {
  rawScrollTop: number;
  /** The top edge of the column's viewport. */
  fold: number;
  rows: MountedRows;
  rowStride: number;
}): number {
  let low = 0;
  let high = rows.count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows.edgesAt(middle).bottom > fold) high = middle;
    else low = middle + 1;
  }
  // Every mounted card is above the fold: the fold is in the trailing spacer.
  if (low === rows.count) return rawScrollTop;
  const { top } = rows.edgesAt(low);
  // The first mounted card is below the fold: the fold is in the leading spacer.
  if (low === 0 && top > fold) return rawScrollTop;
  const index = rows.indexAt(low);
  if (index === undefined) return rawScrollTop;
  // Kept strictly inside the card's own row: a card taller than the stride,
  // scrolled most of the way past, must not read as the row after it.
  return index * rowStride + clamp(fold - top, 0, Math.max(0, rowStride - 1));
}
