/**
 * @vitest-environment jsdom
 *
 * The renderer test project runs under `node` by default, and most of its
 * tests take a recording stand-in rather than a DOM. This one cannot: the
 * appearance fallback reads the class preload stamps on `<html>` from INSIDE
 * `activeMonacoEditorThemeId`, so there is no root to hand in — and the whole
 * point of the fallback is that it agrees with what is on the document.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  activeMonacoEditorThemeId,
  applyMonacoThemeForDiffEditor,
  bindMonacoEditorThemeEnsure,
  bindMonacoEditorThemeHost,
  ensureMonacoEditorTheme,
  ensureMonacoEditorThemeLoaded,
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

  it("returns the pending id so create() construction options do not clobber it", () => {
    stampAppearance("dark");
    refreshMonacoEditorTheme(LIGHT);
    expect(activeMonacoEditorThemeId()).toBe(LIGHT);
  });
});

describe("refreshMonacoEditorTheme", () => {
  it("no-ops safely before Monaco is bound and remembers the pending id", async () => {
    expect(() => refreshMonacoEditorTheme(LIGHT)).not.toThrow();

    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith(LIGHT));
  });

  it("awaits ensure then setTheme when a host is already bound", async () => {
    const ensure = vi.fn(async () => undefined);
    const setTheme = vi.fn();
    bindMonacoEditorThemeEnsure(ensure);
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    refreshMonacoEditorTheme(LIGHT);

    await vi.waitFor(() => {
      expect(ensure).toHaveBeenCalledWith(LIGHT);
      expect(setTheme).toHaveBeenCalledWith(LIGHT);
    });
    expect(ensure.mock.invocationCallOrder[0]!).toBeLessThan(setTheme.mock.invocationCallOrder[0]!);
  });

  it("applies the latest pending id when Monaco binds after several refreshes", async () => {
    refreshMonacoEditorTheme(DARK);
    refreshMonacoEditorTheme(LIGHT);

    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith(LIGHT));
    expect(setTheme).not.toHaveBeenCalledWith(DARK);
  });

  it("does not paint a superseded theme after a slower ensure", async () => {
    // A light↔dark flip mid-load is exactly this race: the outgoing theme must
    // never land on top of the incoming one.
    let releaseSlow!: () => void;
    let slowEnsureFinished = false;
    const gate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const ensure = vi.fn(async (id: string) => {
      if (id === DARK) {
        await gate;
        slowEnsureFinished = true;
      }
    });
    const setTheme = vi.fn();
    bindMonacoEditorThemeEnsure(ensure);
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    refreshMonacoEditorTheme(DARK);
    refreshMonacoEditorTheme(LIGHT);
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith(LIGHT));
    setTheme.mockClear();
    releaseSlow();
    await vi.waitFor(() => expect(slowEnsureFinished).toBe(true));
    expect(setTheme).not.toHaveBeenCalledWith(DARK);
  });

  it("reports a lazy theme-load failure without an unhandled rejection or stale paint", async () => {
    const failure = new Error("theme chunk missing");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setTheme = vi.fn();
    bindMonacoEditorThemeEnsure(vi.fn(async () => Promise.reject(failure)));
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    refreshMonacoEditorTheme(LIGHT);

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(`[volli] failed to load Monaco theme "${LIGHT}":`, failure),
    );
    expect(setTheme).not.toHaveBeenCalledWith(LIGHT);
  });
});

describe("ensureMonacoEditorThemeLoaded", () => {
  it("delegates to the bound ensure seam", async () => {
    const ensure = vi.fn(async () => undefined);
    bindMonacoEditorThemeEnsure(ensure);

    await ensureMonacoEditorThemeLoaded(LIGHT);

    expect(ensure).toHaveBeenCalledWith(LIGHT);
  });

  it("no-ops when no ensure seam is bound", async () => {
    await expect(ensureMonacoEditorThemeLoaded(LIGHT)).resolves.toBeUndefined();
  });
});

describe("ensureMonacoEditorTheme", () => {
  it("activates the appearance's theme only when nothing is pending", async () => {
    stampAppearance("light");
    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });

    ensureMonacoEditorTheme();
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith(LIGHT));

    // A store refresh that already landed must not be clobbered by bootstrap.
    refreshMonacoEditorTheme(DARK);
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith(DARK));
    setTheme.mockClear();
    ensureMonacoEditorTheme();
    await Promise.resolve();
    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe("applyMonacoThemeForDiffEditor", () => {
  it("setThemes the appearance's theme on the handed-in monaco (DiffEditor ignores construction theme)", async () => {
    stampAppearance("light");
    const setTheme = vi.fn();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } });

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith(LIGHT));
    expect(setTheme.mock.calls.some((call) => call[0] === "volli-dark")).toBe(false);
  });

  it("uses the pending refresh id when one is already queued", async () => {
    stampAppearance("light");
    refreshMonacoEditorTheme(DARK);
    const setTheme = vi.fn();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } });

    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledWith(DARK));
  });

  it("skips the handed-in setTheme when a newer pending id supersedes the target", async () => {
    let releaseEnsure!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    bindMonacoEditorThemeEnsure(async () => gate);
    const setTheme = vi.fn();
    bindMonacoEditorThemeHost({ editor: { setTheme } });
    stampAppearance("light");
    setTheme.mockClear();

    applyMonacoThemeForDiffEditor({ editor: { setTheme } });
    refreshMonacoEditorTheme(DARK);
    releaseEnsure();

    await vi.waitFor(() => {
      expect(setTheme.mock.calls.some((call) => call[0] === DARK)).toBe(true);
    });
    expect(setTheme.mock.calls.some((call) => call[0] === LIGHT)).toBe(false);
  });

  it("reports a lazy load failure and leaves the DiffEditor on its current theme", async () => {
    const failure = new Error("theme import failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setTheme = vi.fn();
    bindMonacoEditorThemeEnsure(vi.fn(async () => Promise.reject(failure)));

    applyMonacoThemeForDiffEditor({ editor: { setTheme } });

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(setTheme).not.toHaveBeenCalled();
  });
});
