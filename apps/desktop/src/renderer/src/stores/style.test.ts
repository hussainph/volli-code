// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { seedAppStateCache, flushPendingAppStateKey } from "@renderer/lib/app-state-storage";
import { useThemeStore } from "./theme";
import { startStylePreferences, useStyleStore } from "./style";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

describe("client style preference", () => {
  it("hydrates safely, paints scope overrides, and persists through the app_state bridge", async () => {
    const set = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("window", { api: { appState: { set } } });
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
    await expect(flushPendingAppStateKey("volli:style")).resolves.toBe(true);
    expect(set).toHaveBeenLastCalledWith(
      "volli:style",
      expect.stringContaining('"global":"modern"'),
    );
    await useStyleStore.persist.rehydrate();
    expect(useStyleStore.getState().projects.p1).toBe("macos");
    vi.unstubAllGlobals();
  });
});
