/**
 * Whether a pane can hold two columns of diff, as arithmetic (VC-288).
 *
 * Monaco has its own answer to this — `useInlineViewWhenSpaceIsLimited`, which
 * collapses a side-by-side diff somewhere under ~900px — and issue #109 turned
 * it OFF, for a good reason at the time: the ticket pane is routinely narrower
 * than that, and a Side-by-side toggle that silently did nothing in the app's
 * ordinary layout read as a broken control. What that fix left behind is the
 * opposite failure, and VC-288 measured it: in a split at 150% zoom the diff
 * pane is around 320 CSS px, and two columns of 13px Geist Mono there are two
 * gutters and an ellipsis each.
 *
 * So the heuristic comes back, but as OUR number rather than Monaco's, in one
 * place both the editor and the control band read. That is the whole reason
 * this is a module and not a ternary inside the host: the band has to be able
 * to say that the diff is not drawing what was asked for, and a rule the band
 * re-derives is a rule that can disagree with the editor beside it.
 *
 * **The stored choice is never touched.** `diffPresentation` is an app-wide
 * preference (`stores/ui.ts`) and a pane being narrow is not a person changing
 * their mind: the fit is computed on the way to the screen, so widening the
 * pane restores the two columns with nothing to press.
 */
import type { DiffPresentation } from "@renderer/stores/ui";

/**
 * The narrowest pane that still gets two columns, in CSS px.
 *
 * Arithmetic, not taste: at 13px Geist Mono an average glyph is ~7.8px, and
 * each side of a diff spends ~44px on its line-number gutter and change
 * decoration before any code is drawn. 640 gives each column ~320px, which is
 * ~35 characters — a short line whole, and enough of a long one to see WHICH
 * line it is. Below that the two columns stop being a comparison and become
 * two truncations, which is exactly what the audit photographed.
 *
 * It also sits clear of both ends of VC-288's acceptance: 480 falls back, 720
 * does not, and the 240px floor VC-264 clamps a split pane to is far under it.
 */
export const DIFF_SIDE_BY_SIDE_MIN_WIDTH = 640;

/**
 * Whether a measured pane of `width` can hold both columns.
 *
 * A width of `0` is not a narrow pane, it is an unmeasured one — a first frame,
 * a `display: none` ancestor, a pane mid-transition — and is treated like the
 * `null` in {@link fitDiffPresentation}.
 */
export function diffFitsSideBySide(width: number): boolean {
  return width >= DIFF_SIDE_BY_SIDE_MIN_WIDTH;
}

/**
 * The presentation the pane will actually draw, given what the reader chose.
 *
 * `null` (and `0`) mean the pane has not been measured yet, and the answer
 * there is the stored choice: a diff that flashed inline for one frame and then
 * split into columns would be the toggle looking broken all over again, just
 * faster.
 */
export function fitDiffPresentation(
  chosen: DiffPresentation,
  width: number | null,
): DiffPresentation {
  if (chosen === "inline") return "inline";
  if (width === null || width === 0) return chosen;
  return diffFitsSideBySide(width) ? "side-by-side" : "inline";
}

/**
 * Whether the pane is drawing something other than what was chosen — the one
 * state the control band has to be able to name, because the segmented control
 * still shows Side by side while the diff below it has one column.
 */
export function isDiffInlineFallback(chosen: DiffPresentation, width: number | null): boolean {
  return chosen !== fitDiffPresentation(chosen, width);
}
