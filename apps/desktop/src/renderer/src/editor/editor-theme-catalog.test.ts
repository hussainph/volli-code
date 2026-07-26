import { describe, expect, it, vi } from "vite-plus/test";

import { SHIPPED_EDITOR_THEME_IDS } from "@volli/shared";

import {
  DEFAULT_EDITOR_THEME_ID,
  editorThemeImporterFor,
  listEditorThemes,
  resolveEditorThemeId,
} from "./editor-theme-catalog";

describe("listEditorThemes", () => {
  it("returns a catalog entry for each shipped editor theme", () => {
    const themes = listEditorThemes();

    expect(themes.map((theme) => theme.id)).toEqual([...SHIPPED_EDITOR_THEME_IDS]);
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

describe("editorThemeImporterFor", () => {
  it("returns the static importer for a shipped catalog id", async () => {
    const load = editorThemeImporterFor("nord");
    expect(load).not.toBeNull();
    expect(typeof load).toBe("function");
    expect(await load!()).toBeTruthy();
  });

  it("returns null for unknown ids", () => {
    expect(editorThemeImporterFor("volli-dark")).toBeNull();
    expect(editorThemeImporterFor("")).toBeNull();
  });

  it("returns a static importer for every catalog entry", async () => {
    for (const theme of listEditorThemes()) {
      const load = editorThemeImporterFor(theme.id);
      expect(load).not.toBeNull();
      expect(await load!()).toBeTruthy();
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
});

describe("catalog alignment", () => {
  it("throws when EDITOR_THEMES ids drift from SHIPPED_EDITOR_THEME_IDS", async () => {
    vi.resetModules();
    vi.doMock("@volli/shared", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@volli/shared")>();
      return {
        ...actual,
        SHIPPED_EDITOR_THEME_IDS: [
          "drifted-id",
        ] as unknown as typeof actual.SHIPPED_EDITOR_THEME_IDS,
      };
    });

    try {
      await expect(import("./editor-theme-catalog")).rejects.toThrow(
        /EDITOR_THEMES ids must match SHIPPED_EDITOR_THEME_IDS exactly/,
      );
    } finally {
      vi.doUnmock("@volli/shared");
      vi.resetModules();
    }
  });
});
