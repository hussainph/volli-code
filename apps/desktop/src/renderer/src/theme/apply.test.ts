import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_THEME,
  EMPTY_PROJECT_THEME_OVERRIDE,
  generateThemeTokens,
  generateVeilTokens,
  THEME_TOKEN_NAMES,
  THEME_VEIL_TOKEN_NAMES,
  type ThemeDefinition,
} from "@volli/shared";

import { applyThemeTokens, resolveActiveTheme } from "./apply";

/**
 * The renderer test project runs under vitest's default `node` environment, so
 * there is no DOM. `applyThemeTokens` only ever touches `root.style`, so a
 * recording stand-in exercises the real contract (which properties get written,
 * with which values) without pulling in jsdom.
 */
function fakeRoot() {
  const written = new Map<string, string>();
  const root = {
    style: {
      setProperty(name: string, value: string) {
        written.set(name, value);
      },
    },
  };
  return { root: root as unknown as HTMLElement, written };
}

const MIDNIGHT: ThemeDefinition = {
  ...DEFAULT_THEME,
  name: "Midnight",
  slug: "midnight",
  seed: "#4c6ef5",
};

describe("applyThemeTokens", () => {
  it("writes every themeable token as a custom property on the root", () => {
    const { root, written } = fakeRoot();
    const tokens = generateThemeTokens(DEFAULT_THEME);

    applyThemeTokens(tokens, root);

    for (const name of THEME_TOKEN_NAMES) expect(written.get(name)).toBe(tokens[name]);
  });

  it("writes the veils alongside the tokens they are solved from", () => {
    // A veil is generated from the token set, so it has to move WITH it. Left
    // behind, every veiled surface would keep compositing to the previous
    // theme's rung — the sidebar frozen on the old palette while the rail under
    // it repaints, which is the most visible half of a theme change.
    const { root, written } = fakeRoot();
    const tokens = generateThemeTokens(MIDNIGHT);

    applyThemeTokens(tokens, root);

    const veils = generateVeilTokens(tokens);
    for (const name of THEME_VEIL_TOKEN_NAMES) expect(written.get(name)).toBe(veils[name]);
  });

  it("writes nothing but color tokens — geometry and type never follow a theme", () => {
    const { root, written } = fakeRoot();
    applyThemeTokens(generateThemeTokens(DEFAULT_THEME), root);
    const colorTokens: readonly string[] = [...THEME_TOKEN_NAMES, ...THEME_VEIL_TOKEN_NAMES];
    for (const name of written.keys()) expect(colorTokens).toContain(name);
  });

  it("re-applying a different theme overwrites every token", () => {
    const { root, written } = fakeRoot();
    applyThemeTokens(generateThemeTokens(DEFAULT_THEME), root);
    const midnight = generateThemeTokens(MIDNIGHT);

    applyThemeTokens(midnight, root);

    expect(written.get("--primary")).toBe(midnight["--primary"]);
    expect(written.get("--background")).toBe(midnight["--background"]);
  });
});

describe("resolveActiveTheme", () => {
  const catalog = [DEFAULT_THEME, MIDNIGHT];

  it("inherits every surface from the global theme when there is no override", () => {
    const active = resolveActiveTheme(DEFAULT_THEME, null, catalog);

    expect(active.app).toEqual({ value: DEFAULT_THEME, scope: "global" });
    expect(active.terminal).toEqual({ value: null, scope: "global" });
    expect(active.editor).toEqual({ value: null, scope: "global" });
  });

  it("inherits the global editor theme id when the project does not override it", () => {
    const active = resolveActiveTheme(DEFAULT_THEME, null, catalog, "nord");

    expect(active.editor).toEqual({ value: "nord", scope: "global" });
  });

  it("keeps inheriting the global editor id when only another surface is overridden", () => {
    const active = resolveActiveTheme(
      DEFAULT_THEME,
      { ...EMPTY_PROJECT_THEME_OVERRIDE, terminalThemeName: "Nord" },
      catalog,
      "dracula",
    );

    expect(active.editor).toEqual({ value: "dracula", scope: "global" });
    expect(active.terminal).toEqual({ value: "Nord", scope: "project" });
  });

  it("inherits per surface — an override of one surface leaves the others global", () => {
    const active = resolveActiveTheme(
      DEFAULT_THEME,
      { ...EMPTY_PROJECT_THEME_OVERRIDE, terminalThemeName: "Nord" },
      catalog,
    );

    expect(active.terminal).toEqual({ value: "Nord", scope: "project" });
    expect(active.app.scope).toBe("global");
    expect(active.editor.scope).toBe("global");
  });

  it("overrides the editor independently of the other two surfaces", () => {
    const active = resolveActiveTheme(
      DEFAULT_THEME,
      { ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: "catppuccin-mocha" },
      catalog,
    );

    expect(active.editor).toEqual({ value: "catppuccin-mocha", scope: "project" });
    expect(active.app.scope).toBe("global");
    expect(active.terminal.scope).toBe("global");
  });

  it("resolves a project's app theme slug against the catalog", () => {
    const active = resolveActiveTheme(
      DEFAULT_THEME,
      { ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: "midnight" },
      catalog,
    );

    expect(active.app).toEqual({ value: MIDNIGHT, scope: "project" });
  });

  it("auto-tints the global theme from the project seed when no slug is set (#72)", () => {
    const active = resolveActiveTheme(
      DEFAULT_THEME,
      { ...EMPTY_PROJECT_THEME_OVERRIDE, seed: "#3f9142" },
      catalog,
    );

    expect(active.app.scope).toBe("project");
    expect(active.app.value.seed).toBe("#3f9142");
    // Everything else about the global theme is kept — only the seed moves.
    expect(active.app.value.grain).toBe(DEFAULT_THEME.grain);
    expect(active.app.value.canvas).toEqual(DEFAULT_THEME.canvas);
  });

  it("returns the identical derived-tint object for the same inputs, twice", () => {
    // Not a performance nicety: this value is read through a zustand selector,
    // and zustand v5 compares each render's snapshot with `Object.is`. A fresh
    // object per call is an infinite render loop, so reference stability is
    // the contract — assert it directly rather than via the value.
    const override = { ...EMPTY_PROJECT_THEME_OVERRIDE, seed: "#3f9142" };

    const first = resolveActiveTheme(DEFAULT_THEME, override, catalog).app.value;
    const second = resolveActiveTheme(DEFAULT_THEME, override, catalog).app.value;

    expect(second).toBe(first);
  });

  it("derives a distinct tint per global theme and per override", () => {
    const override = { ...EMPTY_PROJECT_THEME_OVERRIDE, seed: "#3f9142" };
    const otherOverride = { ...EMPTY_PROJECT_THEME_OVERRIDE, seed: "#b5651d" };

    const base = resolveActiveTheme(DEFAULT_THEME, override, catalog).app.value;
    // Same global, second override: the per-global cache exists but misses.
    const other = resolveActiveTheme(DEFAULT_THEME, otherOverride, catalog).app.value;
    // Same override, second global: a tint follows the theme it tints, so a
    // changed global theme must not serve the previous theme's tint back.
    const onMidnight = resolveActiveTheme(MIDNIGHT, override, catalog).app.value;

    expect(other.seed).toBe("#b5651d");
    expect(onMidnight).not.toBe(base);
    expect(onMidnight.name).toBe("Midnight (tinted)");
    expect(resolveActiveTheme(MIDNIGHT, override, catalog).app.value).toBe(onMidnight);
  });

  it("prefers an explicitly named theme over the derived tint", () => {
    const active = resolveActiveTheme(
      DEFAULT_THEME,
      { ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: "midnight", seed: "#3f9142" },
      catalog,
    );

    expect(active.app.value).toEqual(MIDNIGHT);
  });

  it("falls back rather than failing when the named theme is gone", () => {
    const active = resolveActiveTheme(
      DEFAULT_THEME,
      { ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: "deleted-theme" },
      catalog,
    );

    expect(active.app).toEqual({ value: DEFAULT_THEME, scope: "global" });
  });

  it("resolves a slug naming the global theme itself without needing a catalog", () => {
    const active = resolveActiveTheme(DEFAULT_THEME, {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: DEFAULT_THEME.slug,
    });

    expect(active.app).toEqual({ value: DEFAULT_THEME, scope: "project" });
  });
});
