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
import type { GhosttyAppearancePayload } from "@volli/shared";

import { resolveAppearance } from "./appearance-model";
import { parseHexColor } from "./css-color";
import type { TerminalAppearance } from "./engine";

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
 * Build the fallback theme from the live design tokens so a config-less
 * terminal cannot drift from globals.css. `complete` is false when any token
 * failed to read.
 */
function buildTokenTheme(): { theme: GhosttyTheme; complete: boolean } {
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

/**
 * The appearance every terminal renders with right now. Safe to call before
 * `initTerminalAppearance` resolves — you get the token fallback, and the
 * change event fires once the real config lands.
 */
export function getCurrentAppearance(): TerminalAppearance {
  cachedAppearance ??= resolveAppearance(payload, tokenTheme());
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
  cachedAppearance = null;
  for (const listener of changeListeners) listener();
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
