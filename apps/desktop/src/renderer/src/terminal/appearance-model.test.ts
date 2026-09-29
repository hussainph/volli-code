import { describe, expect, it } from "vite-plus/test";
import type { GhosttyAppearancePayload, GhosttyTerminalPrefs, GhosttyTheme } from "@volli/shared";

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
  // Overlay chain fields (theming engine, decision #67) — this suite predates
  // them and exercises the prefs/theme mapping, so the fixture supplies the
  // "nothing overlaid" state.
  provenance: {},
  overlayPaths: { global: "/userData/volli/ghostty/config", project: null },
  ghosttyConfigPath: "/home/u/.config/ghostty/config",
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
  it("resolves the theme FILE main read off the user's own disk", () => {
    const theme = resolveGhosttyThemeChoice(
      payload({ themeName: "user-theme" }, { themeSource: "background = #123456" }),
      FALLBACK,
      "dark",
    );
    expect(theme.colors.background).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
  });

  /**
   * VC-413. A name used to be looked up in a theme catalog vendored out of
   * Ghostty.app when no file answered to it; the app ships no catalog, so a name
   * with no file behind it is an UNAVAILABLE override rather than an error. The
   * terminal wears the app's own token-derived palette — nothing is written and
   * the name stays in the user's config, so it starts painting again the moment
   * a file by that name exists.
   */
  it("falls back to the token theme for a name no file on this machine answers to", () => {
    const theme = resolveGhosttyThemeChoice(
      payload({ themeName: "a-theme-with-no-file" }),
      FALLBACK,
      "dark",
    );
    expect(theme.colors.background).toEqual(FALLBACK.colors.background);
  });

  // main resolves `theme = light:X,dark:Y` without knowing the mode, so the
  // half it picked is a guess; the live appearance re-picks from the config text
  // that travels with the payload. Without this a light-mode window renders the
  // user's DARK ghostty theme and nothing anywhere reports a problem.
  it("re-picks the half of a light/dark theme pair that matches the live mode", () => {
    const paired = payload(
      { themeName: "night-theme" },
      {
        configText: "theme = light:day-theme,dark:night-theme",
        themeSource: "background = #123456",
      },
    );

    const dark = resolveGhosttyThemeChoice(paired, FALLBACK, "dark");
    const light = resolveGhosttyThemeChoice(paired, FALLBACK, "light");

    // Dark is the half main resolved, so its file answers. Light is the other
    // half, whose file main never read — the token fallback answers instead.
    expect(dark.colors.background).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
    expect(light.colors.background).toEqual(FALLBACK.colors.background);
  });

  // The file main read belongs to the half main resolved. Reusing it for the
  // other half would paint a dark theme's colors in light mode — the fallback
  // (which the caller builds for the live mode) is the honest answer.
  it("ignores main's theme file when the live mode picks the other half", () => {
    const theme = resolveGhosttyThemeChoice(
      payload(
        { themeName: "night-theme" },
        {
          configText: "theme = light:day-theme,dark:night-theme",
          themeSource: "background = #123456",
        },
      ),
      FALLBACK,
      "light",
    );

    expect(theme.colors.background).toEqual(FALLBACK.colors.background);
  });

  it("overlays explicit config color keys on the chosen theme (ghostty: user keys win)", () => {
    const theme = resolveGhosttyThemeChoice(
      payload(
        { themeName: "user-theme" },
        {
          configText: 'theme = "user-theme"\nbackground = #101010',
          themeSource: "background = #123456",
        },
      ),
      FALLBACK,
      "dark",
    );
    expect(theme.colors.background).toEqual({ r: 0x10, g: 0x10, b: 0x10 });
  });

  it("overlays explicit config color keys on the token fallback too", () => {
    const theme = resolveGhosttyThemeChoice(
      payload(
        { themeName: "a-theme-with-no-file" },
        { configText: "theme = a-theme-with-no-file\nbackground = #101010" },
      ),
      FALLBACK,
      "dark",
    );
    expect(theme.colors.background).toEqual({ r: 0x10, g: 0x10, b: 0x10 });
  });
});

describe("resolveAppearance", () => {
  it("yields pure defaults when no config exists", () => {
    const appearance = resolveAppearance(null, FALLBACK, "dark");
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
    const appearance = resolveAppearance(payload({}), FALLBACK, "dark");
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
      "dark",
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
