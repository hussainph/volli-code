/** The settled canvas elevation, ink weight and shadow strength in each mode.
 * Content paper is neutral; these choices affect only window chrome.
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

  /** Weight of the on-canvas label ladder, independent of neutral paper ink. */
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

/** The three settled dials, as they apply to one appearance. */
export interface SettledDials {
  lift: number;
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
    textWeight: ARC_SETTLED.textWeight[resolved],
    shadow: ARC_SETTLED.shadow[resolved],
  };
}
