import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_EDITOR_THEME_ID } from "./editor-theme-catalog";
import {
  activeMonacoEditorThemeId,
  applyMonacoThemeForDiffEditor,
  bindMonacoEditorThemeEnsure,
  bindMonacoEditorThemeHost,
  ensureMonacoEditorTheme,
  ensureMonacoEditorThemeLoaded,
  refreshMonacoEditorTheme,
  resetMonacoEditorThemeForTests,
  restoreEditorThemeFromState,
} from "./monaco-theme";

afterEach(() => {
  resetMonacoEditorThemeForTests();
});

describe("restoreEditorThemeFromState", () => {
  it("paints and returns the committed catalog id after a successful store commit", async () => {
    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });
    // Preview of something else must not win: restore reads live store inputs.
    refreshMonacoEditorTheme("dracula");
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("dracula"));
    setTheme.mockClear();

    const painted = restoreEditorThemeFromState({
      editorThemeId: "nord",
      appThemeSlug: "ember",
    });

    expect(painted).toBe("nord");
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("nord"));
    expect(activeMonacoEditorThemeId()).toBe("nord");
  });

  it("restores the live resolved id when selection is empty (automatic from app slug)", async () => {
    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });
    refreshMonacoEditorTheme("dracula");
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("dracula"));
    setTheme.mockClear();

    const painted = restoreEditorThemeFromState({
      editorThemeId: null,
      appThemeSlug: "midnight",
    });

    expect(painted).toBe("tokyo-night");
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("tokyo-night"));
  });
});

describe("refreshMonacoEditorTheme", () => {
  it("no-ops safely before Monaco is bound and remembers the pending id", async () => {
    expect(() => refreshMonacoEditorTheme("nord")).not.toThrow();

    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("nord"));
  });

  it("awaits ensure then setThemes when a host is already bound", async () => {
    const ensure = vi.fn(async () => undefined);
    const setTheme = vi.fn();
    bindMonacoEditorThemeEnsure(ensure);
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    refreshMonacoEditorTheme("dracula");

    await vi.waitFor(() => {
      expect(ensure).toHaveBeenCalledWith("dracula");
      expect(setTheme).toHaveBeenCalledWith("dracula");
    });
    expect(ensure.mock.invocationCallOrder[0]!).toBeLessThan(setTheme.mock.invocationCallOrder[0]!);
  });

  it("applies the latest pending id when Monaco binds after several refreshes", async () => {
    refreshMonacoEditorTheme("nord");
    refreshMonacoEditorTheme("dracula");

    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("dracula"));
    expect(setTheme).not.toHaveBeenCalledWith("nord");
  });

  it("does not paint a superseded theme after a slower ensure", async () => {
    let resolveNord!: () => void;
    let nordEnsureFinished = false;
    const nordGate = new Promise<void>((resolve) => {
      resolveNord = resolve;
    });
    const ensure = vi.fn(async (id: string) => {
      if (id === "nord") {
        await nordGate;
        nordEnsureFinished = true;
      }
    });
    const setTheme = vi.fn();
    bindMonacoEditorThemeEnsure(ensure);
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    refreshMonacoEditorTheme("nord");
    refreshMonacoEditorTheme("dracula");
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("dracula"));
    setTheme.mockClear();
    resolveNord();
    await vi.waitFor(() => expect(nordEnsureFinished).toBe(true));
    expect(setTheme).not.toHaveBeenCalledWith("nord");
  });

  it("reports a lazy theme-load failure without an unhandled rejection or stale paint", async () => {
    const failure = new Error("theme chunk missing");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setTheme = vi.fn();
    bindMonacoEditorThemeEnsure(vi.fn(async () => Promise.reject(failure)));
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    refreshMonacoEditorTheme("nord");

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[volli] failed to load Monaco theme "nord":', failure),
    );
    expect(setTheme).not.toHaveBeenCalledWith("nord");
  });
});

describe("ensureMonacoEditorThemeLoaded", () => {
  it("delegates to the bound ensure seam", async () => {
    const ensure = vi.fn(async () => undefined);
    bindMonacoEditorThemeEnsure(ensure);

    await ensureMonacoEditorThemeLoaded("nord");

    expect(ensure).toHaveBeenCalledWith("nord");
  });
});

describe("ensureMonacoEditorTheme", () => {
  it("activates the fallback only when nothing is pending", async () => {
    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    ensureMonacoEditorTheme("one-dark-pro");
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("one-dark-pro"));

    refreshMonacoEditorTheme("nord");
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("nord"));
    setTheme.mockClear();
    ensureMonacoEditorTheme("one-dark-pro");
    await Promise.resolve();
    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe("applyMonacoThemeForDiffEditor", () => {
  it("always setThemes an explicit catalog id on the handed-in monaco (DiffEditor ignores construction theme)", async () => {
    const setTheme = vi.fn();
    const monaco = { editor: { setTheme } };

    applyMonacoThemeForDiffEditor(monaco, "nord");

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("nord"));
    expect(setTheme.mock.calls.some((call) => call[0] === "volli-dark")).toBe(false);
  });

  it("uses the pending refresh id when no themeId is passed", async () => {
    refreshMonacoEditorTheme("dracula");
    const setTheme = vi.fn();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } });

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith("dracula"));
  });

  it("falls back to DEFAULT_EDITOR_THEME_ID when nothing is pending", async () => {
    const setTheme = vi.fn();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } });

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith(DEFAULT_EDITOR_THEME_ID));
  });

  it("never activates volli-dark even when asked — maps through the catalog", async () => {
    const setTheme = vi.fn();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } }, "volli-dark");

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith(DEFAULT_EDITOR_THEME_ID));
    expect(setTheme.mock.calls.some((call) => call[0] === "volli-dark")).toBe(false);
  });

  it("skips the handed-in setTheme when a newer pending id supersedes the target", async () => {
    let resolveEnsure!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveEnsure = resolve;
    });
    bindMonacoEditorThemeEnsure(async () => gate);
    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });
    setTheme.mockClear();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } }, "nord");
    refreshMonacoEditorTheme("dracula");
    resolveEnsure();

    await vi.waitFor(() => {
      expect(setTheme.mock.calls.some((call) => call[0] === "dracula")).toBe(true);
    });
    expect(setTheme.mock.calls.some((call) => call[0] === "nord")).toBe(false);
  });

  it("reports a lazy load failure and leaves the DiffEditor on its current theme", async () => {
    const failure = new Error("theme import failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setTheme = vi.fn();
    bindMonacoEditorThemeEnsure(vi.fn(async () => Promise.reject(failure)));

    applyMonacoThemeForDiffEditor({ editor: { setTheme } }, "nord");

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[volli] failed to load Monaco theme "nord":', failure),
    );
    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe("activeMonacoEditorThemeId", () => {
  it("returns the pending catalog id so create() construction options do not clobber it", () => {
    expect(activeMonacoEditorThemeId()).toBe(DEFAULT_EDITOR_THEME_ID);
    refreshMonacoEditorTheme("nord");
    expect(activeMonacoEditorThemeId()).toBe("nord");
  });
});
