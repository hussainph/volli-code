/**
 * The canvas, put on the document: the gradient, the on-canvas ink ladder, the
 * lift veils, the shadow set — and the whole derived app token set underneath
 * them.
 *
 * Ported from `lab/arc/paint.ts`, with the `--lab-` prefix dropped from every
 * property (the lab wrote a namespace the app deliberately does not read) and
 * the lab's `localStorage` half left behind: the app's canvas comes from
 * SQLite through the theme store, so this module only paints what it is handed.
 *
 * ONE write reaches the DOM, and it goes through {@link applyThemeTokens} — the
 * same choke point the seed system used, so `refreshTerminalTokenTheme` still
 * fires on every color change and there is still no way to move the app's
 * colors without the live terminals hearing about it. The canvas properties
 * ride along as that call's `extra` bag rather than joining
 * `THEME_TOKEN_NAMES`: they are canvas-pipeline output, not
 * `generateThemeTokens` output, and a name in the wrong list is a token that
 * silently never lands.
 *
 * It also owns the MODE CLASS. `index.html` no longer pins `class="dark"`;
 * preload stamps the resolved mode before first paint, and from then on this is
 * the one place it moves — the same argument as the tokens, for the same
 * reason. Two writers of that class is two answers to "what mode is this?".
 */

import {
  canvasBackground,
  canvasElevation,
  canvasInk,
  deriveCanvasTokens,
  deriveLabelInk,
  type Canvas,
  type ResolvedAppearance,
} from "@volli/shared";

import { applyThemeTokens, type ThemeApplyOptions } from "@renderer/theme/apply";

/**
 * The gradient itself — one CSS `background` value, grain layer included.
 *
 * Read by `globals.css`'s canvas rule rather than written to an element inline,
 * which is what lets the generated `:root` blocks carry a first-paint value for
 * it: a property the stylesheet declares and JS overrides is paintable before
 * any JS has run, and an element styled inline is not.
 *
 * Exported for `scope-transition.ts`, which reads the value off the root
 * immediately before this module overwrites it — that outgoing gradient is what
 * the eased repaint crossfades FROM.
 */
export const CANVAS_VARIABLE = "--canvas";

/**
 * The on-canvas copy ladder, head first.
 *
 * All three carry the `--canvas-ink` prefix because they are one family solved
 * together (`canvasInk`) — which is also what keeps the middle one
 * distinguishable from `--label-ink` below, the CARD's label tier, whose name it
 * otherwise nearly repeats. Prefix says which side of the card's edge a tier
 * belongs to; suffix says which rung.
 */
const INK_VARIABLE = "--canvas-ink";
const INK_LABEL_VARIABLE = "--canvas-ink-label";
const INK_MUTED_VARIABLE = "--canvas-ink-muted";

/**
 * The elevation set — cumulative lift per on-canvas tier, the micro-label ink,
 * and the three shadow tiers.
 *
 * Every one of these carries a value even when its dial is at zero
 * (`transparent`, `none`, the muted token) rather than being left unset. The
 * seam's rules in `globals.css` are unconditional, so an unset property would
 * fall back to its `var()` fallback on a repaint while the rule still matched —
 * a one-frame flicker with no error anywhere.
 */
const LIFT_VARIABLES = ["--lift-1", "--lift-2"] as const;
const LABEL_VARIABLE = "--label-ink";
const SHADOW_VARIABLES = {
  raised: "--shadow-raised",
  card: "--shadow-card",
  overlay: "--shadow-overlay",
} as const;

/**
 * Every custom property the canvas pipeline writes.
 *
 * Deliberately NOT part of `THEME_TOKEN_NAMES`: that list is the
 * `generateThemeTokens` output contract, and `applyThemeTokens` iterates it to
 * write a `ThemeTokens` record. These come out of a different pipeline and have
 * no member in that record, so they get their own list — and the list exists at
 * all so `globals.css`'s generator and this writer cannot disagree about which
 * properties a canvas is responsible for.
 */
export const CANVAS_TOKEN_NAMES = [
  CANVAS_VARIABLE,
  INK_VARIABLE,
  INK_LABEL_VARIABLE,
  INK_MUTED_VARIABLE,
  ...LIFT_VARIABLES,
  LABEL_VARIABLE,
  ...Object.values(SHADOW_VARIABLES),
] as const;

export type CanvasTokenName = (typeof CANVAS_TOKEN_NAMES)[number];

/** The canvas pipeline's output, keyed by the property each value is written to. */
export type CanvasTokens = Record<CanvasTokenName, string>;

/** The two classes that name a resolved appearance on `<html>`. */
const MODE_CLASSES = ["light", "dark"] as const;

/**
 * Whether the system is currently asking for dark — the input `auto` resolves
 * against, as main read it off `nativeTheme` when this window was built.
 *
 * NOT `matchMedia("(prefers-color-scheme: dark)")`, which is the obvious answer
 * here and a wrong one. Chromium resolves that query against the root element's
 * used `color-scheme` — which this module stamps, a few functions down — so in
 * this renderer it reads back whatever was last painted rather than what the
 * system wants. Measured on a Dark-mode Mac with the root in light: main's
 * `nativeTheme.shouldUseDarkColors` was `true` and the query answered `false`.
 * `auto` then resolves to the mode already on screen, forever, and no OS flip
 * can ever be noticed. Main is the only process that can see the truth, so the
 * answer arrives over the bridge (argv, then a push — see
 * {@link watchSystemAppearance}) and is never re-derived here.
 *
 * Guarded because the theme store's singleton is constructed at import time and
 * reads this for its initial state, and the renderer's own test project runs
 * under vitest's `node` environment with no DOM and no preload (see
 * apply.test.ts). With no bridge to ask, the answer is `true`: dark is what
 * `globals.css` renders with no mode class stamped, so the guard agrees with the
 * stylesheet rather than inventing a third default.
 */
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return true;
  return window.api?.theme.systemPrefersDark() ?? true;
}

/**
 * Every color a canvas implies, in one record.
 *
 * Split from the write so the same derivation can answer a question without
 * painting — the first-paint hint main stores, and the CSS generator, both need
 * the values and neither has a document.
 *
 * Order matters at one joint: elevation before ink. A lifted tier is a new
 * surface the on-canvas text sits on and, at negative lift, is darker than any
 * pool — so an ink chosen against the gradient alone would be chosen against
 * surfaces that are no longer the hardest ones on screen.
 */
export function deriveCanvasPaint(
  canvas: Canvas,
  resolved: ResolvedAppearance,
): { tokens: ReturnType<typeof deriveCanvasTokens>; canvasTokens: CanvasTokens } {
  const tokens = deriveCanvasTokens(canvas, resolved);
  const elevation = canvasElevation(canvas, resolved, tokens);
  const { ink, inkLabel, inkMuted } = canvasInk(canvas, resolved, elevation.surfaces);
  return {
    tokens,
    canvasTokens: {
      [CANVAS_VARIABLE]: canvasBackground(canvas, resolved),
      [INK_VARIABLE]: ink,
      [INK_LABEL_VARIABLE]: inkLabel,
      [INK_MUTED_VARIABLE]: inkMuted,
      "--lift-1": elevation.tiers[0].veil,
      "--lift-2": elevation.tiers[1].veil,
      // Solved off the token set that was just derived rather than off the
      // canvas a second time — the label tier is a position between two of
      // these exact hexes, so a second derivation could only disagree with them.
      [LABEL_VARIABLE]: deriveLabelInk(tokens, resolved),
      "--shadow-raised": elevation.shadows.raised,
      "--shadow-card": elevation.shadows.card,
      "--shadow-overlay": elevation.shadows.overlay,
    },
  };
}

/**
 * Everything a paint takes besides the canvas and the mode.
 *
 * `root` rides in this bag rather than sitting in front of it as a positional
 * parameter, and that is a correctness fix rather than tidying. The theme store
 * wires this function up as a dependency; with `root` third, that wiring was an
 * arrow function that had to re-list every parameter, and it silently stopped
 * at two — TypeScript accepts a function of fewer parameters wherever a longer
 * one is expected, so `transient` was dropped with no error anywhere and the
 * deferral it asks for never happened in the running app. One bag means the
 * store can forward the whole thing point-free and there is nothing left to
 * drop.
 */
export interface PaintCanvasOptions extends ThemeApplyOptions {
  /** Where to paint. Defaults to `<html>`; tests pass a recording stand-in. */
  root?: HTMLElement;
}

/**
 * Paints `canvas` at `resolved` onto `options.root` (the document element by
 * default).
 *
 * The mode class moves FIRST and the properties second, because the class is
 * what the `:root.light` block is selected by: writing an inline light ink
 * while `.dark` was still on the element would leave one frame in which the
 * generated dark block supplied every surface underneath it.
 *
 * `transient` is carried straight through to {@link applyThemeTokens}, which is
 * where it means something — this module has no per-frame cost of its own worth
 * skipping.
 */
export function paintCanvas(
  canvas: Canvas,
  resolved: ResolvedAppearance,
  options: PaintCanvasOptions = {},
): void {
  const target = options.root ?? documentRoot();
  if (target === null) return;
  applyResolvedAppearanceClass(resolved, target);
  const { tokens, canvasTokens } = deriveCanvasPaint(canvas, resolved);
  applyThemeTokens(tokens, target, canvasTokens, options);
}

/**
 * Puts the resolved mode on `root` as a class, replacing whichever one was
 * there.
 *
 * Exported because preload stamps the same class before this module exists and
 * a test has to be able to check the two agree — and because "which class names
 * a mode" is exactly the kind of fact that grows a second, drifting copy the
 * moment it is only written down inside a function.
 */
export function applyResolvedAppearanceClass(
  resolved: ResolvedAppearance,
  root?: HTMLElement,
): void {
  const target = root ?? documentRoot();
  if (target === null) return;
  for (const mode of MODE_CLASSES) target.classList.toggle(mode, mode === resolved);
}

/**
 * `<html>`, or null where there is no document.
 *
 * Null is only ever reachable headlessly — the renderer's own test project runs
 * under vitest's `node` environment (see apply.test.ts), and `boot()` now paints
 * as part of adopting the bootstrap rows. Returning null there makes the paint a
 * no-op rather than a `ReferenceError` that fails a test about something else
 * entirely; in the app this branch cannot be taken, and every test that is
 * actually ABOUT the paint passes its own recording root.
 */
function documentRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.documentElement;
}

let watching = false;

/**
 * Repaints when the system flips appearance — the `auto` half of the appearance
 * setting, which nothing in the renderer can observe.
 *
 * The flip is PUSHED from main (`nativeTheme`'s `updated`), for the reason
 * {@link systemPrefersDark} gives: the media query this used to listen to
 * resolves against the mode the app itself stamped, so its `change` event could
 * never fire for an OS flip and a window on `auto` stayed on whatever it had.
 * The new boolean rides the event rather than being re-read, because the
 * argv snapshot behind `systemPrefersDark` is fixed for the window's lifetime.
 *
 * Registered from `main.tsx` rather than at import time, and idempotent, so a
 * hot reload or a second caller cannot stack subscriptions. The unsubscribe is
 * deliberately dropped: this listener's lifetime is the window's. The callback
 * decides whether the flip is relevant (an explicit light/dark choice ignores
 * it); this module only reports that it happened, because "is this scope on
 * auto?" is the store's question and it is the only thing that can answer it
 * for the scope currently loaded.
 */
export function watchSystemAppearance(
  onSystemAppearanceChange: (prefersDark: boolean) => void,
): void {
  if (watching) return;
  watching = true;
  window.api.theme.onSystemAppearanceChanged(onSystemAppearanceChange);
}

/** Test seam: forgets that a listener was installed. Never called by the app. */
export function resetSystemAppearanceWatchForTests(): void {
  watching = false;
}
