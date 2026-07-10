/**
 * Terminal appearance: the Ghostty-format color theme mirrored from the app's
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

import { decodeBase64DataUri } from "./data-uri";

// `ThemeColor` is not re-exported from restty's entry; it is structurally just
// an 0-255 RGBA record, so a local alias stays assignable to the palette type.
type ThemeColor = { r: number; g: number; b: number; a?: number };

const rgb = (r: number, g: number, b: number): ThemeColor => ({ r, g, b });

/**
 * Ghostty theme mirrored from globals.css. Background near #111111, foreground
 * #f5f5f5, ember-orange (#e8652a) cursor. The 16-entry ANSI palette is a
 * restrained dark set tuned to sit on the near-black background.
 */
export const TERMINAL_THEME: GhosttyTheme = {
  name: "Volli Dark",
  raw: {},
  colors: {
    background: rgb(0x11, 0x11, 0x11),
    foreground: rgb(0xf5, 0xf5, 0xf5),
    cursor: rgb(0xe8, 0x65, 0x2a),
    cursorText: rgb(0x11, 0x11, 0x11),
    selectionBackground: rgb(0x34, 0x34, 0x34),
    selectionForeground: rgb(0xf5, 0xf5, 0xf5),
    palette: [
      // Normal (0-7)
      rgb(0x1c, 0x1c, 0x1c), // black
      rgb(0xe5, 0x48, 0x4d), // red
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
    ],
  },
};

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
    theme: TERMINAL_THEME,
    // restty owns auto-sizing: it measures the canvas and emits `term-size`
    // runtime events, which the engine forwards to the PTY.
    autoResize: true,
  };
}
