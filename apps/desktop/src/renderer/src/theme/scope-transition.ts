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
 * │    0ms   the gradient now on <html> is copied to --canvas-outgoing and
 * │          data-canvas-fade goes on, mounting the layer that fades it out
 * │    0ms   every color token is rewritten in one pass (theme/apply.ts)
 * │    0ms   background / text / border / shadow colors start easing, all of
 * │          them together, on --theme-scope-ease: fast start, long gentle
 * │          settle, NO overshoot (this is a state change, not a thrown object
 * │          — bounce would imply momentum that nothing here carries)
 * │  300ms   the crossfade lands — tokens AND gradient, one duration, one curve
 * │  340ms   both attributes come off, the outgoing gradient is dropped, and
 * │          ordinary hover transitions go back to their own durations
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
 *
 * THE GRADIENT NEEDS ITS OWN HALF, and this module owns that too. The canvas is
 * a multi-stop `background-image` on `<html>`, and no two gradient strings have
 * a value in between — CSS swaps them discretely however long the transition is.
 * Left alone that is WORSE than no animation: for a third of a second the card,
 * the sidebar and the text are still the outgoing workspace's colors, easing
 * over the incoming workspace's wallpaper. So the outgoing gradient is copied to
 * {@link CANVAS_OUTGOING_VARIABLE} and painted a second time on a layer that
 * fades out over the new one (globals.css's `[data-canvas-fade]` rule): opacity
 * interpolates between any two canvases, and it is compositor-friendly.
 *
 * Both halves are one window — one duration, one curve, one hold timer, and one
 * reduced-motion collapse — because two timings would be two crossfades that
 * only look like one until something is retuned.
 */

import { CANVAS_VARIABLE } from "@renderer/theme/canvas-paint";

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

/** How long both root attributes below stay on the root element. */
export const SCOPE_REPAINT_HOLD_MS = SCOPE_REPAINT.crossfade + SCOPE_REPAINT.tail;

/** The root attribute globals.css keys the transition off. */
export const SCOPE_TRANSITION_ATTRIBUTE = "data-theme-transition";

/** Its only value today; named so the CSS selector and the writer cannot drift. */
export const SCOPE_TRANSITION_VALUE = "scope";

/**
 * The root attribute that mounts the gradient's fading copy — a SECOND
 * attribute rather than a second meaning for the one above, and that separation
 * is load-bearing.
 *
 * A CSS animation only restarts when the element carrying it is created afresh,
 * so an overlapping scope change has to take this off, let the style flush, and
 * put it back. Doing that to `data-theme-transition` would strip
 * `transition-property` off every element in the window mid-crossfade and SNAP
 * the colors to their current targets — the exact defect the re-entrant hold
 * below exists to avoid. Two attributes, one lifetime: they are armed together
 * and dropped together, so a stuck layer is not reachable without a stuck
 * transition, which the timer rules out.
 */
export const CANVAS_FADE_ATTRIBUTE = "data-canvas-fade";

/** Its only value; named for the same reason {@link SCOPE_TRANSITION_VALUE} is. */
export const CANVAS_FADE_VALUE = "outgoing";

/** The custom property that layer paints — the gradient being faded OUT. */
export const CANVAS_OUTGOING_VARIABLE = "--canvas-outgoing";

/** What the theme store knows about a repaint it is about to perform. */
export interface ScopeRepaintInput {
  /** False before the first payload has ever landed. */
  hydrated: boolean;
  /** The project the store was showing (null = the global scope). */
  from: string | null;
  /** The project the incoming payload belongs to. */
  to: string | null;
  /** The RESOLVED appearance before this repaint — `auto` already answered. */
  fromAppearance?: ResolvedAppearance;
  /** The resolved appearance after it. */
  toAppearance?: ResolvedAppearance;
}

/** `auto` already answered; mirrors `@volli/shared`'s type without importing the barrel. */
type ResolvedAppearance = "light" | "dark";

/**
 * Whether this repaint is one of the two whole-window changes that ease.
 *
 * A **scope change** is the first: switching workspaces can move every color at
 * once, and the crossfade is what tells you the window now belongs to a
 * different project.
 *
 * A **light↔dark flip** is the second, and it was missed while the pin was on.
 * It is a whole-window repaint with no scope change at all — the same project,
 * the same canvas, every surface inverted — so keying only on `projectId` would
 * hard-cut precisely the transition Apple's accessibility guidance singles out
 * for easing (HIG: ease dark↔light theme changes). It reaches here from three
 * places: the user picking a mode, a workspace whose override differs from the
 * global one coming into scope, and the system flipping under `auto`.
 *
 * Two things stay excluded. The first paint is not a transition — there is no
 * previous look to come from, and easing it would make boot look like a slow
 * fade-in of an app that had already rendered. And a repaint within the same
 * scope at the same mode (authoring a gradient, a live preview) is a direct
 * response to a drag or a keystroke, where instant IS the correct feedback.
 */
export function shouldEaseScopeRepaint({
  hydrated,
  from,
  to,
  fromAppearance,
  toAppearance,
}: ScopeRepaintInput): boolean {
  if (!hydrated) return false;
  if (from !== to) return true;
  // Undefined on either side means the caller is not tracking appearance, which
  // is not the same as "it did not change" — but it is the only honest answer
  // available, and it preserves the pre-appearance behaviour exactly.
  return (
    fromAppearance !== undefined && toAppearance !== undefined && fromAppearance !== toAppearance
  );
}

/**
 * The live timer AND what it is armed on, so overlapping scope changes extend
 * one window instead of cutting each other short — and so re-arming on a
 * different root disarms the first one rather than leaving it stuck mid-fade.
 */
let holding: { timer: ReturnType<typeof setTimeout>; target: HTMLElement } | null = null;

/**
 * Puts a root back to rest: no transition, no fading layer, no spent gradient
 * left inline.
 *
 * One function because "armed" is a state of THREE things that must never be
 * separable — the timer's expiry and the hand-off to a different root are the
 * same disarm asked for from two places.
 */
function disarm(target: HTMLElement): void {
  target.removeAttribute(SCOPE_TRANSITION_ATTRIBUTE);
  target.removeAttribute(CANVAS_FADE_ATTRIBUTE);
  target.style.removeProperty(CANVAS_OUTGOING_VARIABLE);
}

/**
 * Arms the crossfade on `root` (the document element by default) — tokens and
 * gradient both — and takes it off again once the swap has settled.
 *
 * Called immediately BEFORE the tokens are rewritten, which is also the only
 * moment the OUTGOING gradient can be read: `--canvas` is still the one on
 * screen, and `paintCanvas` is about to overwrite it. Reading the inline value
 * rather than the computed one is deliberate — inline is what that function
 * writes, so an empty answer means nothing has ever been painted, which is the
 * first paint, which never eases anyway. In that case the gradient simply cuts,
 * exactly as it did before this layer existed.
 *
 * The forced style read is not superstition, and it now does two jobs. The
 * attribute and the new token values would otherwise land in a single style
 * recalc, and while the spec says the after-change style's transition still
 * applies, flushing makes the two-step explicit and identical across engines.
 * The same flush is also what destroys the previous fading layer, so re-arming
 * mid-fade builds a NEW one whose animation starts from the top instead of
 * resuming a spent one at opacity 0.
 *
 * Re-entrant: a second scope change mid-crossfade keeps the transition attribute
 * on and restarts the hold, so the colors simply re-target from wherever they
 * are rather than snapping when the first timer fires. The hold EXTENDS rather
 * than stacking — one timer, cleared and re-armed — which is what makes two
 * changes in quick succession one window instead of two.
 *
 * ONE ARM PER CHANGE, and it is worth writing down because the measurement that
 * says otherwise is easy to take. `animationstart` for the gradient layer does
 * not fire when the attribute lands; it fires on the first rendering lifecycle
 * that samples the animation, measured at 40–100ms later on an idle window and
 * far longer when frames are starved. So a recorder attached between two changes
 * can collect the previous one's start alongside the current one's and read as a
 * single flip arming twice. Verified by patching `setAttribute` and stack-tracing
 * every arm through a full run: one call per flip, all of them from the store's
 * own repaint path. Anything counting fades has to start from a root at rest —
 * see `e2e/canvas-theming-smoke.mjs`'s `watchScopeRepaint`.
 */
export function beginScopeRepaint(root?: HTMLElement): void {
  const target = root ?? document.documentElement;
  const outgoing = target.style.getPropertyValue(CANVAS_VARIABLE);
  target.setAttribute(SCOPE_TRANSITION_ATTRIBUTE, SCOPE_TRANSITION_VALUE);
  // Off before the flush, on after it: that is the whole restart mechanism.
  target.removeAttribute(CANVAS_FADE_ATTRIBUTE);
  // Flush: makes the transition current style before the caller moves the
  // tokens, and retires any layer left over from a fade still in flight.
  void target.offsetWidth;
  if (outgoing !== "") {
    target.style.setProperty(CANVAS_OUTGOING_VARIABLE, outgoing);
    target.setAttribute(CANVAS_FADE_ATTRIBUTE, CANVAS_FADE_VALUE);
  }
  if (holding !== null) {
    clearTimeout(holding.timer);
    // A different root: its timer is gone, so disarm it here or it stays armed
    // forever — with a full-window gradient layer frozen on top of it.
    if (holding.target !== target) disarm(holding.target);
  }
  const timer = setTimeout(() => {
    holding = null;
    disarm(target);
  }, SCOPE_REPAINT_HOLD_MS);
  holding = { timer, target };
}

/**
 * Reverses whatever is currently armed, on whichever root it is armed on.
 *
 * The module-level hold is otherwise only ever cleared by its own timer, so an
 * HMR swap landing between an arm and that timer's expiry would leave the
 * transition attribute, the fade layer and its spent gradient on the root
 * forever — the first of those a universal-selector transition on eight paint
 * properties. Exported so the dispose hook below can call it.
 */
export function disarmScopeRepaint(): void {
  if (holding === null) return;
  clearTimeout(holding.timer);
  disarm(holding.target);
  holding = null;
}

/* v8 ignore next 3 -- `import.meta.hot` exists only under the dev server;
   tests and production builds cannot take this branch. */
import.meta.hot?.dispose(() => {
  disarmScopeRepaint();
});
