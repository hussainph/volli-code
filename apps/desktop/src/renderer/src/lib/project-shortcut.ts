/** The subset of `KeyboardEvent` the ⌘-digit rail shortcut cares about. */
export interface ProjectShortcutKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  key: string;
}

/**
 * ⌘1–⌘9 → 0-based project rail index. ⌘/⌃ or ⌘/⌥ combos, ⌘0, and any
 * non-digit key return `null` — no shortcut fires.
 */
export function projectIndexForKeyEvent(event: ProjectShortcutKeyEvent): number | null {
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  return Number(event.key) - 1;
}
