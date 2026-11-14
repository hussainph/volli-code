/**
 * Whether the transcript follows a streaming reply, decided by the reader's
 * own scrolls (VC-1234).
 *
 * THE RULE
 *
 * - A scroll that brings the reader nearer the end and leaves them within
 *   {@link FOLLOW_ZONE_PX} of it turns following on. That covers the wheel, the
 *   keyboard, a drag of the scroll thumb, and a scroll no input announces.
 * - A scroll the reader's hand makes away from the end turns following off at
 *   once, and it stays off while the reply grows. The hand is a wheel, a key,
 *   a touch, the scroll thumb or a pointer held in the transcript (selecting).
 * - Nothing else changes it. Content growing above or below, the browser's
 *   scroll anchoring, rows the transcript window swaps, and the library's own
 *   writes all leave following as it was. A release the library makes with no
 *   hand behind it is undone.
 * - A pointer held in the transcript never turns following on: a reader
 *   selecting text is not captured when the selection auto-scrolls. Nor does
 *   the scroll that follows the transcript letting go for the reader (a jump
 *   to a message, a reading place put back).
 *
 * The rule never compares a scroll event with one the library wrote itself:
 * when a write and a step of the reader's land in one event, the step starts
 * at the write ({@link placeBefore}).
 *
 * WHY IT IS OURS
 *
 * `use-stick-to-bottom` 1.1.6 has the same rule in `handleScroll`, and three
 * things undo it:
 *
 * - It throws away every scroll event that lands while its ResizeObserver's
 *   `resizeDifference` is set. When the content changes height in a frame, the
 *   observer reports after that frame's layout; the scroll event was
 *   dispatched earlier in the frame, and its one-millisecond timer runs after
 *   the observer. The reset waits for the next frame's animation callback plus
 *   another millisecond. So a scroll in the frame where the reply adds a line,
 *   or the frame after, is lost: an arrival is not followed, a key or thumb
 *   step up is not released and the next line pulls the reader back.
 * - It reads any drop in `scrollTop` it does not discard as the reader leaving,
 *   anchoring included. A turn start adds a row at the end while the window
 *   drops one of the same height from the top: the height does not change, the
 *   observer stays quiet, anchoring lowers `scrollTop` by the row, and the
 *   library lets go of a reader who did nothing.
 * - Its own writes and a reader's step land in one scroll event, which it
 *   corrects for and a naive comparison does not (`ignoreScrollToTop`).
 *
 * Here the reader's hand and geometry decide, not the frame. Between two
 * scroll events:
 *
 * - Growth below the reader only ever adds distance to the end, and anchoring
 *   keeps that distance as it is. So distance to the end that SHRANK is the
 *   reader moving toward the end, whatever moved them.
 * - Under a wheel or key that scrolls toward the end, a `scrollTop` that grew
 *   counts too: a small step taken in the frame a line lands.
 * - Moving away needs a hand that is not going down: `scrollTop` fell and the
 *   distance grew. Without a hand that is anchoring and a line in one frame,
 *   which looks exactly like a scroll up (VC-1232).
 * - The thumb keeps its share of the scroll range as the reply lengthens
 *   (VC-1217), which moves `scrollTop` and the distance with nobody moving.
 *   Under the thumb that share tells a move away; a drag follows when it
 *   reaches the end, or when it lets go within the zone having brought the
 *   thumb down ({@link followingOnLift}).
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

/**
 * Within this many pixels of the end is the end itself: where a thumb taken
 * all the way down puts the reader, and where the library's following keeps
 * them (`scrollHeight - 1 - clientHeight`). Its zone is measured from there.
 */
const AT_END_PX = 1;

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

/** Within the follow zone, measured as the library measures it. */
function inZone(place: ScrollPlace): boolean {
  return place.fromEnd - AT_END_PX <= FOLLOW_ZONE_PX;
}

/**
 * Where the reader was before this scroll event. The library marks each write
 * of its own with `ignoreScrollToTop`; when this event's position is not that
 * write, the write and a step of the reader's landed in one event, and the
 * write is where the step started. Measured against today's geometry.
 */
export function placeBefore(
  previous: ScrollPlace,
  libraryWrite: number | undefined,
  geometry: ScrollGeometry,
): ScrollPlace {
  if (libraryWrite === undefined || libraryWrite === geometry.scrollTop) return previous;
  // Read field by field: the scroller's geometry is getters on its prototype,
  // which a spread would not copy.
  return scrollPlace({
    scrollTop: libraryWrite,
    scrollHeight: geometry.scrollHeight,
    clientHeight: geometry.clientHeight,
  });
}

export type FollowingChange = "follow" | "release" | null;

/**
 * The reader's hand on the transcript.
 *
 * - `down`, `up`: a wheel or a key that scrolls toward the end or the start,
 *   moments ago.
 * - `direct`: a touch, or a key that moves the view either way (Tab).
 * - `select`: a pointer pressed in the transcript and held, or just lifted.
 * - `thumb`: a drag of the scroll thumb, held or lifted moments ago.
 * - `app`: the transcript let go itself, for the reader, moments ago: a
 *   disclosure opened, a jump to a message, a reading place put back
 *   (`useStopFollowing`). The writes that follow are its, not an arrival.
 */
export type ReaderHand = "none" | "down" | "up" | "direct" | "select" | "thumb" | "app";

/**
 * How far, in pixels, the thumb moved toward the end between two places: the
 * change in its share of the scroll range, in today's pixels. Negative is away.
 */
function thumbTowardEnd(previous: ScrollPlace, current: ScrollPlace): number {
  const range = previous.top + previous.fromEnd;
  const share = range > 0 ? previous.top / range : 0;
  return current.top - share * (current.top + current.fromEnd);
}

/** Whether a scroll event under the thumb moved it, rather than the thumb keeping its place. */
export function thumbMoved(previous: ScrollPlace, current: ScrollPlace): boolean {
  return Math.abs(thumbTowardEnd(previous, current)) > MOVED_PX;
}

/**
 * What one scroll event means for following, given where the reader was
 * before it ({@link placeBefore}) and their hand. `null` is no change.
 */
export function followingAfterScroll(
  previous: ScrollPlace,
  current: ScrollPlace,
  hand: ReaderHand,
): FollowingChange {
  if (hand === "thumb") {
    const moved = thumbTowardEnd(previous, current);
    if (current.fromEnd <= AT_END_PX && moved > MOVED_PX) return "follow";
    return moved < -MOVED_PX ? "release" : null;
  }
  const nearer = previous.fromEnd - current.fromEnd > MOVED_PX;
  const rose = current.top > previous.top + MOVED_PX;
  const away =
    current.top < previous.top - MOVED_PX && current.fromEnd > previous.fromEnd + MOVED_PX;
  switch (hand) {
    case "none":
      return nearer && inZone(current) ? "follow" : null;
    case "down":
      return (nearer || rose) && inZone(current) ? "follow" : null;
    case "up":
    case "direct":
      if (nearer) return inZone(current) ? "follow" : null;
      return away ? "release" : null;
    case "select":
    case "app":
      return away ? "release" : null;
  }
}

/**
 * What a thumb drag means for following when it lets go. `grabbed` is where it
 * was grabbed, `moved` where a scroll event last saw the reader move it, and
 * `lifted` the scroller as it lets go. That includes the drag's last write,
 * whose scroll event only comes a frame later, and any growth since the last
 * move. A drag that brought the thumb down and stopped within the zone follows;
 * one that took it up stays released.
 */
export function followingOnLift(
  grabbed: ScrollPlace,
  moved: ScrollPlace,
  lifted: ScrollPlace,
): FollowingChange {
  const down = thumbTowardEnd(grabbed, lifted) > MOVED_PX;
  return down && (inZone(moved) || inZone(lifted)) ? "follow" : null;
}

/** One scroll event's judgement, waiting for the library's own. */
export interface PendingJudgement {
  readonly change: FollowingChange;
  readonly hand: ReaderHand;
  /** The library's state when the event arrived. */
  readonly wasFollowing: boolean;
}

/**
 * Folds a newer scroll event's judgement into one still waiting. Only one
 * waits: the newest event's timer runs after the library has judged every
 * event before it. A newer event's decision wins; an event that decided
 * nothing leaves the older decision standing, so a held thumb keeping its
 * place cannot undo an arrival the moment before. Whether the library was
 * following is kept from the first waiting event, the state none of them had
 * changed yet.
 */
export function foldJudgement(
  waiting: PendingJudgement | null,
  next: PendingJudgement,
): PendingJudgement {
  if (waiting === null) return next;
  return {
    change: next.change ?? waiting.change,
    hand: next.hand,
    wasFollowing: waiting.wasFollowing,
  };
}

/**
 * What to make true once the library has judged the same scroll events, which
 * it does a millisecond after each.
 *
 * - An arrival the library discarded is followed; a release it undid is
 *   released again.
 * - A release the library made by itself stands only if a hand that can
 *   leave was on the transcript. With no hand, or a hand going down, it was
 *   anchoring or a row swap read as the reader leaving: following comes back.
 * - A re-attach the library made by itself stands with no hand (its re-lock
 *   near the end when content shrinks) or a hand going down. Under any other
 *   hand it is undone: the library re-attaches on any rise in `scrollTop` near
 *   the end, which a thumb keeping its place makes with no move at all.
 */
export function followingSettled(
  input: PendingJudgement & {
    /** The library's state now. */
    readonly following: boolean;
  },
): FollowingChange {
  const { change, hand, wasFollowing, following } = input;
  if (change === "follow") return following ? null : "follow";
  if (change === "release") return following ? "release" : null;
  const handLeaves = hand !== "none" && hand !== "down";
  if (wasFollowing && !following) return handLeaves ? null : "follow";
  if (!wasFollowing && following) return handLeaves ? "release" : null;
  return null;
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

const KEYS_UP = new Set(["ArrowUp", "PageUp", "Home"]);
const KEYS_DOWN = new Set(["ArrowDown", "PageDown", "End"]);

/** The hand a key press puts on the transcript, when it can scroll it at all. */
export function keyHand(press: ScrollKey): ReaderHand {
  if (press.inTextEntry) return "none";
  if (press.key === " ") {
    if (press.onControl) return "none";
    return press.shiftKey ? "up" : "down";
  }
  if (KEYS_UP.has(press.key)) return "up";
  if (KEYS_DOWN.has(press.key)) return "down";
  // Focus moving to a control scrolls it into view, either way.
  return press.key === "Tab" ? "direct" : "none";
}

/** The hand a wheel event puts on the transcript. */
export function wheelHand(deltaY: number): ReaderHand {
  if (deltaY > 0) return "down";
  return deltaY < 0 ? "up" : "none";
}
