/**
 * The themes that ship with the app.
 *
 * Deliberately small and deliberately *data*: each entry is an authored
 * {@link ThemeDefinition} (a seed plus taste), and every color the UI draws
 * with is generated from it. Nothing here is a hand-picked palette, so adding a
 * theme is adding one line, and no theme in this list can be less readable than
 * any other — the generator's clamps hold for all of them alike.
 *
 * Scope note: decision #76's preset *families* (Catppuccin, Tokyo Night, Nord,
 * …) are three-surface bundles that also set the ghostty and shiki themes.
 * Those land with the editor surface; this list is the app-surface catalog the
 * picker needs in order to exist at all, plus the Volli originals #76 names.
 */

import { DEFAULT_THEME } from "@volli/shared";
import type { ThemeDefinition } from "@volli/shared";

/** One Volli original: a name, a seed, and the shared defaults. */
function original(name: string, slug: string, seed: string): ThemeDefinition {
  return { ...DEFAULT_THEME, name, slug, seed };
}

/**
 * Shipped app-surface themes, in presentation order. Ember (the brand seed,
 * and the shipped default) leads; the rest span the hue circle so the picker's
 * derived tags have something to distinguish.
 */
export const BUILTIN_THEMES: readonly ThemeDefinition[] = [
  DEFAULT_THEME,
  original("Midnight", "midnight", "#4c6ef5"),
  original("Moss", "moss", "#3f9142"),
  original("Iris", "iris", "#8b5cf6"),
  original("Rose", "rose", "#f43f5e"),
  // A near-grey seed takes the generator's neutral path (C = 0): true
  // achromatic chrome, with the accent still carrying the hue.
  original("Graphite", "graphite", "#8a8a8a"),
];
