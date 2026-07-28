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
  it("defaults to one-dark-pro when no id is authored", () => {
    expect(DEFAULT_EDITOR_THEME_ID).toBe("one-dark-pro");
    expect(resolveEditorThemeId({ editorThemeId: null })).toBe("one-dark-pro");
    expect(resolveEditorThemeId({ editorThemeId: undefined })).toBe("one-dark-pro");
  });

  it("honors an explicit catalog editorThemeId", () => {
    expect(resolveEditorThemeId({ editorThemeId: "dracula" })).toBe("dracula");
  });

  it("falls back to the default for a non-shipped, non-empty id", () => {
    // The whole of the fallback behaviour now: an id that names no catalog
    // theme is indistinguishable from nothing chosen.
    expect(resolveEditorThemeId({ editorThemeId: "not-a-theme" })).toBe(DEFAULT_EDITOR_THEME_ID);
  });

  it("falls back to the default for an empty string", () => {
    expect(resolveEditorThemeId({ editorThemeId: "" })).toBe(DEFAULT_EDITOR_THEME_ID);
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
