import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_EDITOR_THEME_ID } from "./editor-theme-catalog";
import {
  applyMonacoThemeForDiffEditor,
  bindMonacoEditorThemeHost,
  ensureMonacoEditorTheme,
  refreshMonacoEditorTheme,
  resetMonacoEditorThemeForTests,
} from "./monaco-theme";

afterEach(() => {
  resetMonacoEditorThemeForTests();
});

describe("refreshMonacoEditorTheme", () => {
  it("no-ops safely before Monaco is bound and remembers the pending id", () => {
    expect(() => refreshMonacoEditorTheme("nord")).not.toThrow();

    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    expect(setTheme).toHaveBeenCalledWith("nord");
  });

  it("calls monaco.editor.setTheme when a host is already bound", () => {
    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    refreshMonacoEditorTheme("dracula");

    expect(setTheme).toHaveBeenCalledWith("dracula");
  });

  it("applies the latest pending id when Monaco binds after several refreshes", () => {
    refreshMonacoEditorTheme("nord");
    refreshMonacoEditorTheme("dracula");

    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    expect(setTheme).toHaveBeenCalledTimes(1);
    expect(setTheme).toHaveBeenCalledWith("dracula");
  });
});

describe("ensureMonacoEditorTheme", () => {
  it("activates the fallback only when nothing is pending", () => {
    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    ensureMonacoEditorTheme("one-dark-pro");
    expect(setTheme).toHaveBeenCalledWith("one-dark-pro");

    refreshMonacoEditorTheme("nord");
    setTheme.mockClear();
    ensureMonacoEditorTheme("one-dark-pro");
    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe("applyMonacoThemeForDiffEditor", () => {
  it("always setThemes an explicit catalog id on the handed-in monaco (DiffEditor ignores construction theme)", () => {
    const setTheme = vi.fn();
    const monaco = { editor: { setTheme } };

    applyMonacoThemeForDiffEditor(monaco, "nord");

    expect(setTheme).toHaveBeenCalledWith("nord");
    expect(setTheme.mock.calls.some((call) => call[0] === "volli-dark")).toBe(false);
  });

  it("uses the pending refresh id when no themeId is passed", () => {
    refreshMonacoEditorTheme("dracula");
    const setTheme = vi.fn();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } });

    expect(setTheme).toHaveBeenCalledWith("dracula");
  });

  it("falls back to DEFAULT_EDITOR_THEME_ID when nothing is pending", () => {
    const setTheme = vi.fn();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } });

    expect(setTheme).toHaveBeenCalledWith(DEFAULT_EDITOR_THEME_ID);
  });

  it("never activates volli-dark even when asked — maps through the catalog", () => {
    const setTheme = vi.fn();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } }, "volli-dark");

    expect(setTheme).toHaveBeenCalledWith(DEFAULT_EDITOR_THEME_ID);
    expect(setTheme.mock.calls.some((call) => call[0] === "volli-dark")).toBe(false);
  });
});
