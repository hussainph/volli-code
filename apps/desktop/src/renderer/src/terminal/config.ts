/**
 * Terminal appearance: the Ghostty-format color theme derived from the app's
 * design tokens (globals.css) and the bundled monospace font.
 *
 * Font strategy: restty's text-shaper rasterizes glyphs itself, so it needs the
 * raw font BYTES — a CSS `font-family` alone does nothing for its canvas. Its
 * default font chain reaches for the Local Font Access API and then remote CDN
 * URLs; under our strict CSP and the packaged `file://` origin both are
 * unavailable and the chain THROWS (blank terminal). So we hand it Geist Mono
 * explicitly, inlined as base64 into the bundle (see data-uri.ts) so it loads
 * with no fetch under both dev and the packaged build.
 */
import geistMonoWoff2 from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?inline";
import type { GhosttyTheme, ResttyFontInput, ResttyTerminalConfig } from "restty";

import { parseHexColor } from "./css-color";
import { decodeBase64DataUri } from "./data-uri";

// `ThemeColor` is not re-exported from restty's entry; it is structurally just
// an 0-255 RGBA record, so a local alias stays assignable to the palette type.
type ThemeColor = { r: number; g: number; b: number; a?: number };

const rgb = (r: number, g: number, b: number): ThemeColor => ({ r, g, b });

// Literal fallbacks mirroring globals.css, used only when a token is missing
// or unparseable (e.g. the stylesheet has not applied yet).
const FALLBACK_BACKGROUND = rgb(0x11, 0x11, 0x11); // --background
const FALLBACK_FOREGROUND = rgb(0xf5, 0xf5, 0xf5); // --foreground
const FALLBACK_CURSOR = rgb(0xe8, 0x65, 0x2a); // --primary (ember orange)
const FALLBACK_ANSI_RED = rgb(0xe5, 0x48, 0x4d); // --destructive

/**
 * The 16-entry ANSI palette is terminal-domain color with no matching app
 * tokens — a restrained dark set tuned to sit on the near-black background —
 * except normal red, which mirrors `--destructive`.
 */
const terminalPalette = (red: ThemeColor): ThemeColor[] => [
  // Normal (0-7)
  rgb(0x1c, 0x1c, 0x1c), // black
  red,
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
 * Build the theme from the live design tokens so the terminal cannot drift
 * from globals.css. `complete` is false when any token failed to read.
 */
function buildTheme(): { theme: GhosttyTheme; complete: boolean } {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string): ThemeColor | null => parseHexColor(styles.getPropertyValue(name));

  const background = token("--background");
  const foreground = token("--foreground");
  const cursor = token("--primary");
  const ansiRed = token("--destructive");
  const complete =
    background !== null && foreground !== null && cursor !== null && ansiRed !== null;

  const bg = background ?? FALLBACK_BACKGROUND;
  const fg = foreground ?? FALLBACK_FOREGROUND;
  return {
    theme: {
      name: "Volli Dark",
      raw: {},
      colors: {
        background: bg,
        foreground: fg,
        cursor: cursor ?? FALLBACK_CURSOR,
        cursorText: bg,
        selectionBackground: rgb(0x34, 0x34, 0x34),
        selectionForeground: fg,
        palette: terminalPalette(ansiRed ?? FALLBACK_ANSI_RED),
      },
    },
    complete,
  };
}

let cachedTheme: GhosttyTheme | null = null;

/**
 * Tokens are read at theme-build time, NOT module import time — the stylesheet
 * may not be applied yet when this module loads. A theme built from a partial
 * read is served but not cached, so a later call retries the tokens.
 */
function terminalTheme(): GhosttyTheme {
  if (cachedTheme !== null) return cachedTheme;
  const { theme, complete } = buildTheme();
  if (complete) cachedTheme = theme;
  return theme;
}

/** Terminal font size in CSS pixels. */
export const TERMINAL_FONT_SIZE = 13;

let cachedFonts: ResttyFontInput[] | undefined;

/** Geist Mono as an in-memory font buffer (decoded once, then cached). */
function terminalFonts(): ResttyFontInput[] {
  cachedFonts ??= [{ data: decodeBase64DataUri(geistMonoWoff2), name: "Geist Mono" }];
  return cachedFonts;
}

/** The per-pane terminal config handed to restty for every session. */
export function terminalConfig(): ResttyTerminalConfig {
  return {
    renderer: "auto", // WebGPU with automatic WebGL2 fallback
    fontSize: TERMINAL_FONT_SIZE,
    fonts: terminalFonts(),
    theme: terminalTheme(),
    // restty owns auto-sizing: it measures the canvas and emits `term-size`
    // runtime events, which the engine forwards to the PTY.
    autoResize: true,
  };
}
