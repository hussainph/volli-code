/**
 * The overlay scroll thumb's arithmetic, kept apart from the DOM so it can be
 * tested on numbers: how long the thumb is, where it sits, and how a drag maps
 * back onto the content.
 *
 * Two coordinate spaces meet here. The scroller's sizes (`clientHeight`,
 * `scrollHeight`, `scrollTop`) are in its own CSS px; the track is drawn in
 * the viewport, where an ancestor's CSS `zoom` (the app's UI scale) or a
 * transform (a menu's open animation) scales the box. `scale` converts the
 * first to the second, so the track spans the box as drawn and a pointer
 * pixel maps onto the right amount of content.
 */

/** Gap between the thumb's track and the scroller's edges, on every side, in viewport px. */
export const TRACK_INSET = 2;

/**
 * The pill's thickness, and how far in from the scroller's far edge it is drawn
 * by default. A subtree can draw its thumbs further in with the inherited
 * `--scroll-thumb-edge-inset` (the sidebar does, to clear its resize grip).
 */
export const THUMB_THICKNESS = 4;
export const THUMB_EDGE_INSET = 3;
export const EDGE_INSET_PROPERTY = "--scroll-thumb-edge-inset";

/** A very long list would shrink a proportional thumb to nothing; this is the floor. */
export const THUMB_MIN_LENGTH = 20;

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

/** The track's length for a box drawn `visualSize` long: the box less its two insets. */
export function trackLength(visualSize: number): number {
  return Math.max(0, visualSize - TRACK_INSET * 2);
}

/**
 * The fraction of the track the thumb fills, in (0, 1]. `1` means there is
 * nothing to scroll. The floor is in drawn px, so it holds at any zoom.
 */
export function thumbRatio(clientSize: number, scrollSize: number, track: number): number {
  if (!overflows(clientSize, scrollSize) || track <= 0) return 1;
  return Math.min(1, Math.max(clientSize / scrollSize, THUMB_MIN_LENGTH / track));
}

/** One axis of a scroller, as measured. */
export interface LaneInput {
  /** `clientHeight`/`clientWidth`, in the scroller's CSS px. */
  clientSize: number;
  /** `scrollHeight`/`scrollWidth`, likewise. */
  scrollSize: number;
  /** `scrollTop`/`|scrollLeft|`, likewise. */
  scrollPos: number;
  /** Viewport px per scroller px: the drawn box over its layout size. */
  scale: number;
}

/** Where the thumb goes. Lengths in viewport px except `range`, which is content px. */
export interface LaneMetrics {
  overflow: boolean;
  track: number;
  length: number;
  /** How far the thumb can move: the track less the thumb. */
  travel: number;
  /** The thumb's distance from the track's start. */
  offset: number;
  /** How far the content can scroll. */
  range: number;
}

export function laneMetrics({ clientSize, scrollSize, scrollPos, scale }: LaneInput): LaneMetrics {
  const track = trackLength(clientSize * (scale > 0 ? scale : 1));
  const ratio = thumbRatio(clientSize, scrollSize, track);
  const length = track * ratio;
  const travel = track - length;
  const range = Math.max(0, scrollSize - clientSize);
  const progress = range > 0 ? Math.min(1, Math.max(0, scrollPos / range)) : 0;
  return {
    overflow: overflows(clientSize, scrollSize),
    track,
    length,
    travel,
    offset: progress * travel,
    range,
  };
}

/**
 * The scroll position for a thumb `offset` along its `travel`, clamped. A drag
 * keeps the thumb's offset (where the pointer put it) and asks this for the
 * scroll each time either it or the content's range changes, so a drag held at
 * the end stays at the end while content grows.
 */
export function scrollForOffset(offset: number, travel: number, range: number): number {
  if (travel <= 0 || range <= 0) return 0;
  return (Math.min(travel, Math.max(0, offset)) / travel) * range;
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
export function inThumbLane(
  box: Box,
  axis: "x" | "y",
  x: number,
  y: number,
  lane: number = THUMB_LANE,
): boolean {
  if (axis === "y") {
    return x <= box.right && x >= box.right - lane && y >= box.top && y <= box.bottom;
  }
  return y <= box.bottom && y >= box.bottom - lane && x >= box.left && x <= box.right;
}

/**
 * The lane for a pill drawn `edgeInset` in from the edge: everything from the
 * edge to a pixel past the pill. {@link THUMB_LANE} at the default inset.
 */
export function laneWidth(edgeInset: number): number {
  return edgeInset + THUMB_THICKNESS + 1;
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
  lane: number = THUMB_LANE,
): boolean {
  if (!inThumbLane(scroller, axis, x, y, lane)) return false;
  return axis === "y" ? y >= thumb.top && y <= thumb.bottom : x >= thumb.left && x <= thumb.right;
}
