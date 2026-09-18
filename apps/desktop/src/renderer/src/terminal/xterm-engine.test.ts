// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({
  fit: vi.fn(),
  scrollToBottom: vi.fn(),
  buffer: { viewportY: 0, baseY: 0 },
}));

vi.mock("./appearance", () => ({
  getCurrentAppearance: () => ({
    fontFamilies: [],
    fontSize: 14,
    macosOptionAsAlt: false,
    scrollbackLimitBytes: null,
    theme: {},
    ligatures: false,
    mouseReporting: true,
  }),
}));
vi.mock("./option-as-alt", () => ({
  heldAltSides: () => ({ left: false, right: false }),
  installAltSideTracker: () => undefined,
  optionAsAltSequence: () => null,
}));
vi.mock("./xterm-appearance", () => ({
  clampFontSize: (size: number) => size,
  isMouseTrackingOnly: () => false,
  macOptionIsMeta: () => false,
  scrollbackLines: () => 10_000,
  xtermFontFamily: () => "monospace",
  xtermTheme: () => ({}),
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = hooks.fit;
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: vi.fn() }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    readonly buffer = { active: hooks.buffer };
    readonly options = {
      fontSize: 14,
      fontFamily: "monospace",
      macOptionIsMeta: false,
      scrollback: 10_000,
      theme: {},
    };
    readonly unicode = { activeVersion: "" };
    readonly parser = { registerCsiHandler: () => ({ dispose: () => undefined }) };

    loadAddon(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    onScroll(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    attachCustomKeyEventHandler(): void {}
    open(host: HTMLElement): void {
      const root = document.createElement("div");
      root.className = "xterm";
      host.append(root);
    }
    scrollToBottom = hooks.scrollToBottom;
    focus(): void {}
    dispose(): void {}
  },
}));

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: FakeResizeObserver,
});
Object.defineProperty(window, "requestAnimationFrame", {
  configurable: true,
  value: vi.fn(() => 1),
});
Object.defineProperty(window, "cancelAnimationFrame", {
  configurable: true,
  value: vi.fn(),
});
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ width: 800, height: 600 }),
});

const { XtermEngine } = await import("./xterm-engine");

describe("XtermEngine follow-bottom behavior", () => {
  beforeEach(() => {
    hooks.fit.mockClear();
    hooks.scrollToBottom.mockClear();
    hooks.buffer.viewportY = 0;
    hooks.buffer.baseY = 0;
  });

  it("re-anchors after fit changes the row count while already at the bottom", () => {
    const engine = new XtermEngine();
    engine.attach(document.createElement("div"));
    hooks.scrollToBottom.mockClear();
    hooks.buffer.viewportY = 12;
    hooks.buffer.baseY = 12;
    hooks.fit.mockImplementation(() => {
      hooks.buffer.baseY = 24;
    });

    // The fit changes the grid from 12 visible rows to 24. The old viewport
    // index is no longer the tail, so the engine must follow the new bottom.
    engine.fit();

    expect(hooks.scrollToBottom).toHaveBeenCalledOnce();
  });

  it("preserves an intentional scrollback position across the same fit", () => {
    const engine = new XtermEngine();
    engine.attach(document.createElement("div"));
    hooks.scrollToBottom.mockClear();
    hooks.buffer.viewportY = 4;
    hooks.buffer.baseY = 12;
    hooks.fit.mockImplementation(() => {
      hooks.buffer.baseY = 24;
    });

    engine.fit();

    expect(hooks.scrollToBottom).not.toHaveBeenCalled();
  });
});
