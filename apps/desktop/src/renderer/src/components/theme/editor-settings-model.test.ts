import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_EDITOR_THEME_ID, listEditorThemes } from "@renderer/editor/editor-theme-catalog";

import {
  buildEditorThemeDisplay,
  editorThemeLabel,
  planEditorThemePreview,
} from "./editor-settings-model";

describe("buildEditorThemeDisplay", () => {
  const themes = listEditorThemes();

  it("resolves to the shipped default when editorThemeId is null", () => {
    const display = buildEditorThemeDisplay({
      editorThemeId: null,
      themes,
    });

    expect(display.resolvedId).toBe(DEFAULT_EDITOR_THEME_ID);
    expect(display.label).toBe("One Dark Pro");
    expect(display.source).toBe("automatic");
    expect(display.sourceLabel).toBe("Default");
    expect(display.resettable).toBe(false);
  });

  it("honors an explicit catalog id", () => {
    const display = buildEditorThemeDisplay({
      editorThemeId: "nord",
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
      themes,
    });

    expect(display.source).toBe("automatic");
    expect(display.resolvedId).toBe(DEFAULT_EDITOR_THEME_ID);
    expect(display.resettable).toBe(false);
  });

  it("defaults to the shipped catalog when themes are omitted", () => {
    const display = buildEditorThemeDisplay({
      editorThemeId: null,
    });

    expect(display.label).toBe("One Dark Pro");
    expect(display.sourceLabel).toBe("Default");
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

  it("post-commit restore input equals the committed catalog id (endPreview contract)", () => {
    // After setEditorTheme("nord") the store already holds nord; endPreview must
    // resolve from those live inputs — not a stale pre-commit resolvedId.
    const committed = buildEditorThemeDisplay({
      editorThemeId: "nord",
      themes: listEditorThemes(),
    });
    expect(
      planEditorThemePreview({ selection: "", resolvedId: committed.resolvedId }).themeId,
    ).toBe("nord");
  });
});
