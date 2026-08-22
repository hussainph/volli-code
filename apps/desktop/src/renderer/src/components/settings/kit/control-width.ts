/**
 * The width ladder for a settings control.
 *
 * Three widths, because the controls on these surfaces sit in a right-aligned
 * column, and a column with eight widths in it is not a column. The audit that
 * produced this redesign (VC-111) counted eight ad-hoc `w-*` classes across two
 * panes; every one of them was a value someone picked in a component rather
 * than a decision anyone could repeat.
 *
 * Nothing else sets a control width. A control that genuinely does not fit one
 * of these rungs is a change argued here, not a `className` at the call site.
 */
export const CONTROL_W = {
  /** A number, a unit, a short enum — days, a zoom step, a reasoning level. */
  sm: "w-24",
  /** The default. One-of-N where the options are words. */
  md: "w-44",
  /** A model name, a path, anything carrying a provider suffix. */
  lg: "w-64",
} as const;

export type ControlWidth = keyof typeof CONTROL_W;
