/**
 * What the two Appearance surfaces — app-wide Settings and a project's
 * Configure — offer and open.
 *
 * It lives beside the picker rather than inside either page so neither page has
 * to import the other, and so the global and per-project rows cannot end up
 * listing different catalogs.
 *
 * The EDITOR is not offered here any more (VC-123): it has one light theme and
 * one dark theme, chosen by the resolved appearance, so there is nothing to
 * list and nothing to open.
 */

import { errorMessage } from "@volli/shared";
import type { ResolvedAppearance } from "@volli/shared";
import { listBuiltinThemeNames } from "restty";

import type { ThemeComboBoxItem } from "@renderer/components/theme/theme-combo-box";
import { toastError } from "@renderer/lib/toast";
import { TOKEN_THEME_NAMES } from "@renderer/terminal/appearance";

/**
 * What the terminal wears when no layer names a theme: the palette derived from
 * the app's own tokens (terminal/appearance.ts), which has no catalog entry to
 * check-mark — so it is a LABEL, never a value anything writes.
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
 * restty's bundled catalog — which IS ghostty's full theme collection, already
 * in the app bundle, so the terminal picker needs no network and no disk read.
 */
export function terminalThemeItems(): ThemeComboBoxItem[] {
  return listBuiltinThemeNames().map((name) => ({ value: name, label: name }));
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
