/**
 * The caret binding a {@link ComposerPickerStack} hands the textarea under it
 * — in its own module so the composer's chrome (`composer-add-menu.tsx`) and
 * the composer itself can both read it without importing each other.
 */
import * as React from "react";

/** The caret bindings the stack owns and the textarea below it consumes. */
export interface ComposerCaretBinding {
  ref: React.RefCallback<HTMLTextAreaElement>;
  /** Consumes the picker's keys. `true` means the composer must not act on it. */
  handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
  trackCaret(element: HTMLTextAreaElement): void;
  /**
   * Type a picker trigger for the person, at the caret, and open its list
   * (VC-335). Present only under a real stack: a surface with no picker has
   * nothing for a `/` to open, and the `+` menu reads its absence as "offer
   * no such row" rather than as a row that would write a character to no end.
   */
  insert?(trigger: "/" | "@"): void;
  /** Hand the caret back to the textarea — after a menu closes, mainly. */
  focus(): void;
}

/**
 * Inert by default, so a textarea rendered outside a stack is a plain textarea
 * rather than a crash. Nothing in the app does that; the Lab could.
 */
export const ComposerCaretContext = React.createContext<ComposerCaretBinding>({
  ref: () => undefined,
  handleKeyDown: () => false,
  trackCaret: () => undefined,
  focus: () => undefined,
});

/**
 * The stack's caret binding, for a textarea that is not the chat's own.
 *
 * The Automation editor (VC-126) renders its Instructions box inside a
 * `ComposerPickerStack` so `/` and `@` resolve identically to the chat
 * composer — same picker, same insertion, same grammar — without inheriting
 * the chat textarea's queue and steer semantics. Any consumer must wire all
 * three members exactly as the chat's `ComposerTextarea` does: `ref`, then
 * `handleKeyDown` first in its own keydown, then `trackCaret` on
 * change/select/keyup.
 */
export function useComposerCaretBinding(): ComposerCaretBinding {
  return React.useContext(ComposerCaretContext);
}
