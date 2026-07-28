/**
 * The two neutral ladders the card is built from, side by side — and the one
 * rule that spaces both.
 *
 * They are built from opposite ends, which is why they belong together rather
 * than merged into `generate.ts`'s `LADDER`:
 *
 *  - **Dark** starts from the app's own `generateThemeTokens` and MOVES it. That
 *    generator is the proven ladder — every lightness is a constant in it and
 *    every foreground is APCA-solved — so hand-building a second dark ladder
 *    here would be inventing a way to be wrong. {@link DARK_LADDER} therefore
 *    holds no rungs: only how far the settled settings may push the generator's,
 *    read back out of its own output.
 *  - **Light** has no shipped counterpart, so {@link LIGHT_LADDER} is a mirror of
 *    that module's table: same shape, same floor list, same solver, inverted
 *    rungs.
 *
 * Merging the pair into the generator's own table would destabilise a ladder the
 * whole app already renders from, for no gain — the win is having the mirror and
 * the original visible in one file, where a rung that moves in one and not the
 * other is a diff you can see.
 */

import { clamp, hexToOklch, lerp, oklchToHex, type Oklch } from "../color";
import { neutralChroma } from "../generate";
import type { ThemeTokenName, ThemeTokens } from "../tokens";
import type { SettledDials } from "./settled";

/**
 * The lightness handed to `generateThemeTokens` as part of its seed.
 *
 * Arbitrary and DISCARDED by that function (it reads hue and chroma only), so
 * this is a carrier, not a color anybody sees. Mid-scale so it is representable
 * at every hue and chroma the canvas can produce. It sits outside both tables on
 * purpose: both paths seed the generator, so a carrier filed under the light
 * ladder would be a dark value living in the light table.
 */
export const SEED_CARRIER_L = 0.6;

/**
 * Everything the light path is tuned by, in one commented block — the same
 * contract as `ARC_TUNING`, because this ladder gets adjusted from screenshots
 * exactly like the gradient does.
 */
export const LIGHT_LADDER = {
  /**
   * The neutral ladder, LIGHTEST → darkest: a fixed lightness plus a chroma
   * multiplier per rung, mirroring `generate.ts`'s table with the ordering
   * turned over. `k` still rises as the rungs move AWAY from paper, for the same
   * reason it rises there — a constant chroma reads as draining of color across
   * a ladder.
   *
   * Two placements are not free choices and must not be "fixed" by eye:
   *
   *  - `--sidebar` sits BELOW `--rail`, the reverse of the dark ladder. The veil
   *    solve (`veil.ts`) is `C = (T − B(1−α))/α` at α 0.10, so the veiled surface
   *    may exceed its base by at most (255 − B)/10 bytes — about 2 at this end of
   *    the scale. A sidebar lighter than the rail is unsolvable here, and
   *    `generateVeilTokens` does not clamp: it would emit an out-of-range `rgb()`
   *    and the sidebar would quietly composite wrong.
   *  - `--rail` is darker than `--background` rather than lighter. In the dark
   *    ladder the rail is the recessive backdrop; on a light page receding means
   *    darker, and a backdrop lighter than the content card would make the card
   *    read as a hole punched in the window.
   */
  rungs: [
    { tokens: ["--background"], L: 0.955, k: 1.0 },
    { tokens: ["--popover"], L: 0.945, k: 1.0 },
    { tokens: ["--card"], L: 0.938, k: 1.1 },
    { tokens: ["--rail"], L: 0.93, k: 0.8 },
    { tokens: ["--secondary", "--muted"], L: 0.918, k: 1.2 },
    { tokens: ["--sidebar"], L: 0.9, k: 1.1 },
    { tokens: ["--sidebar-border"], L: 0.878, k: 1.4 },
    { tokens: ["--accent", "--sidebar-accent"], L: 0.872, k: 1.3 },
    { tokens: ["--border", "--input"], L: 0.858, k: 1.4 },
    { tokens: ["--border-hover"], L: 0.806, k: 1.5 },
    { tokens: ["--border-strong"], L: 0.778, k: 1.5 },
  ] satisfies readonly { tokens: readonly ThemeTokenName[]; L: number; k: number }[],

  /**
   * How much the paper is allowed to say about the canvas, as a multiplier on
   * `neutralChroma` — lerped by vibrancy so the slider reaches both ends of the
   * ask: 0 is near-neutral paper, 1 is clearly tinted.
   *
   * 3 is a measured ceiling, not a taste: at L 0.955 the sRGB boundary is close
   * enough that a warm hue already gives chroma back to the gamut map there
   * (0.0288 requested, 0.0240 kept). Past it the cool hues keep gaining and the
   * warm ones do not, so the tint would stop being even across the wheel.
   */
  tintGain: { min: 1, max: 3 },

  /**
   * How far the ladder's rungs are pushed APART, as a multiplier on each rung's
   * drop below `--background`.
   *
   * The rungs above were mirrored from `generate.ts` step for step, and that is
   * where they inherited a spacing that does not survive the mirror: perceptual
   * step size is not symmetric about mid-grey, so ΔL 0.020 that reads clearly
   * near L 0.17 is a surface you have to hunt for near L 0.94. This range starts
   * at 1 and only opens because it is a CORRECTION rather than a control.
   *
   * The multiplier FADES OUT as the drop grows, and that shape is the whole
   * design: a flat multiplier would fix the surfaces and turn the border rungs
   * into rules in the same stroke. Fading it means the rungs that are invisible
   * get the correction and the rungs that already work are left alone;
   * `--border-strong`, the furthest, does not move at all. Appendix § Surface
   * spread.
   */
  spread: { min: 1, max: 2.6 },
} as const;

/**
 * The dark counterpart — what the settings do to a ladder this module does not
 * author.
 *
 * Reading the rung lightnesses back OUT of the generated set rather than
 * transcribing them here is the point: a copy would be a second source of truth
 * that drifts silently the first time the generator is retuned, and the failure
 * would look like a spread that stopped landing where its measurement said.
 */
export const DARK_LADDER = {
  /**
   * The surfaces and edges the spread and the tint move — everything in the
   * token set that is a FILL. Foregrounds are excluded because they are solved
   * against these afterward, and the accent family because `--primary` is a
   * solved pair whose floor is measured on the button itself.
   */
  surfaces: [
    "--rail",
    "--background",
    "--card",
    "--popover",
    "--secondary",
    "--muted",
    "--accent",
    "--sidebar",
    "--sidebar-accent",
    "--border",
    "--border-hover",
    "--border-strong",
    "--input",
    "--sidebar-border",
  ] satisfies readonly ThemeTokenName[],

  /**
   * The spread multiplier's range — and unlike light's, it straddles 1.
   *
   * That asymmetry is the honest one rather than an oversight. Light's range is
   * a correction for a known defect in the mirror; dark's rungs are the
   * originals, measured at the lightness they were measured for, so it has
   * nothing to correct and the range exists to let the ladder be tightened as
   * well as opened.
   *
   * Centred so 0.5 is exactly 1.0, which means the midpoint reproduces the
   * shipped dark ladder byte for byte. That is the anchor a later adjustment
   * should be checked against — and `ARC_SETTLED.surfaceSpread.dark` sits above
   * it, at gain 1.10.
   */
  spread: { min: 0.6, max: 1.4 },

  /**
   * What fraction of light's tint the same setting buys here.
   *
   * Below 1 on purpose, and the reason is the distance being mixed across. The
   * light path mixes the paper toward a pastel that is already near it; the dark
   * canvas is a saturated wash sitting 0.10 of lightness ABOVE the page, so an
   * identical fraction would drag the card most of the way out of the dark
   * ladder — and take every foreground solved against it along, since those are
   * re-solved on the moved rung.
   *
   * Scaling rather than clamping keeps the mapping linear over its whole range.
   * A ceiling would give its top end a dead zone, which is the one thing a number
   * being chosen by eye must not have — and `ARC_SETTLED.cardTint` did land at
   * the top end.
   */
  tintScale: 0.55,
} as const;

/**
 * A rung's lightness → its lightness at this spread, for EITHER ladder.
 *
 * Built once per derivation and returned as a closure because the fade needs the
 * ladder's FULL depth to normalize against, and re-deriving that inside the loop
 * would compute the same constant eleven times.
 *
 * `origin` is a fixed point at every setting, and it is `--background` in both
 * ladders: the page is the one surface with nowhere to go, and a ladder whose
 * anchor drifted with a spacing control would turn a spacing control into a
 * brightness control.
 *
 * The distance from that origin is SIGNED, which is what lets one function serve
 * both. Light's rungs all sit below paper, so the sign never varies; dark's do
 * not — `--rail` is below `--background` and `--card` above it — so a formula
 * that assumed one direction would push half the ladder the wrong way. The fade
 * normalizes on |distance| for the same reason.
 *
 * Known defect, characterised by a test rather than fixed: the faded multiplier
 * is applied to a rung's whole distance rather than integrated along it, which
 * makes the map non-monotone above gain 2.0. Appendix § The non-monotone spread
 * curve.
 */
export function spreadCurve(origin: number, deepest: number, gain: number): (L: number) => number {
  return (L) => {
    const delta = L - origin;
    // Full gain at the origin, none at the far end, linear between. A ladder
    // with no depth at all has no far end to fade toward, and 0/0 would poison
    // every rung with NaN — so it is simply left alone.
    const reach = deepest === 0 ? 1 : Math.min(1, Math.abs(delta) / deepest);
    return origin + delta * lerp(gain, 1, reach);
  };
}

/**
 * How chromatic the light ladder's neutrals are, before the canvas is mixed in.
 *
 * Vibrancy is in charge here as well as in the gradient: it is the same slider
 * that decides how much color there IS, so paper that ignored it would be tinted
 * by a canvas that is barely tinted itself.
 */
export function lightTint(seedChroma: number, vibrancy: number): number {
  const { min, max } = LIGHT_LADDER.tintGain;
  return neutralChroma(seedChroma) * lerp(min, max, vibrancy);
}

/** Both ladders emit the same thing: every fill token, at a hex. */
export type LadderFills = Record<ThemeTokenName, string>;

/**
 * The light ladder's rungs, spread and then mixed toward the canvas.
 *
 * Spread first, mix second. They pull on the same axis and the order is not
 * arbitrary: spread is a statement about the ladder's own proportions and mix is
 * a statement about how far the whole thing sits from the canvas, so spreading a
 * mixed ladder would have the tint decide the spacing.
 *
 * Every rung then moves by the same fraction toward the same target, so the gaps
 * scale by (1 − mix) and their ORDER cannot change — which is what keeps the veil
 * solves (whose window depends on a rung pair's gap) valid at every tint.
 *
 * `cardTint` mixes toward the canvas AS PAINTED, which is a different move from
 * turning the ladder's chroma up and reaches somewhere turning it up cannot:
 * chroma alone runs into the sRGB boundary at L 0.955, and the boundary is closer
 * at warm hues than cool ones. A mix brings the canvas's LIGHTNESS along with its
 * chroma, walking the rung away from the boundary at exactly the moment it asks
 * for more color. Mixing toward the PAINTED color also keeps vibrancy in charge:
 * at vibrancy 0 the canvas is a near-neutral wash, so a quarter of it is a
 * quarter of nearly nothing.
 */
export function buildLightLadder(
  canvas: Oklch,
  tint: number,
  hue: number,
  dials: SettledDials,
): LadderFills {
  const { rungs } = LIGHT_LADDER;
  const paper = rungs[0].L;
  const spread = spreadCurve(
    paper,
    paper - rungs[rungs.length - 1].L,
    lerp(LIGHT_LADDER.spread.min, LIGHT_LADDER.spread.max, clamp(dials.surfaceSpread, 0, 1)),
  );
  const mix = clamp(dials.cardTint, 0, 1);

  const ladder = {} as LadderFills;
  for (const { tokens, L, k } of rungs) {
    const hex = oklchToHex(lerp(spread(L), canvas.L, mix), lerp(tint * k, canvas.C, mix), hue);
    for (const token of tokens) ladder[token] = hex;
  }
  return ladder;
}

/**
 * The dark ladder: the generator's own rungs, spread and mixed by the same two
 * settings in the same order.
 *
 * Every rung lightness, chroma and hue is read back out of `dark` rather than
 * restated — the one arrangement in which a later retune of `generate.ts` cannot
 * leave this file quietly describing a ladder that no longer exists.
 */
export function buildDarkLadder(
  dark: ThemeTokens,
  canvas: Oklch,
  dials: SettledDials,
): LadderFills {
  const rungs = DARK_LADDER.surfaces.map((token) => ({ token, ...hexToOklch(dark[token]) }));
  const origin = hexToOklch(dark["--background"]).L;
  const spread = spreadCurve(
    origin,
    Math.max(...rungs.map((rung) => Math.abs(rung.L - origin))),
    lerp(DARK_LADDER.spread.min, DARK_LADDER.spread.max, clamp(dials.surfaceSpread, 0, 1)),
  );
  const mix = clamp(dials.cardTint, 0, 1) * DARK_LADDER.tintScale;

  const ladder = {} as LadderFills;
  for (const rung of rungs) {
    // Each rung keeps its OWN chroma and hue rather than taking a common tint.
    // The generator varies chroma per rung on purpose (a constant reads as
    // draining of color across a ladder), and that variation is exactly what
    // this function has no business re-deciding.
    ladder[rung.token] = oklchToHex(
      lerp(spread(rung.L), canvas.L, mix),
      lerp(rung.C, canvas.C, mix),
      rung.h,
    );
  }
  return ladder;
}
