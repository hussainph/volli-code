/**
 * Shared clamp policy for long-form ticket surfaces (VC-99): agent-written
 * comments and ticket bodies can grow without bound, and an uncapped block in
 * the Doc tab's scrolling column turns one verbose comment into an extensive
 * scroll. Both surfaces clamp the same way — a px cap from here, applied as an
 * inline `maxHeight` so the number and the style cannot drift apart — and both
 * show their expand affordance only when the content actually exceeds the cap.
 *
 * Pure on purpose: the DOM measurement that feeds it is view glue, but the
 * decision (does this height overflow? is this surface clamped right now?) is
 * policy, and policy belongs where a unit test can pin it.
 */

/** Collapsed height of a comment body: 288px (~12 typeset lines). */
export const COMMENT_CLAMP_PX = 288;

/** Collapsed height of a ticket body editor: 384px (~19 lines at the editor's leading). */
export const BODY_CLAMP_PX = 384;

/**
 * Sub-pixel rounding slack: measured heights land on fractional pixels, so an
 * exact `>` comparison would flag a body that misses the cap by 0.5px. Anything
 * within a pixel of the cap reads as fitting.
 */
export const CLAMP_TOLERANCE_PX = 1;

/**
 * The clamp decision for one surface. `overflowing` says the content exceeds
 * the cap (so the expand affordance belongs on screen even while expanded — the
 * user still needs the way back down); `clamped` says the cap is binding right
 * now (overflowing AND not expanded — the fade, the `maxHeight`, the internal
 * scroll all key off this).
 */
export interface ClampPlan {
  readonly overflowing: boolean;
  readonly clamped: boolean;
}

/**
 * Plan the clamp for a surface of `contentHeight` px under `capPx`.
 * `contentHeight` may be `null` before the first measurement arrives: nothing
 * overflows yet, so no cap and no affordance — the measurement (a layout
 * effect, pre-paint) corrects both before the user can see the difference.
 */
export function planClamp(
  contentHeight: number | null,
  capPx: number,
  expanded: boolean,
): ClampPlan {
  const overflowing = contentHeight !== null && contentHeight > capPx + CLAMP_TOLERANCE_PX;
  return { overflowing, clamped: overflowing && !expanded };
}
