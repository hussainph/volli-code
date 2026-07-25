import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_THEME } from "./definition";
import type { ThemeDefinition } from "./definition";
import {
  EMPTY_PROJECT_THEME_OVERRIDE,
  isProjectThemeOverride,
  isProjectThemeOverrideEmpty,
  isThemeDefinition,
  parseGlobalTheme,
  serializeGlobalTheme,
  THEME_APP_STATE_KEY,
} from "./persistence";

describe("global theme persistence", () => {
  it("stores the authored definition under the `theme` app_state key", () => {
    expect(THEME_APP_STATE_KEY).toBe("theme");
  });

  it("round-trips an authored definition", () => {
    expect(parseGlobalTheme(serializeGlobalTheme(DEFAULT_THEME))).toEqual(DEFAULT_THEME);
  });

  // docs/plans/theming-engine.md § Derived rules, first bullet: the resolved
  // token set is DERIVED at render time and persisted nowhere. VS Code's
  // most-complained-about theming bug is auto-switching writing the resolved
  // theme back over the user's authored intent.
  it("never persists a resolved token set", () => {
    const smuggled = {
      ...DEFAULT_THEME,
      tokens: { "--background": "#15100e", "--foreground": "#f5f5f5" },
    } as ThemeDefinition;
    const json = serializeGlobalTheme(smuggled);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed["tokens"]).toBeUndefined();
    expect(json).not.toContain("--");
    expect(Object.keys(parsed).toSorted()).toEqual(
      ["accent", "appearance", "canvas", "grain", "name", "overrides", "seed", "slug"].toSorted(),
    );
  });

  it("keeps the theme's own sparse authored overrides — those are intent, not resolution", () => {
    const authored: ThemeDefinition = {
      ...DEFAULT_THEME,
      overrides: { "--border-strong": "#4a3227" },
    };
    const parsed = parseGlobalTheme(serializeGlobalTheme(authored));
    expect(parsed?.overrides).toEqual({ "--border-strong": "#4a3227" });
  });

  it("reports null for a missing, malformed, or wrong-shaped value", () => {
    expect(parseGlobalTheme(undefined)).toBeNull();
    expect(parseGlobalTheme("")).toBeNull();
    expect(parseGlobalTheme("{ not json")).toBeNull();
    expect(parseGlobalTheme('{"name":"X"}')).toBeNull();
    expect(parseGlobalTheme("[]")).toBeNull();
  });

  it("guards a definition's shape", () => {
    expect(isThemeDefinition(DEFAULT_THEME)).toBe(true);
    expect(isThemeDefinition({ ...DEFAULT_THEME, seed: 42 })).toBe(false);
    expect(isThemeDefinition({ ...DEFAULT_THEME, canvas: { kind: "hologram" } })).toBe(false);
    expect(isThemeDefinition({ ...DEFAULT_THEME, overrides: { "--border": 3 } })).toBe(false);
    expect(isThemeDefinition({ ...DEFAULT_THEME, appearance: "sepia" })).toBe(false);
    expect(isThemeDefinition(null)).toBe(false);
  });
});

describe("project theme override", () => {
  it("inherits on every surface by default", () => {
    expect(EMPTY_PROJECT_THEME_OVERRIDE).toEqual({
      appThemeSlug: null,
      terminalThemeName: null,
      editorThemeId: null,
      seed: null,
    });
    expect(isProjectThemeOverrideEmpty(EMPTY_PROJECT_THEME_OVERRIDE)).toBe(true);
    expect(
      isProjectThemeOverrideEmpty({ ...EMPTY_PROJECT_THEME_OVERRIDE, terminalThemeName: "Nord" }),
    ).toBe(false);
  });

  it("guards the per-surface shape", () => {
    expect(isProjectThemeOverride(EMPTY_PROJECT_THEME_OVERRIDE)).toBe(true);
    expect(
      isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: "catppuccin-mocha" }),
    ).toBe(true);
    expect(isProjectThemeOverride({ appThemeSlug: "x" })).toBe(false);
    expect(isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, seed: 7 })).toBe(false);
    expect(isProjectThemeOverride(null)).toBe(false);
  });
});

const withCanvas = (canvas: unknown): unknown => ({ ...DEFAULT_THEME, canvas });

describe("the canvas guard", () => {
  it("accepts a gradient or mesh carrying string stops", () => {
    expect(isThemeDefinition(withCanvas({ kind: "gradient", stops: ["#2a1207", "#0d0d0d"] }))).toBe(
      true,
    );
    expect(isThemeDefinition(withCanvas({ kind: "mesh", stops: [] }))).toBe(true);
  });

  it("rejects a gradient whose stops are missing or not strings", () => {
    expect(isThemeDefinition(withCanvas({ kind: "gradient" }))).toBe(false);
    expect(isThemeDefinition(withCanvas({ kind: "mesh", stops: "#fff" }))).toBe(false);
    expect(isThemeDefinition(withCanvas({ kind: "gradient", stops: ["#fff", 7] }))).toBe(false);
  });

  it("rejects a canvas that is not an object at all", () => {
    expect(isThemeDefinition(withCanvas("solid"))).toBe(false);
    expect(isThemeDefinition(withCanvas(null))).toBe(false);
  });

  it("round-trips a gradient canvas through storage", () => {
    const themed: ThemeDefinition = {
      ...DEFAULT_THEME,
      canvas: { kind: "gradient", stops: ["#2a1207", "#0d0d0d"] },
    };
    expect(parseGlobalTheme(serializeGlobalTheme(themed))).toEqual(themed);
  });
});
