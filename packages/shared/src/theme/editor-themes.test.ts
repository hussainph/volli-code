import { describe, expect, it } from "vite-plus/test";

import {
  editorThemeForAppearance,
  isShippedEditorThemeId,
  SHIPPED_EDITOR_THEME_IDS,
} from "./editor-themes";

describe("SHIPPED_EDITOR_THEME_IDS", () => {
  it("ships exactly one light and one dark theme", () => {
    expect(SHIPPED_EDITOR_THEME_IDS).toEqual(["vitesse-light", "vitesse-dark"]);
  });
});

describe("editorThemeForAppearance", () => {
  it("answers the light theme in light and the dark theme in dark", () => {
    expect(editorThemeForAppearance("light")).toBe("vitesse-light");
    expect(editorThemeForAppearance("dark")).toBe("vitesse-dark");
  });

  it("answers a shipped id for every resolved appearance", () => {
    for (const resolved of ["light", "dark"] as const) {
      expect(isShippedEditorThemeId(editorThemeForAppearance(resolved))).toBe(true);
    }
  });

  it("gives the two appearances different themes", () => {
    // The whole point of the pairing: a light app must not wear a dark editor.
    expect(editorThemeForAppearance("light")).not.toBe(editorThemeForAppearance("dark"));
  });
});

describe("isShippedEditorThemeId", () => {
  it("accepts every shipped id and rejects unknowns", () => {
    for (const id of SHIPPED_EDITOR_THEME_IDS) {
      expect(isShippedEditorThemeId(id)).toBe(true);
    }
    expect(isShippedEditorThemeId("")).toBe(false);
    expect(isShippedEditorThemeId("volli-dark")).toBe(false);
    expect(isShippedEditorThemeId("not-a-theme")).toBe(false);
  });

  it("rejects the retired catalog ids a previous build could have persisted", () => {
    // These were shipped picker choices before VC-123 collapsed the catalog;
    // an old `app_state.theme_editor` row can still name one.
    for (const retired of ["one-dark-pro", "nord", "dracula", "tokyo-night", "monokai"]) {
      expect(isShippedEditorThemeId(retired)).toBe(false);
    }
  });
});
