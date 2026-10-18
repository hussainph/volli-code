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
  const commands = { close: vi.fn(() => true), focusAddress: vi.fn(), focusPane: vi.fn() };
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
  it("replays a chord as a cancelable window keydown, and reports a claimed one as acted on", () => {
    const seen: KeyboardEvent[] = [];
    const listener = (event: Event) => {
      const keyboard = event as KeyboardEvent;
      seen.push(keyboard);
      if (isCommandPaletteKeyEvent(keyboard)) keyboard.preventDefault();
    };
    window.addEventListener("keydown", listener);
    cleanups.push(() => window.removeEventListener("keydown", listener));

    const acted = runBrowserAppShortcut({
      tabId: "tab-1",
      shortcut: { kind: "replay", chord: commandK },
    });

    expect(acted).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ...commandK, bubbles: true, defaultPrevented: true });
  });

  it("reports a replayed chord no listener claimed, so focus can go back to the page", () => {
    // ⌘K under the terminal guard, ⌃⌘ + arrow with no split: the owning
    // listener returns without preventDefault, which is how it says "not mine".
    const listener = vi.fn();
    window.addEventListener("keydown", listener);
    cleanups.push(() => window.removeEventListener("keydown", listener));

    expect(
      runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "replay", chord: commandK } }),
    ).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("focuses the pane drawing the page before the chord is replayed", () => {
    const order: string[] = [];
    const page = pane("tab-2");
    page.focusPane.mockImplementation(() => order.push("focus-pane"));
    const other = pane("tab-1");
    const listener = () => order.push("keydown");
    window.addEventListener("keydown", listener);
    cleanups.push(() => window.removeEventListener("keydown", listener));

    runBrowserAppShortcut({ tabId: "tab-2", shortcut: { kind: "replay", chord: commandK } });

    expect(order).toEqual(["focus-pane", "keydown"]);
    expect(other.focusPane).not.toHaveBeenCalled();
  });

  it("still replays a chord from a tab no pane draws", () => {
    const listener = vi.fn();
    window.addEventListener("keydown", listener);
    cleanups.push(() => window.removeEventListener("keydown", listener));

    runBrowserAppShortcut({ tabId: "tab-gone", shortcut: { kind: "replay", chord: commandK } });

    expect(listener).toHaveBeenCalledOnce();
  });

  it("closes the tab the key came from, never another registered pane", () => {
    const first = pane("tab-1");
    const second = pane("tab-2");

    expect(runBrowserAppShortcut({ tabId: "tab-2", shortcut: { kind: "close-tab" } })).toBe(true);

    expect(second.close).toHaveBeenCalledOnce();
    expect(first.close).not.toHaveBeenCalled();
    expect(second.focusAddress).not.toHaveBeenCalled();
  });

  it("returns focus to the address bar of the tab the key came from", () => {
    const first = pane("tab-1");
    const second = pane("tab-2");

    expect(runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "focus-address" } })).toBe(
      true,
    );

    expect(first.focusAddress).toHaveBeenCalledOnce();
    expect(second.focusAddress).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
  });

  it("reports a close the pane had no close for as not acted on", () => {
    const page = pane("tab-1");
    page.close.mockReturnValue(false);

    expect(runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "close-tab" } })).toBe(false);
  });

  it("does nothing for a tab no mounted pane draws", () => {
    const other = pane("tab-1");

    expect(runBrowserAppShortcut({ tabId: "tab-gone", shortcut: { kind: "close-tab" } })).toBe(
      false,
    );
    expect(runBrowserAppShortcut({ tabId: "tab-gone", shortcut: { kind: "focus-address" } })).toBe(
      false,
    );

    expect(other.close).not.toHaveBeenCalled();
    expect(other.focusAddress).not.toHaveBeenCalled();
  });
});

describe("registerBrowserPaneCommands", () => {
  it("stops answering for a pane once it unregisters", () => {
    const commands = { close: vi.fn(() => true), focusAddress: vi.fn(), focusPane: vi.fn() };
    registerBrowserPaneCommands("tab-1", commands)();

    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "close-tab" } });

    expect(commands.close).not.toHaveBeenCalled();
  });

  it("keeps a later registration for the same tab when an earlier one unregisters", () => {
    // React's development double mount: the second mount outlives the first's cleanup.
    const firstMount = { close: vi.fn(() => true), focusAddress: vi.fn(), focusPane: vi.fn() };
    const unregisterFirst = registerBrowserPaneCommands("tab-1", firstMount);
    const secondMount = pane("tab-1");
    unregisterFirst();

    runBrowserAppShortcut({ tabId: "tab-1", shortcut: { kind: "close-tab" } });

    expect(secondMount.close).toHaveBeenCalledOnce();
    expect(firstMount.close).not.toHaveBeenCalled();
  });
});
