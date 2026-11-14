/**
 * Whether the transcript follows a streaming reply, decided by the reader's
 * own scrolls (VC-1234).
 *
 * THE RULE
 *
 * - A scroll that brings the reader nearer the end and leaves them within
 *   {@link FOLLOW_ZONE_PX} of it turns following on. That covers the wheel, the
 *   keyboard, a drag of the scroll thumb, and anything else that moves them.
 * - A scroll the reader makes away from the end turns following off at once,
 *   and it stays off while the reply grows.
 * - Nothing else changes it. Content growing below, the browser's scroll
 *   anchoring, and the library's own writes all leave it as it is.
 *
 * WHY IT IS OURS
 *
 * `use-stick-to-bottom` 1.1.6 has the same rule in `handleScroll`, but it
 * throws away every scroll event that lands while its ResizeObserver's
 * `resizeDifference` is set. When the content changes height in a frame, the
 * observer reports after that frame's layout and sets the difference. The
 * scroll event was dispatched earlier in the same frame, and its one-
 * millisecond timer runs after the observer. The reset waits for the next
 * frame's animation callback plus another millisecond.
 *
 * So the library discards a scroll in the frame where the reply adds a line,
 * and one in the frame after. It is not a coin toss between timers: it is
 * decided by the frame. Measured in the lab with a fast stream, it discarded:
 *
 * - an arrival in the zone: the reader is at the end but not following, and
 *   the reply runs on below the fold;
 * - an ArrowUp, PageUp or thumb drag away from the end, in roughly a quarter of
 *   presses: never released, so the next line pulled the reader back to the
 *   end.
 *
 * The wheel up was never lost, because the library releases on the `wheel`
 * event itself.
 *
 * Here geometry decides instead of the frame. Comparing where two consecutive
 * scroll events leave the reader:
 *
 * - Growth below the reader only ever adds distance to the end, and anchoring
 *   keeps that distance as it is. So distance to the end that SHRANK between
 *   two scroll events is the reader moving toward the end.
 * - A `scrollTop` that GREW is the library's own reading of the same move.
 *   Either one, landing in the zone, is an arrival.
 * - Moving away is told apart from anchoring by the hand behind it, not by
 *   geometry. While a reply streams, anchoring can lower `scrollTop` as content
 *   above shrinks, in the same frame as growth below adds distance, which is
 *   exactly what a scroll up looks like (VC-1232). So a release needs the
 *   reader's hand on the transcript too: a scrolling key, a grab of the
 *   scroll thumb, or a touch.
 *
 * Pure, so the node test project reaches every branch. The listeners that
 * feed it are `useReaderFollowing` in `conversation.tsx`.
 */

/**
 * How close to the end counts as at the end: `use-stick-to-bottom`'s own
 * `STICK_TO_BOTTOM_OFFSET_PX`, which also re-locks a reader this close when the
 * content shrinks. The transcript's held-row fill (VC-1226) waits while the
 * reader is inside it.
 */
export const FOLLOW_ZONE_PX = 70;

/** Smaller moves are sub-pixel rounding, not a scroll. */
const MOVED_PX = 0.5;

/** What a scroll event is read from: the transcript's scroll element. */
export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Where one scroll event leaves the reader. */
export interface ScrollPlace {
  readonly top: number;
  /** Pixels from the reader's view to the end of the transcript. */
  readonly fromEnd: number;
}

export function scrollPlace(geometry: ScrollGeometry): ScrollPlace {
  return {
    top: geometry.scrollTop,
    fromEnd: geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop,
  };
}

export type FollowingChange = "follow" | "release" | null;

/**
 * The reader's hand on the transcript: none, a scrolling key or a lifted drag
 * moments ago, or a thumb drag or touch still held.
 */
export type ReaderHand = "none" | "recent" | "holding";

/**
 * What one scroll event means for following, given where the previous scroll
 * event left the reader and their hand. `null` is no change.
 *
 * A thumb held still is the one place `scrollTop` grows with no move toward
 * the end. The drag keeps the thumb's share of the scroll range as the reply
 * lengthens (VC-1217), so while a hand holds it only a shorter distance to the
 * end counts as nearer.
 */
export function followingAfterScroll(
  previous: ScrollPlace,
  current: ScrollPlace,
  hand: ReaderHand,
): FollowingChange {
  const nearer =
    current.fromEnd < previous.fromEnd - MOVED_PX ||
    (hand !== "holding" && current.top > previous.top + MOVED_PX);
  if (nearer) return current.fromEnd <= FOLLOW_ZONE_PX ? "follow" : null;
  const away =
    current.top < previous.top - MOVED_PX && current.fromEnd > previous.fromEnd + MOVED_PX;
  return hand !== "none" && away ? "release" : null;
}

/** A key press, as far as scrolling is concerned. */
export interface ScrollKey {
  readonly key: string;
  readonly shiftKey: boolean;
  /** It types into a field: a text input, a textarea or editable content. */
  readonly inTextEntry: boolean;
  /** It lands on a control that Space would activate: a button, a link. */
  readonly onControl: boolean;
}

/** Whether a key press, when it scrolls the transcript at all, scrolls it toward the start. */
export function keyScrollsUp(press: ScrollKey): boolean {
  if (press.inTextEntry) return false;
  if (press.key === " ") return press.shiftKey && !press.onControl;
  return press.key === "ArrowUp" || press.key === "PageUp" || press.key === "Home";
}
