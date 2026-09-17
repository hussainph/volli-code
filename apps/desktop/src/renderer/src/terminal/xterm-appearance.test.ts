import type { GhosttyTheme, ThemeColor } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SCROLLBACK_LINES,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  MOUSE_TRACKING_MODES,
  clampFontSize,
  isMouseTrackingOnly,
  macOptionIsMeta,
  resolveThemeTerminalColor,
  scrollbackLines,
  themeColorToHex,
  xtermFontFamily,
  xtermTheme,
} from "./xterm-appearance";

const rgb = (r: number, g: number, b: number, a?: number): ThemeColor =>
  a === undefined ? { r, g, b } : { r, g, b, a };

/** A theme with only the slots a case cares about; palette defaults to empty. */
function theme(colors: Partial<GhosttyTheme["colors"]> = {}): GhosttyTheme {
  return { raw: {}, colors: { palette: [], ...colors } };
}

describe("clampFontSize", () => {
  it("passes an ordinary size through", () => {
    expect(clampFontSize(14)).toBe(14);
  });

  it("holds the pane-zoom bounds at both ends", () => {
    expect(clampFontSize(1)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(400)).toBe(MAX_FONT_SIZE);
  });
});

describe("themeColorToHex", () => {
  it("writes six digits for an opaque color", () => {
    expect(themeColorToHex(rgb(0x1c, 0x13, 0x10))).toBe("#1c1310");
  });

  it("pads each channel so a dark color is not truncated to three digits", () => {
    expect(themeColorToHex(rgb(0, 5, 15))).toBe("#00050f");
  });

  it("appends the alpha byte only when the theme set one", () => {
    expect(themeColorToHex(rgb(0x12, 0x34, 0x56, 0x80))).toBe("#12345680");
    expect(themeColorToHex(rgb(0x12, 0x34, 0x56, 0))).toBe("#12345600");
  });

  // Ghostty's parser produces 0-255 bytes, but the token-derived fallback
  // theme is assembled in the app from computed CSS, and a channel that
  // arrives fractional or out of range must not produce a hex string CSS
  // silently drops (which would paint the slot with xterm's default instead).
  it("rounds and clamps a channel that is not already a byte", () => {
    expect(themeColorToHex(rgb(-10, 127.6, 300))).toBe("#0080ff");
  });
});

describe("resolveThemeTerminalColor", () => {
  it("passes a literal color straight through", () => {
    expect(resolveThemeTerminalColor(rgb(0x34, 0x34, 0x34), theme().colors)).toBe("#343434");
  });

  // xterm takes ONE selection color for the whole selection, so Ghostty's
  // per-cell `cell-foreground`/`cell-background` collapse onto the terminal's
  // own default pair. Flat over colored output, right everywhere else.
  it("reads the cell keywords as the terminal's own foreground and background", () => {
    const colors = theme({
      foreground: rgb(0xe8, 0xe4, 0xe2),
      background: rgb(0x1c, 0x13, 0x10),
    }).colors;
    expect(resolveThemeTerminalColor("cell-foreground", colors)).toBe("#e8e4e2");
    expect(resolveThemeTerminalColor("cell-background", colors)).toBe("#1c1310");
  });

  it("answers nothing when the slot it points at is itself unset", () => {
    expect(resolveThemeTerminalColor("cell-foreground", theme().colors)).toBeUndefined();
    expect(resolveThemeTerminalColor("cell-background", theme().colors)).toBeUndefined();
  });

  it("answers nothing for an unset slot", () => {
    expect(resolveThemeTerminalColor(undefined, theme().colors)).toBeUndefined();
  });
});

describe("xtermTheme", () => {
  it("maps the semantic slots onto xterm's names", () => {
    const mapped = xtermTheme(
      theme({
        background: rgb(1, 2, 3),
        foreground: rgb(4, 5, 6),
        cursor: rgb(7, 8, 9),
        cursorText: rgb(10, 11, 12),
      }),
    );

    expect(mapped.background).toBe("#010203");
    expect(mapped.foreground).toBe("#040506");
    expect(mapped.cursor).toBe("#070809");
    // Ghostty's cursor-text is the ink inside the block cursor.
    expect(mapped.cursorAccent).toBe("#0a0b0c");
  });

  // Ghostty keeps a selection at full strength when the surface loses focus;
  // xterm dims it to a separate color unless the two are pinned together.
  it("gives the unfocused selection the same fill as the focused one", () => {
    const mapped = xtermTheme(
      theme({
        foreground: rgb(0xe8, 0xe4, 0xe2),
        selectionBackground: rgb(0x34, 0x34, 0x34),
        selectionForeground: "cell-foreground",
      }),
    );

    expect(mapped.selectionBackground).toBe("#343434");
    expect(mapped.selectionInactiveBackground).toBe("#343434");
    expect(mapped.selectionForeground).toBe("#e8e4e2");
  });

  it("leaves the selection ink to xterm when the slot it names is itself unset", () => {
    expect(xtermTheme(theme({ selectionForeground: "cell-foreground" }))).toEqual({});
  });

  it("names palette 0-15 and leaves 16 and up to extendedAnsi", () => {
    const palette: (ThemeColor | undefined)[] = [];
    for (let index = 0; index < 18; index += 1) palette[index] = rgb(index, index, index);
    const mapped = xtermTheme(theme({ palette }));

    expect(mapped.black).toBe("#000000");
    expect(mapped.brightWhite).toBe("#0f0f0f");
    expect(mapped.extendedAnsi).toEqual(["#101010", "#111111"]);
  });

  // Most themes define only the first sixteen slots plus a stray override, and
  // xterm backfills a missing extendedAnsi entry with its own default for that
  // index — so the holes have to survive the mapping rather than be closed.
  it("keeps a sparse extended palette sparse", () => {
    const palette: (ThemeColor | undefined)[] = [];
    palette[20] = rgb(0xab, 0xcd, 0xef);
    const mapped = xtermTheme(theme({ palette }));

    expect(mapped.extendedAnsi).toHaveLength(5);
    expect(mapped.extendedAnsi?.[4]).toBe("#abcdef");
    expect(mapped.extendedAnsi?.[0]).toBeUndefined();
  });

  // A slot xterm never hears about keeps xterm's own default. Writing the key
  // with `undefined` would mean the same thing less clearly, so an empty theme
  // has to map to an empty object rather than sixteen explicit holes.
  it("omits every slot the theme left unset", () => {
    expect(xtermTheme(theme())).toEqual({});
  });
});

describe("xtermFontFamily", () => {
  it("quotes the configured families and appends the symbol fallbacks", () => {
    expect(xtermFontFamily(["JetBrains Mono", "Menlo"])).toBe(
      '"JetBrains Mono", "Menlo", "Apple Symbols", "STIX Two Math", "Apple Color Emoji", monospace',
    );
  });

  // `monospace` is a CSS keyword: quoted, it becomes a family name nobody has
  // installed, and the chain can fall through to the page's proportional face.
  it("leaves the generic monospace keyword unquoted", () => {
    expect(xtermFontFamily([])).toMatch(/, monospace$/);
  });

  it("trims whitespace and drops empty entries", () => {
    expect(xtermFontFamily(["  Menlo  ", "   "])).toBe(
      '"Menlo", "Apple Symbols", "STIX Two Math", "Apple Color Emoji", monospace',
    );
  });

  // A double quote inside a family name would close the CSS string early and
  // turn the rest of the stack into garbage, so the name is dropped instead.
  it("drops a family whose name would break out of the CSS string", () => {
    expect(xtermFontFamily(['Ev"il', "Menlo"])).toBe(
      '"Menlo", "Apple Symbols", "STIX Two Math", "Apple Color Emoji", monospace',
    );
  });
});

describe("scrollbackLines", () => {
  it("uses the engine default when ghostty sets no limit", () => {
    expect(scrollbackLines(null)).toBe(DEFAULT_SCROLLBACK_LINES);
  });

  it("converts a byte budget into a line budget", () => {
    expect(scrollbackLines(2_000_000)).toBe(10_000);
    expect(scrollbackLines(1_000_100)).toBe(5_001);
  });

  // The clamp matters more than the divisor: a tiny limit must still leave
  // usable history, and a huge one must not let a config line commit the
  // renderer to unbounded memory.
  it("holds a floor and a ceiling on the converted budget", () => {
    expect(scrollbackLines(0)).toBe(1_000);
    expect(scrollbackLines(1)).toBe(1_000);
    expect(scrollbackLines(1_000_000_000)).toBe(100_000);
  });
});

describe("macOptionIsMeta", () => {
  // Only the unsided `true` may reach xterm's own encoder: it reads
  // `event.altKey`, which cannot say which Option key is down, so enabling it
  // under a sided mode would remap the side the config excluded.
  it("enables xterm's own Alt encoding only for the unsided mode", () => {
    expect(macOptionIsMeta(true)).toBe(true);
    expect(macOptionIsMeta(false)).toBe(false);
    expect(macOptionIsMeta("left")).toBe(false);
    expect(macOptionIsMeta("right")).toBe(false);
  });
});

describe("isMouseTrackingOnly", () => {
  it("claims a DECSET that is nothing but mouse tracking", () => {
    for (const mode of MOUSE_TRACKING_MODES) {
      expect(isMouseTrackingOnly([mode])).toBe(true);
    }
    expect(isMouseTrackingOnly([1000, 1002, 1006])).toBe(true);
  });

  it("declines a DECSET that has nothing to do with the mouse", () => {
    expect(isMouseTrackingOnly([25])).toBe(false);
    expect(isMouseTrackingOnly([1049])).toBe(false);
  });

  // The parser hands over a whole sequence, not one parameter at a time, so a
  // mixed set cannot be answered for in part. Letting it through is the safe
  // direction: unwanted mouse reports are a nuisance, an invisible cursor is
  // a broken terminal.
  it("lets a mixed DECSET through rather than swallowing the modes beside the mouse", () => {
    expect(isMouseTrackingOnly([1000, 25])).toBe(false);
  });

  // `CSI ? 1000 : 2 h` is not a spelling any mouse mode uses, and a nested
  // parameter is not a number we can check against the list.
  it("lets a sub-parameterised DECSET through", () => {
    expect(isMouseTrackingOnly([[1000, 2]])).toBe(false);
  });

  it("lets a parameterless DECSET through", () => {
    expect(isMouseTrackingOnly([])).toBe(false);
  });
});
