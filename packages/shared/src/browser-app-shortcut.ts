/**
 * An app shortcut pressed while a Browser page held keyboard focus (VC-301):
 * the wire shape of the desktop-only `browserShortcuts.*` entries.
 *
 * A Browser Tab's page is its own native WebContents, so the window's
 * `keydown` listeners never see its keys. Desktop main takes the few that
 * belong to the app before the page or the menu can, and hands them to the
 * window as one of these:
 *
 *  • `replay` — a chord the window already binds (⌘K, ⌘1–⌘9, ⌃⌘ + arrow),
 *    replayed as a `keydown` so its existing listener and guards decide.
 *  • `close-tab` — ⌘W, which closes THIS tab through its own surface's close.
 *  • `focus-address` — ⌘L, which brings focus back into the app, onto this
 *    tab's address bar.
 */

/** The `KeyboardEvent` fields of one replayed chord. */
export interface BrowserAppKeyChord {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

export type BrowserAppShortcut =
  | { kind: "replay"; chord: BrowserAppKeyChord }
  | { kind: "close-tab" }
  | { kind: "focus-address" };

/** One {@link BrowserAppShortcut}, naming the opaque tab whose page took it. */
export interface BrowserAppShortcutEvent {
  tabId: string;
  shortcut: BrowserAppShortcut;
}
