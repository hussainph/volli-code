/**
 * The application layer: generated tokens → live CSS custom properties, and
 * the per-surface global → project resolution that decides WHICH theme gets
 * generated in the first place (decision #69).
 *
 * Two rules from docs/plans/theming-engine.md are enforced here rather than
 * merely documented:
 *
 *  - **The resolved token set is never persisted.** This module takes an
 *    authored {@link ThemeDefinition} in and writes CSS out; nothing it
 *    produces is storable, because everything it produces is recomputed from
 *    `{global theme, project override}` at render time. (VS Code's
 *    most-complained-about theming bug is auto-switching writing the
 *    *resolved* theme back over the user's authored intent.)
 *  - **Resolution is per surface, never per token.** A project overrides the
 *    app surface, the terminal, or the editor as whole units, so "what is
 *    overridden here" is always answerable — and {@link ResolvedThemeSurface}
 *    carries the answer to the UI instead of making it re-derive one.
 *
 * `globals.css` authors the shipped ember theme's generated values verbatim,
 * so the first paint already carries the right palette and this module's
 * writes are a no-op until the user picks something else.
 */

import { generateThemeTokens, THEME_TOKEN_NAMES } from "@volli/shared";
import type { ProjectThemeOverride, ThemeDefinition, ThemeTokens } from "@volli/shared";

import { refreshTerminalTokenTheme } from "@renderer/terminal/appearance";

/**
 * Writes every themeable color token onto `root` (the document element by
 * default), replacing whatever `globals.css` authored.
 *
 * Also drops the terminal's token-derived fallback palette
 * ({@link refreshTerminalTokenTheme}): a config-less terminal paints itself
 * from these same tokens and caches the result, so without this a theme change
 * leaves every such terminal rendering the previous palette until relaunch.
 * Doing it here rather than at each call site makes the apply path the single
 * choke point — there is no way to change the app's colors without the
 * terminals hearing about it.
 */
export function applyThemeTokens(tokens: ThemeTokens, root?: HTMLElement): void {
  const target = root ?? document.documentElement;
  for (const name of THEME_TOKEN_NAMES) target.style.setProperty(name, tokens[name]);
  refreshTerminalTokenTheme();
}

/** Generates and applies an authored theme in one step — the ordinary caller's entry point. */
export function applyTheme(theme: ThemeDefinition, root?: HTMLElement): void {
  applyThemeTokens(generateThemeTokens(theme), root);
}

/** Which scope supplied a surface's value. */
export type ThemeSurfaceScope = "global" | "project";

/** One resolved surface: the value in force, and the scope that supplied it. */
export interface ResolvedThemeSurface<T> {
  value: T;
  scope: ThemeSurfaceScope;
}

/**
 * The three surfaces (#66) as currently resolved. Each is independent: a
 * project overriding its terminal theme leaves the app surface and the editor
 * inheriting, and the UI can say so per row.
 */
export interface ActiveTheme {
  /** The authored app-surface theme to generate tokens from. */
  app: ResolvedThemeSurface<ThemeDefinition>;
  /** Ghostty theme name, or null to keep whatever the ghostty config chain resolves. */
  terminal: ResolvedThemeSurface<string | null>;
  /** Monaco/shiki theme id, or null for the app's own derived editor theme. */
  editor: ResolvedThemeSurface<string | null>;
}

/** The derived-tint theme's slug (#72). Never persisted — the project stores the SEED, not this. */
export const PROJECT_TINT_SLUG = "project-tint";

/** A surface the project did not override — it takes the global choice. */
function inherited<T>(value: T): ResolvedThemeSurface<T> {
  return { value, scope: "global" };
}

/**
 * The auto-tint (#72) is the one resolution path that has to BUILD a theme
 * rather than pick one, and the built value is read as a zustand selector
 * result (`effectiveTheme`). zustand v5 routes selectors through React's
 * `useSyncExternalStore`, which compares each render's snapshot with
 * `Object.is` — so a freshly-constructed object there is not a wasted
 * allocation, it is an infinite render loop ("The result of getSnapshot should
 * be cached").
 *
 * So the derived theme is memoized on the exact pair it is derived from: the
 * same `{global theme, project override}` REFERENCES in, the identical theme
 * reference out. Both keys are weak, so a discarded theme or override takes
 * its entry with it, and nothing is shared between unrelated input pairs —
 * stability is a property of the inputs, not of call ordering.
 */
const tintCache = new WeakMap<ThemeDefinition, WeakMap<ProjectThemeOverride, ThemeDefinition>>();

function tintedTheme(
  global: ThemeDefinition,
  override: ProjectThemeOverride,
  seed: string,
): ThemeDefinition {
  let byOverride = tintCache.get(global);
  if (byOverride === undefined) {
    byOverride = new WeakMap<ProjectThemeOverride, ThemeDefinition>();
    tintCache.set(global, byOverride);
  }
  const cached = byOverride.get(override);
  if (cached !== undefined) return cached;
  // Only the seed moves: grain, canvas and the authored overrides stay the
  // user's global choices, so a tinted project still looks like their app.
  const tinted: ThemeDefinition = {
    ...global,
    name: `${global.name} (tinted)`,
    slug: PROJECT_TINT_SLUG,
    seed,
  };
  byOverride.set(override, tinted);
  return tinted;
}

/**
 * Resolves what a scope actually renders with: the global theme, with each
 * surface a project set replacing its inherited value.
 *
 * The app surface has one wrinkle the other two don't. A project may name a
 * theme (`appThemeSlug`) *or* carry only a seed — #72's "Auto-tint from this
 * project's color", derived from the `colorIndex` the project already has. A
 * named theme wins when both are set: it is the more specific statement of
 * intent, and the seed is retained so a later switch back to auto-tint doesn't
 * have to re-derive it.
 *
 * An unresolvable slug (a custom theme file the user deleted) falls back to the
 * global theme rather than throwing — a missing theme must degrade to the
 * shipped look, never to a blank window.
 */
export function resolveActiveTheme(
  global: ThemeDefinition,
  projectOverride: ProjectThemeOverride | null,
  catalog: readonly ThemeDefinition[] = [],
): ActiveTheme {
  if (projectOverride === null) {
    return { app: inherited(global), terminal: inherited(null), editor: inherited(null) };
  }

  const named =
    projectOverride.appThemeSlug === null
      ? undefined
      : [global, ...catalog].find((theme) => theme.slug === projectOverride.appThemeSlug);

  let app: ResolvedThemeSurface<ThemeDefinition>;
  if (named !== undefined) {
    app = { value: named, scope: "project" };
  } else if (projectOverride.seed !== null) {
    app = { value: tintedTheme(global, projectOverride, projectOverride.seed), scope: "project" };
  } else {
    app = inherited(global);
  }

  return {
    app,
    terminal:
      projectOverride.terminalThemeName === null
        ? inherited(null)
        : { value: projectOverride.terminalThemeName, scope: "project" },
    editor:
      projectOverride.editorThemeId === null
        ? inherited(null)
        : { value: projectOverride.editorThemeId, scope: "project" },
  };
}
