/** The subset of `KeyboardEvent` the ⌘P quick-open shortcut cares about. */
export interface QuickOpenKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}

/**
 * True for a bare ⌘P — opens quick-open. Requires Cmd alone, exactly as
 * {@link isCommandPaletteKeyEvent} requires it for ⌘K: no Ctrl (Ctrl+P is a
 * readline/terminal binding and must reach the pty untouched), no Alt, no
 * Shift. ⇧⌘P is deliberately left free — it is the command-palette chord in
 * every editor that has one, and this app already spends ⌘K on that.
 */
export function isQuickOpenKeyEvent(event: QuickOpenKeyEvent): boolean {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  return event.key.toLowerCase() === "p";
}
