import type { BrowserWindow } from "electron";
import type { BrowserAppShortcutEvent } from "@volli/shared";
import type { BrowserShortcutsPort } from "@volli/host-core/handlers";

/**
 * Where the Browser Tab host's app shortcuts go (VC-301): the window that
 * draws the page gets keyboard focus back, then every window following the
 * desktop-only `browserShortcuts.subscribe` entry hears the shortcut.
 *
 * {@link deliver} is the host's `deliverAppShortcut`; {@link subscribe} is the
 * half of the map's `BrowserShortcutsPort` this relay owns. Focus comes back
 * to the app FIRST: the palette's field, the address bar and the pane a chord
 * moves to are all renderer DOM, unreachable while the page holds focus.
 */
export interface BrowserShortcutRelay {
  deliver(window: BrowserWindow, event: BrowserAppShortcutEvent): void;
  subscribe: BrowserShortcutsPort["subscribe"];
}

export function createBrowserShortcutRelay(
  onListenerError: (error: unknown) => void,
): BrowserShortcutRelay {
  const listeners = new Set<(event: BrowserAppShortcutEvent) => void>();
  return {
    deliver(window, event) {
      if (window.isDestroyed()) return;
      window.webContents.focus();
      for (const listener of listeners) {
        // One window's broken stream must not keep the key from another.
        try {
          listener(event);
        } catch (error) {
          onListenerError(error);
        }
      }
    },
    subscribe(listener) {
      // A wrapper per subscription, so the same function subscribed twice is two streams.
      const one = (event: BrowserAppShortcutEvent) => listener(event);
      listeners.add(one);
      return () => {
        listeners.delete(one);
      };
    },
  };
}
