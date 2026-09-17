import { describe, expect, it } from "vite-plus/test";

import {
  getGhosttyTheme,
  isGhosttyThemeName,
  listGhosttyThemeNames,
  parseGhosttyColor,
  parseGhosttyTerminalColor,
  parseGhosttyTheme,
} from "./ghostty-theme";

describe("parseGhosttyColor", () => {
  it("parses a 6-digit hex with a leading #", () => {
    expect(parseGhosttyColor("#1e1e2e")).toEqual({ r: 0x1e, g: 0x1e, b: 0x2e });
  });

  it("parses a 6-digit hex with no leading #", () => {
    expect(parseGhosttyColor("1e1e2e")).toEqual({ r: 0x1e, g: 0x1e, b: 0x2e });
  });

  it("parses an 8-digit hex with alpha, with and without a leading #", () => {
    expect(parseGhosttyColor("#11223344")).toEqual({ r: 0x11, g: 0x22, b: 0x33, a: 0x44 });
    expect(parseGhosttyColor("11223344")).toEqual({ r: 0x11, g: 0x22, b: 0x33, a: 0x44 });
  });

  it("trims surrounding whitespace", () => {
    expect(parseGhosttyColor("  #ffffff  ")).toEqual({ r: 0xff, g: 0xff, b: 0xff });
  });

  it("rejects rgb()/named colors and anything not a clean hex", () => {
    expect(parseGhosttyColor("rgb(255, 0, 0)")).toBeNull();
    expect(parseGhosttyColor("red")).toBeNull();
    expect(parseGhosttyColor("cell-foreground")).toBeNull();
    expect(parseGhosttyColor("#fff")).toBeNull();
    expect(parseGhosttyColor("#gggggg")).toBeNull();
    expect(parseGhosttyColor("")).toBeNull();
  });
});

describe("parseGhosttyTerminalColor", () => {
  it("accepts cell-foreground and cell-background verbatim", () => {
    expect(parseGhosttyTerminalColor("cell-foreground")).toBe("cell-foreground");
    expect(parseGhosttyTerminalColor("cell-background")).toBe("cell-background");
  });

  it("falls through to a hex color", () => {
    expect(parseGhosttyTerminalColor("#010203")).toEqual({ r: 1, g: 2, b: 3 });
  });

  it("returns null for anything else", () => {
    expect(parseGhosttyTerminalColor("not-a-color")).toBeNull();
  });
});

describe("parseGhosttyTheme", () => {
  it("parses the six semantic color keys", () => {
    const theme = parseGhosttyTheme(
      [
        "background = #1e1e2e",
        "foreground = #cdd6f4",
        "cursor-color = #f5e0dc",
        "cursor-text = #1e1e2e",
        "selection-background = #585b70",
        "selection-foreground = cell-foreground",
      ].join("\n"),
    );

    expect(theme.colors.background).toEqual({ r: 0x1e, g: 0x1e, b: 0x2e });
    expect(theme.colors.foreground).toEqual({ r: 0xcd, g: 0xd6, b: 0xf4 });
    expect(theme.colors.cursor).toEqual({ r: 0xf5, g: 0xe0, b: 0xdc });
    expect(theme.colors.cursorText).toEqual({ r: 0x1e, g: 0x1e, b: 0x2e });
    expect(theme.colors.selectionBackground).toEqual({ r: 0x58, g: 0x5b, b: 0x70 });
    expect(theme.colors.selectionForeground).toBe("cell-foreground");
  });

  it("parses palette entries by index", () => {
    const theme = parseGhosttyTheme("palette = 0=#000000\npalette = 15=#ffffff");
    expect(theme.colors.palette[0]).toEqual({ r: 0, g: 0, b: 0 });
    expect(theme.colors.palette[15]).toEqual({ r: 0xff, g: 0xff, b: 0xff });
    expect(theme.colors.palette[1]).toBeUndefined();
  });

  it("skips blank lines and # comments", () => {
    const theme = parseGhosttyTheme("\n# a comment\n  \nbackground = #101010\n");
    expect(theme.colors.background).toEqual({ r: 0x10, g: 0x10, b: 0x10 });
    expect(Object.keys(theme.raw)).toEqual(["background"]);
  });

  it("skips a palette line with no '=' separator in its value", () => {
    const theme = parseGhosttyTheme("palette = garbage");
    expect(theme.colors.palette).toEqual([]);
  });

  it("skips a palette entry whose index is not an integer 0-255", () => {
    const theme = parseGhosttyTheme(
      ["palette = -1=#ffffff", "palette = 256=#ffffff", "palette = abc=#ffffff"].join("\n"),
    );
    expect(theme.colors.palette).toEqual([]);
  });

  it("skips a palette entry whose color does not parse", () => {
    const theme = parseGhosttyTheme("palette = 0=not-a-color");
    expect(theme.colors.palette[0]).toBeUndefined();
  });

  it("keeps a previously-parsed semantic color when a later line for the same key is malformed", () => {
    const theme = parseGhosttyTheme("background = #112233\nbackground = not-a-color");
    expect(theme.colors.background).toEqual({ r: 0x11, g: 0x22, b: 0x33 });
  });

  it("leaves every other semantic key unset when its value is malformed", () => {
    const theme = parseGhosttyTheme(
      [
        "foreground = not-a-color",
        "cursor-color = not-a-color",
        "cursor-text = not-a-color",
        "selection-background = not-a-color",
        "selection-foreground = not-a-color",
      ].join("\n"),
    );
    expect(theme.colors.foreground).toBeUndefined();
    expect(theme.colors.cursor).toBeUndefined();
    expect(theme.colors.cursorText).toBeUndefined();
    expect(theme.colors.selectionBackground).toBeUndefined();
    expect(theme.colors.selectionForeground).toBeUndefined();
  });

  it("keeps unknown keys in raw and otherwise ignores them, including search* keys", () => {
    const theme = parseGhosttyTheme(
      ["some-unknown-key = whatever", "search-background = #ffffff"].join("\n"),
    );
    expect(theme.raw["some-unknown-key"]).toBe("whatever");
    expect(theme.raw["search-background"]).toBe("#ffffff");
    // No semantic field reads search* — nothing in the app does either.
    expect(theme.colors).not.toHaveProperty("searchBackground");
  });

  it("records every recognized key's raw value, even when the color fails to parse", () => {
    const theme = parseGhosttyTheme("background = not-a-color");
    expect(theme.raw["background"]).toBe("not-a-color");
    expect(theme.colors.background).toBeUndefined();
  });

  it("produces no name — only the catalog lookup sets one", () => {
    const theme = parseGhosttyTheme("background = #000000");
    expect(theme.name).toBeUndefined();
  });
});

describe("the vendored catalog", () => {
  const WELL_KNOWN = ["Catppuccin Mocha", "Dracula", "GitHub Dark", "Tomorrow Night"];

  it("lists well-known theme names", () => {
    const names = listGhosttyThemeNames();
    for (const name of WELL_KNOWN) expect(names).toContain(name);
  });

  it("lists names sorted case-insensitively", () => {
    const names = listGhosttyThemeNames();
    const sorted = names.toSorted((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    expect(names).toEqual(sorted);
  });

  it("recognizes only catalog names", () => {
    expect(isGhosttyThemeName("Dracula")).toBe(true);
    expect(isGhosttyThemeName("No Such Theme")).toBe(false);
  });

  it("resolves a well-known theme, naming it after the catalog entry", () => {
    const theme = getGhosttyTheme("Dracula");
    expect(theme).not.toBeNull();
    expect(theme?.name).toBe("Dracula");
    expect(theme?.colors.background).toEqual({ r: 0x28, g: 0x2a, b: 0x36 });
  });

  it("returns null for a name outside the catalog", () => {
    expect(getGhosttyTheme("No Such Theme")).toBeNull();
  });

  it("caches a parsed theme across calls", () => {
    const first = getGhosttyTheme("Nord");
    const second = getGhosttyTheme("Nord");
    expect(first).toBe(second);
  });

  it("parses every catalog entry into a theme with a full palette and a background/foreground", () => {
    for (const name of listGhosttyThemeNames()) {
      const theme = getGhosttyTheme(name);
      expect(theme, name).not.toBeNull();
      expect(theme?.colors.palette.length, name).toBeGreaterThanOrEqual(16);
      expect(theme?.colors.background, name).toBeDefined();
      expect(theme?.colors.foreground, name).toBeDefined();
    }
  });
});
