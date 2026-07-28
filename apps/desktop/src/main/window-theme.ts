/**
 * The two things main has to know before a renderer exists: what color the
 * window's edge is, and whether the app is in light or dark.
 *
 * Both are first-paint problems, and they are the same problem. Chromium paints
 * `BrowserWindow.backgroundColor` during resizes and before first paint, and the
 * renderer's mode class has to be on `<html>` before the first frame — so a
 * value that arrives over IPC arrives a frame too late, and the user sees a
 * flash of the wrong palette at exactly the two moments they are most likely to
 * notice.
 *
 * Two sources, in order:
 *
 *  1. **The `first-paint` hint** — what the renderer actually resolved and
 *     painted last launch. Preferred, and the reason it exists at all: the
 *     renderer may have been showing a WORKSPACE, whose canvas and appearance
 *     override the global ones, and which workspace was open is renderer state
 *     main cannot resolve. Re-deriving here would repaint the window edge to the
 *     global canvas and then let the renderer correct it — the flash again.
 *  2. **The stored global pair**, run through the same pure `@volli/shared`
 *     pipeline the renderer uses (`windowBackground`/`resolveAppearance`), with
 *     `nativeTheme.shouldUseDarkColors` answering `auto`. No IPC round trip and
 *     no possibility of drift; this is what a first-ever launch gets.
 *
 * Deliberately Electron-free so it stays unit-testable: the caller reads
 * `nativeTheme` and passes a boolean, and the `setBackgroundColor`/
 * `additionalArguments` call sites live in `index.ts`, next to the windows they
 * own.
 */

import { resolveAppearance, windowBackground } from "@volli/shared";
import type { Appearance, Canvas, FirstPaintHint } from "@volli/shared";

/**
 * Everything main can read synchronously at window construction. Passed as one
 * object rather than four arguments because they are read together, from the
 * same db handle, at the same moment — and because a caller that supplies three
 * of the four has a bug this shape makes visible.
 */
export interface FirstPaintInput {
  /** The recorded hint, or null on a first-ever launch (or an unreadable row). */
  hint: FirstPaintHint | null;
  /** The stored global canvas; null falls back to the shipped default. */
  canvas: Canvas | null;
  /** The stored global appearance; null means the user has never chosen, which is `auto`. */
  appearance: Appearance | null;
  /** `nativeTheme.shouldUseDarkColors` — what `auto` resolves against. */
  systemPrefersDark: boolean;
}

/**
 * The mode and background to construct a window with. Always produces both: a
 * window is created long before any UI exists to surface a read failure in, so
 * every arm of this has to end in a color.
 */
export function resolveFirstPaint(input: FirstPaintInput): FirstPaintHint {
  if (input.hint !== null) return input.hint;
  const resolved = resolveAppearance(input.appearance ?? "auto", input.systemPrefersDark);
  return { appearance: resolved, background: windowBackground(input.canvas, resolved) };
}

/** The window background alone — {@link resolveFirstPaint}'s color half. */
export function windowBackgroundColor(input: FirstPaintInput): string {
  return resolveFirstPaint(input).background;
}

/**
 * The flag carrying the resolved mode into the renderer, via
 * `webPreferences.additionalArguments` → the preload's `process.argv`.
 *
 * Must match `FIRST_PAINT_ARG_PREFIX` in `src/preload/index.ts`, which reads it.
 * The preload cannot import this module (main and preload are kept
 * dependency-disjoint) and may not import @volli/shared at runtime either, so
 * the literal is stated in both places and pinned by a test here.
 */
export const FIRST_PAINT_APPEARANCE_ARG = "--volli-first-paint-appearance=";

/**
 * The `additionalArguments` a window is constructed with. Electron documents
 * this as the way to pass "small bits of data down to renderer process preload
 * scripts", and one word is exactly that; the alternative — a synchronous IPC
 * call from the preload — blocks main on every window.
 */
export function firstPaintArguments(paint: FirstPaintHint): string[] {
  return [`${FIRST_PAINT_APPEARANCE_ARG}${paint.appearance}`];
}
