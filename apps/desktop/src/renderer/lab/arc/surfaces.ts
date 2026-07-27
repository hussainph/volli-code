/**
 * Elevation: how a surface says it is nearer to you than the canvas behind it.
 *
 * Dark mode already had an answer and it is a good one — every surface is a
 * lighter fill than the one under it, and the veil in `@volli/shared` keeps
 * that rung intact once the backdrop becomes a gradient. Light mode inherited
 * the same machinery and it does not carry: measured on the shipped default at
 * vibrancy 0.6, the sidebar veil composites to **ΔL −0.015** from the canvas
 * beneath it, against dark's **ΔL +0.022** — and dark's happens near black,
 * where a given ΔL reads far larger. Two panes that differ by a hundredth of a
 * lightness unit on a bright saturated backdrop are one pane.
 *
 * So light mode gets two mechanisms dark mode does not need:
 *
 *  - **Lift** — a translucent overlay per on-canvas tier, cumulative outward
 *    from the gradient. Signed, because the two arrangements worth comparing
 *    are the same arrangement with the sign turned over: positive walks the
 *    chrome and the rail, then the sidebar, toward paper, so the window reads
 *    canvas → chrome → sidebar → card with every step closer to you; negative
 *    walks them toward the ink, restoring the recessed reading the light ladder
 *    started with. One dial, both models, and zero is exactly today's picture.
 *  - **Shadow** — the blurred halo under a raised surface. It is a light-mode
 *    tool for a structural reason and not a stylistic one: a shadow works by
 *    removing luminance, and on a near-black canvas there is almost none left
 *    to remove. That is why the app ships none.
 *
 * Pure and DOM-free like its neighbours. It sits above both of them —
 * `model.ts` owns the gradient, `tokens.ts` owns the paper, and elevation is
 * the one thing that needs to know about both — so nothing here may be imported
 * back into either.
 */
import { hexToOklch, oklchToHex, type ThemeTokens } from "@volli/shared";

import {
  arcBaseFillHex,
  ARC_TUNING,
  compositeHex,
  effectiveStopHexes,
  type ArcCanvasState,
  type ArcResolvedMode,
} from "./model";

/** One tier's overlay, and what it lands on. */
export interface ArcLiftTier {
  /** The overlay as a paintable `rgb(R G B / a)`, or `transparent` at lift 0. */
  veil: string;
  /**
   * What the tier composites to over every pool AND the base fill — the pixels
   * text on this tier will really sit on.
   */
  surfaces: string[];
}

export interface ArcElevation {
  /**
   * Outward from the canvas: the chrome band and project rail first, the inner
   * sidebar second. Always {@link ARC_TUNING.lift.tiers}-many, so the seam can
   * index them by position rather than by name.
   */
  tiers: ArcLiftTier[];
  /** Every tier's composited surfaces, flattened — what {@link arcInk} scores against. */
  surfaces: string[];
  /** `box-shadow` values, or `none` at strength 0 / in dark mode. */
  shadows: { raised: string; card: string; overlay: string };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * What the lift moves toward, and how hard.
 *
 * The target is a TOKEN rather than a color computed here, and that is the
 * point of this module importing the token set: a frosted sidebar that walked
 * toward some locally-invented "paper" would drift away from the card as the
 * card's own tint changed, and the two surfaces reading as the same material is
 * the entire effect. Sinking walks toward the canvas ink for the same reason —
 * it is the darkest color the canvas family contains, so a sunk tier stays in
 * the family instead of turning grey.
 */
function liftTarget(
  state: ArcCanvasState,
  tokens: ThemeTokens,
): { hex: string; alpha: number } | null {
  const { liftAlpha, sinkAlpha } = ARC_TUNING.lift;
  const lift = clamp(state.lift, -1, 1);
  if (lift === 0) return null;
  if (lift > 0) return { hex: tokens["--background"], alpha: lift * liftAlpha };
  const { darkL, darkC } = ARC_TUNING.ink;
  const { h } = hexToOklch(state.stops[state.primaryIndex].hex);
  return { hex: oklchToHex(darkL, darkC, h), alpha: -lift * sinkAlpha };
}

/**
 * The elevation a canvas implies: the lift overlays for each on-canvas tier,
 * what they composite to, and the shadow set.
 *
 * Dark mode returns the inert answer — no overlays, no shadows — rather than a
 * quieter version of the light one. Its tiers are already separated by the
 * veil, and stacking a second mechanism on top would double-count the
 * separation the veil exists to provide.
 */
export function arcElevation(
  state: ArcCanvasState,
  resolved: ArcResolvedMode,
  tokens: ThemeTokens,
): ArcElevation {
  const inert: ArcLiftTier = { veil: "transparent", surfaces: [] };
  if (resolved === "dark") {
    return {
      tiers: ARC_TUNING.lift.tiers.map(() => inert),
      surfaces: [],
      shadows: { raised: "none", card: "none", overlay: "none" },
    };
  }

  // Every pool plus the base fill: a tier spans the whole window, so it sits on
  // all of them and its worst reading is the one that counts.
  const beneath = [...effectiveStopHexes(state, resolved), arcBaseFillHex(state, resolved)];
  const target = liftTarget(state, tokens);
  const tiers = ARC_TUNING.lift.tiers.map((share) => {
    if (target === null) return inert;
    const alpha = target.alpha * share;
    const { r, g, b } = channels(target.hex);
    return {
      veil: `rgb(${r} ${g} ${b} / ${alpha.toFixed(4)})`,
      surfaces: beneath.map((under) => compositeHex(target.hex, alpha, under)),
    };
  });

  return {
    tiers,
    surfaces: tiers.flatMap((tier) => tier.surfaces),
    shadows: arcShadows(state, resolved),
  };
}

function channels(hex: string): { r: number; g: number; b: number } {
  const at = (index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return { r: at(0), g: at(1), b: at(2) };
}

/**
 * The three shadow tiers, as `box-shadow` values.
 *
 * Two layers each, always: a tight one that draws the contact edge and a wide
 * one that draws the distance. A single layer can do one or the other and
 * reads as a smudge attempting both.
 *
 * The color is the canvas's own hue at low lightness rather than neutral black,
 * and on a pastel canvas that is the difference between a shadow and a stain —
 * grey over a warm wash desaturates the pixels beneath it, so the shadow reads
 * as dirt on the gradient instead of as an absence of light.
 */
export function arcShadows(
  state: ArcCanvasState,
  resolved: ArcResolvedMode,
): { raised: string; card: string; overlay: string } {
  const strength = clamp(state.shadow, 0, 1);
  if (resolved === "dark" || strength === 0) {
    return { raised: "none", card: "none", overlay: "none" };
  }
  const { color, raised, card, overlay } = ARC_TUNING.shadow;
  const { h } = hexToOklch(state.stops[state.primaryIndex].hex);
  const { r, g, b } = channels(oklchToHex(color.L, color.C, h));
  const layers = (spec: readonly { y: number; blur: number; spread: number; alpha: number }[]) =>
    spec
      .map(
        ({ y, blur, spread, alpha }) =>
          `0 ${y}px ${blur}px ${spread}px rgb(${r} ${g} ${b} / ${(alpha * strength).toFixed(4)})`,
      )
      .join(", ");

  return { raised: layers(raised), card: layers(card), overlay: layers(overlay) };
}
