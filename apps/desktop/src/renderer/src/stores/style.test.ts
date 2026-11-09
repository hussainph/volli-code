// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { seedAppStateCache, flushPendingAppStateKey } from "@renderer/lib/app-state-storage";
import { useThemeStore } from "./theme";
import { startStylePreferences, useStyleStore } from "./style";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

describe("client style preference", () => {
  it("defaults missing preferences and accepts a valid global style without workspace overrides", async () => {
    for (const state of [null, {}, { global: "modern" }, { global: "macos" }]) {
      seedAppStateCache({ "volli:style": JSON.stringify({ state, version: 0 }) });
      await useStyleStore.persist.rehydrate();
      expect(useStyleStore.getState()).toMatchObject({
        global: state?.global ?? "macos",
        projects: {},
        motion: true,
      });
    }
  });

  it("hydrates safely, paints scope overrides, and persists through the app_state bridge", async () => {
    const set = vi.fn(async () => ({ ok: true }));
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { api: { appState: { set } }, dispatchEvent });
    seedAppStateCache({
      "volli:style": JSON.stringify({
        state: { global: "unknown", projects: { p1: "modern", bad: "invalid" }, motion: false },
        version: 0,
      }),
    });
    await startStylePreferences();
    expect(useStyleStore.getState().global).toBe("macos");
    expect(useStyleStore.getState().projects).toEqual({ p1: "modern" });
    expect(document.documentElement.style.getPropertyValue("--ui-font")).toContain("system-ui");
    expect(document.documentElement.dataset.motion).toBe("off");
    useThemeStore.setState({ projectId: "p1" });
    expect(document.documentElement.style.getPropertyValue("--ui-font")).toContain("Mona Sans");
    useStyleStore.getState().setStyle(null, "p1");
    expect(document.documentElement.style.getPropertyValue("--ui-font")).not.toContain("Mona Sans");
    useStyleStore.getState().setStyle("modern");
    useStyleStore.getState().setStyle("macos", "p1");
    expect(document.documentElement.style.getPropertyValue("--ui-font")).not.toContain("Mona Sans");
    useThemeStore.setState({ projectId: "p2" });
    expect(document.documentElement.style.getPropertyValue("--ui-font")).toContain("Mona Sans");
    useStyleStore.getState().setMotion(true);
    expect(document.documentElement.dataset.motion).toBe("on");
    expect(dispatchEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "volli-motion-change" }),
    );
    dispatchEvent.mockClear();
    const paint = vi.spyOn(document.documentElement.style, "setProperty");
    useThemeStore.setState({ projectId: "p2" });
    expect(paint).not.toHaveBeenCalled();
    paint.mockRestore();
    useStyleStore.getState().setMotion(true);
    expect(dispatchEvent).not.toHaveBeenCalled();
    await expect(flushPendingAppStateKey("volli:style")).resolves.toBe(true);
    expect(set).toHaveBeenLastCalledWith(
      "volli:style",
      expect.stringContaining('"global":"modern"'),
      expect.stringContaining('"global":"unknown"'),
    );
    await useStyleStore.persist.rehydrate();
    expect(useStyleStore.getState().projects.p1).toBe("macos");
    useStyleStore.getState().setStyle(null);
    expect(useStyleStore.getState().global).toBe("macos");
    expect(useStyleStore.getState().projects.p1).toBe("macos");
    expect(document.documentElement.style.getPropertyValue("--ui-font")).not.toContain("Mona Sans");
    await expect(flushPendingAppStateKey("volli:style")).resolves.toBe(true);
    expect(set).toHaveBeenLastCalledWith(
      "volli:style",
      expect.stringContaining('"global":"macos"'),
      expect.stringContaining('"global":"modern"'),
    );
    vi.unstubAllGlobals();
  });
});
