import { describe, expect, it } from "vite-plus/test";
import type { GhosttyTheme } from "restty";
import type { GhosttyAppearancePayload, GhosttyTerminalPrefs } from "@volli/shared";

import {
  DEFAULT_TERMINAL_FONT_SIZE,
  FALLBACK_FONT_FAMILIES,
  overlayGhosttyTheme,
  resolveAppearance,
  resolveGhosttyThemeChoice,
  terminalFontFamilies,
} from "./appearance-model";

const FALLBACK: GhosttyTheme = {
  name: "Volli Dark",
  raw: {},
  colors: {
    background: { r: 0x11, g: 0x11, b: 0x11 },
    foreground: { r: 0xf5, g: 0xf5, b: 0xf5 },
    palette: [],
  },
};

const prefs = (overrides: Partial<GhosttyTerminalPrefs>): GhosttyTerminalPrefs => ({
  fontFamilies: [],
  fontSize: null,
  themeName: null,
  ligatures: null,
  scrollbackLimitBytes: null,
  mouseReporting: null,
  macosOptionAsAlt: null,
  ...overrides,
});

const payload = (
  prefsOverrides: Partial<GhosttyTerminalPrefs>,
  rest?: Partial<Omit<GhosttyAppearancePayload, "prefs">>,
): GhosttyAppearancePayload => ({
  prefs: prefs(prefsOverrides),
  configText: null,
  themeSource: null,
  ...rest,
});

describe("terminalFontFamilies", () => {
  it("puts configured families first and appends the fallbacks", () => {
    expect(terminalFontFamilies(["Iosevka"])).toEqual(["Iosevka", ...FALLBACK_FONT_FAMILIES]);
  });

  it("dedupes case-insensitively — a configured fallback is not repeated", () => {
    const families = terminalFontFamilies(["menlo", "Iosevka"]);
    expect(families.filter((f) => f.toLowerCase() === "menlo")).toEqual(["menlo"]);
  });

  it("drops empty entries and trims whitespace", () => {
    expect(terminalFontFamilies(["  ", " Iosevka "])[0]).toBe("Iosevka");
  });

  it("never returns an empty chain", () => {
    expect(terminalFontFamilies([]).length).toBeGreaterThan(0);
  });
});

describe("overlayGhosttyTheme", () => {
  it("lets defined overlay keys win and keeps the rest of the base", () => {
    const overlay: GhosttyTheme = {
      raw: { background: "#ff0000" },
      colors: { background: { r: 0xff, g: 0, b: 0 }, palette: [] },
    };
    const merged = overlayGhosttyTheme(FALLBACK, overlay);
    expect(merged.colors.background).toEqual({ r: 0xff, g: 0, b: 0 });
    expect(merged.colors.foreground).toEqual(FALLBACK.colors.foreground);
    expect(merged.name).toBe("Volli Dark");
  });

  it("merges palette entries index-by-index", () => {
    const base: GhosttyTheme = {
      raw: {},
      colors: {
        palette: [
          { r: 1, g: 1, b: 1 },
          { r: 2, g: 2, b: 2 },
        ],
      },
    };
    const overlay: GhosttyTheme = {
      raw: {},
      colors: { palette: [undefined, { r: 9, g: 9, b: 9 }] },
    };
    expect(overlayGhosttyTheme(base, overlay).colors.palette).toEqual([
      { r: 1, g: 1, b: 1 },
      { r: 9, g: 9, b: 9 },
    ]);
  });
});

describe("resolveGhosttyThemeChoice", () => {
  it("resolves a builtin theme by name (the owner's real config case)", () => {
    const theme = resolveGhosttyThemeChoice(payload({ themeName: "Front End Delight" }), FALLBACK);
    expect(theme.colors.background).toEqual({ r: 27, g: 28, b: 29 });
  });

  it("prefers an explicit theme file over the builtin catalog", () => {
    const theme = resolveGhosttyThemeChoice(
      payload({ themeName: "Front End Delight" }, { themeSource: "background = #123456" }),
      FALLBACK,
    );
    expect(theme.colors.background).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
  });

  it("falls back to the token theme for an unknown name", () => {
    const theme = resolveGhosttyThemeChoice(payload({ themeName: "No Such Theme" }), FALLBACK);
    expect(theme.colors.background).toEqual(FALLBACK.colors.background);
  });

  it("overlays explicit config color keys on the chosen theme (ghostty: user keys win)", () => {
    const theme = resolveGhosttyThemeChoice(
      payload(
        { themeName: "Front End Delight" },
        { configText: 'theme = "Front End Delight"\nbackground = #101010' },
      ),
      FALLBACK,
    );
    expect(theme.colors.background).toEqual({ r: 0x10, g: 0x10, b: 0x10 });
  });
});

describe("resolveAppearance", () => {
  it("yields pure defaults when no config exists", () => {
    const appearance = resolveAppearance(null, FALLBACK);
    expect(appearance).toEqual({
      theme: FALLBACK,
      fontFamilies: [...FALLBACK_FONT_FAMILIES],
      fontSize: DEFAULT_TERMINAL_FONT_SIZE,
      ligatures: true,
      mouseReporting: true,
      macosOptionAsAlt: false,
      scrollbackLimitBytes: null,
    });
  });

  it("defaults every unset pref when a config exists but sets none of them", () => {
    const appearance = resolveAppearance(payload({}), FALLBACK);
    expect(appearance.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(appearance.ligatures).toBe(true);
    expect(appearance.mouseReporting).toBe(true);
    expect(appearance.macosOptionAsAlt).toBe(false);
    expect(appearance.scrollbackLimitBytes).toBeNull();
  });

  it("maps every configured pref and defaults the unset ones", () => {
    const appearance = resolveAppearance(
      payload({
        fontFamilies: ["Iosevka"],
        fontSize: 15,
        ligatures: false,
        mouseReporting: false,
        macosOptionAsAlt: "left",
        scrollbackLimitBytes: 1_000_000,
      }),
      FALLBACK,
    );
    expect(appearance.fontFamilies[0]).toBe("Iosevka");
    expect(appearance.fontSize).toBe(15);
    expect(appearance.ligatures).toBe(false);
    expect(appearance.mouseReporting).toBe(false);
    expect(appearance.macosOptionAsAlt).toBe("left");
    expect(appearance.scrollbackLimitBytes).toBe(1_000_000);
    expect(appearance.theme).toEqual(FALLBACK);
  });
});
