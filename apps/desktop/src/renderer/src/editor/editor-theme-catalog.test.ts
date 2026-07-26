import { describe, expect, it } from "vite-plus/test";

import { SHIPPED_EDITOR_THEME_IDS } from "@volli/shared";

import {
  allEditorThemeImporters,
  DEFAULT_EDITOR_THEME_ID,
  editorThemeIdForAppSlug,
  listEditorThemes,
  resolveEditorThemeId,
} from "./editor-theme-catalog";

describe("listEditorThemes", () => {
  it("returns a catalog entry for each shipped editor theme", () => {
    const themes = listEditorThemes();

    expect(themes.length).toBeGreaterThanOrEqual(18);
    expect(themes.length).toBeLessThanOrEqual(22);
    expect(themes[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        label: expect.any(String),
      }),
    );
  });

  it("has unique theme ids", () => {
    const ids = listEditorThemes().map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("matches SHIPPED_EDITOR_THEME_IDS exactly so the IPC guard cannot drift", () => {
    expect(listEditorThemes().map((theme) => theme.id)).toEqual([...SHIPPED_EDITOR_THEME_IDS]);
  });
});

describe("allEditorThemeImporters", () => {
  it("returns one static importer per catalog id", async () => {
    const themes = listEditorThemes();
    const importers = allEditorThemeImporters();

    expect(importers).toHaveLength(themes.length);

    for (const importer of importers) {
      expect(typeof importer).toBe("function");
    }

    // Every catalog id must resolve to a loadable @shikijs/themes module.
    const loaded = await Promise.all(
      importers.map(async (load) => {
        if (typeof load !== "function") throw new Error("expected dynamic theme importer");
        return load();
      }),
    );
    expect(loaded).toHaveLength(themes.length);
    for (const module of loaded) {
      expect(module).toBeTruthy();
    }
  });
});

describe("resolveEditorThemeId", () => {
  it("defaults ember (and the shared default constant) to one-dark-pro", () => {
    expect(DEFAULT_EDITOR_THEME_ID).toBe("one-dark-pro");
    expect(resolveEditorThemeId({ editorThemeId: null, appThemeSlug: "ember" })).toBe(
      "one-dark-pro",
    );
  });

  it.each([
    ["ember", "one-dark-pro"],
    ["midnight", "tokyo-night"],
    ["moss", "everforest-dark"],
    ["iris", "catppuccin-mocha"],
    ["rose", "rose-pine"],
    ["graphite", "github-dark"],
  ] as const)("maps app slug %s → %s when editorThemeId is unset", (slug, expected) => {
    expect(resolveEditorThemeId({ editorThemeId: null, appThemeSlug: slug })).toBe(expected);
    expect(resolveEditorThemeId({ editorThemeId: undefined, appThemeSlug: slug })).toBe(expected);
  });

  it("falls back to one-dark-pro for unknown app theme slugs", () => {
    expect(resolveEditorThemeId({ editorThemeId: null, appThemeSlug: "my-custom-theme" })).toBe(
      DEFAULT_EDITOR_THEME_ID,
    );
    expect(resolveEditorThemeId({ editorThemeId: null, appThemeSlug: null })).toBe(
      DEFAULT_EDITOR_THEME_ID,
    );
  });

  it("honors an explicit catalog editorThemeId over the app slug", () => {
    expect(resolveEditorThemeId({ editorThemeId: "dracula", appThemeSlug: "ember" })).toBe(
      "dracula",
    );
  });

  it("ignores an unknown explicit editorThemeId and maps from the app slug", () => {
    expect(resolveEditorThemeId({ editorThemeId: "volli-dark", appThemeSlug: "midnight" })).toBe(
      "tokyo-night",
    );
    expect(resolveEditorThemeId({ editorThemeId: "not-a-theme", appThemeSlug: "unknown" })).toBe(
      DEFAULT_EDITOR_THEME_ID,
    );
    expect(resolveEditorThemeId({ editorThemeId: "", appThemeSlug: "moss" })).toBe(
      "everforest-dark",
    );
  });

  it("exposes editorThemeIdForAppSlug as the null-override convenience", () => {
    expect(editorThemeIdForAppSlug("iris")).toBe("catppuccin-mocha");
    expect(editorThemeIdForAppSlug(null)).toBe(DEFAULT_EDITOR_THEME_ID);
  });
});
