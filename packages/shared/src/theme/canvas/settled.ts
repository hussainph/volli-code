/**
 * The five settings that used to be dials in the editor, at the values the
 * tuning pass ended on.
 *
 * A separate table from `ARC_TUNING` because the two answer different questions,
 * and keeping that distinction is the point rather than tidiness. Everything
 * there is a constant of the MODEL — a band edge, a cap, an alpha — true of
 * every canvas anyone might author. Everything here is a CHOICE, made on screen
 * against the app's own chrome, that stopped changing. A later disagreement with
 * one of these is an argument about taste and belongs in this block.
 *
 * **Every dial is a per-mode record, including the two whose modes agree**, and
 * that uniformity is the maintainability requirement rather than a formality.
 * Every consumer reads `settled(resolved).x`, so a retune that discovers `shadow`
 * or `cardTint` needs to differ after all is a one-value edit here — not a
 * signature change, a new branch at the call site, and a second reader to keep in
 * step. Three of the five already needed it; the other two were checked in both
 * modes rather than assumed, and the day one of them stops agreeing this table
 * is already shaped for the answer.
 *
 * Every number was solved against the ember default at vibrancy 0.6 — the canvas
 * the app ships with — and then measured across the editor's other seeds to
 * confirm it does not fall apart on them. The measurement runs live in
 * `docs/plans/arc-theming-migration.md` § Appendix — measured derivations.
 */

import type { ResolvedAppearance } from "./types";

export const ARC_SETTLED = {
  /**
   * Surface elevation: where the on-canvas tiers sit on `ARC_TUNING.lift`'s
   * signed axis.
   *
   * Opposite signs, one result. The sidebar lands ΔL +0.023 above the canvas in
   * light and +0.022 above it in dark — the same pane, lit the same way, in both
   * appearances. It takes a POSITIVE lift to get there in light (paper is the
   * lighter end) and a negative one in dark (paper is the darker end), because
   * the dark card is a well cut into a bright wash rather than a panel raised
   * off a dim one. Reading the pair as "frosted in light, recessed in dark" gets
   * the mechanism right and the picture backwards.
   *
   * A quarter rather than the half the dial opened on: at 0.5 the sidebar
   * started reading as a second card rather than as a pane of the window.
   */
  lift: { light: 0.25, dark: -0.25 },

  /**
   * How far the paper ladder is mixed toward the canvas's own colour, 0–1 — a
   * fraction of the canvas mixed IN, not a chroma multiplier (see `derive.ts`,
   * where the mix happens).
   *
   * The same in both modes, and that is a measurement rather than a
   * convenience: the mix is stated as a fraction of the distance between two
   * surfaces, so it already means the same thing on a pastel and on a
   * near-black. The dark path scales it by `DARK_LADDER.tintScale` for the one
   * asymmetry that IS real — the distance being crossed there is longer.
   *
   * 0.25 is the top of the range the editor offered, which is the honest place
   * for it to have landed: the directive was that the card belong to the
   * canvas's family, and every value under it read as a card that merely had a
   * tint applied.
   */
  cardTint: { light: 0.25, dark: 0.25 },

  /**
   * How far apart the ladder's rungs sit inside the card — solved, in each mode,
   * for the ONE rung pair the complaint was actually about: `--rail` under
   * `--background`, the tab strip beneath a tab.
   *
   * Two numbers because the target is |ΔL| and perceptual step size is not
   * symmetric about mid-grey. The light ladder is a mirror of the dark
   * generator's and inherited a spacing that does not survive the mirror, so it
   * needs a much bigger correction to reach a gap that reads: 0.042 near paper
   * against 0.020 near black. Solving one number for both would be picking which
   * mode to leave broken.
   *
   * Measured at {@link cardTint} 0.25 and nowhere else, because the gap is
   * tint-dependent. Appendix § Surface spread.
   */
  surfaceSpread: { light: 0.943, dark: 0.627 },

  /**
   * Copy weight: where secondary and label text sit between their old floors and
   * near-body (see `floors.ts`, and `ARC_TUNING.ink` for the canvas's own
   * ladder).
   *
   * Per-mode because the ranges it indexes are, and they are per-mode because
   * each starts at its own generator's floor — 68 in light, 60 in dark. The same
   * dial position would therefore mean two different Lc, so the number that was
   * frozen is the Lc and the weight is read back off it: secondary Lc 69.9 in
   * light and 64.0 in dark, label 51% / 55% of the way from secondary to body.
   * Appendix § Copy weight.
   */
  textWeight: { light: 0.133, dark: 0.222 },

  /**
   * Elevation shadow strength, 0–1 — a scale on every layer's alpha in
   * `ARC_TUNING.shadow`.
   *
   * The two modes agree because the per-mode part of a shadow is its COLOUR,
   * which that table already carries: light's rung sits under the light band and
   * dark's under the darkest canvas, so the same strength removes a comparable
   * share of whatever luminance is there. What 0.75 buys over the 0.6 the dial
   * opened on is the contact edge on the tab without the wide layer turning into
   * a smudge.
   */
  shadow: { light: 0.75, dark: 0.75 },
} as const;

/** The five settled dials, as they apply to one appearance. */
export interface SettledDials {
  lift: number;
  cardTint: number;
  surfaceSpread: number;
  textWeight: number;
  shadow: number;
}

/**
 * The settled values for one resolved appearance — the ONE way anything reads
 * this table.
 *
 * Going through a reader rather than indexing `ARC_SETTLED` at each call site is
 * what keeps the per-mode shape an implementation detail of this module: a dial
 * that later needs to stop being a plain number (a range, a curve, a function of
 * vibrancy) changes here and nowhere else.
 */
export function settled(resolved: ResolvedAppearance): SettledDials {
  return {
    lift: ARC_SETTLED.lift[resolved],
    cardTint: ARC_SETTLED.cardTint[resolved],
    surfaceSpread: ARC_SETTLED.surfaceSpread[resolved],
    textWeight: ARC_SETTLED.textWeight[resolved],
    shadow: ARC_SETTLED.shadow[resolved],
  };
}
