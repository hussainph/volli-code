/**
 * What copy inside the CARD is held to, in each appearance — the ranges
 * `ARC_SETTLED.textWeight` is a position on.
 *
 * The generator ships one floor per role because it only ever paints on
 * near-black. These are ranges instead, because the weight is a judgment call
 * made on screen and a frozen number would leave nothing to state it against.
 * Both tables have the same shape and the same structural decision — the range
 * STARTS at the declared floor and only reaches upward, so the null sits at the
 * BOTTOM in both modes rather than in the middle. Centring on the shipped value
 * was the first cut here and the sweep caught it: at weight 0 dark measured Lc
 * 50.5 against a declared 60, and `THEME_CONTRAST_FLOORS` is a contract.
 *
 * What differs is only where each starts, because each starts at its own
 * generator's floor — 68 in light, 60 in dark — and that is the whole reason
 * `textWeight` is per-mode: one position on two ranges that begin 8 Lc apart is
 * two different asks. Appendix § Copy weight.
 */

import { clamp, lerp } from "../color";
import { settled } from "./settled";
import type { ResolvedAppearance } from "./types";

/**
 * Light mode's floors.
 *
 * The bug these were raised to fix, measured before they existed: secondary copy
 * scored Lc 60.3 on `--background` — its declared floor — but **57.0 on
 * `--card`**, which is the surface the ticket rail and every panel actually
 * paint it on. Two independent fixes: the floors move (below), AND the solve
 * moves to `--card`, because a token solved against the lightest rung in the
 * ladder is guaranteed to under-deliver on every rung beneath it.
 *
 * Every range is centred so that `textWeight` 0.5 gives **90 / 85 / 75 on the
 * card**. That is the anchor a later adjustment should be checked against.
 */
export const LIGHT_FLOORS = {
  /**
   * Body copy, on `--background` — deliberately NOT moved to the card with the
   * others, because this one token is already the answer.
   *
   * The ink it produces (#352a26 on the shipped default) is the branch text the
   * owner named as the thing he liked, and a floor is a means to an ink rather
   * than the other way round. Re-solving the same 90 against `--card` looks like
   * the consistent choice and is not: APCA's curve is steep at the paper end, so
   * one rung of surface reaches for #0d0503, a stark near-black nobody asked for.
   */
  body: 90,
  /**
   * Secondary copy, on `--card`: the old floor at 0, near-body at 1.
   *
   * The ceiling is set by `body`, not by taste — body scores about 84.6 on the
   * card, so a secondary allowed past that would end up DARKER than the copy it
   * is subordinate to. 82 leaves the tier intact at the top of the range with a
   * couple of Lc to spare.
   */
  secondary: { min: 68, max: 82 },
  /**
   * Micro-labels — a POSITION between body and secondary, not a floor of their
   * own. 0 is body's exact ink, 1 is secondary's.
   *
   * Stated relatively because the ask was about a specific ink ("the colour of
   * the branch text, across the board"), and any absolute Lc that reproduces it
   * does so only for the surface and tint it was measured against. This holds at
   * every spread, tint and hue instead — and it cannot invert the hierarchy or
   * run out of color space the way a fourth independent solve can, since both of
   * its endpoints are already-solved inks.
   *
   * The travel runs BACKWARDS against the weight (0.55 → 0.10): more copy weight
   * means labels move toward body, which is a smaller fraction, not a larger one.
   */
  labelTowardSecondary: { min: 0.55, max: 0.1 },
  /** Sidebar nav. Unmoved — the canvas layer flips it to the canvas ink anyway. */
  sidebar: 75,
} as const;

/**
 * The same contract in dark, starting at the generator's own floors.
 *
 * The secondary range is a little wider than light's (18 Lc against 14) because
 * APCA's curve is shallower at the dark end: the same Lc step buys less visible
 * change on a near-black page than on paper, and a range that measured the same
 * would read as a smaller move.
 */
export const DARK_FLOORS = {
  /** Body copy, on `--background` — the generator's own floor, unmoved. */
  body: 90,
  /** Secondary copy, on `--card`: the generator's own floor at 0, near-body at 1. */
  secondary: { min: 60, max: 78 },
  /**
   * Micro-labels — a POSITION between body and secondary, exactly as in light.
   * Same travel and same backwards direction.
   */
  labelTowardSecondary: { min: 0.55, max: 0.1 },
  /** Sidebar nav. Unmoved, and the canvas layer flips it to the canvas ink anyway. */
  sidebar: 75,
} as const;

/**
 * What copy is held to in this appearance — the numbers actually solved for.
 *
 * Still a lerp rather than four literals, because the ranges above are where the
 * argument lives and `ARC_SETTLED.textWeight` is only a position on them.
 * Collapsing it would land the same hexes and throw away the reason they are
 * those hexes.
 */
export function copyFloors(resolved: ResolvedAppearance): {
  /** Lc, on `--background`. */
  body: number;
  /** Lc, on `--card`. */
  secondary: number;
  /** A fraction from body's ink toward secondary's — not an Lc. */
  labelTowardSecondary: number;
  /** Lc, on `--sidebar`. */
  sidebar: number;
} {
  const t = clamp(settled(resolved).textWeight, 0, 1);
  const { body, secondary, labelTowardSecondary, sidebar } =
    resolved === "dark" ? DARK_FLOORS : LIGHT_FLOORS;
  return {
    body,
    secondary: lerp(secondary.min, secondary.max, t),
    labelTowardSecondary: lerp(labelTowardSecondary.min, labelTowardSecondary.max, t),
    sidebar,
  };
}
