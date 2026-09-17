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
  overscan?: number;
  minimum?: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The window a column at this scroll offset needs.
 *
 * Grows to {@link COLUMN_WINDOW_MINIMUM} by extending DOWNWARD first and only
 * then upward, because a column is read from the top: when the minimum is what
 * is binding, the rows a reader is about to reach matter more than the ones
 * they have already passed.
 */
export function columnWindow({
  count,
  scrollTop,
  viewportHeight,
  rowStride,
  overscan = COLUMN_WINDOW_OVERSCAN,
  minimum = COLUMN_WINDOW_MINIMUM,
}: ColumnWindowInput): ColumnWindow {
  if (count <= minimum) return { first: 0, last: count };
  // A non-finite or non-positive stride is a column that has not been measured
  // yet, never a reason to divide by zero.
  const stride = Number.isFinite(rowStride) && rowStride > 0 ? rowStride : COLUMN_ROW_STRIDE_FALLBACK;
  const top = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  let first = clamp(Math.floor(top / stride) - overscan, 0, count);
  let last = clamp(Math.ceil((top + height) / stride) + overscan, first, count);
  if (last - first < minimum) last = Math.min(count, first + minimum);
  if (last - first < minimum) first = Math.max(0, last - minimum);
  return { first, last };
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
 * The measured stride for a column, or `null` when there is nothing to learn.
 *
 * Averaged over the mounted rows rather than taken from the first one: cards
 * are one or two title lines tall and may or may not carry a label row, so any
 * single card is the wrong estimate for its neighbours. The spacers this feeds
 * decide the column's scroll range, and a range that disagrees with the
 * content is what makes a windowed list feel like it is sliding under the
 * hand — so it is re-derived from whatever is mounted on every commit, and
 * adopted only when it has actually moved (below).
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
