import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// This registry is pure; the shared test cleanup need not load the host bus.
vi.mock("./broadcast", () => ({ resetDataChangedForTest() {} }));
import {
  getAppContentsRole,
  isSettingsContents,
  mainWindows,
  registerAppWindow,
} from "./window-roles";

const cleanups: (() => void)[] = [];
function fakeWindow(id: number, contentsId = id + 100) {
  let close: (() => void) | undefined;
  const window = {
    id,
    webContents: { id: contentsId },
    once(event: string, listener: () => void) {
      expect(event).toBe("closed");
      close = listener;
    },
  } as BrowserWindow;
  cleanups.push(() => close?.());
  return { window, close: () => close?.() };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("owned app window roles", () => {
  it("distinguishes main, Settings and unowned web contents without URL heuristics", () => {
    const main = fakeWindow(1);
    const settings = fakeWindow(2);
    registerAppWindow(main.window, "main");
    registerAppWindow(settings.window, "settings");

    expect(getAppContentsRole(main.window.webContents)).toBe("main");
    expect(isSettingsContents(settings.window.webContents)).toBe(true);
    expect(isSettingsContents(main.window.webContents)).toBe(false);
    expect(getAppContentsRole({ id: 999 })).toBeNull();
    expect(mainWindows()).toEqual([main.window]);
  });

  it("revokes ownership on close", () => {
    const main = fakeWindow(1);
    registerAppWindow(main.window, "main");
    main.close();
    expect(getAppContentsRole(main.window.webContents)).toBeNull();
    expect(mainWindows()).toEqual([]);
  });

  it("does not revoke a replacement registration when an old window closes", () => {
    const first = fakeWindow(1, 101);
    const replacement = fakeWindow(2, 101);
    registerAppWindow(first.window, "main");
    registerAppWindow(replacement.window, "settings");
    first.close();
    expect(getAppContentsRole(replacement.window.webContents)).toBe("settings");
    expect(mainWindows()).toEqual([]);
  });
});
