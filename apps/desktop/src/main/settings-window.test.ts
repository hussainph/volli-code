import { describe, expect, it, vi } from "vite-plus/test";
import type { SettingsWindowNavigation } from "../ipc/settings-window";
import {
  createSettingsWindowOwner,
  restoreSettingsFrame,
  settleSettingsNavigation,
} from "./settings-window";

describe("native Settings lifetime", () => {
  it("creates one independent window, navigates and raises it, then recreates after close", () => {
    let closed: (() => void) | undefined;
    const make = () => ({
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      once: (_: "closed", listener: () => void) => {
        closed = listener;
      },
    });
    const create = vi.fn(make);
    const navigate = vi.fn();
    const reveal = vi.fn();
    const owner = createSettingsWindowOwner({ create, navigate, reveal });
    const window = owner.open({ category: "general" });
    expect(owner.open({ configureCategory: "worktrees", projectId: "p1" })).toBe(window);
    expect(create).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(window, {
      configureCategory: "worktrees",
      projectId: "p1",
    });
    expect(window.restore).not.toHaveBeenCalled(); // native reveal owns restoration after readiness
    expect(reveal).toHaveBeenCalledExactlyOnceWith(window);
    closed?.();
    expect(owner.current()).toBeNull();
    expect(owner.open({})).not.toBe(window);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
describe("Settings frame persistence", () => {
  const displays = [
    { x: 0, y: 0, width: 1440, height: 900 },
    { x: 1440, y: -300, width: 1920, height: 1080 },
  ];
  it("retains a frame on a second display", () => {
    const frame = { x: 1500, y: -200, width: 900, height: 680 };
    expect(restoreSettingsFrame(JSON.parse(JSON.stringify(frame)), displays)).toEqual(frame);
  });
  it("clamps oversized and undersized frames", () => {
    expect(restoreSettingsFrame({ x: 0, y: 0, width: 12, height: 9000 }, displays)).toEqual({
      x: 0,
      y: 0,
      width: 720,
      height: 1200,
    });
  });
  it("re-centres when a display is removed, preserving a usable size", () => {
    expect(restoreSettingsFrame({ x: 9000, y: 200, width: 900, height: 680 }, displays)).toEqual({
      width: 900,
      height: 680,
    });
  });
  it.each([
    null,
    {},
    { x: 0, y: 0, width: "900", height: 680 },
    { x: NaN, y: 0, width: 900, height: 680 },
  ])("rejects malformed frames", (frame) => {
    expect(restoreSettingsFrame(frame, displays)).toEqual({});
  });
});

describe("settling a Settings navigation (VC-1236)", () => {
  it("spends a sign-in-again request once acknowledged, so a page reload cannot replay it", () => {
    let kept: SettingsWindowNavigation | null = {
      revision: 3,
      category: "model-access",
      signInProviderId: "anthropic",
      reauthenticate: "oauth",
    };
    // The page's bootstrap read sees the request and starts the flow once.
    expect(kept).toMatchObject({ reauthenticate: "oauth" });
    const ready = settleSettingsNavigation(kept, 3);
    expect(ready.acknowledged).toBe(true);
    kept = ready.navigation;
    // A reload reads the kept navigation again: same pane, no request.
    expect(kept).toEqual({ revision: 3, category: "model-access" });
    // The reloaded page acknowledges the same revision; nothing comes back.
    const reloaded = settleSettingsNavigation(kept, 3);
    expect(reloaded).toEqual({ acknowledged: true, navigation: kept });
  });

  it("acknowledges nothing for a stale or absent revision, and keeps the request", () => {
    const current: SettingsWindowNavigation = {
      revision: 4,
      signInProviderId: "anthropic",
      reauthenticate: "api-key",
    };
    expect(settleSettingsNavigation(current, 3)).toEqual({
      acknowledged: false,
      navigation: current,
    });
    expect(settleSettingsNavigation(null, 1)).toEqual({ acknowledged: false, navigation: null });
  });
});
