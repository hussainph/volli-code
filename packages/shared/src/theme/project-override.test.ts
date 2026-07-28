import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROJECT_THEME_OVERRIDE,
  isProjectThemeOverride,
  isProjectThemeOverrideEmpty,
} from "./project-override";

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
    expect(
      isProjectThemeOverrideEmpty({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: "nord" }),
    ).toBe(false);
    expect(isProjectThemeOverrideEmpty({ ...EMPTY_PROJECT_THEME_OVERRIDE, seed: "#3a7d9a" })).toBe(
      false,
    );
    expect(
      isProjectThemeOverrideEmpty({ ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: "sea" }),
    ).toBe(false);
  });

  it("guards the per-surface shape", () => {
    expect(isProjectThemeOverride(EMPTY_PROJECT_THEME_OVERRIDE)).toBe(true);
    expect(
      isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: "catppuccin-mocha" }),
    ).toBe(true);
    expect(isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: "nord" })).toBe(
      true,
    );
    expect(isProjectThemeOverride({ appThemeSlug: "x" })).toBe(false);
    expect(isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, terminalThemeName: 7 })).toBe(
      false,
    );
    expect(isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, seed: 7 })).toBe(false);
    expect(isProjectThemeOverride(null)).toBe(false);
    expect(isProjectThemeOverride([])).toBe(false);
  });

  it("rejects a non-catalog editorThemeId while still allowing null inherit", () => {
    expect(isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: null })).toBe(
      true,
    );
    expect(
      isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: "volli-dark" }),
    ).toBe(false);
    expect(
      isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: "not-a-theme" }),
    ).toBe(false);
    expect(isProjectThemeOverride({ ...EMPTY_PROJECT_THEME_OVERRIDE, editorThemeId: "" })).toBe(
      false,
    );
  });
});
