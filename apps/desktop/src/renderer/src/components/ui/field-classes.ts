/**
 * The one place a TEXT FIELD's states are spelled — the sibling of
 * `menu-classes.ts`, and for the same reason: Input, Textarea and the input
 * group each carried their own copy of a focus recipe, so the family could
 * drift a state at a time.
 *
 * WHY THERE IS NO FOCUS STATE HERE. A text field gets no focus dressing at all — no border shift, no ring, no lift. The
 * caret is the indicator, and WCAG 2.4.7's understanding notes sanction the
 * text cursor as a sufficient focus indicator for text-entry fields, so this
 * is not an accessibility gap. The keyboard `focus-visible` ring survives only
 * where its absence WOULD be a violation: controls with no caret to speak for
 * them (buttons, switches, the select trigger), which keep the quiet
 * `focus-visible:ring-2 ring-ring` recipe spelled in `button.tsx`. Do not
 * "restore" a field focus treatment without reopening that decision.
 */

/**
 * Invalid. The edge alone, at full destructive strength — the one state a
 * field still wears on its border.
 */
export const FIELD_INVALID = "aria-invalid:border-destructive";

/** Geometry shared by actions, text fields and closed choice controls. */
export const CONTROL_SIZE = {
  xs: "h-control-xs px-control-pad-xs",
  sm: "h-control-sm px-control-pad-sm",
  default: "h-control-default px-control-pad-default",
  lg: "h-control-lg px-control-pad-lg",
} as const;
export type ControlSize = keyof typeof CONTROL_SIZE;

/** A text field keeps its lift even while its caret is active. */
export const FIELD_SURFACE =
  "border border-border-strong bg-card shadow-raised disabled:opacity-50";
