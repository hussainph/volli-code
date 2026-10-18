/**
 * App shortcuts out of a focused Browser page (VC-301): what the handler map's
 * desktop-only `browserShortcuts.subscribe` and `browserShortcuts.focusPage`
 * call.
 *
 * Desktop main implements it over its Browser Tab host: a page's
 * `before-input-event` takes an app chord from the page, and every subscribed
 * window hears it; a shortcut the window then had nothing to do with hands
 * keyboard focus back to the page. Every other host supplies none, and both
 * entries answer `OperationUnavailableError`. Structural, so host-core imports
 * nothing of the desktop's.
 */
import type { BrowserAppShortcutEvent } from "@volli/shared";

export interface BrowserShortcutsPort {
  /** Calls `listener` with every shortcut a page hands back; the answer stops it. */
  subscribe(listener: (event: BrowserAppShortcutEvent) => void): () => void;
  /** Focuses one shown page; quiet for a tab that is gone or off screen. */
  focusPage(tabId: string): void;
}
