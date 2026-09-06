/**
 * The Session cursor's motion arithmetic (VC-239), pure so it can be tested
 * and so the overlay host can bound its wait on the same numbers.
 */

/** The longest a glide may take. The click waits on it, so it is a promise to the page too. */
export const SESSION_CURSOR_GLIDE_MAX_MS = 250;

/** Below this the eye reads a jump as a jump; there is nothing to glide. */
export const SESSION_CURSOR_GLIDE_MIN_PX = 2;

/**
 * How long a glide over `distance` pixels takes: distance-scaled from a short
 * floor, capped at {@link SESSION_CURSOR_GLIDE_MAX_MS}. A cursor that took the
 * same 250ms to cross 20px as 800px would feel slow on the short hop and
 * rushed on the long one; scaling keeps the perceived speed close to constant
 * until the cap, where speed is allowed to rise rather than the wait.
 *
 * Zero when there is nothing to travel, and zero under reduced motion, so a
 * caller can use the answer as both the transition duration and the wait.
 */
export function sessionCursorGlideMs(distance: number, reducedMotion: boolean): number {
  if (reducedMotion || !Number.isFinite(distance) || distance < SESSION_CURSOR_GLIDE_MIN_PX) {
    return 0;
  }
  return Math.min(SESSION_CURSOR_GLIDE_MAX_MS, Math.round(70 + distance * 0.3));
}

/** Euclidean distance between two points, the one line every caller wrote. */
export function pointDistance(
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/**
 * How long the label chip stays pinned when a hold begins. Long enough to be
 * read once by someone whose eye was elsewhere; short enough that it is not
 * still there when the second action lands.
 */
export const SESSION_CURSOR_LABEL_PIN_MS = 1_600;
