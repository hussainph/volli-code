/**
 * What the two Appearance surfaces — app-wide Settings and a project's
 * Configure — say about the terminal, and how they open the files behind it.
 *
 * It lives beside the rows rather than inside either page so neither page has
 * to import the other, and so the global and per-project rows cannot end up
 * describing the terminal differently.
 *
 * NEITHER SURFACE LISTS THEMES ANY MORE (VC-413), which is why this file is no
 * longer called `appearance-catalog.ts`. It used to hand both pages a picker's
 * worth of items — 463 names read out of a theme catalog vendored from
 * Ghostty.app, whose individual provenance was never verified. The catalog is
 * gone and the picker with it: the terminal's theme is whatever the user's own
 * ghostty config chain names, which is what decision #67 always said the file,
 * not this panel, was for. The rows still SAY what is in force and where it came
 * from, and still revert Volli's own overlay key.
 *
 * The EDITOR is not offered here either (VC-123): it has one light theme and
 * one dark theme, chosen by the resolved appearance, so there is nothing to
 * list and nothing to open.
 */

import { errorMessage } from "@volli/shared";
import type { ResolvedAppearance } from "@volli/shared";

import { toastError } from "@renderer/lib/toast";
import { TOKEN_THEME_NAMES } from "@renderer/terminal/appearance";

/**
 * What the terminal wears when no layer names a theme — and, since VC-413, also
 * when a layer names one no file on this machine answers to: the palette derived
 * from the app's own tokens (terminal/appearance.ts). It is a LABEL, never a
 * value anything writes.
 *
 * Takes the appearance because that palette has two names, one per mode, and a
 * constant here could only ever be right about one of them: under light the row
 * read "Volli Dark" over a terminal that was rendering Volli Light. The names
 * come from the module that builds the theme, so the label and the palette
 * cannot disagree.
 */
export function fallbackTerminalThemeLabel(resolved: ResolvedAppearance): string {
  return TOKEN_THEME_NAMES[resolved];
}

/**
 * Reveal a config file in Finder — #67's "the file, not this panel, is the full
 * interface". A missing path or a failed reveal toasts rather than doing
 * nothing: `shell` reports failure by returning, never by throwing.
 */
export async function revealPath(path: string | null): Promise<void> {
  if (path === null) {
    toastError("Terminal config hasn't loaded yet.");
    return;
  }
  try {
    const result = await window.api.fs.revealInFinder(path);
    if (!result.ok) toastError(`Couldn't reveal ${path}: ${result.error}`);
  } catch (error) {
    toastError(`Couldn't reveal ${path}: ${errorMessage(error)}`);
  }
}
