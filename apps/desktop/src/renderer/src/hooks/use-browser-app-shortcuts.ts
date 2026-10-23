import * as React from "react";

import { followBrowserAppShortcuts } from "@renderer/components/browser/browser-app-shortcuts";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

/**
 * Follows the app shortcuts a focused Browser page hands back (VC-301) — ⌘K
 * and the navigation chords from inside a page, ⌘W and ⌘L on the page's own
 * tab — over the desktop-only `browserShortcuts.*` entries. Mounted once in
 * the app shell, beside the window's other chord hooks, because a page can be
 * focused on any surface that draws one.
 */
export function useBrowserAppShortcuts(): void {
  React.useEffect(() => followBrowserAppShortcuts(sessionRpcClient()), []);
}
