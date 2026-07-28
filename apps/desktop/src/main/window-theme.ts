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
  // The hint is a snapshot of what the renderer painted LAST launch, and on
  // `auto` that snapshot is only as fresh as the OS preference was at that
  // moment. If the system flips while the app is closed, the hint's mode is now
  // the stale one — trusting it unconditionally would reintroduce the flash it
  // exists to prevent, from the other direction. An explicit `light`/`dark`
  // choice has no such expiry: it means the same thing regardless of what the OS
  // is doing, so the hint stays authoritative for it. Note this checks the
  // *stored* appearance, not `input.hint.appearance` — the hint's own field is
  // always a resolved `light`/`dark` (never `auto`), so it can't tell us which
  // case we're in.
  const explicit = input.appearance === "light" || input.appearance === "dark";
  if (input.hint !== null && explicit) return input.hint;
  const resolved = resolveAppearance(input.appearance ?? "auto", input.systemPrefersDark);
  // Re-resolving the mode means the hint's `background` (if any) belongs to the
  // OTHER mode and must not be reused — recompute it for the mode we just
  // settled on. Reusing it would paint a dark window edge around a light UI (or
  // vice versa), which is the flash this whole function exists to prevent.
  return { appearance: resolved, background: windowBackground(input.canvas, resolved) };
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
 * The flag carrying `nativeTheme.shouldUseDarkColors` — the boolean `auto`
 * resolves against — into the renderer alongside the resolved mode.
 *
 * It rides the same channel as the flag above for the same reason (the theme
 * store's singleton is constructed at import time and reads this for its initial
 * state, so an awaited answer is too late), but it exists for a second reason
 * that is worth stating: the renderer cannot work this out on its own. Chromium
 * resolves `matchMedia("(prefers-color-scheme: dark)")` against the root
 * element's used `color-scheme`, and this app stamps that itself — so that query
 * reads back whatever was last painted rather than what the system is asking
 * for. Measured on a Dark-mode Mac with the root in light: main said
 * `shouldUseDarkColors = true`, the renderer's query said `false`. `nativeTheme`
 * is the only honest source, and this is how its first answer gets across.
 *
 * Must match `SYSTEM_DARK_ARG_PREFIX` in `src/preload/index.ts`, duplicated as a
 * literal and pinned by a test here for the same reason as the flag above.
 */
export const SYSTEM_DARK_ARG = "--volli-system-dark=";

/**
 * The `additionalArguments` a window is constructed with. Electron documents
 * this as the way to pass "small bits of data down to renderer process preload
 * scripts", and two words are exactly that; the alternative — a synchronous IPC
 * call from the preload — blocks main on every window.
 *
 * `systemPrefersDark` arrives as an argument rather than being read here so this
 * module stays Electron-free and unit-testable — the same stance
 * {@link FirstPaintInput} takes on the same boolean.
 */
export function firstPaintArguments(paint: FirstPaintHint, systemPrefersDark: boolean): string[] {
  return [
    `${FIRST_PAINT_APPEARANCE_ARG}${paint.appearance}`,
    `${SYSTEM_DARK_ARG}${systemPrefersDark ? "1" : "0"}`,
  ];
}
