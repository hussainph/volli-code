import { describe, expect, it, vi } from "vite-plus/test";
import { createSettingsWindowOwner, restoreSettingsFrame } from "./settings-window";

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
