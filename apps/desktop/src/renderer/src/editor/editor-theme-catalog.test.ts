import { describe, expect, it } from "vite-plus/test";

import { allEditorThemeImporters, listEditorThemes } from "./editor-theme-catalog";

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
