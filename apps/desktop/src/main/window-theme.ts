/**
 * The one color main has to know about: `BrowserWindow`'s `backgroundColor`.
 *
 * Main cannot read renderer CSS, so this used to be a hand-copied literal of
 * `--background` sitting next to a "keep the two in sync" comment. With themes
 * that stops being merely fragile and becomes wrong — the window edge would
 * keep the shipped color while the app repaints, and Chromium paints that color
 * during resizes and before first paint, so the old theme flashes at exactly
 * the two moments the user is most likely to notice.
 *
 * `generateThemeTokens` is pure `@volli/shared` code with no DOM and no
 * Electron dependency, so main runs the SAME generator over the SAME stored
 * definition the renderer does. No IPC round trip, and no possibility of drift.
 *
 * Deliberately Electron-free so it stays unit-testable: the `setBackgroundColor`
 * call site lives in `index.ts`, next to the windows it owns.
 */

import { DEFAULT_THEME, generateThemeTokens } from "@volli/shared";
import type { ThemeDefinition } from "@volli/shared";

/**
 * The window background for an authored theme — its generated `--background`.
 * `null` (nothing stored yet, or a stored theme that failed to parse) yields
 * the shipped default: a window is created long before any UI exists to
 * surface a read failure in, so this path must always produce a color.
 */
export function windowBackgroundColor(theme: ThemeDefinition | null): string {
  return generateThemeTokens(theme ?? DEFAULT_THEME)["--background"];
}
