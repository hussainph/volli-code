import { describe, expect, it, vi } from "vite-plus/test";

import { SHIPPED_EDITOR_THEME_IDS } from "@volli/shared";

import { editorThemeImporterFor, resolveEditorThemeId } from "./editor-theme-catalog";

describe("editorThemeImporterFor", () => {
  it("returns a loadable static importer for both shipped themes", async () => {
    for (const id of SHIPPED_EDITOR_THEME_IDS) {
      const load = editorThemeImporterFor(id);
      expect(load).not.toBeNull();
      expect(await load!()).toBeTruthy();
    }
  });

  it("returns null for unknown and retired ids", () => {
    expect(editorThemeImporterFor("volli-dark")).toBeNull();
    expect(editorThemeImporterFor("")).toBeNull();
    // Retired with the picker: no importer means no way to resurrect one.
    expect(editorThemeImporterFor("one-dark-pro")).toBeNull();
    expect(editorThemeImporterFor("nord")).toBeNull();
  });
});

describe("resolveEditorThemeId", () => {
  it("answers the light theme in a light app and the dark theme in a dark app", () => {
    expect(resolveEditorThemeId({ resolvedAppearance: "light" })).toBe("vitesse-light");
    expect(resolveEditorThemeId({ resolvedAppearance: "dark" })).toBe("vitesse-dark");
  });

  it("resolves to a theme it can actually load", async () => {
    for (const resolved of ["light", "dark"] as const) {
      const load = editorThemeImporterFor(resolveEditorThemeId({ resolvedAppearance: resolved }));
      expect(load).not.toBeNull();
      expect(await load!()).toBeTruthy();
    }
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
