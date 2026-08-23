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
  /**
   * A number, a unit, a short enum — days, a zoom step, a reasoning level.
   *
   * `w-28`, not `w-24`: this rung's longest words sit inside a `SelectTrigger`,
   * which spends ~54px of itself on padding, caret and gap — at `w-24` that
   * left "Manual" and "Medium" clipped mid-word in every table and row that
   * used it. The rung must hold its longest enum word inside the control that
   * actually wears it, not in a bare `<span>`.
   */
  sm: "w-28",
  /** The default. One-of-N where the options are words. */
  md: "w-44",
  /** A model name, a path, anything carrying a provider suffix. */
  lg: "w-64",
} as const;

export type ControlWidth = keyof typeof CONTROL_W;
