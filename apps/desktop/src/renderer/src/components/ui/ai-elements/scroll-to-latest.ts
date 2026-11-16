/**
 * How "Scroll to latest" gets the reader to the end of the transcript (VC-1232).
 *
 * The button used to hand the trip to `use-stick-to-bottom`'s own spring, and
 * after a long read far up the chat that spring stopped tens of thousands of
 * pixels short. Two facts together did it:
 *
 * 1. Content above the reader changes height while the scroll passes it.
 *    Streamdown draws every code block with `content-visibility: auto` and a
 *    200px placeholder, so a block takes its real height the first time it is
 *    rendered, which is the frame the scroll passes it. Images, Mermaid and
 *    late highlighting do the same. The browser's scroll anchoring keeps the
 *    page still by lowering `scrollTop` by the change.
 * 2. The library reads that lowered `scrollTop` as the reader scrolling up and
 *    detaches (`handleScroll` 1.1.6: a scroll below the position it last wrote
 *    is an escape unless `resizeDifference` is still set, which is a race
 *    between two one-millisecond timers). A detached spring stops on its next
 *    frame, wherever it is.
 *
 * So the trip is ours. It is measured from the END, not from where it began:
 * each frame puts the reader at a share of the distance the end actually is
 * from them now. A change above the reader does not change that distance
 * (anchoring absorbs it), a change below them (a block resolving, a reply
 * streaming) is absorbed in proportion rather than as a jump, and the last
 * frame is the end as it stands at that frame. Nothing here can stop short,
 * because nothing here remembers a target.
 *
 * The motion is the shared critically damped spring (`--spring-smooth`,
 * {@link GLASS_MOTION.pin}): continuity, no overshoot, and a fixed 270ms
 * whatever the distance. Distance is capped instead: a trip longer than
 * {@link LATEST_GLIDE_SCREENS} screens starts that far from the end. At two
 * screens the fastest frame moves under half a screen, so the reader sees the
 * last of the conversation slide into place; a 200,000px trip in 270ms would
 * move a dozen screens a frame, which reads as nothing and lays out every
 * region it crosses. Keyboard activation and reduced motion arrive at once.
 *
 * Pure: the scroller and the clock are injected, so the node test project
 * reaches every branch.
 */
import { GLASS_MOTION, springSamples } from "@renderer/lib/glass-motion";

/** The longest trip that is animated, in heights of the transcript's viewport. */
export const LATEST_GLIDE_SCREENS = 2;

/**
 * How far from the end the motion starts: the whole distance when it is short,
 * the last {@link LATEST_GLIDE_SCREENS} screens when it is long, and 0 (arrive
 * at once) for an instant trip, an unmeasured viewport or nothing to travel.
 */
export function latestGlideStart(distance: number, viewport: number, instant: boolean): number {
  if (instant || !(distance > 0) || !(viewport > 0)) return 0;
  return Math.min(distance, viewport * LATEST_GLIDE_SCREENS);
}

const SPRING = springSamples("pin");

/** The share of the trip covered `elapsed` ms in: 0 at the start, exactly 1 at its end. */
export function latestGlideProgress(elapsed: number): number {
  if (!(elapsed > 0)) return 0;
  if (elapsed >= GLASS_MOTION.pin) return 1;
  const at = (elapsed / GLASS_MOTION.pin) * (SPRING.length - 1);
  const index = Math.floor(at);
  const from = SPRING[index];
  const to = SPRING[index + 1];
  return from + (to - from) * (at - index);
}

/**
 * How far above the end to put the reader for progress `now`, given that they
 * are `live` pixels from it after progress `before`. The share of the trip
 * still left is scaled, not subtracted, so growth anywhere below the reader is
 * spread over the frames that remain, and progress 1 is the end.
 */
export function latestGlideStep(live: number, before: number, now: number): number {
  if (now >= 1 || before >= 1) return 0;
  return (Math.max(0, live) * (1 - now)) / (1 - before);
}

/** What the trip reads and writes on the transcript's scroll element. */
export interface LatestScroller {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  scrollTop: number;
}

/** Frames and time, injected for tests. */
export interface LatestClock {
  /** Run `callback` before the next paint. Returns a cancel. */
  frame(callback: () => void): () => void;
  now(): number;
}

const BROWSER_CLOCK: LatestClock = {
  frame: (callback) => {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  },
  now: () => performance.now(),
};

/**
 * Take the reader to the end of `scroller`, then call `arrive` on the frame
 * they are there. Starts on the next frame, so a commit made by the same press
 * (the transcript dropping held rows) has landed before anything is measured.
 * Returns a cancel that leaves the reader where they are and never calls
 * `arrive`.
 */
export function glideToLatest(
  scroller: LatestScroller,
  instant: boolean,
  arrive: () => void,
  clock: LatestClock = BROWSER_CLOCK,
): () => void {
  const fromEnd = () =>
    Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
  const place = (remaining: number) => {
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - remaining;
  };
  let phase: "measure" | "placed" | "moving" = "measure";
  let started = 0;
  let progress = 0;
  let cancel: () => void;
  const step = () => {
    if (phase === "measure") {
      const live = fromEnd();
      const start = latestGlideStart(live, scroller.clientHeight, instant);
      if (start === 0) {
        place(0);
        arrive();
        return;
      }
      phase = "placed";
      if (start < live) {
        // A long trip jumps to its start on this frame and moves from the
        // next. The jump lays out a region of the chat no one has rendered
        // yet, and a long frame there must not eat the start of the motion.
        place(start);
        cancel = clock.frame(step);
        return;
      }
    }
    if (phase === "placed") {
      phase = "moving";
      started = clock.now();
    }
    const now = latestGlideProgress(clock.now() - started);
    place(latestGlideStep(fromEnd(), progress, now));
    progress = now;
    if (now >= 1) {
      arrive();
      return;
    }
    cancel = clock.frame(step);
  };
  cancel = clock.frame(step);
  return () => cancel();
}
