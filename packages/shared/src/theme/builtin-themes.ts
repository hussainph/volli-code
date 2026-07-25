/**
 * Slugs reserved for themes that ship with Volli.
 *
 * Custom theme files must not use these slugs — a hand-dropped `ember.json`
 * must not collide with the shipped Ember entry in the picker or open an
 * in-place edit that overwrites the built-in.
 *
 * Keep this list in sync with `apps/desktop/src/renderer/src/theme/catalog.ts`.
 */

export const BUILTIN_THEME_SLUGS = [
  "ember",
  "midnight",
  "moss",
  "iris",
  "rose",
  "graphite",
] as const;

export type BuiltinThemeSlug = (typeof BUILTIN_THEME_SLUGS)[number];

const BUILTIN_SLUG_SET = new Set<string>(BUILTIN_THEME_SLUGS);

/** Whether `slug` names a shipped app-surface theme. */
export function isBuiltinThemeSlug(slug: string): slug is BuiltinThemeSlug {
  return BUILTIN_SLUG_SET.has(slug);
}

/**
 * Rejects a slug reserved for a built-in theme. Call before writing a custom
 * theme file; callers turn the throw into a typed error across IPC.
 */
export function rejectReservedThemeSlug(slug: string): void {
  if (isBuiltinThemeSlug(slug)) {
    throw new Error(`Theme slug ${JSON.stringify(slug)} is reserved for a built-in theme`);
  }
}
