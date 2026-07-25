/**
 * The user's own themes on disk: one JSON file each under
 * `<userData>/volli/themes/<slug>.json` (decision #71), so "Open file" and
 * "Reveal in Finder" are real affordances and a theme stays a shareable
 * artifact rather than a row in a database.
 *
 * Same three rules as `theme-overlay.ts`, for the same reasons:
 *
 *  - **The slug is the guard, and it runs before any filesystem call.**
 *    `customThemePath` throws on anything that is not a `slugify` fixed point,
 *    so a rejected slug is one no path was ever built from — a traversal is
 *    unrepresentable rather than caught late.
 *  - **Writes are atomic.** Content lands in a temp file *in the same
 *    directory* (rename is only atomic within one filesystem) and is renamed
 *    over the target, so an interrupted write leaves the previous theme intact
 *    rather than a half-written file the picker would then skip.
 *  - **Results are typed unions, never thrown errors.** These cross IPC, and a
 *    failed mutation must be surfaceable in the UI (CLAUDE.md).
 *
 * All string/path/codec logic lives in `@volli/shared`
 * (`theme/custom-themes.ts`); this module supplies only the filesystem,
 * through injected deps.
 */

import {
  customThemePath,
  errorMessage,
  parseThemeJson,
  serializeThemeFile,
  themeSlugFromFileName,
  volliThemesDir,
} from "@volli/shared";
import type { Result, ThemeDefinition } from "@volli/shared";
import type { FsDeps } from "./fs-deps";

/**
 * This module's slice of {@link FsDeps} (`defaultFsDeps` supplies the real
 * one), so every guard below is provable against a fake root — see
 * `trippedDeps` in the tests.
 *
 * The omissions are the point, exactly as in `ThemeOverlayDeps`: no `env` and
 * no `homeDir`, so nothing here can resolve a path outside the `userData` root
 * it was handed, whatever a slug says.
 */
export type ThemeFileDeps = Pick<
  FsDeps,
  | "userDataDir"
  | "readFile"
  | "readDir"
  | "ensureDir"
  | "writeFile"
  | "rename"
  | "removeFile"
  | "tempName"
>;

/**
 * Every custom theme on disk, sorted by display name.
 *
 * Best-effort by design: this walks a directory the user can drop anything
 * into, and one unreadable or hand-broken file must cost exactly itself. An
 * entry that isn't a theme file, doesn't parse, or doesn't hold a
 * `ThemeDefinition` is skipped — never fatal to the catalog, which is what the
 * picker renders.
 *
 * The FILE NAME is the identity: a theme is returned with its `slug` set from
 * the file it was found in, so copying `ember.json` to `my-ember.json` by hand
 * produces a second theme rather than a duplicate of the first.
 */
export function listCustomThemes(deps: ThemeFileDeps): ThemeDefinition[] {
  const dir = volliThemesDir(deps.userDataDir);
  const themes: ThemeDefinition[] = [];
  for (const entry of deps.readDir(dir)) {
    const slug = themeSlugFromFileName(entry);
    if (slug === null) continue;
    const theme = parseThemeJson(deps.readFile(`${dir}/${entry}`));
    if (theme === null) continue;
    themes.push({ ...theme, slug });
  }
  return themes.toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * The absolute path a slug names, or a typed error — the ONE place a slug
 * becomes a path in this module, so every verb below inherits the same guard
 * rather than repeating it. (A caller that only wants the path — reveal, open —
 * uses `customThemePath` from @volli/shared and lets the throw surface.)
 */
function resolveThemeFile(
  deps: Pick<ThemeFileDeps, "userDataDir">,
  slug: string,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    return { ok: true, path: customThemePath(deps.userDataDir, slug) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Result of reading one theme file: the authored theme, or a typed error. */
export type ThemeFileReadResult =
  | { ok: true; theme: ThemeDefinition }
  | { ok: false; error: string };

/**
 * Reads one custom theme by slug. A missing file and a file that no longer
 * holds a `ThemeDefinition` are both ORDINARY outcomes here — the user is
 * invited to hand-edit this file — so each is a typed error the UI can show,
 * never a throw across IPC.
 */
export function readCustomTheme(deps: ThemeFileDeps, slug: string): ThemeFileReadResult {
  const resolved = resolveThemeFile(deps, slug);
  if (!resolved.ok) return resolved;
  const text = deps.readFile(resolved.path);
  if (text === null) return { ok: false, error: "Theme was not found" };
  const theme = parseThemeJson(text);
  if (theme === null) {
    return { ok: false, error: `Theme file could not be read as a theme: ${resolved.path}` };
  }
  // The file name is the identity — same rule listCustomThemes applies.
  return { ok: true, theme: { ...theme, slug } };
}

/** Result of a theme-file write: the path written, or a typed error. */
export type ThemeFileWriteResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Writes `theme` to its own file, named by its slug: guard → serialize →
 * atomic replace. The guard runs BEFORE any filesystem call, so a rejected
 * slug is a slug nothing was ever attempted against.
 */
export function writeCustomTheme(
  deps: ThemeFileDeps,
  theme: ThemeDefinition,
): ThemeFileWriteResult {
  const resolved = resolveThemeFile(deps, theme.slug);
  if (!resolved.ok) return resolved;
  try {
    const tempPath = deps.tempName(resolved.path);
    deps.ensureDir(volliThemesDir(deps.userDataDir));
    deps.writeFile(tempPath, serializeThemeFile(theme));
    deps.rename(tempPath, resolved.path);
    return { ok: true, path: resolved.path };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Deletes one custom theme. Deleting a theme that is already gone SUCCEEDS —
 * the user asked for it not to be there, and it isn't; failing a `⋯ → Delete`
 * against a file a hand-edit already removed would be noise, not information.
 */
export function deleteCustomTheme(deps: ThemeFileDeps, slug: string): Result {
  const resolved = resolveThemeFile(deps, slug);
  if (!resolved.ok) return resolved;
  try {
    deps.removeFile(resolved.path);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
