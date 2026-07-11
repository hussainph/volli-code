/**
 * Pure mapping from the user's Ghostty config (as shipped by the main
 * process, issue #18) onto a resolved `TerminalAppearance`. No DOM, no IPC —
 * the glue that reads design tokens and talks to the preload bridge lives in
 * appearance.ts; this module is the unit-tested logic layer.
 */
import { getBuiltinTheme, parseGhosttyTheme } from "restty";
import type { GhosttyTheme } from "restty";
import type { GhosttyAppearancePayload } from "@volli/shared";

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
 * Resolve the theme for a payload: named custom theme file, else builtin
 * catalog (restty bundles ghostty's full theme collection), else the app's
 * token-derived fallback — then overlay any explicit color keys from the
 * config text on whichever base won.
 */
export function resolveGhosttyThemeChoice(
  payload: GhosttyAppearancePayload,
  fallbackTheme: GhosttyTheme,
): GhosttyTheme {
  let base: GhosttyTheme | null = null;
  if (payload.themeSource !== null) {
    base = parseGhosttyTheme(payload.themeSource);
  } else if (payload.prefs.themeName !== null) {
    base = getBuiltinTheme(payload.prefs.themeName);
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
    theme: resolveGhosttyThemeChoice(payload, fallbackTheme),
    fontFamilies: terminalFontFamilies(prefs.fontFamilies),
    fontSize: prefs.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
    ligatures: prefs.ligatures ?? true,
    mouseReporting: prefs.mouseReporting ?? true,
    macosOptionAsAlt: prefs.macosOptionAsAlt ?? false,
    scrollbackLimitBytes: prefs.scrollbackLimitBytes,
  };
}
