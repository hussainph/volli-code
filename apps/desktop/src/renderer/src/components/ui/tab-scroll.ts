/**
 * The one mouse-wheel convention a horizontally overflowing tab strip owns.
 *
 * A trackpad's sideways gesture already supplies a dominant `deltaX`, which
 * the browser can scroll natively. A mouse wheel needs Shift held to say the
 * same thing — matching the board canvas without hijacking ordinary vertical
 * scrolling elsewhere in the workspace.
 */
export interface TabWheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly shiftKey: boolean;
}

export function tabWheelScrollDelta({ deltaX, deltaY, shiftKey }: TabWheelInput): number | null {
  if (!shiftKey || deltaY === 0 || Math.abs(deltaX) > Math.abs(deltaY)) return null;
  return deltaY;
}

/** The small DOM seam the strip's native wheel listener needs. */
export interface TabScrollport {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  scrollLeft: number;
}

export interface TabWheelEvent extends TabWheelInput {
  preventDefault(): void;
}

/**
 * Apply a Shift+wheel gesture only when tabs actually overflow.
 *
 * Returning whether the event was claimed keeps the boundary explicit: a
 * short strip and every non-horizontal intent remain the browser's to handle.
 */
export function scrollTabsWithWheel(scrollport: TabScrollport, event: TabWheelEvent): boolean {
  const delta = tabWheelScrollDelta(event);
  if (delta === null || scrollport.scrollWidth <= scrollport.clientWidth) return false;
  event.preventDefault();
  scrollport.scrollLeft += delta;
  return true;
}

/* ------------------------------------------------------- reaching a tab */

/**
 * How much of the strip is left showing past a revealed tab, in px (VC-288).
 *
 * A tab scrolled flush to the edge reads as the last one there is. Eight pixels
 * is a sliver of the neighbour's fill and its rounded corner — enough to say
 * "there is more this way" without being mistaken for a tab you could hit.
 */
export const TAB_REVEAL_INSET = 8;

/**
 * Fractional scroll offsets are real: at 125% and 150% zoom — the levels this
 * work is about — a browser hands back `scrollLeft` values like `599.6` for a
 * strip that is, to the eye and to the person, at its end. Comparing exactly
 * leaves a chevron lit that scrolls nowhere.
 */
const SCROLL_EPSILON = 1;

/** Where a tab sits inside the scroller's own content box. */
export interface TabBox {
  /** Offset from the content's left edge, NOT from the viewport's. */
  readonly left: number;
  readonly width: number;
}

/**
 * The `scrollLeft` that brings `tab` into view, or `null` where it already is.
 *
 * `null` rather than "the current value" on purpose: this runs from a layout
 * effect on every activation and every focus, and a write on each of those
 * would fight a person mid-drag of the strip. Nothing to do has to be sayable.
 *
 * A tab WIDER than the window cannot be whole in view, and the answer there is
 * its left edge — the end that carries the status dot and the start of the
 * label. It falls out of the arithmetic rather than being special-cased: the
 * left-clip branch is tested last and wins.
 */
export function tabScrollLeftFor(scrollport: TabScrollport, tab: TabBox): number | null {
  const max = Math.max(0, scrollport.scrollWidth - scrollport.clientWidth);
  const clamp = (at: number): number => Math.max(0, Math.min(max, at));
  const start = tab.left - TAB_REVEAL_INSET;
  const end = tab.left + tab.width + TAB_REVEAL_INSET - scrollport.clientWidth;
  // Right first, then left, so a tab too wide for the window lands on its
  // start: the right-clip answer scrolls past its left edge, and the left-clip
  // test then catches that and pulls it back.
  const next = scrollport.scrollLeft < end ? end : scrollport.scrollLeft;
  const at = clamp(next > start ? Math.min(next, start) : next);
  return at === scrollport.scrollLeft ? null : at;
}

/** Whether a strip overflows, and which of its ends is already in view. */
export interface TabOverflow {
  readonly overflowing: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

/**
 * What the edge affordances are drawn from: a strip that fits offers none, and
 * an end already in view offers no way to travel further into it.
 */
export function tabOverflow(scrollport: TabScrollport): TabOverflow {
  const max = scrollport.scrollWidth - scrollport.clientWidth;
  return {
    overflowing: max > SCROLL_EPSILON,
    atStart: scrollport.scrollLeft <= SCROLL_EPSILON,
    atEnd: scrollport.scrollLeft >= max - SCROLL_EPSILON,
  };
}

/**
 * Where one press of an edge affordance lands.
 *
 * Four fifths of a window rather than a whole one: a press that scrolled
 * exactly one window leaves no tab in common between the two views, which is
 * how a person loses their place in a list they were scanning. The overlap is
 * the same courtesy Page Down has always paid.
 */
export function tabScrollStep(scrollport: TabScrollport, towards: "prev" | "next"): number {
  const max = Math.max(0, scrollport.scrollWidth - scrollport.clientWidth);
  const travel = scrollport.clientWidth * 0.8;
  const at = towards === "next" ? scrollport.scrollLeft + travel : scrollport.scrollLeft - travel;
  return Math.max(0, Math.min(max, at));
}
