import * as React from "react";

import { runBrowserAppShortcut } from "@renderer/components/browser/browser-app-shortcuts";

/**
 * Receives the app shortcuts a focused Browser page handed back (VC-301) —
 * ⌘K and the navigation chords from inside a page, ⌘W and ⌘L on the page's own
 * tab. Mounted once in the app shell, beside the window's other chord hooks,
 * because a page can be focused on any surface that draws one.
 *
 * A shortcut the app then had nothing to do with — ⌘K under the terminal
 * guard, ⌃⌘ + arrow with no split — hands focus back to the page main took it
 * from. Nothing is toasted if that fails: nobody asked for the hand-back, and
 * the person is left in the app, one click from the page (AGENTS.md's
 * exception for work no one requested).
 */
export function useBrowserAppShortcuts(): void {
  React.useEffect(
    () =>
      window.api.browser.onAppShortcut((event) => {
        if (runBrowserAppShortcut(event)) return;
        void window.api.browser.focusPage({ tabId: event.tabId }).catch(() => undefined);
      }),
    [],
  );
}
