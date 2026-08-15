/**
 * Waiting for an instant a model named, instead of polling in case it has
 * already happened.
 *
 * Every surface that shows a word derived from the clock — "Working" decaying
 * to "Idle", "2m" becoming "3m" — has exactly one thing it needs from the
 * clock: the next instant its own answer differs. A pure derivation can say
 * that instant (`nextAgeChangeAt`, a listing's `nextBoundaryAt`), and a caller
 * that arms a timer on it renders once per visible change rather than once per
 * second forever. This is the arithmetic both halves of that pattern share; it
 * lives here because two surfaces now do it and the clamp below is the kind of
 * knowledge that must not exist in two copies.
 */

/**
 * The longest `setTimeout` a browser can hold. Past `2^31 - 1` ms the delay
 * overflows to a signed 32-bit int and the timer fires IMMEDIATELY — which,
 * for a timer whose handler re-arms it, is not a late wake but a spin. Callers
 * wait on model-supplied instants, and some of those (the year an age column
 * stops printing) are legitimately months away, so the wait is capped: the
 * timer wakes early, recomputes, finds the same boundary and waits again, which
 * costs a fortnight's worth of nothing.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * How long to wait for the absolute instant `at`, clamped at both ends.
 *
 * Never negative and never zero: an instant already past (a boundary computed
 * against a deliberately-behind clock, which is what these clocks are) becomes
 * a wake on the next tick, which recomputes against the real wall clock and
 * lands on the right answer. Never longer than {@link MAX_TIMER_DELAY_MS}.
 */
export function delayUntil(at: number, now: number = Date.now()): number {
  // The +1 lands the wake INSIDE the new state rather than on the instant the
  // old one is still true for.
  return Math.min(Math.max(0, at - now) + 1, MAX_TIMER_DELAY_MS);
}
