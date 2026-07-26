import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
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
