/**
 * The application layer: derived tokens → live CSS custom properties, and the
 * per-surface global → workspace resolution that decides WHICH canvas gets
 * derived in the first place (decision #69).
 *
 * Two rules are enforced here rather than merely documented:
 *
 *  - **The resolved token set is never persisted.** This module takes an
 *    authored {@link Canvas} in and writes CSS out; nothing it produces is
 *    storable, because everything it produces is recomputed from
 *    `{canvas, appearance}` at render time. (VS Code's most-complained-about
 *    theming bug is auto-switching writing the *resolved* theme back over the
 *    user's authored intent.)
 *  - **Resolution is per surface, never per token.** A workspace overrides the
 *    canvas, the appearance, or the terminal as whole units, so "what is
 *    overridden here" is always answerable — and {@link ResolvedThemeSurface}
 *    carries the answer to the UI instead of making it re-derive one.
 *
 * The EDITOR is not among those surfaces (VC-123). It has no scoped value to
 * resolve: it wears light or dark because {@link ActiveTheme.resolved} says so.
 * A project that wants a light editor overrides its appearance.
 *
 * `globals.css` authors the default canvas's generated values verbatim, in both
 * modes, so the first paint already carries the right palette and this module's
 * writes are a no-op until the user authors something else.
 */

import {
  generateVeilTokens,
  resolveAppearance,
  THEME_TOKEN_NAMES,
  THEME_VEIL_TOKEN_NAMES,
} from "@volli/shared";
import type { Appearance, Canvas, ResolvedAppearance, ThemeTokens } from "@volli/shared";

import { refreshTerminalTokenTheme } from "@renderer/terminal/appearance";

/**
 * How a paint should treat the work that only matters once a value settles.
 *
 * `transient` marks a paint that is already known to be superseded — one frame
 * of a drag. The properties still land, because following the pointer is the
 * whole point of a live preview; what is deferred is
 * {@link refreshTerminalTokenTheme}, the one part of a paint whose cost has
 * nothing to do with how much changed.
 *
 * That call drops every live terminal's cached palette and makes each one
 * rebuild it by reading ~20 custom properties back off `<html>` with
 * `getComputedStyle` — a forced style recalculation of the whole document,
 * issued immediately after this function has just written ~50 properties to
 * that same element, followed by a full repaint per terminal. At pointer-event
 * rates that is the drag's stutter, and every one of those palettes is thrown
 * away by the next frame.
 *
 * This module stays the single choke point for COMMITTED colour changes:
 * `transient` defaults to false, so every path except an in-flight preview
 * still refreshes, and the paint that ends a gesture is a committed one.
 */
export interface ThemeApplyOptions {
  /** True while a gesture is still running; the terminals are told on settle. */
  transient?: boolean;
}

/**
 * Writes every themeable color token onto `root` (the document element by
 * default), replacing whatever `globals.css` authored, plus any `extra`
 * properties the caller owns.
 *
 * `extra` is how the canvas pipeline's own properties (the gradient, the ink
 * ladder, the lift veils, the shadows — `CANVAS_TOKEN_NAMES` in
 * `canvas-paint.ts`) reach the document without being smuggled into
 * {@link ThemeTokens}, which is `generateThemeTokens`'s output contract and
 * nothing else's. One write function, two vocabularies, no third DOM writer.
 *
 * Also drops the terminal's token-derived fallback palette
 * ({@link refreshTerminalTokenTheme}): a config-less terminal paints itself
 * from these same tokens and caches the result, so without this a canvas change
 * leaves every such terminal rendering the previous palette until relaunch.
 * Doing it here rather than at each call site makes the apply path the single
 * choke point — there is no way to commit a change to the app's colors without
 * the terminals hearing about it. See {@link ThemeApplyOptions} for the one
 * case that defers it.
 */
export function applyThemeTokens(
  tokens: ThemeTokens,
  root?: HTMLElement,
  extra?: Readonly<Record<string, string>>,
  options: ThemeApplyOptions = {},
): void {
  const target = root ?? document.documentElement;
  for (const name of THEME_TOKEN_NAMES) target.style.setProperty(name, tokens[name]);
  // The veils (#74) are solved FROM the set above, so they move with it. A
  // surface that gave up its fill to sit on the canvas composites through one
  // of these; leaving them behind would freeze the sidebar on the previous
  // canvas's rung while the rail beneath it repaints.
  const veils = generateVeilTokens(tokens);
  for (const name of THEME_VEIL_TOKEN_NAMES) target.style.setProperty(name, veils[name]);
  if (extra !== undefined) {
    for (const [name, value] of Object.entries(extra)) target.style.setProperty(name, value);
  }
  if (options.transient !== true) refreshTerminalTokenTheme();
}

/** Which scope supplied a surface's value. */
export type ThemeSurfaceScope = "global" | "project";

/** One resolved surface: the value in force, and the scope that supplied it. */
export interface ResolvedThemeSurface<T> {
  value: T;
  scope: ThemeSurfaceScope;
}

/**
 * What one workspace overrides, as the RENDERER resolves it.
 *
 * Deliberately not `@volli/shared`'s `ProjectThemeOverride`, which is still the
 * live half of the migration-013 row (`terminalThemeName`) that the main
 * process reads and writes. The two are assembled from different places —
 * canvas and appearance are migration-014 columns that ride in on the bootstrap
 * payload's `Project`, while the terminal name comes from the 013 row — and
 * this is the shape the resolution below actually needs. Every field is
 * independently nullable, and `null` means "inherit the global choice".
 */
export interface ProjectSurfaceOverride {
  /** This workspace's own gradient, or null to inherit the global one. */
  canvas: Canvas | null;
  /** This workspace's own light/dark/auto, or null to inherit. Scoped separately from the canvas. */
  appearance: Appearance | null;
  /** Ghostty theme name, as written into the workspace's terminal overlay. */
  terminalThemeName: string | null;
}

/** Every surface inheriting — the state every workspace starts in (#72). */
export const EMPTY_SURFACE_OVERRIDE: ProjectSurfaceOverride = {
  canvas: null,
  appearance: null,
  terminalThemeName: null,
};

/**
 * The three surfaces as currently resolved, plus the one derived value every
 * consumer would otherwise re-derive.
 *
 * `resolved` is `auto` already answered. It is carried rather than recomputed
 * downstream because recomputing it needs `matchMedia`, which makes every
 * consumer impure and gives the app as many opinions about "is it dark right
 * now" as there are readers — and since VC-123 the editor's theme is one of
 * the things derived from it.
 */
export interface ActiveTheme {
  /** The authored canvas to derive tokens from. */
  canvas: ResolvedThemeSurface<Canvas>;
  /** The authored light/dark/auto choice in force. */
  appearance: ResolvedThemeSurface<Appearance>;
  /** {@link appearance} with `auto` answered — what every derivation actually runs against. */
  resolved: ResolvedAppearance;
  /** Ghostty theme name, or null to keep whatever the ghostty config chain resolves. */
  terminal: ResolvedThemeSurface<string | null>;
}

/** A surface the workspace did not override — it takes the global choice. */
function inherited<T>(value: T): ResolvedThemeSurface<T> {
  return { value, scope: "global" };
}

/** A surface the workspace set. */
function overridden<T>(value: T): ResolvedThemeSurface<T> {
  return { value, scope: "project" };
}

/**
 * Picks one surface: the workspace's value when it has one, the global
 * otherwise.
 *
 * It PICKS rather than builds, and that is load-bearing for the canvas. The
 * result is read through a zustand selector, and zustand v5 routes selectors
 * through `useSyncExternalStore`, which compares snapshots with `Object.is` — so
 * a freshly-constructed object there is an infinite render loop, not a wasted
 * allocation. The seed system's auto-tint had to build a theme here and paid for
 * it with a `WeakMap` memo; nothing in this resolution constructs a value, so
 * that whole hazard is gone for the VALUE. It is not gone for the SELECTOR: a
 * selector that wraps this in `{canvas, scope}` reintroduces it exactly. Return
 * the `Canvas` reference itself.
 */
function pick<T>(override: T | null, global: T): ResolvedThemeSurface<T> {
  return override === null ? inherited(global) : overridden(override);
}

/**
 * Resolves what a scope actually renders with.
 *
 * Canvas and appearance resolve INDEPENDENTLY. A workspace may override the
 * gradient, the mode, both, or neither — one canvas is built to render
 * correctly in both appearances (that is what the per-mode dials in
 * `ARC_SETTLED` are for), so overriding the gradient and overriding the mode are
 * genuinely different things to want.
 */
export function resolveActiveTheme(
  globalCanvas: Canvas,
  globalAppearance: Appearance,
  projectOverride: ProjectSurfaceOverride | null,
  systemPrefersDark: boolean,
): ActiveTheme {
  const override = projectOverride ?? EMPTY_SURFACE_OVERRIDE;
  const appearance = pick(override.appearance, globalAppearance);
  return {
    canvas: pick(override.canvas, globalCanvas),
    appearance,
    resolved: resolveAppearance(appearance.value, systemPrefersDark),
    terminal: pick(override.terminalThemeName, null),
  };
}
