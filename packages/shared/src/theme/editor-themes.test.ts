import { describe, expect, it } from "vite-plus/test";

import { isShippedEditorThemeId, SHIPPED_EDITOR_THEME_IDS } from "./editor-themes";

describe("SHIPPED_EDITOR_THEME_IDS", () => {
  it("lists unique non-empty catalog ids", () => {
    expect(SHIPPED_EDITOR_THEME_IDS.length).toBeGreaterThanOrEqual(18);
    expect(new Set(SHIPPED_EDITOR_THEME_IDS).size).toBe(SHIPPED_EDITOR_THEME_IDS.length);
    for (const id of SHIPPED_EDITOR_THEME_IDS) {
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it("includes the ember default and common picker targets", () => {
    expect(SHIPPED_EDITOR_THEME_IDS).toContain("one-dark-pro");
    expect(SHIPPED_EDITOR_THEME_IDS).toContain("nord");
    expect(SHIPPED_EDITOR_THEME_IDS).toContain("tokyo-night");
  });
});

describe("isShippedEditorThemeId", () => {
  it("accepts every shipped id and rejects unknowns", () => {
    for (const id of SHIPPED_EDITOR_THEME_IDS) {
      expect(isShippedEditorThemeId(id)).toBe(true);
    }
    expect(isShippedEditorThemeId("volli-dark")).toBe(false);
    expect(isShippedEditorThemeId("not-a-theme")).toBe(false);
    expect(isShippedEditorThemeId("")).toBe(false);
  });
});
