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
 * decided by the frame. Measured in the lab with a fast stream, on main:
 *
 * - a thumb drag that stopped within the zone was left not following a third
 *   of the time. The thumb (VC-1217) writes in its own ResizeObserver
 *   callback, so its scroll events keep company with a line landing;
 * - an ArrowUp, PageUp, Home or thumb drag away from the end was pulled back
 *   to the end in about a quarter of presses.
 *
 * The wheel up was never lost, because the library releases on the `wheel`
 * event itself.
 *
 * Here geometry and the reader's hand decide, not the frame. Comparing where
 * two consecutive scroll events leave the reader:
 *
 * - Growth below the reader only ever adds distance to the end, and anchoring
 *   keeps that distance as it is. So distance to the end that SHRANK between
 *   two scroll events is the reader moving toward the end.
 * - With no hand on the transcript, a `scrollTop` that GREW counts too. That
 *   is the library's own reading, and it catches a small step down taken in
 *   the frame a line lands.
 * - A thumb keeps its share of the scroll range as the reply lengthens
 *   (VC-1217), which moves `scrollTop` and the distance to the end with
 *   nobody moving. Under the thumb, that share tells a move away; a drag
 *   follows when it reaches the end, or when it lets go within the zone
 *   having brought the thumb down.
 * - Moving away is told apart from anchoring by the hand behind it, not by
 *   geometry. While a reply streams, anchoring can lower `scrollTop` as content
 *   above shrinks, in the same frame as growth below adds distance, which is
 *   exactly what a scroll up looks like (VC-1232). So a release needs the
 *   reader's hand on the transcript too: a scrolling key, a grab of the
 *   scroll thumb, or a touch.
 *
 * The library still judges every scroll event as well, a millisecond later.
 * {@link followingSettled} says what to make true once it has: ours is the
 * last word.
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
 * The reader's hand on the transcript.
 *
 * - `direct`: a key that scrolls up, or a touch, held or lifted moments ago.
 *   It moves the content itself.
 * - `thumb`: a drag of the scroll thumb, held or lifted moments ago.
 */
export type ReaderHand = "none" | "direct" | "thumb";

/**
 * Within this many pixels of the end is the end itself: where a thumb taken
 * all the way down puts the reader, and where the library's own following
 * keeps them.
 */
const AT_END_PX = 1;

/**
 * How far, in pixels, the reader moved toward the end between two places: a
 * negative number is away from it. Under the thumb this is the change in the
 * thumb's share of the scroll range, in today's pixels.
 */
function towardEnd(previous: ScrollPlace, current: ScrollPlace, hand: ReaderHand): number {
  if (hand === "thumb") {
    const range = previous.top + previous.fromEnd;
    const share = range > 0 ? previous.top / range : 0;
    return current.top - share * (current.top + current.fromEnd);
  }
  return previous.fromEnd - current.fromEnd;
}

/**
 * What one scroll event means for following, given where the previous scroll
 * event left the reader and their hand. `null` is no change.
 *
 * Under the thumb only the end itself, or a move away, is decided here. A
 * thumb keeps its share of the scroll range as the reply lengthens (VC-1217),
 * and its scroll event can come after another event has already read the
 * longer range: `scrollTop` then rises with nobody moving, which no
 * comparison of two places can tell from a step down. Where a drag that stops
 * short of the end leaves the reader is decided when it lets go
 * ({@link followingOnLift}).
 */
export function followingAfterScroll(
  previous: ScrollPlace,
  current: ScrollPlace,
  hand: ReaderHand,
): FollowingChange {
  const moved = towardEnd(previous, current, hand);
  if (hand === "thumb") {
    if (current.fromEnd <= AT_END_PX && moved > MOVED_PX) return "follow";
    return moved < -MOVED_PX ? "release" : null;
  }
  const nearer = moved > MOVED_PX || (hand === "none" && current.top > previous.top + MOVED_PX);
  if (nearer) return current.fromEnd <= FOLLOW_ZONE_PX ? "follow" : null;
  if (hand === "none") return null;
  return current.top < previous.top - MOVED_PX && moved < -MOVED_PX ? "release" : null;
}

/** Whether a scroll event under the thumb moved it, rather than the thumb keeping its place. */
export function thumbMoved(previous: ScrollPlace, current: ScrollPlace): boolean {
  return Math.abs(towardEnd(previous, current, "thumb")) > MOVED_PX;
}

/**
 * What a thumb drag means for following when it lets go: grabbed at
 * `grabbed`, last moved to `rest`. A drag that brought the thumb down and
 * rested within the zone follows; one that took it up stays released.
 */
export function followingOnLift(grabbed: ScrollPlace, rest: ScrollPlace): FollowingChange {
  const down = towardEnd(grabbed, rest, "thumb") > MOVED_PX;
  return down && rest.fromEnd <= FOLLOW_ZONE_PX ? "follow" : null;
}

/**
 * What to make true once the library has judged the same scroll event, which
 * it does a millisecond after it. `wasFollowing` is the library's state when
 * the event arrived, `following` its state now.
 *
 * - An arrival the library discarded is followed.
 * - A release the library undid is released again.
 * - With a hand on the transcript, a move that was not toward the end does
 *   not re-attach. The library re-attaches on any rise in `scrollTop` near
 *   the end, which a thumb keeping its place makes with no move at all.
 * - With no hand, the library's own re-attach stands. That includes the
 *   re-lock near the end when content shrinks.
 */
export function followingSettled(input: {
  readonly change: FollowingChange;
  readonly hand: ReaderHand;
  readonly wasFollowing: boolean;
  readonly following: boolean;
}): FollowingChange {
  const { change, hand, wasFollowing, following } = input;
  if (change === "follow") return following ? null : "follow";
  if (change === "release") return following ? "release" : null;
  return hand !== "none" && !wasFollowing && following ? "release" : null;
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
