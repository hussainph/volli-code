import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const electron = vi.hoisted(() => ({
  shell: { openExternal: vi.fn(() => Promise.resolve()), showItemInFolder: vi.fn() },
  clipboard: {
    writeText: vi.fn(() => Promise.resolve()),
    readText: vi.fn(() => Promise.resolve("copied")),
  },
  focused: null as unknown,
  popup: vi.fn(),
  template: [] as { label?: string; type?: string; enabled?: boolean; click?: () => void }[],
}));

vi.mock("electron", () => ({
  shell: electron.shell,
  clipboard: electron.clipboard,
  BrowserWindow: { getFocusedWindow: () => electron.focused },
  Menu: {
    buildFromTemplate: (template: typeof electron.template) => {
      electron.template = template;
      return { popup: electron.popup };
    },
  },
}));

import { createElectronClientCapabilities } from "./client-capabilities";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  electron.focused = null;
});

describe("the desktop client's capabilities", () => {
  it("opens links, reveals files and uses the clipboard through Electron, unchanged", async () => {
    const client = createElectronClientCapabilities();
    await client.openExternal("https://example.com/auth");
    client.revealInFolder("/Users/me/volli.db");
    await client.writeClipboardText("hello");

    expect(electron.shell.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/auth");
    expect(electron.shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith("/Users/me/volli.db");
    expect(electron.clipboard.writeText).toHaveBeenCalledExactlyOnceWith("hello");
    await expect(client.readClipboardText()).resolves.toBe("copied");
  });

  it("shows a menu over the focused window and answers the chosen id", async () => {
    const window = { id: 1 };
    electron.focused = window;
    const chosen = createElectronClientCapabilities().showMenu([
      { kind: "item", id: "copy", label: "Copy" },
      { kind: "separator" },
      { kind: "item", id: "delete", label: "Delete", enabled: false },
    ]);

    expect(electron.template).toEqual([
      { label: "Copy", enabled: true, click: expect.any(Function) },
      { type: "separator" },
      { label: "Delete", enabled: false, click: expect.any(Function) },
    ]);
    const options = electron.popup.mock.calls[0]?.[0] as { window?: unknown; callback: () => void };
    expect(options.window).toBe(window);
    // macOS closes the menu before it performs the chosen item.
    options.callback();
    electron.template[0]?.click?.();
    await expect(chosen).resolves.toBe("copy");
  });

  it("answers null when the menu is dismissed, with no window focused", async () => {
    vi.useFakeTimers();
    const chosen = createElectronClientCapabilities().showMenu([
      { kind: "item", id: "copy", label: "Copy" },
    ]);
    const options = electron.popup.mock.calls[0]?.[0] as { window?: unknown; callback: () => void };
    expect(options).not.toHaveProperty("window");
    options.callback();
    vi.runAllTimers();
    await expect(chosen).resolves.toBeNull();
  });
});
