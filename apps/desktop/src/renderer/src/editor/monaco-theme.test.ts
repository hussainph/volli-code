/**
 * @vitest-environment jsdom
 *
 * The appearance fallback reads the class preload stamps on `<html>` from
 * inside `activeMonacoEditorThemeId`, so this suite needs a document. It proves
 * the fixed Vitesse pair always follows that rendered answer.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  activeMonacoEditorThemeId,
  applyMonacoThemeForDiffEditor,
  bindMonacoEditorThemeHost,
  ensureMonacoEditorTheme,
  refreshMonacoEditorTheme,
  resetMonacoEditorThemeForTests,
} from "./monaco-theme";

const LIGHT = "vitesse-light";
const DARK = "vitesse-dark";

/** Stamp the appearance class preload writes on `<html>`, as the paint path does. */
function stampAppearance(resolved: "light" | "dark"): void {
  document.documentElement.classList.toggle("light", resolved === "light");
}

afterEach(() => {
  resetMonacoEditorThemeForTests();
  document.documentElement.classList.remove("light");
});

describe("activeMonacoEditorThemeId", () => {
  it("follows the appearance stamped on the document when nothing is pending", () => {
    stampAppearance("dark");
    expect(activeMonacoEditorThemeId()).toBe(DARK);

    stampAppearance("light");
    expect(activeMonacoEditorThemeId()).toBe(LIGHT);
  });

  it("returns the pending Vitesse id so construction options do not clobber it", () => {
    stampAppearance("dark");
    refreshMonacoEditorTheme(LIGHT);
    expect(activeMonacoEditorThemeId()).toBe(LIGHT);
  });
});

describe("refreshMonacoEditorTheme", () => {
  it("queues a Vitesse id before Monaco binds, then paints it on bind", () => {
    refreshMonacoEditorTheme(LIGHT);

    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    expect(setTheme).toHaveBeenCalledWith(LIGHT);
  });

  it("applies immediately when Monaco is already bound", () => {
    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    refreshMonacoEditorTheme(LIGHT);

    expect(setTheme).toHaveBeenCalledWith(LIGHT);
  });

  it("applies only the latest queued Vitesse id when Monaco binds", () => {
    refreshMonacoEditorTheme(DARK);
    refreshMonacoEditorTheme(LIGHT);

    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    expect(setTheme).toHaveBeenCalledTimes(1);
    expect(setTheme).toHaveBeenCalledWith(LIGHT);
  });

  it("does not paint when a host binds before an appearance is known", () => {
    const setTheme = vi.fn();

    bindMonacoEditorThemeHost({ editor: { setTheme } });

    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe("ensureMonacoEditorTheme", () => {
  it("activates the appearance's theme only when nothing is pending", () => {
    stampAppearance("light");
    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    ensureMonacoEditorTheme();
    expect(setTheme).toHaveBeenCalledWith(LIGHT);

    refreshMonacoEditorTheme(DARK);
    expect(setTheme).toHaveBeenCalledWith(DARK);
    setTheme.mockClear();

    ensureMonacoEditorTheme();
    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe("applyMonacoThemeForDiffEditor", () => {
  it("setThemes the appearance's Vitesse half on the handed-in Monaco", () => {
    stampAppearance("light");
    const setTheme = vi.fn();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } });

    expect(setTheme).toHaveBeenCalledWith(LIGHT);
    expect(setTheme.mock.calls.some((call) => call[0] === "volli-dark")).toBe(false);
  });

  it("uses the pending Vitesse id when one is already queued", () => {
    stampAppearance("light");
    refreshMonacoEditorTheme(DARK);
    const setTheme = vi.fn();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } });

    expect(setTheme).toHaveBeenCalledWith(DARK);
  });
});
