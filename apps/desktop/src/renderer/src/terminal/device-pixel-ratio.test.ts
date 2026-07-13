import { describe, expect, it, vi } from "vite-plus/test";

import { watchDevicePixelRatio } from "./device-pixel-ratio";

class FakeMediaQueryList {
  readonly listeners = new Set<() => void>();

  addEventListener(_type: "change", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: () => void): void {
    this.listeners.delete(listener);
  }

  emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

class FakeDisplayWindow {
  devicePixelRatio = 1;
  readonly queries: string[] = [];
  readonly mediaQueries: FakeMediaQueryList[] = [];
  readonly resizeListeners = new Set<() => void>();

  matchMedia(query: string): FakeMediaQueryList {
    this.queries.push(query);
    const mediaQuery = new FakeMediaQueryList();
    this.mediaQueries.push(mediaQuery);
    return mediaQuery;
  }

  addEventListener(_type: "resize", listener: () => void): void {
    this.resizeListeners.add(listener);
  }

  removeEventListener(_type: "resize", listener: () => void): void {
    this.resizeListeners.delete(listener);
  }

  emitResize(): void {
    for (const listener of this.resizeListeners) listener();
  }
}

describe("watchDevicePixelRatio", () => {
  it("notifies and re-arms its resolution query when a window moves between displays", () => {
    const target = new FakeDisplayWindow();
    const onChange = vi.fn();

    const stop = watchDevicePixelRatio(target, onChange);

    expect(target.queries).toEqual(["(resolution: 1dppx)"]);
    target.devicePixelRatio = 2;
    target.mediaQueries[0]?.emitChange();

    expect(onChange).toHaveBeenCalledOnce();
    expect(target.queries).toEqual(["(resolution: 1dppx)", "(resolution: 2dppx)"]);
    expect(target.mediaQueries[0]?.listeners.size).toBe(0);
    expect(target.mediaQueries[1]?.listeners.size).toBe(1);

    stop();
    expect(target.mediaQueries[1]?.listeners.size).toBe(0);
    expect(target.resizeListeners.size).toBe(0);
  });

  it("uses resize as a fallback but refits only when the pixel ratio changed", () => {
    const target = new FakeDisplayWindow();
    const onChange = vi.fn();

    watchDevicePixelRatio(target, onChange);
    target.emitResize();
    expect(onChange).not.toHaveBeenCalled();

    target.devicePixelRatio = 1.5;
    target.emitResize();

    expect(onChange).toHaveBeenCalledOnce();
    expect(target.queries.at(-1)).toBe("(resolution: 1.5dppx)");
  });
});
