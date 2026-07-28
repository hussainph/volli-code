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
 * So the canvas gets two mechanisms the app's own ladder does not have:
 *
 *  - **Lift** — a translucent overlay per on-canvas tier, cumulative outward
 *    from the gradient. Signed, because the two modes reach the same picture
 *    from opposite ends: positive walks a tier toward paper, negative away from
 *    it, and paper is the LIGHTER end of the ladder in light and the darker one
 *    in dark. So {@link ARC_SETTLED.lift} is +0.25 in light and −0.25 in dark
 *    and both land the sidebar ~ΔL 0.022 above the canvas.
 *  - **Shadow** — the blurred halo under a raised surface. A shadow works by
 *    removing luminance, so it needs a backdrop with some: that is why the app
 *    ships none on its L 0.18 page, and why this canvas — a vivid wash at
 *    L 0.21–0.44 even in dark — can carry one.
 *
 * BOTH RUN IN BOTH MODES, which they did not originally. What changes with the
 * mode is not whether they apply but which way the ladder points: `--background`
 * is the lightest surface in light and one of the darkest in dark, so "toward
 * paper" is a direction on the ladder rather than on the lightness axis. Every
 * mode-dependent number is measured and lives in `ARC_TUNING` or
 * `ARC_SETTLED`; nothing below branches on `resolved` except to read one of
 * those.
 *
 * Pure and DOM-free like its neighbours. It sits above both of them —
 * `model.ts` owns the gradient, `tokens.ts` owns the paper, and elevation is
 * the one thing that needs to know about both — so nothing here may be imported
 * back into either.
 */
import { hexToOklch, oklchToHex, type ThemeTokens } from "@volli/shared";

import {
  arcBaseFillHex,
  ARC_SETTLED,
  ARC_TUNING,
  compositeHex,
  effectiveStopHexes,
  type ArcCanvasState,
  type ArcResolvedMode,
} from "./model";

/** One tier's overlay, and what it lands on. */
export interface ArcLiftTier {
  /** The overlay as a paintable `rgb(R G B / a)`, or `transparent` at share 0. */
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
   * sidebar second. Always as many as {@link ARC_TUNING.lift.shares}, so the
   * stylesheet can index them by position rather than by name.
   */
  tiers: ArcLiftTier[];
  /**
   * Where the sidebar ends up between the canvas and the paper, 0–1 — the
   * number the window's arrangement is really about. A sidebar at 0 or 1 is one
   * of the two materials the window already has; anything in between is a
   * third, which is exactly what reads as an unexplained band. Reported rather
   * than used, so the editor's digest can show the position instead of the
   * alpha that produced it.
   */
  sidebarTowardPaper: number;
  /** Every tier's composited surfaces, flattened — what {@link arcInk} scores against. */
  surfaces: string[];
  /** `box-shadow` values, in both modes — see {@link arcShadows}. */
  shadows: { raised: string; card: string; overlay: string };
}

/**
 * What the lift moves toward, and how hard.
 *
 * The target is a TOKEN rather than a color computed here, and that is the
 * point of this module importing the token set: a frosted sidebar that walked
 * toward some locally-invented "paper" would drift away from the card as the
 * card's own tint changed, and the two surfaces reading as the same material is
 * the entire effect. Sinking walks toward a canvas ink for the same reason — it
 * is the far end of the canvas's own family, so a sunk tier stays in the family
 * instead of turning grey.
 *
 * WHICH ink is measured, not assumed, and that one line is what lets one signed
 * amount serve both modes. "Sink" means away from the paper, and the paper is
 * not always the lighter end: in light it sits above the canvas (ember 0.78 →
 * 0.949) and in dark below it (0.276 → 0.176), because the dark card is a well
 * cut into a bright wash. Hardcoding the dark ink — which is what this did while
 * it was light-only — would send both signs the same way in dark, and dark's
 * settled lift is the negative one.
 *
 * Comparing the two lightnesses rather than branching on `resolved` is
 * deliberate beyond tidiness: the light band runs to L 0.90 and a dark canvas
 * reaches 0.44, so the mode is a proxy for the thing that actually matters and
 * the measurement is the thing itself.
 *
 * Always an answer, never null. It used to admit the flush case, back when the
 * lift was a slider that ran through zero; the settled pair does not, so the
 * only thing that can pin a tier to the canvas now is a share of zero — which
 * is a statement about which tiers are surfaces, and belongs one level up.
 */
function liftTarget(
  state: ArcCanvasState,
  resolved: ArcResolvedMode,
  tokens: ThemeTokens,
): { hex: string; alpha: number } {
  const { liftAlpha, sinkAlpha } = ARC_TUNING.lift;
  const lift = ARC_SETTLED.lift[resolved];
  const paper = tokens["--background"];
  if (lift > 0) return { hex: paper, alpha: lift * liftAlpha[resolved] };
  const { lightL, lightC, darkL, darkC } = ARC_TUNING.ink;
  const { h } = hexToOklch(state.stops[state.primaryIndex].hex);
  const away =
    hexToOklch(paper).L > hexToOklch(arcBaseFillHex(state, resolved)).L
      ? { L: darkL, C: darkC }
      : { L: lightL, C: lightC };
  return { hex: oklchToHex(away.L, away.C, h), alpha: -lift * sinkAlpha[resolved] };
}

/**
 * The elevation a canvas implies: the lift overlays for each on-canvas tier,
 * what they composite to, and the shadow set.
 *
 * Runs in both modes. Dark used to return the inert answer on the grounds that
 * its tiers were already separated by `--sidebar-veil` and a second mechanism
 * would double-count — but the two were never independent enough for that to
 * hold. Measured on the dark ladder, `--sidebar` (L 0.199) sits BELOW a dark
 * canvas (0.276 on ember), so the veil was already walking the sidebar toward
 * the card: the same direction as a positive lift, at a fixed amount, and
 * nothing to turn it off with. So `lab.css` now drops that veil whenever a
 * canvas is armed in either mode, and this is the one mechanism that positions
 * the on-canvas tiers.
 *
 * Two things fall out of that, both wanted. Lift 0 means the same thing in both
 * modes — every tier IS the canvas — and the share row applies in dark as well,
 * so the chrome band and rail genuinely stay on the gradient there instead of
 * only claiming to.
 */
export function arcElevation(
  state: ArcCanvasState,
  resolved: ArcResolvedMode,
  tokens: ThemeTokens,
): ArcElevation {
  const inert: ArcLiftTier = { veil: "transparent", surfaces: [] };
  const shares = ARC_TUNING.lift.shares;

  // Every pool plus the base fill: a tier spans the whole window, so it sits on
  // all of them and its worst reading is the one that counts.
  const beneath = [...effectiveStopHexes(state, resolved), arcBaseFillHex(state, resolved)];
  const target = liftTarget(state, resolved, tokens);
  const tiers = shares.map((share) => {
    // A share of zero says the tier is not a surface at all — which is what the
    // outer one is. Returning the inert answer rather than a 0-alpha overlay
    // keeps that a structural statement: nothing to paint, and nothing added to
    // the list of surfaces the ink has to survive, since the bare canvas is
    // already in it.
    if (share === 0) return inert;
    const alpha = target.alpha * share;
    const { r, g, b } = channels(target.hex);
    return {
      veil: `rgb(${r} ${g} ${b} / ${alpha.toFixed(4)})`,
      surfaces: beneath.map((under) => compositeHex(target.hex, alpha, under)),
    };
  });

  // An alpha toward `--background` IS the share of the way to paper — but only
  // while the lift is positive, which is light's case and not dark's. Sinking
  // walks the other way entirely, so there is no position between canvas and
  // paper to report and 0 is the honest one.
  const inner = shares[shares.length - 1] ?? 0;
  const sidebarTowardPaper = ARC_SETTLED.lift[resolved] > 0 ? target.alpha * inner : 0;

  return {
    tiers,
    surfaces: tiers.flatMap((tier) => tier.surfaces),
    sidebarTowardPaper,
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
 *
 * All three tiers always cast. The card's used to drop out under a seam that
 * took its gutter away — a halo with no ground to fall on is a dark line inside
 * the sidebar's edge — but the settled window gives the card a gutter on three
 * sides and abuts the sidebar on the fourth, where a `clip-path` in `lab.css`
 * stops the two halves shading each other. Geometry solves it there, so there
 * is nothing for this function to special-case.
 */
export function arcShadows(
  state: ArcCanvasState,
  resolved: ArcResolvedMode,
): { raised: string; card: string; overlay: string } {
  const strength = ARC_SETTLED.shadow;
  const { color, raised, card, overlay } = ARC_TUNING.shadow;
  const { h } = hexToOklch(state.stops[state.primaryIndex].hex);
  const { L, C } = color[resolved];
  const { r, g, b } = channels(oklchToHex(L, C, h));
  const layers = (spec: readonly { y: number; blur: number; spread: number; alpha: number }[]) =>
    spec
      .map(
        ({ y, blur, spread, alpha }) =>
          `0 ${y}px ${blur}px ${spread}px rgb(${r} ${g} ${b} / ${(alpha * strength).toFixed(4)})`,
      )
      .join(", ");

  return { raised: layers(raised), card: layers(card), overlay: layers(overlay) };
}
