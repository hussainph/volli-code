import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_THEME,
  EMPTY_PROJECT_THEME_OVERRIDE,
  generateThemeTokens,
  THEME_TOKEN_NAMES,
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

    expect(written.size).toBe(THEME_TOKEN_NAMES.length);
    for (const name of THEME_TOKEN_NAMES) expect(written.get(name)).toBe(tokens[name]);
  });

  it("writes nothing but color tokens — geometry and type never follow a theme", () => {
    const { root, written } = fakeRoot();
    applyThemeTokens(generateThemeTokens(DEFAULT_THEME), root);
    for (const name of written.keys()) {
      expect(THEME_TOKEN_NAMES as readonly string[]).toContain(name);
    }
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
