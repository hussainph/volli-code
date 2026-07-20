/** The subset of `KeyboardEvent` the ⌘K command-palette shortcut cares about. */
export interface CommandPaletteKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}

/**
 * True for a bare ⌘K — toggles the global command palette. Requires Cmd
 * alone: no Ctrl (so Ctrl+K, a readline/terminal binding, is left untouched),
 * Alt, or Shift.
 */
export function isCommandPaletteKeyEvent(event: CommandPaletteKeyEvent): boolean {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  return event.key.toLowerCase() === "k";
}
