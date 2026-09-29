// Pure vocabulary and parser for a Ghostty terminal theme (a `background = …`,
// `palette = N=…` style file, distinct from `ghostty-config.ts`'s window/font
// preferences). The terminal renderer used to own this type and its parser;
// VC-107 replaced that renderer with xterm.js, so `GhosttyTheme` is now simply
// the app's own vocabulary for a theme. `xterm-appearance.ts` translates it
// into xterm's `ITheme`, and `raw` survives because callers read the original
// key-value pairs back out.
//
// THIS MODULE SHIPS NO THEMES (VC-413). It used to resolve a name against a
// catalog vendored verbatim out of Ghostty.app's bundled collection — 463
// third-party theme files whose individual provenance and license status were
// never verified. All of that is deleted: what is left is a PARSER, and the
// only theme text it is ever handed is the user's own — a file their Ghostty
// config names, or the config text itself. Material that is local to one user
// is not material this app redistributes.
//
// The consequence, spelled out because it is the design and not an omission: a
// theme NAME on its own no longer resolves to colors here. `theme = X` is
// answered by reading X off the user's disk (`main/ghostty-config.ts` probes
// Ghostty's own theme directories) and, failing that, by the app's own
// token-derived palette (`renderer/terminal/appearance.ts`).

import { parseConfigLine } from "./ghostty-config";

/** RGBA color with 0-255 byte components. */
export interface ThemeColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/** A color slot that may also point at the terminal's own foreground/background. */
export type ThemeTerminalColor = ThemeColor | "cell-foreground" | "cell-background";

/** A parsed Ghostty terminal theme: semantic colors plus the 256-color palette. */
export interface GhosttyTheme {
  /**
   * What to call this theme, when the caller knows. Set by whoever BUILT the
   * theme — today only the app's own token-derived palette, which names itself
   * per appearance — never by the parser, which is handed text and has no way
   * to know what the text was called.
   */
  name?: string;
  colors: {
    background?: ThemeColor;
    foreground?: ThemeColor;
    cursor?: ThemeColor;
    cursorText?: ThemeColor;
    selectionBackground?: ThemeTerminalColor;
    selectionForeground?: ThemeTerminalColor;
    /** 256-color palette (indices 0-255); sparse — an unset index is `undefined`. */
    palette: Array<ThemeColor | undefined>;
  };
  /** Original key-value pairs from the theme source, for keys this parser recognized. */
  raw: Record<string, string>;
}

const HEX6 = /^#?([0-9a-fA-F]{6})$/;
const HEX8 = /^#?([0-9a-fA-F]{8})$/;

/** Two hex digits at `offset` in `digits`, as a 0-255 int. */
function byteAt(digits: string, offset: number): number {
  return Number.parseInt(digits.slice(offset, offset + 2), 16);
}

/**
 * Parse a Ghostty color value: 6-digit hex (`#rrggbb` or `rrggbb`) or 8-digit
 * hex with trailing alpha (`#rrggbbaa` or `rrggbbaa`). Ghostty documents no
 * other theme-file color spelling — no `rgb()`, no named colors — so anything
 * else, including a malformed hex, answers `null` rather than guessing.
 */
export function parseGhosttyColor(value: string): ThemeColor | null {
  const trimmed = value.trim();

  const hex8 = HEX8.exec(trimmed);
  if (hex8 !== null) {
    const digits = hex8[1] as string;
    return {
      r: byteAt(digits, 0),
      g: byteAt(digits, 2),
      b: byteAt(digits, 4),
      a: byteAt(digits, 6),
    };
  }

  const hex6 = HEX6.exec(trimmed);
  if (hex6 !== null) {
    const digits = hex6[1] as string;
    return { r: byteAt(digits, 0), g: byteAt(digits, 2), b: byteAt(digits, 4) };
  }

  return null;
}

/**
 * Parse a Ghostty `TerminalColor` value: `cell-foreground`/`cell-background`
 * (the terminal's own live colors, used for selection/search slots), else a
 * hex color via `parseGhosttyColor`, else `null`.
 */
export function parseGhosttyTerminalColor(value: string): ThemeTerminalColor | null {
  const trimmed = value.trim();
  if (trimmed === "cell-foreground" || trimmed === "cell-background") return trimmed;
  return parseGhosttyColor(trimmed);
}

/** Applies one `palette = N=<color>` line's value (`"N=<color>"`) onto `palette`. */
function applyPaletteEntry(value: string, palette: Array<ThemeColor | undefined>): void {
  const eq = value.indexOf("=");
  if (eq === -1) return;
  const index = Number(value.slice(0, eq).trim());
  if (!Number.isInteger(index) || index < 0 || index > 255) return;
  const color = parseGhosttyColor(value.slice(eq + 1));
  if (color !== null) palette[index] = color;
}

/**
 * Parse a Ghostty theme file's text (`key = value` lines, `#` comments, blank
 * lines — the same grammar `ghostty-config.ts` tokenizes) into a
 * {@link GhosttyTheme}. Tolerant on read: a malformed line or an unparseable
 * color value is skipped rather than thrown. Unknown keys are kept verbatim in
 * `raw` and otherwise ignored; `search*` keys are among them — nothing in the
 * app reads Ghostty's search-match colors, so no semantic field is reserved
 * for them.
 */
export function parseGhosttyTheme(text: string): GhosttyTheme {
  const palette: Array<ThemeColor | undefined> = [];
  const colors: GhosttyTheme["colors"] = { palette };
  const raw: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const parsed = parseConfigLine(line);
    if (parsed === null) continue;
    const [key, value] = parsed;
    raw[key] = value;

    switch (key) {
      case "palette":
        applyPaletteEntry(value, palette);
        break;
      case "background":
        colors.background = parseGhosttyColor(value) ?? colors.background;
        break;
      case "foreground":
        colors.foreground = parseGhosttyColor(value) ?? colors.foreground;
        break;
      case "cursor-color":
        colors.cursor = parseGhosttyColor(value) ?? colors.cursor;
        break;
      case "cursor-text":
        colors.cursorText = parseGhosttyColor(value) ?? colors.cursorText;
        break;
      case "selection-background":
        colors.selectionBackground = parseGhosttyTerminalColor(value) ?? colors.selectionBackground;
        break;
      case "selection-foreground":
        colors.selectionForeground = parseGhosttyTerminalColor(value) ?? colors.selectionForeground;
        break;
      default:
        break;
    }
  }

  return { colors, raw };
}
