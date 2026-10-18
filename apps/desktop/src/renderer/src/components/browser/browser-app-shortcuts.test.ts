// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserAppKeyChord } from "../../../../ipc/contract";
import { isCommandPaletteKeyEvent } from "@renderer/lib/command-palette-shortcut";
import { registerBrowserPaneCommands, runBrowserAppShortcut } from "./browser-app-shortcuts";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function pane(tabId: string) {
  const commands = { close: vi.fn(), focusAddress: vi.fn() };
  cleanups.push(registerBrowserPaneCommands(tabId, commands));
  return commands;
}

const commandK: BrowserAppKeyChord = {
  key: "k",
  code: "KeyK",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
};

describe("runBrowserAppShortcut", () => {
  it("replays a chord as a cancelable window keydown its own listener recognises", () => {
    const seen: KeyboardEvent[] = [];
    const listener = (event: Event) => {
      const keyboard = event as KeyboardEvent;
      seen.push(keyboard);
      if (isCommandPaletteKeyEvent(keyboard)) keyboard.preventDefault();
    };
    window.addEventListener("keydown", listener);
    cleanups.push(() => window.removeEventListener("keydown", listener));

    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "replay", chord: commandK } });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ...commandK, bubbles: true, defaultPrevented: true });
  });

  it("replays to `window` by default and to the target it is handed otherwise", () => {
    const target = new EventTarget();
    const onTarget = vi.fn();
    const onWindow = vi.fn();
    target.addEventListener("keydown", onTarget);
    window.addEventListener("keydown", onWindow);
    cleanups.push(() => window.removeEventListener("keydown", onWindow));

    runBrowserAppShortcut(
      { tabId: "tab-1", shortcut: { kind: "replay", chord: commandK } },
      target,
    );

    expect(onTarget).toHaveBeenCalledOnce();
    expect(onWindow).not.toHaveBeenCalled();
  });

  it("closes the tab the key came from, never another registered pane", () => {
    const first = pane("tab-1");
    const second = pane("tab-2");

    runBrowserAppShortcut({ tabId: "tab-2", shortcut: { kind: "close-tab" } });

    expect(second.close).toHaveBeenCalledOnce();
    expect(first.close).not.toHaveBeenCalled();
    expect(second.focusAddress).not.toHaveBeenCalled();
  });

  it("returns focus to the address bar of the tab the key came from", () => {
    const first = pane("tab-1");
    const second = pane("tab-2");

    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "focus-address" } });

    expect(first.focusAddress).toHaveBeenCalledOnce();
    expect(second.focusAddress).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
  });

  it("does nothing for a tab no mounted pane draws", () => {
    const other = pane("tab-1");

    runBrowserAppShortcut({ tabId: "tab-gone", shortcut: { kind: "close-tab" } });
    runBrowserAppShortcut({ tabId: "tab-gone", shortcut: { kind: "focus-address" } });

    expect(other.close).not.toHaveBeenCalled();
    expect(other.focusAddress).not.toHaveBeenCalled();
  });
});

describe("registerBrowserPaneCommands", () => {
  it("stops answering for a pane once it unregisters", () => {
    const commands = { close: vi.fn(), focusAddress: vi.fn() };
    registerBrowserPaneCommands("tab-1", commands)();

    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "close-tab" } });

    expect(commands.close).not.toHaveBeenCalled();
  });

  it("keeps a later registration for the same tab when an earlier one unregisters", () => {
    // React's development double mount: the second mount outlives the first's cleanup.
    const firstMount = { close: vi.fn(), focusAddress: vi.fn() };
    const unregisterFirst = registerBrowserPaneCommands("tab-1", firstMount);
    const secondMount = pane("tab-1");
    unregisterFirst();

    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "close-tab" } });

    expect(secondMount.close).toHaveBeenCalledOnce();
    expect(firstMount.close).not.toHaveBeenCalled();
  });
});
