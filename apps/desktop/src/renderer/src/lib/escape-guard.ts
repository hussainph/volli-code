/**
 * Whether an Escape keypress landing on `target` should be left to the focused
 * control rather than treated as a view-level dismissal (closing the ticket
 * detail, deselecting a board card). The selector is the UNION of every control
 * that owns its own Escape — text entry (input / textarea / contenteditable)
 * and the Radix overlays (menus, dialogs, alert dialogs). Both the ticket
 * detail's "Escape closes the view" and the board's "Escape deselects"
 * window-level listeners consult this so a property dropdown, an open dialog, or
 * the label editor's text field can dismiss itself on Escape without also firing
 * the view-level action off the same bubbling keypress.
 */
const ESCAPE_EXEMPT_SELECTOR =
  "input, textarea, [contenteditable], [role=menu], [role=dialog], [role=alertdialog]";

export function isEscapeExempt(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ESCAPE_EXEMPT_SELECTOR) !== null;
}
