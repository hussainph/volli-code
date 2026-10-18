import * as React from "react";

import { runBrowserAppShortcut } from "@renderer/components/browser/browser-app-shortcuts";

/**
 * Receives the app shortcuts a focused Browser page handed back (VC-301) —
 * ⌘K and the navigation chords from inside a page, ⌘W and ⌘L on the page's own
 * tab. Mounted once in the app shell, beside the window's other chord hooks,
 * because a page can be focused on any surface that draws one.
 */
export function useBrowserAppShortcuts(): void {
  React.useEffect(
    () => window.api.browser.onAppShortcut((event) => runBrowserAppShortcut(event)),
    [],
  );
}
