/**
 * The one place a TEXT FIELD's states are spelled — the sibling of
 * `menu-classes.ts`, and for the same reason: Input, Textarea and the input
 * group each carried their own copy of a focus recipe, so the family could
 * drift a state at a time.
 *
 * WHY THERE IS NO FOCUS STATE HERE. The owner's decision (2026-08-14): a text
 * field gets no focus dressing at all — no border shift, no ring, no lift. The
 * caret is the indicator, and WCAG 2.4.7's understanding notes sanction the
 * text cursor as a sufficient focus indicator for text-entry fields, so this
 * is not an accessibility gap. The keyboard `focus-visible` ring survives only
 * where its absence WOULD be a violation: controls with no caret to speak for
 * them (buttons, switches, the select trigger), which keep the quiet
 * `focus-visible:ring-2 ring-ring/45` recipe spelled in `button.tsx`. Do not
 * "restore" a field focus treatment without reopening that decision.
 */

/**
 * Invalid. The edge alone, at full destructive strength — the one state a
 * field still wears on its border.
 */
export const FIELD_INVALID = "aria-invalid:border-destructive";
