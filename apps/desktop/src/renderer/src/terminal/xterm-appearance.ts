/**
 * The pure half of the xterm.js engine: `TerminalAppearance` (Ghostty's
 * vocabulary, decision #26) → xterm.js option values. No DOM, no xterm
 * instance, no module state — so every mapping rule below is unit-testable,
 * which is the point of keeping it out of `xterm-engine.ts` (jsdom cannot lay
 * out a terminal, so the class itself is only exercised by the desktop smoke).
 *
 * Ghostty remains the appearance SOURCE in both directions of this file: we
 * translate its config into xterm's options and never the other way, so a
 * knob Ghostty does not have is a knob this app does not offer.
 */
import type { GhosttyTheme, ThemeColor, ThemeTerminalColor } from "@volli/shared";
import type { ITheme } from "@xterm/xterm";

import type { MacosOptionAsAlt } from "./option-as-alt";

/** Pane-local zoom bounds, in CSS pixels. */
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 40;

/**
 * Fonts appended after the user's own families. macOS's Apple Symbols covers
 * the common terminal-symbol blocks, STIX Two Math fills later Misc Technical
 * codepoints (U+23FA and friends) that Apple Symbols omits, and color emoji
 * stays last so it is reached only for emoji presentation. `monospace` closes
 * the chain because a CSS font stack that resolves to nothing falls back to the
 * page's proportional face, which would draw a terminal with ragged columns.
 */
const FALLBACK_FONT_STACK = [
  "Apple Symbols",
  "STIX Two Math",
  "Apple Color Emoji",
  "monospace",
] as const;

/** Scrollback when Ghostty sets no `scrollback-limit`, in lines. */
export const DEFAULT_SCROLLBACK_LINES = 10_000;
const MIN_SCROLLBACK_LINES = 1_000;
const MAX_SCROLLBACK_LINES = 100_000;
/**
 * Bytes per scrollback line, for converting Ghostty's `scrollback-limit`
 * (bytes) into xterm's `scrollback` (lines). A heuristic, and openly one: the
 * true ratio depends on line length and on how much SGR state each cell
 * carries. 200 B/line is roughly a half-filled 120-column line of plain text
 * with a little styling, which is what shell scrollback mostly is. The clamp
 * either side matters more than the divisor — it keeps a tiny limit from
 * leaving a terminal with no usable history and a huge one from letting a
 * config line commit the renderer to unbounded memory.
 */
const BYTES_PER_SCROLLBACK_LINE = 200;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** Pane font size: the Ghostty base plus this pane's zoom offset, clamped. */
export function clampFontSize(size: number): number {
  return clamp(size, MIN_FONT_SIZE, MAX_FONT_SIZE);
}

function hexByte(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

/** `#rrggbb`, or `#rrggbbaa` when the theme gave the slot an alpha. */
export function themeColorToHex(color: ThemeColor): string {
  const rgb = `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
  return color.a === undefined ? rgb : `${rgb}${hexByte(color.a)}`;
}

/**
 * Resolve a slot that may name the cell's own colors.
 *
 * ACCEPTED LOSS. Ghostty's `cell-foreground`/`cell-background` mean "whatever
 * THIS cell is painted in", so a selection over multi-colored output inverts
 * per cell. xterm's `ITheme` takes one color for the whole selection and has no
 * per-cell hook, so the nearest honest reading is the terminal's own default
 * foreground/background — right for the overwhelmingly common case (a
 * selection over ordinary text) and merely flat over colored output.
 */
export function resolveThemeTerminalColor(
  value: ThemeTerminalColor | undefined,
  colors: GhosttyTheme["colors"],
): string | undefined {
  if (value === undefined) return undefined;
  if (value === "cell-foreground") {
    return colors.foreground === undefined ? undefined : themeColorToHex(colors.foreground);
  }
  if (value === "cell-background") {
    return colors.background === undefined ? undefined : themeColorToHex(colors.background);
  }
  return themeColorToHex(value);
}

/** The sixteen single-color `ITheme` keys the ANSI palette fills. */
type AnsiThemeKey =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

/** Palette slots 0-15, in xterm's naming order. */
const ANSI_THEME_KEYS: readonly AnsiThemeKey[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/**
 * A Ghostty theme as xterm's `ITheme`.
 *
 * Every slot is OMITTED rather than set when the theme leaves it unset: xterm
 * substitutes its own default for a missing key, and writing `undefined` into
 * one would only mean the same thing less clearly. Palette 16-255 goes to
 * `extendedAnsi`, which xterm indexes from 16 and backfills per entry, so a
 * sparse palette (the normal case — most themes define only the first 16) can
 * be handed over with its holes intact.
 */
export function xtermTheme(theme: GhosttyTheme): ITheme {
  const { colors } = theme;
  const result: ITheme = {};
  if (colors.background !== undefined) result.background = themeColorToHex(colors.background);
  if (colors.foreground !== undefined) result.foreground = themeColorToHex(colors.foreground);
  if (colors.cursor !== undefined) result.cursor = themeColorToHex(colors.cursor);
  // Ghostty's `cursor-text` is the ink drawn INSIDE the block cursor, which is
  // what xterm calls the cursor accent.
  if (colors.cursorText !== undefined) result.cursorAccent = themeColorToHex(colors.cursorText);

  const selectionBackground = resolveThemeTerminalColor(colors.selectionBackground, colors);
  if (selectionBackground !== undefined) {
    result.selectionBackground = selectionBackground;
    // Ghostty keeps a selection visible at full strength when the surface loses
    // focus; xterm dims it to a separate color unless told otherwise.
    result.selectionInactiveBackground = selectionBackground;
  }
  const selectionForeground = resolveThemeTerminalColor(colors.selectionForeground, colors);
  if (selectionForeground !== undefined) result.selectionForeground = selectionForeground;

  ANSI_THEME_KEYS.forEach((key, index) => {
    const color = colors.palette[index];
    if (color !== undefined) result[key] = themeColorToHex(color);
  });

  const extendedAnsi: string[] = [];
  for (let index = 16; index < colors.palette.length; index += 1) {
    const color = colors.palette[index];
    if (color !== undefined) extendedAnsi[index - 16] = themeColorToHex(color);
  }
  if (extendedAnsi.length > 0) result.extendedAnsi = extendedAnsi;
  return result;
}

/**
 * The CSS `font-family` value for a Ghostty font chain. Each family is quoted
 * so names with spaces or digits survive CSS parsing; the generic `monospace`
 * keyword at the end of the fallback stack must NOT be quoted, or CSS reads it
 * as a family nobody has installed.
 */
export function xtermFontFamily(families: readonly string[]): string {
  const quoted = families
    // A quote inside a family name would close the string early and turn the
    // rest of the stack into garbage; Ghostty has no escaping syntax for one,
    // so the name is simply dropped.
    .filter((family) => family.trim().length > 0 && !family.includes('"'))
    .map((family) => `"${family.trim()}"`);
  const fallbacks = FALLBACK_FONT_STACK.map((family) =>
    family === "monospace" ? family : `"${family}"`,
  );
  return [...quoted, ...fallbacks].join(", ");
}

/** Ghostty's byte budget as xterm's line budget. See BYTES_PER_SCROLLBACK_LINE. */
export function scrollbackLines(limitBytes: number | null): number {
  if (limitBytes === null) return DEFAULT_SCROLLBACK_LINES;
  return clamp(
    Math.round(limitBytes / BYTES_PER_SCROLLBACK_LINE),
    MIN_SCROLLBACK_LINES,
    MAX_SCROLLBACK_LINES,
  );
}

/**
 * xterm's own macOS Alt encoding, enabled only for the unsided `true`.
 *
 * It is a backstop, not the main path: `option-as-alt.ts` intercepts every
 * chord it can encode first (xterm would emit ESC + the macOS COMPOSED
 * character, where Ghostty emits ESC + the base one). What this leaves xterm is
 * the keys that table does not cover — a non-US layout's moved punctuation —
 * where ESC + the composed character still beats no ESC at all.
 *
 * The sided modes cannot use it: xterm reads `event.altKey`, which does not say
 * which Option key is down, so enabling it under `"left"` would remap the right
 * Option too — the opposite of what the config asked for.
 */
export function macOptionIsMeta(mode: MacosOptionAsAlt): boolean {
  return mode === true;
}

/**
 * The DECSET (`CSI ? Pm h`) modes that turn mouse tracking on.
 *
 * 9 is X10 compatibility; 1000/1002/1003 are button, button-motion and
 * any-motion tracking; 1005/1006/1015/1016 select the report ENCODING, which is
 * inert on its own but is set alongside a tracking mode by every TUI that uses
 * it, so a Ghostty `mouse-reporting = false` that let them through would leave
 * a terminal in a half-configured state.
 */
export const MOUSE_TRACKING_MODES: readonly number[] = [
  9, 1000, 1002, 1003, 1005, 1006, 1015, 1016,
];

/**
 * Whether a DECSET's parameters are ALL mouse-tracking modes — i.e. whether
 * swallowing the whole sequence throws nothing else away.
 *
 * A mixed `CSI ? 1000 ; 25 h` is let through intact (mouse tracking wins, but
 * the cursor stays visible) because xterm's parser hands over the sequence, not
 * the individual parameters: there is no way to answer for one and decline for
 * another. Letting it through is the safe direction — a terminal that reports
 * mouse against the user's preference is a nuisance, a terminal with an
 * invisible cursor is broken. No TUI in practice mixes them; they are set in
 * separate sequences.
 *
 * Sub-parameters (`CSI ? 1000 : 2 h`, delivered as a nested array) are likewise
 * let through: they are not a spelling any mouse mode uses.
 */
export function isMouseTrackingOnly(params: readonly (number | number[])[]): boolean {
  if (params.length === 0) return false;
  return params.every((param) => typeof param === "number" && MOUSE_TRACKING_MODES.includes(param));
}
