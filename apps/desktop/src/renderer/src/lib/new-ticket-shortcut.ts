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
 * own "c" keystrokes untouched), `[role="dialog"]`/`[role="alertdialog"]`
 * (keeps "c" inert while any modal, including the New-ticket dialog itself, is
 * already open), and the Monaco source editor.
 *
 * Monaco needs its own two entries because it is text entry that matches NONE
 * of the generic ones: its input surface in this build is a
 * `div.native-edit-context` — not a `<textarea>`, not `[contenteditable]` — so
 * typing `const`/`class`/`function` inside a file tab opened the New-ticket
 * dialog and swallowed the rest of the word. Both a Monaco-owned and an
 * app-owned anchor are listed on purpose, so neither alone is load-bearing:
 *
 *  - `.monaco-editor` — Monaco's own editor root, which wraps whichever input
 *    surface the build uses (`native-edit-context` today, `textarea.inputarea`
 *    before it). Matching the ROOT rather than the input element is what keeps
 *    this fix alive across an input-strategy change; matching
 *    `.native-edit-context` would just re-encode the assumption that broke.
 *  - `[data-monaco-status]` — OUR host attribute (components/editor/*), set by
 *    every editor surface we mount. It can't drift without us changing it, and
 *    the e2e smokes read the same attribute.
 */
export const NEW_TICKET_GUARD_SELECTOR =
  'input, textarea, select, [contenteditable], [data-terminal-renderer], [role="dialog"], [role="alertdialog"], .monaco-editor, [data-monaco-status]';

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
