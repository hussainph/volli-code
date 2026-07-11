/** The subset of `KeyboardEvent` the plain-"c" new-ticket shortcut cares about. */
export interface NewTicketKeyEvent {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  repeat: boolean;
  isComposing: boolean;
}

/**
 * True for a bare, unmodified "c" press: Linear-style single-letter shortcuts
 * fire on key "c" (or "C" — CapsLock produces an uppercase key with
 * `shiftKey` false, so it must be accepted too) with no meta/ctrl/alt/shift
 * held, not an OS key-repeat, and not mid IME composition (composing keydowns
 * carry provisional, not-yet-committed text and must never trigger a shortcut).
 */
export function isNewTicketKeyEvent(event: NewTicketKeyEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.repeat || event.isComposing) return false;
  return event.key === "c" || event.key === "C";
}

/**
 * Selector for every element the "c" shortcut must never fire inside: form
 * controls and contenteditable regions (so plain typing isn't hijacked),
 * `[data-terminal-renderer]` (the attribute on every live terminal host, see
 * components/sessions/terminal-view.tsx — a terminal session must receive its
 * own "c" keystrokes untouched), and `[role="dialog"]`/`[role="alertdialog"]`
 * (keeps "c" inert while any modal, including the New-ticket dialog itself, is
 * already open).
 */
export const NEW_TICKET_GUARD_SELECTOR =
  'input, textarea, select, [contenteditable], [data-terminal-renderer], [role="dialog"], [role="alertdialog"]';

/**
 * True when a keydown originated somewhere the new-ticket shortcut must
 * ignore. Structural rather than DOM-typed (`target: unknown`) so this runs
 * unmodified in the node-environment unit tests: a target that is
 * null/not-an-object, or has no `closest` function, can't match any guard and
 * is treated as safe (false). Otherwise it's a guarded target when
 * `closest(NEW_TICKET_GUARD_SELECTOR)` finds an ancestor (or itself), or when
 * `isContentEditable` is true (covers editable regions Safari/Electron expose
 * via the property rather than a matching `[contenteditable]` attribute
 * selector).
 */
export function isTextEntryTarget(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as { closest?(selector: string): unknown; isContentEditable?: unknown };
  if (typeof el.closest !== "function") return false;
  // Must stay a method call — a detached `const closest = el.closest` loses
  // `this` and real DOM methods throw "Illegal invocation" when unbound.
  if (el.closest(NEW_TICKET_GUARD_SELECTOR)) return true;
  return el.isContentEditable === true;
}
