import type { BrowserWindow } from "electron";
import type { BrowserAppShortcutEvent } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { createBrowserShortcutRelay } from "./app-shortcut-relay";

const EVENT: BrowserAppShortcutEvent = { tabId: "opaque-1", shortcut: { kind: "close-tab" } };

function appWindow(destroyed = false) {
  const order: string[] = [];
  const window = {
    isDestroyed: () => destroyed,
    webContents: { focus: vi.fn(() => order.push("focus")) },
  };
  return { window: window as unknown as BrowserWindow, focus: window.webContents.focus, order };
}

describe("createBrowserShortcutRelay (VC-301)", () => {
  it("gives the app window focus before any subscriber hears the shortcut", () => {
    const relay = createBrowserShortcutRelay(vi.fn());
    const { window, order } = appWindow();
    relay.subscribe(() => order.push("heard"));

    relay.deliver(window, EVENT);

    expect(order).toEqual(["focus", "heard"]);
  });

  it("hands every subscriber the shortcut until it unsubscribes", () => {
    const relay = createBrowserShortcutRelay(vi.fn());
    const { window } = appWindow();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = relay.subscribe(first);
    relay.subscribe(second);

    relay.deliver(window, EVENT);
    stopFirst();
    relay.deliver(window, EVENT);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledWith(EVENT);
  });

  it("keeps the same function subscribed twice as two streams", () => {
    const relay = createBrowserShortcutRelay(vi.fn());
    const { window } = appWindow();
    const listener = vi.fn();
    const stop = relay.subscribe(listener);
    relay.subscribe(listener);
    stop();

    relay.deliver(window, EVENT);

    expect(listener).toHaveBeenCalledOnce();
  });

  it("reports a subscriber that throws and still reaches the rest", () => {
    const onListenerError = vi.fn();
    const relay = createBrowserShortcutRelay(onListenerError);
    const { window } = appWindow();
    const failure = new Error("stream gone");
    relay.subscribe(() => {
      throw failure;
    });
    const after = vi.fn();
    relay.subscribe(after);

    relay.deliver(window, EVENT);

    expect(onListenerError).toHaveBeenCalledWith(failure);
    expect(after).toHaveBeenCalledWith(EVENT);
  });

  it("does nothing for a window that has gone", () => {
    const relay = createBrowserShortcutRelay(vi.fn());
    const { window, focus } = appWindow(true);
    const listener = vi.fn();
    relay.subscribe(listener);

    relay.deliver(window, EVENT);

    expect(focus).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
