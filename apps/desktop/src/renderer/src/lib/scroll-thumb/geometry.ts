/**
 * The overlay scroll thumb's arithmetic, kept apart from the DOM so it can be
 * tested on numbers: how long the thumb is, where it sits, and how a drag maps
 * back onto the content.
 */

/** Gap between the thumb's track and the scroller's edges, on every side. */
export const TRACK_INSET = 2;

/** A very long list would shrink a proportional thumb to nothing; this is the floor. */
export const THUMB_MIN_LENGTH = 20;

/** The pill's thickness, and how far in from the scroller's far edge it is drawn. */
export const THUMB_THICKNESS = 4;
export const THUMB_EDGE_INSET = 3;

/**
 * How far in from the scroller's far edge a pointer counts as aiming at the
 * thumb: the lane brightens there and a press there can grab it. The pill is
 * {@link THUMB_THICKNESS} wide {@link THUMB_EDGE_INSET} in; the lane is the 8px
 * it is drawn over.
 */
export const THUMB_LANE = 8;

/** Sub-pixel scroll sizes would otherwise read as one pixel of overflow. */
const OVERFLOW_EPSILON = 1;

/** Whether content of `scrollSize` overflows a box of `clientSize`. */
export function overflows(clientSize: number, scrollSize: number): boolean {
  return scrollSize > clientSize + OVERFLOW_EPSILON;
}

/** The track's length for a scroller box of `clientSize`: the box less its two insets. */
export function trackLength(clientSize: number): number {
  return Math.max(0, clientSize - TRACK_INSET * 2);
}

/**
 * The fraction of the track the thumb fills, in (0, 1]. `1` means there is
 * nothing to scroll, and the track stays hidden.
 */
export function thumbRatio(clientSize: number, scrollSize: number): number {
  const track = trackLength(clientSize);
  if (!overflows(clientSize, scrollSize) || track <= 0) return 1;
  return Math.min(1, Math.max(clientSize / scrollSize, THUMB_MIN_LENGTH / track));
}

/**
 * How far along its track the thumb sits, in px from the track's start: the
 * scroll progress times the track less the thumb.
 */
export function thumbOffset(scroll: number, clientSize: number, scrollSize: number): number {
  const range = scrollSize - clientSize;
  if (range <= 0) return 0;
  const progress = Math.min(1, Math.max(0, scroll / range));
  return progress * trackLength(clientSize) * (1 - thumbRatio(clientSize, scrollSize));
}

/** What a drag measured at the press: every quantity is fixed for the gesture. */
export interface DragStart {
  /** Pointer coordinate on the scroll axis at the press. */
  pointer: number;
  /** `scrollTop`/`scrollLeft` at the press. */
  scroll: number;
  clientSize: number;
  scrollSize: number;
}

/**
 * The scroll position a drag to `pointer` asks for. The thumb travels the track
 * less its own length while the content travels its whole overflow, so a pixel
 * of pointer is `range / travel` pixels of content. Clamped to the range.
 */
export function dragScrollPosition(start: DragStart, pointer: number): number {
  const range = start.scrollSize - start.clientSize;
  const ratio = thumbRatio(start.clientSize, start.scrollSize);
  const travel = trackLength(start.clientSize) * (1 - ratio);
  if (range <= 0 || travel <= 0) return start.scroll;
  const next = start.scroll + ((pointer - start.pointer) * range) / travel;
  return Math.min(range, Math.max(0, next));
}

/** A box in viewport coordinates; `DOMRect` satisfies it. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Whether a pointer is in the scroller's thumb lane for `axis`: within
 * {@link THUMB_LANE} of the right edge for the vertical thumb, of the bottom
 * edge for the horizontal one, and inside the box along the other axis.
 */
export function inThumbLane(box: Box, axis: "x" | "y", x: number, y: number): boolean {
  if (axis === "y") {
    return x <= box.right && x >= box.right - THUMB_LANE && y >= box.top && y <= box.bottom;
  }
  return y <= box.bottom && y >= box.bottom - THUMB_LANE && x >= box.left && x <= box.right;
}

/**
 * Whether a press lands on the thumb: inside the lane and within the thumb's own
 * extent along the scroll axis. The lane, not the 4px pill, is the target, so
 * the grab is as forgiving as a native bar's.
 */
export function hitsThumb(
  scroller: Box,
  thumb: Box,
  axis: "x" | "y",
  x: number,
  y: number,
): boolean {
  if (!inThumbLane(scroller, axis, x, y)) return false;
  return axis === "y" ? y >= thumb.top && y <= thumb.bottom : x >= thumb.left && x <= thumb.right;
}
