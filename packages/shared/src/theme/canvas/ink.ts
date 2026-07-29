/**
 * What text painted directly ON the canvas is colored, and the two tiers that
 * rank under it.
 *
 * Two precomputed candidates chosen by measurement, not a solve, because a
 * canvas has no single background to solve against — text crosses several pools,
 * so the honest question is which of the two swatches survives the worst one.
 * Every score in this module is a MINIMUM across surfaces for exactly that
 * reason: an average would happily pick an ink that is unreadable over one pool
 * because it is excellent over the other two, which is the failure the flip
 * exists to prevent.
 */

import { apcaLc, clamp, hexToOklch, lerp, oklchToHex } from "../color";
import { baseFillHex, effectiveStopHexes } from "./gradient";
import { settled } from "./settled";
import { ARC_TUNING } from "./tuning";
import type { Canvas, CanvasInk, ResolvedAppearance } from "./types";

/** The candidate's Lc against the surface it reads WORST on. */
export function worstContrast(candidate: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((surface) => Math.abs(apcaLc(candidate, surface))));
}

/** A tuning range at a copy weight, clamped to the range's own travel. */
function atWeight({ min, max }: { min: number; max: number }, textWeight: number): number {
  return lerp(min, max, clamp(textWeight, 0, 1));
}

/**
 * Halvings in the readable-slide search: 1/1024 of the slide, comfortably finer
 * than one step of the 8-bit hex it ends up as.
 */
const SLIDE_SEARCH_STEPS = 10;

/**
 * The furthest a tier may slide toward the base fill before it stops clearing
 * `floor` on the surface it reads worst on.
 *
 * Searched rather than solved, and searched rather than merely clamped
 * afterwards, for three reasons that point the same way. There is no closed
 * form: the score is a MINIMUM over several surfaces, so the binding one can
 * change partway along the slide and any inverse would have to know which. A
 * solver would have to be handed one background and would therefore answer for a
 * surface the text does not only sit on — the exact averaging this module exists
 * to refuse. And a search cannot throw, where `solveLightnessForContrast` does
 * when the target is unreachable: the gradient is the user's to author, and a
 * canvas vivid enough to strand the bottom tier is one the editor is allowed to
 * reach.
 *
 * Monotone, which is what makes bisection valid here rather than merely
 * convenient. Every surface lies between the base fill's lightness and the
 * pools', and the ink sits outside that span on whichever side its flip put it —
 * so walking toward the base fill walks toward every surface at once, and the
 * worst score only ever falls.
 *
 * Both ends are answers, not errors. `1` means the floor never binds and the
 * full slide is spent; `0` means this canvas has no room for a ladder at all,
 * and the honest response is a flat one — every tier on the head ink — rather
 * than three tiers nobody can read.
 */
export function maxReadableSlide(
  slide: (t: number) => string,
  surfaces: readonly string[],
  floor: number,
): number {
  const reaches = (t: number) => worstContrast(slide(t), surfaces) >= floor;
  if (!reaches(0)) return 0;
  if (reaches(1)) return 1;
  let low = 0;
  let high = 1;
  for (let step = 0; step < SLIDE_SEARCH_STEPS; step += 1) {
    const mid = (low + high) / 2;
    if (reaches(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * Picks the on-canvas foreground — Arc's two precomputed swatches, chosen by
 * measurement rather than by a lightness threshold — then builds the two tiers
 * that rank under it.
 *
 * The ladder under the winner walks toward the BASE FILL, which is what keeps it
 * correct in both appearances without a branch: the base fill is the far side of
 * the canvas from whichever ink won, so "toward the base fill" is "toward the
 * surface" whether the ink is near-black on a pastel or near-white on a
 * near-black. A ladder stated as "lighter" or "darker" would invert the moment
 * the flip did.
 */
export function canvasInk(
  canvas: Canvas,
  resolved: ResolvedAppearance,
  /**
   * What the lift veils composite the on-canvas tiers to — every tier over every
   * pool (see `elevation.ts`). Passed in rather than derived here because the
   * veils are mixed from the app token set, and this module sits UNDER that:
   * `elevation.ts` imports it, so it cannot import back.
   *
   * Optional, and empty is the honest default: a caller that only wants the
   * gradient's own answer gets exactly that. What it buys the real caller is the
   * sink arm — dark's settled lift walks the sidebar to a tier LIGHTER than every
   * pool, so an ink scored on the pools alone would be scored against surfaces it
   * does not actually have to survive.
   */
  liftedSurfaces: readonly string[] = [],
): CanvasInk {
  const { lightL, lightC, darkL, darkC, mutedTowardBase, labelTowardMuted, mutedFloor } =
    ARC_TUNING.ink;
  const { h } = hexToOklch(canvas.stops[canvas.primaryIndex].hex);
  const lightInk = oklchToHex(lightL, lightC, h);
  const darkInk = oklchToHex(darkL, darkC, h);

  // The base fill is a surface too — it is what text sits on wherever no pool
  // reaches, and a worst-case score that exempted it would be an average with
  // extra steps.
  const surfaces = [
    ...effectiveStopHexes(canvas, resolved),
    baseFillHex(canvas, resolved),
    ...liftedSurfaces,
  ];
  const lightLc = worstContrast(lightInk, surfaces);
  const darkLc = worstContrast(darkInk, surfaces);
  const chooseLight = lightLc >= darkLc;
  const ink = chooseLight ? lightInk : darkInk;

  const chosen = hexToOklch(ink);
  const base = hexToOklch(baseFillHex(canvas, resolved));
  const slide = (t: number) => oklchToHex(lerp(chosen.L, base.L, t), chosen.C, chosen.h);

  // The same copy weight the card's own tiers are solved at, so the sidebar out
  // on the gradient and the paper beside it rank their text by one decision
  // rather than two.
  const { textWeight } = settled(resolved);
  // The ask, capped by what the canvas can actually carry. Taking the minimum
  // rather than reporting a failure is the whole degradation story: the ladder
  // gets shorter on a canvas with no headroom, and never unreadable.
  const mutedSlide = Math.min(
    atWeight(mutedTowardBase, textWeight),
    maxReadableSlide(slide, surfaces, mutedFloor),
  );
  // A FRACTION of the slide above, so the label tier is bounded by its two
  // neighbours by construction — it inherits the cap without being told about
  // it, and cannot cross either of them at any weight.
  const inkLabel = slide(mutedSlide * atWeight(labelTowardMuted, textWeight));
  const inkMuted = slide(mutedSlide);

  return {
    ink,
    inkLabel,
    inkMuted,
    worstLc: chooseLight ? lightLc : darkLc,
    labelLc: worstContrast(inkLabel, surfaces),
    mutedLc: worstContrast(inkMuted, surfaces),
    lightLc,
    darkLc,
  };
}
