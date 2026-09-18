// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  handler: null as ((event: KeyboardEvent) => boolean) | null,
  textarea: null as HTMLTextAreaElement | null,
  dispose: vi.fn(),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    activate() {}
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    textarea!: HTMLTextAreaElement;
    unicode = { activeVersion: "" };
    parser = { registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })) };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.options = options;
    }
    loadAddon() {}
    onData() {}
    onResize() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      mocks.handler = handler;
    }
    open() {
      this.textarea = document.createElement("textarea");
      mocks.textarea = this.textarea;
    }
    write() {}
    focus() {}
    dispose() {
      mocks.dispose();
    }
  },
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("./appearance", () => ({
  getCurrentAppearance: () => ({
    fontSize: 13,
    fontFamilies: [],
    macosOptionAsAlt: false,
    mouseReporting: true,
    scrollbackLimitBytes: 1000,
    theme: { colors: { palette: Array.from({ length: 16 }, () => "#000000") } },
  }),
}));

import { XtermEngine } from "./xterm-engine";

const event = (init: KeyboardEventInit & { type?: string } = {}) => {
  const e = new KeyboardEvent(init.type ?? "keydown", init);
  vi.spyOn(e, "preventDefault");
  return e;
};

describe("XtermEngine accessibility keyboard contract", () => {
  afterEach(() => document.body.replaceChildren());
  beforeEach(() => {
    mocks.options = null;
    mocks.handler = null;
    mocks.textarea = null;
    mocks.dispose.mockClear();
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class {
        observe() {}
        disconnect() {}
      },
    });
  });

  it("creates xterm in screen reader mode and labels its input from the host id", () => {
    const engine = new XtermEngine();
    const host = document.createElement("div");
    host.id = "tab-pane-name";
    document.body.append(host);
    engine.attach(host);
    expect(mocks.options?.screenReaderMode).toBe(true);
    expect(mocks.textarea?.getAttribute("aria-labelledby")).toBe(host.id);
    expect(mocks.textarea?.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+M");
    engine.dispose();
  });

  it("toggles Tab navigation while suppressing the chord, including repeat and keyup", () => {
    const engine = new XtermEngine();
    const host = document.createElement("div");
    host.id = "p";
    document.body.append(host);
    engine.attach(host);
    const data = vi.fn();
    engine.onData(data);
    const chord = event({ code: "KeyM", key: "m", ctrlKey: true, shiftKey: true });
    expect(mocks.handler?.(chord)).toBe(false);
    expect(chord.preventDefault).toHaveBeenCalled();
    const repeat = event({ code: "KeyM", key: "m", ctrlKey: true, shiftKey: true, repeat: true });
    expect(mocks.handler?.(repeat)).toBe(false);
    expect(repeat.preventDefault).toHaveBeenCalled();
    const keyup = event({ type: "keyup", code: "KeyM", key: "m", ctrlKey: true, shiftKey: true });
    expect(mocks.handler?.(keyup)).toBe(false);
    expect(keyup.preventDefault).toHaveBeenCalled();
    const tab = event({ key: "Tab" });
    expect(mocks.handler?.(tab)).toBe(false);
    expect(tab.preventDefault).not.toHaveBeenCalled();
    const shiftTab = event({ key: "Tab", shiftKey: true });
    expect(mocks.handler?.(shiftTab)).toBe(false);
    expect(shiftTab.preventDefault).not.toHaveBeenCalled();
    expect(mocks.textarea?.getAttribute("aria-description")).toContain("Tab moves focus");
    const keypress = event({ type: "keypress", key: "M", ctrlKey: true, shiftKey: true });
    expect(mocks.handler?.(keypress)).toBe(false);
    expect(data).not.toHaveBeenCalled();
    mocks.handler?.(chord);
    expect(mocks.textarea?.getAttribute("aria-description")).toContain("Tab sends to terminal");
    // Screen-reader mode must not let Shift-Tab send bytes AND leave the pane.
    const restored = event({ key: "Tab", shiftKey: true });
    expect(mocks.handler?.(restored)).toBe(true);
    expect(restored.preventDefault).toHaveBeenCalled();
    engine.dispose();
  });

  it("leaves normal Tab and modifier variants to xterm", () => {
    const engine = new XtermEngine();
    const host = document.createElement("div");
    document.body.append(host);
    engine.attach(host);
    for (const e of [
      event({ key: "Tab" }),
      event({ key: "Tab", ctrlKey: true }),
      event({ key: "Tab", altKey: true }),
      event({ key: "Tab", metaKey: true }),
      event({ key: "m", ctrlKey: true, shiftKey: true, altKey: true }),
    ])
      expect(mocks.handler?.(e)).toBe(true);
    engine.dispose();
  });

  it("keeps the mode across reattach and disposes the xterm instance", () => {
    const engine = new XtermEngine();
    const first = document.createElement("div");
    first.id = "one";
    const second = document.createElement("div");
    second.id = "two";
    document.body.append(first, second);
    engine.attach(first);
    const chord = event({ code: "KeyM", key: "m", ctrlKey: true, shiftKey: true });
    mocks.handler?.(chord);
    engine.attach(second);
    expect(mocks.textarea?.getAttribute("aria-labelledby")).toBe("two");
    const tab = event({ key: "Tab" });
    expect(mocks.handler?.(tab)).toBe(false);
    engine.dispose();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
