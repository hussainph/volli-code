/**
 * The eased repaint that plays when the app changes THEME SCOPE — #69's "the
 * transition carries the signal".
 *
 * Switching projects can change every color in the window at once. A hard cut
 * there reads as a glitch, and it is exactly the abrupt brightness jump Apple's
 * accessibility guidance asks interfaces to ease rather than snap (HIG: ease
 * dark↔light theme changes). So a scope change crossfades, and everything else
 * — every live drag in the canvas editor, every deliberate theme pick — stays
 * instant, because there response is the whole point and a 300ms lag between
 * moving a stop and seeing it would be a regression.
 *
 * ┌───────────────────────────────────────────────────────────────────────────
 * │ SCOPE-CHANGE REPAINT STORYBOARD
 * │
 * │      0ms   `document.startViewTransition` is called with the swap itself as
 * │            its callback. Chromium blocks rendering and captures the window
 * │            exactly as it stands.
 * │   ~1 frame the callback runs: every color token is rewritten in ONE pass
 * │            (theme/apply.ts, ~7ms), the same single style recalculation a
 * │            hard cut would have cost, and the engine captures the result.
 * │            The two captures become `::view-transition-old(root)` and
 * │            `::view-transition-new(root)`.
 * │  0→300ms   those two layers crossfade ON THE COMPOSITOR — no style, no
 * │            layout, no paint on the main thread for the whole window — over
 * │            --theme-scope-ease: fast start, long gentle settle, NO overshoot
 * │            (this is a state change, not a thrown object; bounce would imply
 * │            momentum that nothing here carries).
 * │    300ms   the engine tears its own pseudo-element tree down. This module
 * │            has no attribute to remove, no timer to clear and no layer to
 * │            unmount, because it never created any. Sooner if the user
 * │            presses anything — see {@link beginScopeRepaint} for why input
 * │            has to end the crossfade rather than play over it.
 * │
 * │ Reduced motion: globals.css's media query collapses the crossfade to 120ms.
 * │ Nothing translates or scales at any point, so there is no vestibular motion
 * │ to remove — the short ease IS the accessible option for a whole-window
 * │ brightness change, and it is over before it registers as animation.
 * └───────────────────────────────────────────────────────────────────────────
 *
 * WHY A VIEW TRANSITION, and not the CSS transition this used to be. The old
 * mechanism armed `transition-property` on eight paint properties over
 * `:root, :root *, :root *::before, :root *::after` for the length of the swap.
 * That is the only way to crossfade through custom properties — unregistered
 * ones animate discretely, so the interpolation has to be bought on the
 * properties that CONSUME them — and the price is per-element: every node in
 * the document gets a live transition, and every one of them is restyled on
 * every frame of it. Measured on a workspace hop: token derivation and the DOM
 * write together were under 7ms, and the crossfade held the main thread in
 * continuous style recalculation for ~331ms afterwards. The owner hops
 * workspaces constantly, so that was ~400ms of jank on the app's most repeated
 * interaction.
 *
 * A view transition inverts the cost. The tokens move exactly once, in one
 * recalculation, inside the update callback — the same work as a hard cut — and
 * what animates afterwards is two flattened captures of the window, which the
 * compositor can crossfade without asking the main thread anything. Per-element
 * recalculation becomes two layers.
 *
 * IT ALSO SOLVES THE GRADIENT, which used to need a whole mechanism of its own.
 * The canvas is a multi-stop `background-image` on `<html>` and no two gradient
 * strings have a value in between, so CSS swapped it discretely however long the
 * transition ran — leaving a third of a second in which the card, the sidebar
 * and the text were still the outgoing workspace's colors, easing over the
 * incoming workspace's wallpaper. The fix was to copy the outgoing gradient to a
 * custom property and paint it a second time on a fading `html::before` layer.
 * Captures are pixels: a gradient in a snapshot is not a gradient any more, so
 * two canvases crossfade for the same reason two of anything else do, and the
 * outgoing-canvas layer, its attribute, its keyframes and the hold timer that
 * dropped them all deleted with it.
 *
 * Timing and curve live entirely in globals.css now (`--theme-scope-crossfade`,
 * `--theme-scope-ease`, and the reduced-motion collapse). This module owns only
 * WHEN a swap eases and what the swap is; it holds no duration of its own,
 * because a second copy of 300ms is a second crossfade waiting to drift.
 */

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
 * The transition currently animating, so {@link disarmScopeRepaint} has
 * something to skip.
 *
 * Chromium already keeps its own "active view transition" and skips it when a
 * new one starts, so this is NOT the re-entrancy mechanism — overlapping scope
 * changes are the engine's problem and it solves them by construction. This
 * reference exists for the one case the engine cannot see: an HMR dispose or a
 * teardown that has to end a transition nothing else will.
 */
let running: ViewTransition | null = null;

/**
 * Runs `applyTokens` as an eased whole-window swap.
 *
 * The callback is the swap — the store hands its `paintCanvas` call in rather
 * than making it before or after, and that is the whole contract. A view
 * transition captures the window as it stands when it is STARTED, which happens
 * at the next rendering opportunity rather than inside this call, so DOM changes
 * made around it land in the OLD capture and animate from themselves to
 * themselves. Only what changes inside the callback crossfades.
 *
 * Falls straight through to a hard cut where the API is missing — old Chromium,
 * and the renderer's own tests, which run under vitest's `node` environment with
 * no document at all. That path is not a degraded crossfade, it IS the swap: the
 * tokens are applied synchronously, exactly as an un-eased repaint applies them,
 * so the only thing lost is the easing.
 *
 * A POINTER PRESS ENDS THE CROSSFADE, and that is not polish. While a view
 * transition plays, Chromium hit-tests the pseudo-element tree instead of the
 * document, so every click inside the window resolves to `<html>` and is
 * DROPPED — not queued, not delayed, gone. Measured in Electron 43: clicks at
 * +0ms, +100ms and +200ms into a 300ms swap never reached the button under the
 * cursor; one at +320ms did. `pointer-events: none` on the whole
 * `::view-transition` tree does not lift it (the computed value takes and the
 * hit test still lands on the root), so the only lever left is length. Skipping
 * on the first press turns "up to 300ms of dead window" into "one lost click,
 * then live" — and it is the right behaviour on its own terms: input outranks
 * decoration, and a second gesture should never wait for the first animation.
 * `pointerdown` rather than every input, because it is discrete and deliberate;
 * a keypress is unaffected by any of this (keyboard focus never leaves the live
 * DOM), and decaying scroll momentum would cut fades it has no opinion about.
 */
export function beginScopeRepaint(applyTokens: () => void): void {
  if (typeof document === "undefined" || typeof document.startViewTransition !== "function") {
    applyTokens();
    return;
  }
  // Held rather than re-read: the listener has to come off the document it went
  // on, and `document` is a live global binding that a teardown can replace.
  const host = document;
  const transition = host.startViewTransition(applyTokens);
  running = transition;
  // Capture phase on the document, because the press is delivered to `<html>`
  // and a listener on anything below it would never see the thing it is here to
  // notice.
  const yieldToInput = (): void => {
    transition.skipTransition();
  };
  host.addEventListener("pointerdown", yieldToInput, { capture: true, once: true });
  // `ready` REJECTS with an AbortError every time a transition is skipped, and
  // skipping is the ORDINARY path here: a second workspace hop inside 300ms
  // makes Chromium abandon the first one, which is exactly the behaviour we
  // want. Swallowed deliberately, or the app's most repeated interaction fills
  // the console with unhandled rejections for working correctly.
  void transition.ready.catch(() => undefined);
  // `finished` settles when the animation ends OR when it is skipped, and only
  // rejects if `applyTokens` itself threw — so ONE handler serves both
  // outcomes, and serving both is what keeps a rejection from going unheard.
  // The identity guard is the point of it: a superseded transition can settle
  // after its successor has already started, and clearing the reference then
  // would leave the live one unskippable.
  const forget = (): void => {
    host.removeEventListener("pointerdown", yieldToInput, { capture: true });
    if (running === transition) running = null;
  };
  void transition.finished.then(forget, forget);
  // `updateCallbackDone` is left unhandled ON PURPOSE. It is the one promise
  // that rejects only when the paint genuinely broke, and a broken paint should
  // reach the console as loudly as the synchronous throw it would have been.
}

/**
 * Ends whatever is currently easing, immediately.
 *
 * `skipTransition` still runs the update callback if it has not run yet, so the
 * tokens land either way and the document is left in the state the swap was
 * headed for — a hard cut, not an abandoned half-repaint. The engine drops its
 * own pseudo-element tree with it, which is the whole cleanup: unlike the
 * attribute-and-timer mechanism this replaced, there is nothing an HMR swap
 * landing mid-crossfade could leave stuck on the root.
 */
export function disarmScopeRepaint(): void {
  if (running === null) return;
  running.skipTransition();
  running = null;
}

/* v8 ignore next 3 -- `import.meta.hot` exists only under the dev server;
   tests and production builds cannot take this branch. */
import.meta.hot?.dispose(() => {
  disarmScopeRepaint();
});
