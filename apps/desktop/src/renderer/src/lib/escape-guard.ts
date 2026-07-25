import { MONACO_SURFACE_SELECTOR } from "./monaco-surface";

/**
 * Whether an Escape keypress landing on `target` should be left to the focused
 * control rather than treated as a view-level dismissal (closing the ticket
 * detail, deselecting a board card). The selector is the UNION of every control
 * that owns its own Escape — text entry (input / textarea / contenteditable /
 * the Monaco source editor) and the Radix overlays (menus, dialogs, alert
 * dialogs). Both the ticket detail's "Escape closes the view" and the board's
 * "Escape deselects" window-level listeners consult this so a property
 * dropdown, an open dialog, or the label editor's text field can dismiss itself
 * on Escape without also firing the view-level action off the same bubbling
 * keypress.
 *
 * Monaco is spliced in via the shared `MONACO_SURFACE_SELECTOR` (see that
 * module for why it takes two anchors, and why `.native-edit-context` is
 * deliberately not one of them). Without it, Escape inside a file tab closed
 * the whole ticket detail: Monaco owns Escape for dismissing its suggest/find
 * widgets and leaving multi-cursor or snippet mode, but a plain Escape it has
 * nothing to dismiss for goes un-`preventDefault`ed and bubbles to the window,
 * where it read as "close the view" — ejecting the user from a file they were
 * editing. Exempting it makes Monaco behave exactly like the `input` /
 * `textarea` / `[contenteditable]` surfaces already do: Escape is the focused
 * control's, and leaving the ticket is ⌘[ / Back / clicking out.
 */
const ESCAPE_EXEMPT_SELECTOR = `input, textarea, [contenteditable], [role=menu], [role=dialog], [role=alertdialog], ${MONACO_SURFACE_SELECTOR}`;

export function isEscapeExempt(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ESCAPE_EXEMPT_SELECTOR) !== null;
}
