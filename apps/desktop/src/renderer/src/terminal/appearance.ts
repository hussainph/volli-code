/**
 * Terminal appearance state: the user's real Ghostty config (fetched from
 * main over IPC, live-reloaded on file edits — issue #18) resolved against
 * the app's design-token fallback theme.
 *
 * Font strategy: restty's text-shaper rasterizes glyphs itself, so CSS
 * `font-family` does nothing for its canvas. Families resolve through the
 * Local Font Access API (main grants the `local-fonts` permission), exactly
 * like ghostty resolves them against installed system fonts — no bundled
 * font bytes, and the same config renders the same face in both apps.
 */
import type { GhosttyTheme } from "restty";
import type { GhosttyAppearancePayload, ResolvedAppearance } from "@volli/shared";

import { resolvedAppearance } from "@renderer/lib/resolved-appearance";

import { resolveAppearance } from "./appearance-model";
import { parseHexColor } from "./css-color";
import type { TerminalAppearance } from "./engine";

// `ThemeColor` is not re-exported from restty's entry; it is structurally just
// an 0-255 RGBA record, so a local alias stays assignable to the palette type.
type ThemeColor = { r: number; g: number; b: number; a?: number };

const rgb = (r: number, g: number, b: number): ThemeColor => ({ r, g, b });

/** The four app tokens this fallback theme is built from, for one appearance. */
interface FallbackTokens {
  background: ThemeColor;
  foreground: ThemeColor;
  cursor: ThemeColor;
  ansiRed: ThemeColor;
}

/**
 * Literal fallbacks mirroring globals.css (i.e. the generated Ember theme) in
 * each mode, used only when a token is missing or unparseable — e.g. the
 * stylesheet has not applied yet. Generated, never hand-tuned: regenerate these
 * whenever globals.css's blocks are regenerated, exactly as CLAUDE.md requires
 * of the stylesheet itself.
 */
const FALLBACK_TOKENS: Record<ResolvedAppearance, FallbackTokens> = {
  dark: {
    background: rgb(0x15, 0x10, 0x0e),
    foreground: rgb(0xeb, 0xe3, 0xdf),
    cursor: rgb(0xe8, 0x65, 0x2a), // --primary (ember orange)
    ansiRed: rgb(0xe5, 0x48, 0x4d), // --destructive
  },
  light: {
    background: rgb(0xfd, 0xde, 0xd2),
    foreground: rgb(0x12, 0x09, 0x06),
    cursor: rgb(0xd6, 0x74, 0x4d),
    ansiRed: rgb(0xe5, 0x48, 0x4d),
  },
};

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
 * The 16-entry ANSI palette is terminal-domain color with no matching app
 * tokens, so it is authored per mode — except normal red, which mirrors
 * `--destructive` in both.
 *
 * `dark` is the original restrained set, tuned to sit on the near-black
 * background.
 *
 * `light` is **GitHub Light Default**, taken verbatim from ghostty's bundled
 * theme catalog (which restty ships, so this is a set the app can already
 * render). A reference set rather than a derivation because how the dark one
 * was picked is recorded nowhere, so there is no rule here to mirror — and a
 * light ANSI palette is not a lightened dark one anyway: every hue has to be
 * pushed DOWN in lightness to survive a light ground, which re-picks all
 * sixteen entries. GitHub's is the light set that holds up best on the two
 * things that matter here. Its chromatic entries clear the contrast floor even
 * on the lightest canvas the app generates, where Solarized Light and One Half
 * Light both fall through it (their bright rows are pale by design, which reads
 * as washed-out on white). And its grey ramp runs black → bright-white *toward*
 * the background — the exact mirror of the dark set's ramp — so `bright black`
 * still means "dim" and `bright white` still means "faint" after a mode flip,
 * which is the meaning programs actually attach to those two slots.
 */
const ANSI_PALETTES: Record<ResolvedAppearance, readonly ThemeColor[]> = {
  dark: [
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
  ],
  light: [
    // Normal (0-7)
    rgb(0x24, 0x29, 0x2f), // black
    rgb(0xcf, 0x22, 0x2e), // red — replaced by --destructive
    rgb(0x11, 0x63, 0x29), // green
    rgb(0x4d, 0x2d, 0x00), // yellow
    rgb(0x09, 0x69, 0xda), // blue
    rgb(0x82, 0x50, 0xdf), // magenta
    rgb(0x1b, 0x7c, 0x83), // cyan
    rgb(0x6e, 0x77, 0x81), // white
    // Bright (8-15)
    rgb(0x57, 0x60, 0x6a), // bright black
    rgb(0xa4, 0x0e, 0x26), // bright red
    rgb(0x1a, 0x7f, 0x37), // bright green
    rgb(0x63, 0x3c, 0x01), // bright yellow
    rgb(0x21, 0x8b, 0xff), // bright blue
    rgb(0xa4, 0x75, 0xf9), // bright magenta
    rgb(0x31, 0x92, 0xaa), // bright cyan
    rgb(0x8c, 0x95, 0x9f), // bright white
  ],
};

/** The mode's ANSI set with normal red replaced by the app's `--destructive`. */
function terminalPalette(red: ThemeColor, appearance: ResolvedAppearance): ThemeColor[] {
  const palette = [...ANSI_PALETTES[appearance]];
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
      name: appearance === "dark" ? "Volli Dark" : "Volli Light",
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
let previewedTheme: GhosttyTheme | null = null;
let cachedPreviewAppearance: TerminalAppearance | null = null;
let initStarted = false;

const changeListeners = new Set<() => void>();

/** Drop every derived appearance and tell live terminals to re-read it. */
function invalidateAndNotify(): void {
  cachedAppearance = null;
  cachedPreviewAppearance = null;
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
  if (previewedTheme === null) return cachedAppearance;
  cachedPreviewAppearance ??= { ...cachedAppearance, theme: previewedTheme };
  return cachedPreviewAppearance;
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
 * Paints every live terminal with `theme` without persisting anything; `null`
 * puts the resolved config chain back in charge.
 *
 * We render the terminal, so a theme preview here is a REAL palette swap
 * rather than a sample panel — the same standard the app-surface picker holds
 * itself to. Memory-only by construction: the overlay file is only ever
 * touched by an explicit save, so an abandoned preview leaves the user's
 * config exactly as it was.
 */
export function previewTerminalTheme(theme: GhosttyTheme | null): void {
  if (previewedTheme === theme) return;
  previewedTheme = theme;
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
