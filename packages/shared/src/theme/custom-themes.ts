/**
 * Where a user's OWN themes live, and what makes a file name legal there.
 *
 * Decision #71: a theme is a plain file. One JSON file per theme under
 * `<userDataDir>/volli/themes/<slug>.json`, so "Open file" and "Reveal in
 * Finder" are real affordances and a theme stays a shareable artifact — the
 * same "UI for the common case, file for full power" story decision #68 gives
 * the terminal overlay.
 *
 * The slug is the whole security boundary, so it is settled here, in pure
 * string logic, before any path exists to be checked: {@link isValidThemeSlug}
 * accepts only what {@link slugify} itself produces, and slugify's output
 * alphabet is `[a-z0-9-]`. A traversal segment, an absolute path, a backslash,
 * an empty name — none of them are slugify fixed points, so none of them are
 * representable as a theme slug at all. That is deliberately the same shape as
 * `projectGhosttyOverlayPath`'s reuse of `isValidPrefix`: the app's existing
 * rule for the identifier, not a second regex invented at the filesystem edge
 * that could drift from it.
 *
 * Pure string/path logic only — no Node imports (this package must stay usable
 * from main, preload, and the CLI alike). The filesystem half is
 * `apps/desktop/src/main/theme-files.ts`.
 */

import { slugify } from "../ticket-branch";
import { persistedTheme } from "./persistence";
import type { ThemeDefinition } from "./definition";

/** Strips a single trailing slash, so `<dir>/` and `<dir>` build the same path. */
function stripTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The extension every custom theme file carries. */
export const THEME_FILE_EXTENSION = ".json";

/** Volli's custom-theme root: `<userDataDir>/volli/themes`. The ONLY directory a theme-file op may touch. */
export function volliThemesDir(userDataDir: string): string {
  return `${stripTrailingSlash(userDataDir)}/volli/themes`;
}

/**
 * Whether `slug` can name a theme file. True exactly when the slug is a
 * {@link slugify} fixed point and non-empty — which bounds it to `[a-z0-9-]`,
 * to slugify's length cap, and to no leading/trailing hyphen. `..`, `/`, `\`,
 * a leading `~`, an absolute path and the empty string all fail, so a traversal
 * is unrepresentable rather than merely rejected.
 */
export function isValidThemeSlug(slug: string): boolean {
  return slug.length > 0 && slugify(slug) === slug;
}

/**
 * A custom theme's file: `<userDataDir>/volli/themes/<slug>.json`.
 *
 * Throws on an invalid slug rather than building a path from it — same stance
 * as {@link projectGhosttyOverlayPath}, so a rejected slug is one no path was
 * ever derived from. Callers turn the throw into a typed error.
 */
export function customThemePath(userDataDir: string, slug: string): string {
  if (!isValidThemeSlug(slug)) {
    throw new Error(`Invalid theme slug: ${JSON.stringify(slug)}`);
  }
  return `${volliThemesDir(userDataDir)}/${slug}${THEME_FILE_EXTENSION}`;
}

/**
 * The slug a directory entry names, or `null` when the entry is not a theme
 * file at all (wrong extension, or a name no theme could have been written
 * under). The listing walks a directory the user can drop anything into, so
 * this is a filter, never an assertion.
 */
export function themeSlugFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(THEME_FILE_EXTENSION)) return null;
  const slug = fileName.slice(0, -THEME_FILE_EXTENSION.length);
  return isValidThemeSlug(slug) ? slug : null;
}

/**
 * The JSON a theme file holds. Pretty-printed with a trailing newline because
 * this file is meant to be opened, read and hand-edited (#71) — and rebuilt
 * field by field by {@link persistedTheme}, so a resolved token set cannot
 * reach a theme file any more than it can reach `app_state`.
 */
export function serializeThemeFile(theme: ThemeDefinition): string {
  return `${JSON.stringify(persistedTheme(theme), null, 2)}\n`;
}
