/**
 * The eased repaint that plays when the app changes THEME SCOPE — #69's "the
 * transition carries the signal".
 *
 * Switching projects can change every color in the window at once. A hard cut
 * there reads as a glitch, and it is exactly the abrupt brightness jump Apple's
 * accessibility guidance asks interfaces to ease rather than snap (HIG: ease
 * dark↔light theme changes). So a scope change crossfades, and everything else
 * — every hover-preview in the picker, every deliberate theme pick — stays
 * instant, because there response is the whole point and a 300ms lag between
 * arrowing down the list and seeing the theme would be a regression.
 *
 * ┌───────────────────────────────────────────────────────────────────────────
 * │ SCOPE-CHANGE REPAINT STORYBOARD
 * │
 * │ Read top-to-bottom. Each `at` is ms after the new scope's payload lands.
 * │
 * │    0ms   data-theme-transition="scope" goes on <html>, and the pending
 * │          style recalc is flushed — the transition has to be LIVE before
 * │          the tokens move, or the browser has nothing to interpolate from
 * │    0ms   every color token is rewritten in one pass (theme/apply.ts)
 * │    0ms   background / text / border / shadow colors start easing, all of
 * │          them together, on --theme-scope-ease: fast start, long gentle
 * │          settle, NO overshoot (this is a state change, not a thrown object
 * │          — bounce would imply momentum that nothing here carries)
 * │  300ms   the crossfade lands
 * │  340ms   the attribute comes off; ordinary hover transitions go back to
 * │          their own durations
 * │
 * │ Reduced motion: globals.css's media query collapses the crossfade to
 * │ 120ms. Nothing translates or scales at any point, so there is no
 * │ vestibular motion to remove — the short ease IS the accessible option for
 * │ a whole-window brightness change, and it is over before it registers as
 * │ animation.
 * └───────────────────────────────────────────────────────────────────────────
 *
 * CSS custom properties do not interpolate on their own (unregistered, they
 * animate discretely), so the crossfade is bought the standard way: the
 * PROPERTIES THAT CONSUME the tokens — `background-color`, `color`,
 * `border-color` and friends — get a transition for the length of the swap.
 * That rule lives in globals.css, unlayered so it outranks Tailwind's own
 * `transition-colors` utilities for the duration; this module owns when it is
 * on, and for how long.
 */

/**
 * The timing, in one place. `crossfade` is mirrored by
 * `--theme-scope-crossfade` in globals.css — CSS owns the interpolation, this
 * owns the attribute's lifetime, and `tail` is the small margin that keeps the
 * attribute alive through the final frame instead of racing it.
 */
export const SCOPE_REPAINT = {
  /** ms — the token crossfade itself. Mirrors `--theme-scope-crossfade`. */
  crossfade: 300,
  /** ms — held past the crossfade so the last frame lands before the rule goes. */
  tail: 40,
} as const;

/** How long `data-theme-transition` stays on the root element. */
export const SCOPE_REPAINT_HOLD_MS = SCOPE_REPAINT.crossfade + SCOPE_REPAINT.tail;

/** The root attribute globals.css keys the transition off. */
export const SCOPE_TRANSITION_ATTRIBUTE = "data-theme-transition";

/** Its only value today; named so the CSS selector and the writer cannot drift. */
export const SCOPE_TRANSITION_VALUE = "scope";

/** What the theme store knows about a repaint it is about to perform. */
export interface ScopeRepaintInput {
  /** False before the first payload has ever landed. */
  hydrated: boolean;
  /** The project the store was showing (null = the global scope). */
  from: string | null;
  /** The project the incoming payload belongs to. */
  to: string | null;
}

/**
 * Whether this repaint is a SCOPE change, and therefore the one that eases.
 *
 * Two things are deliberately excluded. The first paint is not a transition —
 * there is no previous look to come from, and easing it would make boot look
 * like a slow fade-in of an app that had already rendered. And a repaint within
 * the same scope (picking a theme, committing an edit, a preview) is a direct
 * response to a click or a keystroke, where instant IS the correct feedback.
 */
export function shouldEaseScopeRepaint({ hydrated, from, to }: ScopeRepaintInput): boolean {
  return hydrated && from !== to;
}

/** The live timer, so overlapping scope changes extend one window instead of cutting each other short. */
let holding: ReturnType<typeof setTimeout> | null = null;

/**
 * Arms the crossfade on `root` (the document element by default) and takes it
 * off again once the swap has settled.
 *
 * Called immediately BEFORE the tokens are rewritten. The forced style read is
 * not superstition: the attribute and the new token values would otherwise land
 * in a single style recalc, and while the spec says the after-change style's
 * transition still applies, flushing makes the two-step explicit and identical
 * across engines — cheap once per project switch, and the alternative is a
 * silent hard cut that only shows up in a screen recording.
 *
 * Re-entrant: a second scope change mid-crossfade keeps the attribute on and
 * restarts the hold, so the colors simply re-target from wherever they are
 * rather than snapping when the first timer fires.
 */
export function beginScopeRepaint(root?: HTMLElement): void {
  const target = root ?? document.documentElement;
  target.setAttribute(SCOPE_TRANSITION_ATTRIBUTE, SCOPE_TRANSITION_VALUE);
  // Flush: makes the transition current style before the caller moves the tokens.
  void target.offsetWidth;
  if (holding !== null) clearTimeout(holding);
  holding = setTimeout(() => {
    holding = null;
    target.removeAttribute(SCOPE_TRANSITION_ATTRIBUTE);
  }, SCOPE_REPAINT_HOLD_MS);
}
