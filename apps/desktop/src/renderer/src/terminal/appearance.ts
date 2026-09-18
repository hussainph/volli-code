/**
 * Terminal appearance state: the user's real Ghostty config (fetched from
 * main over IPC, live-reloaded on file edits — issue #18) resolved against
 * the app's design-token fallback theme.
 *
 * Font strategy: the families are handed to xterm.js as a CSS `font-family`
 * chain, so Chromium resolves them against the fonts actually installed —
 * exactly like ghostty does. No bundled font bytes, and the same config
 * renders the same face in both apps. The Local Font Access API (main grants
 * the `local-fonts` permission) is what lets the settings picker LIST those
 * families; it is not how a terminal loads one.
 */
import {
  gamutMap,
  hexChannels,
  hexToOklch,
  oklchToHex,
  rgbToHex,
  solveLightnessOrCeiling,
} from "@volli/shared";
import type {
  GhosttyAppearancePayload,
  GhosttyTheme,
  ResolvedAppearance,
  ThemeColor,
} from "@volli/shared";

import { resolvedAppearance } from "@renderer/lib/resolved-appearance";

import { resolveAppearance } from "./appearance-model";
import { parseHexColor } from "./css-color";
import type { TerminalAppearance } from "./engine";

const rgb = (r: number, g: number, b: number): ThemeColor => ({ r, g, b });

/**
 * What the token-derived theme calls itself in each mode.
 *
 * Exported because the Terminal settings row has to print this name for a
 * terminal that no layer named a theme for, and a second literal there went
 * stale the moment light shipped — the picker said "Volli Dark" over a terminal
 * rendering Volli Light.
 */
export const TOKEN_THEME_NAMES: Record<ResolvedAppearance, string> = {
  dark: "Volli Dark",
  light: "Volli Light",
};

/** The four app tokens this fallback theme is built from, for one appearance. */
interface FallbackTokens {
  background: ThemeColor;
  foreground: ThemeColor;
  cursor: ThemeColor;
  ansiRed: ThemeColor;
}

/**
 * Literal fallbacks mirroring globals.css (i.e. the shipped default canvas) in
 * each mode, used only when a token is missing or unparseable — e.g. the
 * stylesheet has not applied yet.
 *
 * Emitted by the same command that writes globals.css's two blocks, and for the
 * same reason: this is the fourth copy of those hexes, and the only one nothing
 * on screen would contradict if it drifted. `appearance.test.ts` re-derives them
 * from `@volli/shared` and fails on any gap, because the previous note here —
 * "regenerate these whenever globals.css is regenerated" — was a comment, and a
 * comment is not a mechanism.
 */
/* GENERATED TERMINAL FALLBACK TOKENS — BEGIN */
export const FALLBACK_TOKENS: Record<ResolvedAppearance, FallbackTokens> = {
  dark: {
    background: rgb(0x1c, 0x13, 0x10), // --background
    foreground: rgb(0xe8, 0xe4, 0xe2), // --foreground
    cursor: rgb(0xb8, 0x5d, 0x38), // --primary
    ansiRed: rgb(0xff, 0xa4, 0x9f), // --destructive
  },
  light: {
    background: rgb(0xfd, 0xde, 0xd2), // --background
    foreground: rgb(0x12, 0x09, 0x06), // --foreground
    cursor: rgb(0xb8, 0x5d, 0x38), // --primary
    ansiRed: rgb(0x9b, 0x1e, 0x28), // --destructive
  },
};
/* GENERATED TERMINAL FALLBACK TOKENS — END */

/**
 * Selection fill. Dark's is a neutral grey lifted off the near-black ground;
 * light's is its mirror about mid-grey (0x34 below white rather than above
 * black), so the selection sits the same perceptual step off the background in
 * both modes and `selectionForeground` keeps the same relative contrast.
 */
const SELECTION_BACKGROUND: Record<ResolvedAppearance, ThemeColor> = {
  dark: rgb(0x34, 0x34, 0x34),
  light: rgb(0xcb, 0xcb, 0xcb),
};

/**
 * The dark ANSI set: terminal-domain color with no matching app tokens, so it
 * is authored — except normal red, which mirrors `--destructive`.
 *
 * The app's own restrained set, tuned to sit on a near-black background. It is
 * also the SOURCE OF HUE for the light set below, which is why it is named
 * rather than inlined.
 */
const DARK_ANSI_PALETTE: readonly ThemeColor[] = [
  // Normal (0-7)
  rgb(0x1c, 0x1c, 0x1c), // black
  rgb(0xe5, 0x48, 0x4d), // red — replaced by --destructive
  rgb(0x46, 0xa7, 0x58), // green
  rgb(0xf0, 0xc0, 0x00), // yellow
  rgb(0x53, 0x91, 0xf5), // blue
  rgb(0xb1, 0x6b, 0xf5), // magenta
  rgb(0x2a, 0xc0, 0xc7), // cyan
  rgb(0xd6, 0xd6, 0xd6), // white
  // Bright (8-15)
  rgb(0x6b, 0x6b, 0x6b), // bright black
  rgb(0xff, 0x6b, 0x6f), // bright red
  rgb(0x6c, 0xd9, 0x75), // bright green
  rgb(0xff, 0xd5, 0x43), // bright yellow
  rgb(0x7d, 0xac, 0xff), // bright blue
  rgb(0xc9, 0x8d, 0xff), // bright magenta
  rgb(0x5a, 0xe0, 0xe6), // bright cyan
  rgb(0xff, 0xff, 0xff), // bright white
];

/**
 * The paper the light set is solved against: the shipped canvas's own light
 * background, read from the generated table above rather than restated, so the
 * palette and the canvas it was solved for cannot drift apart.
 */
const LIGHT_GROUND = rgbToHex({
  r: FALLBACK_TOKENS.light.background.r / 255,
  g: FALLBACK_TOKENS.light.background.g / 255,
  b: FALLBACK_TOKENS.light.background.b / 255,
});

/**
 * The four grey slots' APCA contrast targets against light paper, by palette
 * index.
 *
 * A RAMP, and the numbers are its shape: black hardest, then bright black,
 * then white, then bright white faintest. That descent is what keeps the light
 * ramp's luminance order (0 < 8 < 7 < 15) identical to the dark set's while the
 * ground moves to the other end of it — so `bright black` still means "dim" and
 * `bright white` still means "faint", which is the meaning programs actually
 * attach to those two slots. 58 for `white` is the load-bearing one: ordinary
 * program output, held well clear of the 3:1 floor `appearance.test.ts` pins.
 */
const LIGHT_GREY_TARGET_LC: Record<number, number> = { 0: 86, 8: 70, 7: 58, 15: 42 };

/** APCA targets for the twelve chromatic slots: the bright row sits one step off the paper. */
const LIGHT_CHROMATIC_TARGET_LC = { normal: 72, bright: 56 } as const;

/** Solved on first use; see {@link lightAnsiPalette}. */
let cachedLightPalette: readonly ThemeColor[] | null = null;

/** Chroma the color space can actually deliver at this lightness and hue. */
function maxChroma(L: number, h: number): number {
  // 0.5 is past the sRGB chroma ceiling at every hue, so gamutMap answers with
  // the ceiling itself rather than the ask.
  return gamutMap(L, 0.5, h).C;
}

/**
 * The light ANSI set, DERIVED FROM THE DARK ONE rather than adopted (VC-413).
 *
 * What used to be here was GitHub Light Default, copied verbatim out of the
 * vendored Ghostty theme catalog. The catalog is gone because nobody had
 * verified what any of it was licensed under, and a sixteen-colour excerpt of it
 * is no more ours to ship than the whole. Replacing it with some other
 * established light set would only move the same question, so this set is
 * SOLVED, from material the app already owns:
 *
 *   • HUE comes from `DARK_ANSI_PALETTE`. That is the app's own statement of
 *     what its ANSI green *is*, and keeping it means a mode flip does not
 *     change which colour a program asked for — only how it is rendered.
 *   • LIGHTNESS is solved so each entry clears its APCA target against the
 *     light ground, by the same solver the canvas ladder uses. A light palette
 *     is not a lightened dark one: every hue has to be pushed DOWN to survive
 *     light paper, and solving for the target is what makes that survival a
 *     measured fact rather than a hand-picked hope.
 *   • CHROMA keeps each entry's RELATIVE saturation — its share of the chroma
 *     the space allows at its own lightness. Holding the raw chroma instead
 *     would mute every colour on the way down, because the sRGB cone is widest
 *     in the middle; holding the share is what keeps a vivid dark magenta a
 *     vivid light one. The lightness is re-solved once after the chroma is
 *     restored, since a more saturated ink reaches the same target at a
 *     slightly different lightness.
 *
 * The greys are solved at chroma 0 — neutral, exactly as the dark set's are,
 * rather than tinted toward the paper.
 *
 * Computed once, on first use, and never again: the ground is a constant, so
 * there is nothing for a repaint to change. ~30 solver runs, a few milliseconds,
 * and only when a config-less terminal actually paints in light mode — which is
 * why the cache matters, since a canvas drag invalidates the token theme on
 * every frame.
 */
function lightAnsiPalette(): readonly ThemeColor[] {
  if (cachedLightPalette !== null) return cachedLightPalette;

  cachedLightPalette = DARK_ANSI_PALETTE.map((entry, index) => {
    const { L: darkL, C: darkC, h } = hexToOklch(rgbToHex(toUnit(entry)));
    const greyTarget = LIGHT_GREY_TARGET_LC[index];
    if (greyTarget !== undefined) {
      return themeColor(oklchToHex(solveLightnessOrCeiling(greyTarget, 0, h, LIGHT_GROUND), 0, h));
    }

    const target = index < 8 ? LIGHT_CHROMATIC_TARGET_LC.normal : LIGHT_CHROMATIC_TARGET_LC.bright;
    const share = darkC / maxChroma(darkL, h);
    const firstPass = solveLightnessOrCeiling(target, darkC, h, LIGHT_GROUND);
    const C = share * maxChroma(firstPass, h);
    const L = solveLightnessOrCeiling(target, C, h, LIGHT_GROUND);
    return themeColor(oklchToHex(L, share * maxChroma(L, h), h));
  });
  return cachedLightPalette;
}

/** 0-255 {@link ThemeColor} → the 0-1 channels the color module works in. */
function toUnit({ r, g, b }: ThemeColor): { r: number; g: number; b: number } {
  return { r: r / 255, g: g / 255, b: b / 255 };
}

/** `#rrggbb` → {@link ThemeColor}. */
function themeColor(hex: string): ThemeColor {
  const [r, g, b] = hexChannels(hex);
  return { r, g, b };
}

/** The mode's ANSI set with normal red replaced by the app's `--destructive`. */
function terminalPalette(red: ThemeColor, appearance: ResolvedAppearance): ThemeColor[] {
  const palette = [...(appearance === "dark" ? DARK_ANSI_PALETTE : lightAnsiPalette())];
  palette[1] = red;
  return palette;
}

/**
 * Whether a color is a dark surface — asked of the RESOLVED background, which
 * is the only thing the palette choice may depend on.
 *
 * The stamped mode would be the obvious input and is the wrong one: this theme
 * is assembled from whatever `--background` currently reads, so keying the
 * palette off anything else lets the two disagree for a frame — and a disagreement
 * here does not throw, it just renders a dark palette on a light ground. That
 * silence is the whole bug: `parseHexColor` succeeds in either mode, so nothing
 * upstream ever notices.
 */
function isDarkSurface({ r, g, b }: ThemeColor): boolean {
  // Rec. 601 luma — the standard cheap "is this dark?" test. The exact
  // threshold is not load-bearing: every canvas the generator produces sits far
  // from the middle of the range.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/**
 * Build the fallback theme from the live design tokens so a config-less
 * terminal cannot drift from globals.css. `complete` is false when any token
 * failed to read.
 */
function buildTokenTheme(): { theme: GhosttyTheme; complete: boolean } {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string): ThemeColor | null => parseHexColor(styles.getPropertyValue(name));

  // The stamped mode decides only which literals stand in for tokens that could
  // not be read; everything below follows the colors themselves.
  const fallback = FALLBACK_TOKENS[resolvedAppearance()];
  const background = token("--background");
  const foreground = token("--foreground");
  const cursor = token("--primary");
  const ansiRed = token("--destructive");
  const complete =
    background !== null && foreground !== null && cursor !== null && ansiRed !== null;

  const bg = background ?? fallback.background;
  const fg = foreground ?? fallback.foreground;
  const appearance: ResolvedAppearance = isDarkSurface(bg) ? "dark" : "light";
  return {
    theme: {
      name: TOKEN_THEME_NAMES[appearance],
      raw: {},
      colors: {
        background: bg,
        foreground: fg,
        cursor: cursor ?? fallback.cursor,
        cursorText: bg,
        selectionBackground: SELECTION_BACKGROUND[appearance],
        selectionForeground: fg,
        palette: terminalPalette(ansiRed ?? fallback.ansiRed, appearance),
      },
    },
    complete,
  };
}

let cachedTokenTheme: GhosttyTheme | null = null;

/**
 * Tokens are read at build time, NOT module import time — the stylesheet may
 * not be applied yet when this module loads. A theme built from a partial
 * read is served but not cached, so a later call retries the tokens.
 */
function tokenTheme(): GhosttyTheme {
  if (cachedTokenTheme !== null) return cachedTokenTheme;
  const { theme, complete } = buildTokenTheme();
  if (complete) cachedTokenTheme = theme;
  return theme;
}

// ---- Ghostty config state ---------------------------------------------------

let payload: GhosttyAppearancePayload | null = null;
let cachedAppearance: TerminalAppearance | null = null;
let initStarted = false;

const changeListeners = new Set<() => void>();

/** Drop the derived appearance and tell live terminals to re-read it. */
function invalidateAndNotify(): void {
  cachedAppearance = null;
  for (const listener of changeListeners) listener();
}

/**
 * The appearance every terminal renders with right now. Safe to call before
 * `initTerminalAppearance` resolves — you get the token fallback, and the
 * change event fires once the real config lands.
 */
export function getCurrentAppearance(): TerminalAppearance {
  // The stamped mode, not the token background: a `light:X,dark:Y` theme pair
  // in the user's ghostty config is a statement about the appearance they chose,
  // and it must be re-answered on every mode flip without re-reading the file.
  cachedAppearance ??= resolveAppearance(payload, tokenTheme(), resolvedAppearance());
  return cachedAppearance;
}

/** Subscribe to appearance changes (initial config load + live file edits). */
export function onTerminalAppearanceChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function acceptPayload(next: GhosttyAppearancePayload): void {
  payload = next;
  invalidateAndNotify();
}

/**
 * Drops the cached token-derived palette and republishes the appearance.
 *
 * `tokenTheme`'s cache is permanent by design — design tokens used to be
 * authored once in globals.css and never move — which the theming engine makes
 * false: once the app theme changes at runtime, every config-less terminal
 * would keep rendering the palette it happened to read at boot. Called from the
 * theme apply path (`renderer/src/theme/apply.ts`), the single place app tokens
 * change, so this stays an invalidation hook rather than a polling read.
 */
export function refreshTerminalTokenTheme(): void {
  cachedTokenTheme = null;
  invalidateAndNotify();
}

/**
 * Fetch the Ghostty config once and subscribe to main's file-watch pushes.
 * Idempotent; call at renderer boot. A read failure is not a mutation — the
 * terminal keeps its token-derived defaults and the failure is logged, not
 * toasted.
 */
export async function initTerminalAppearance(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  window.api.terminal.onGhosttyConfigChanged(acceptPayload);
  try {
    const result = await window.api.terminal.ghosttyConfig();
    if (result.ok) {
      acceptPayload(result.value);
    } else {
      console.warn("ghostty config read failed:", result.error);
    }
  } catch (error) {
    console.warn("ghostty config read failed:", error);
  }
}
