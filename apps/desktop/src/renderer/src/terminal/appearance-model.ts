/**
 * Pure mapping from the user's Ghostty config (as shipped by the main
 * process, issue #18) onto a resolved `TerminalAppearance`. No DOM, no IPC —
 * the glue that reads design tokens and talks to the preload bridge lives in
 * appearance.ts; this module is the unit-tested logic layer.
 */
import { getBuiltinTheme, parseGhosttyTheme } from "restty";
import type { GhosttyTheme } from "restty";
import { parseGhosttyTerminalPrefs } from "@volli/shared";
import type { GhosttyAppearancePayload, ResolvedAppearance } from "@volli/shared";

import type { TerminalAppearance } from "./engine";

/** Terminal font size in CSS pixels when the config sets none. */
export const DEFAULT_TERMINAL_FONT_SIZE = 14;

/**
 * Families appended after the user's `font-family` chain. JetBrains Mono is
 * ghostty's own default (bundled there, resolved locally here when
 * installed); SF Mono and Menlo guarantee a monospace face on every macOS
 * install, so the font chain can never come up empty.
 */
export const FALLBACK_FONT_FAMILIES = [
  "JetBrainsMono Nerd Font",
  "JetBrains Mono",
  "SF Mono",
  "Menlo",
] as const;

/** Configured families first, fallbacks appended, case-insensitive dedup. */
export function terminalFontFamilies(configured: readonly string[]): string[] {
  const families: string[] = [];
  const seen = new Set<string>();
  for (const family of [...configured, ...FALLBACK_FONT_FAMILIES]) {
    const key = family.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    families.push(family.trim());
  }
  return families;
}

/**
 * Ghostty semantics for explicit color keys: the theme loads first, then
 * color keys written directly in the config override it. `overlay` is the
 * config text parsed as a theme — only the keys it actually defines win.
 */
export function overlayGhosttyTheme(base: GhosttyTheme, overlay: GhosttyTheme): GhosttyTheme {
  const palette = [...base.colors.palette];
  overlay.colors.palette.forEach((entry, index) => {
    if (entry !== undefined) palette[index] = entry;
  });
  return {
    name: base.name,
    raw: { ...base.raw, ...overlay.raw },
    colors: {
      ...base.colors,
      // Spread of DEFINED overlay keys only: `?? base` per key would drop
      // the distinction between "unset" and an explicit undefined.
      ...Object.fromEntries(
        Object.entries(overlay.colors).filter(
          ([key, value]) => key !== "palette" && value !== undefined,
        ),
      ),
      palette,
    },
  };
}

/**
 * The theme name in force for `appearance`, re-resolved rather than trusted.
 *
 * `prefs.themeName` was resolved in main, where the mode is not known — a
 * ghostty `theme = light:X,dark:Y` pair therefore arrives collapsed to whichever
 * half main defaulted to. The config text travels with the payload, so the
 * cheapest honest answer is to re-run the same pure parse against the LIVE mode;
 * it also means a light↔dark flip re-picks the theme with no file read at all.
 */
function liveThemeName(
  payload: GhosttyAppearancePayload,
  appearance: ResolvedAppearance,
): string | null {
  if (payload.prefs.themeName === null || payload.configText === null) {
    return payload.prefs.themeName;
  }
  return parseGhosttyTerminalPrefs(payload.configText, appearance).themeName;
}

/**
 * Resolve the theme for a payload: named custom theme file, else builtin
 * catalog (restty bundles ghostty's full theme collection), else the app's
 * token-derived fallback — then overlay any explicit color keys from the
 * config text on whichever base won.
 */
export function resolveGhosttyThemeChoice(
  payload: GhosttyAppearancePayload,
  fallbackTheme: GhosttyTheme,
  appearance: ResolvedAppearance,
): GhosttyTheme {
  const themeName = liveThemeName(payload, appearance);
  let base: GhosttyTheme | null = null;
  // `themeSource` is the file main read for the half IT resolved. When the live
  // mode picks the other half that text belongs to the wrong theme, so the
  // catalog (and failing that, the mode-correct token fallback) has to answer
  // instead — painting a dark theme's file in light mode is the exact failure
  // being fixed here.
  if (payload.themeSource !== null && themeName === payload.prefs.themeName) {
    base = parseGhosttyTheme(payload.themeSource);
  } else if (themeName !== null) {
    base = getBuiltinTheme(themeName);
  }
  let resolved = base ?? fallbackTheme;
  if (payload.configText !== null) {
    resolved = overlayGhosttyTheme(resolved, parseGhosttyTheme(payload.configText));
  }
  return resolved;
}

/** The full payload → appearance mapping (null payload = no config at all). */
export function resolveAppearance(
  payload: GhosttyAppearancePayload | null,
  fallbackTheme: GhosttyTheme,
  appearance: ResolvedAppearance,
): TerminalAppearance {
  if (payload === null) {
    return {
      theme: fallbackTheme,
      fontFamilies: terminalFontFamilies([]),
      fontSize: DEFAULT_TERMINAL_FONT_SIZE,
      ligatures: true,
      mouseReporting: true,
      macosOptionAsAlt: false,
      scrollbackLimitBytes: null,
    };
  }
  const { prefs } = payload;
  return {
    theme: resolveGhosttyThemeChoice(payload, fallbackTheme, appearance),
    fontFamilies: terminalFontFamilies(prefs.fontFamilies),
    fontSize: prefs.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
    ligatures: prefs.ligatures ?? true,
    mouseReporting: prefs.mouseReporting ?? true,
    macosOptionAsAlt: prefs.macosOptionAsAlt ?? false,
    scrollbackLimitBytes: prefs.scrollbackLimitBytes,
  };
}
