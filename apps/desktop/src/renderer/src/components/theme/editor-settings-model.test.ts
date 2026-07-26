import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_EDITOR_THEME_ID, listEditorThemes } from "@renderer/editor/editor-theme-catalog";

import {
  buildEditorThemeDisplay,
  editorThemeLabel,
  planEditorThemePreview,
} from "./editor-settings-model";

describe("buildEditorThemeDisplay", () => {
  const themes = listEditorThemes();

  it("derives the effective theme from the app slug when editorThemeId is null", () => {
    const display = buildEditorThemeDisplay({
      editorThemeId: null,
      appThemeSlug: "ember",
      themes,
    });

    expect(display.resolvedId).toBe(DEFAULT_EDITOR_THEME_ID);
    expect(display.label).toBe("One Dark Pro");
    expect(display.source).toBe("automatic");
    expect(display.sourceLabel).toBe("Matches app theme");
    expect(display.resettable).toBe(false);
  });

  it("maps other app slugs when still automatic", () => {
    const display = buildEditorThemeDisplay({
      editorThemeId: null,
      appThemeSlug: "midnight",
      themes,
    });

    expect(display.resolvedId).toBe("tokyo-night");
    expect(display.label).toBe("Tokyo Night");
    expect(display.source).toBe("automatic");
  });

  it("honors an explicit catalog id over the app slug", () => {
    const display = buildEditorThemeDisplay({
      editorThemeId: "nord",
      appThemeSlug: "ember",
      themes,
    });

    expect(display.resolvedId).toBe("nord");
    expect(display.label).toBe("Nord");
    expect(display.source).toBe("explicit");
    expect(display.sourceLabel).toBe("Set by Volli");
    expect(display.resettable).toBe(true);
  });

  it("treats an empty string like automatic", () => {
    const display = buildEditorThemeDisplay({
      editorThemeId: "",
      appThemeSlug: "moss",
      themes,
    });

    expect(display.source).toBe("automatic");
    expect(display.resolvedId).toBe("everforest-dark");
    expect(display.resettable).toBe(false);
  });

  it("defaults to the shipped catalog when themes are omitted", () => {
    const display = buildEditorThemeDisplay({
      editorThemeId: null,
      appThemeSlug: "ember",
    });

    expect(display.label).toBe("One Dark Pro");
    expect(display.sourceLabel).toBe("Matches app theme");
  });
});

describe("editorThemeLabel", () => {
  it("returns the catalog label, or the id when unknown", () => {
    expect(editorThemeLabel(listEditorThemes(), "dracula")).toBe("Dracula");
    expect(editorThemeLabel([], "mystery")).toBe("mystery");
  });
});

describe("planEditorThemePreview", () => {
  it("previews a highlighted catalog id without writing", () => {
    expect(planEditorThemePreview({ selection: "nord", resolvedId: "one-dark-pro" })).toEqual({
      kind: "preview",
      themeId: "nord",
    });
  });

  it("restores the resolved id when the selection clears", () => {
    expect(planEditorThemePreview({ selection: "", resolvedId: "one-dark-pro" })).toEqual({
      kind: "restore",
      themeId: "one-dark-pro",
    });
  });

  it("always yields a themeId the Monaco refresh seam can apply", () => {
    const preview = planEditorThemePreview({ selection: "dracula", resolvedId: "nord" });
    const restore = planEditorThemePreview({ selection: "", resolvedId: "nord" });
    expect(preview.themeId).toBe("dracula");
    expect(restore.themeId).toBe("nord");
    expect(preview.kind).not.toBe(restore.kind);
  });
});
