import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROJECT_THEME_OVERRIDE,
  isProjectThemeOverride,
  isProjectThemeOverrideEmpty,
} from "./project-override";

describe("project theme override", () => {
  it("inherits on every surface by default", () => {
    expect(EMPTY_PROJECT_THEME_OVERRIDE).toEqual({ terminalThemeName: null });
    expect(isProjectThemeOverrideEmpty(EMPTY_PROJECT_THEME_OVERRIDE)).toBe(true);
    expect(
      isProjectThemeOverrideEmpty({ ...EMPTY_PROJECT_THEME_OVERRIDE, terminalThemeName: "Nord" }),
    ).toBe(false);
  });

  it("guards the per-surface shape", () => {
    expect(isProjectThemeOverride(EMPTY_PROJECT_THEME_OVERRIDE)).toBe(true);
    expect(isProjectThemeOverride({ terminalThemeName: "Nord" })).toBe(true);
    expect(isProjectThemeOverride({})).toBe(false);
    expect(isProjectThemeOverride({ terminalThemeName: 7 })).toBe(false);
    expect(isProjectThemeOverride(null)).toBe(false);
    expect(isProjectThemeOverride([])).toBe(false);
  });

  it("carries no editor surface: the editor follows appearance, which is its own column", () => {
    // VC-123. A project can still override light/dark (migration 014's
    // `theme_appearance`), and the editor follows THAT — so a per-project
    // editor theme id would be a second, contradictable answer to a question
    // already settled.
    expect(EMPTY_PROJECT_THEME_OVERRIDE).not.toHaveProperty("editorThemeId");
    // An extra key is ignored rather than rejected: an older renderer's payload
    // still names a project's terminal correctly, and the editor half is now
    // simply not consulted.
    expect(isProjectThemeOverride({ terminalThemeName: null, editorThemeId: "nord" })).toBe(true);
  });
});
