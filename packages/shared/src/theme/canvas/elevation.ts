/**
 * Elevation: how a surface says it is nearer to you than the canvas behind it.
 *
 * Dark mode already had an answer and it is a good one — every surface is a
 * lighter fill than the one under it, and the veil in `veil.ts` keeps that rung
 * intact once the backdrop becomes a gradient. Light mode inherited the same
 * machinery and it does not carry: the sidebar veil composites to ΔL −0.015 from
 * the canvas beneath it, against dark's ΔL +0.022 — and dark's happens near
 * black, where a given ΔL reads far larger. Two panes a hundredth of a lightness
 * unit apart on a bright saturated backdrop are one pane.
 *
 * So the canvas gets two mechanisms the app's own ladder does not have:
 *
 *  - **Lift** — a translucent overlay per on-canvas tier, cumulative outward from
 *    the gradient. Signed, because the two modes reach the same picture from
 *    opposite ends: paper is the LIGHTER end of the ladder in light and the
 *    darker one in dark, so `ARC_SETTLED.lift` is +0.25 / −0.25 and both land the
 *    sidebar ~ΔL 0.022 above the canvas.
 *  - **Shadow** — the blurred halo under a raised surface. A shadow works by
 *    removing luminance, so it needs a backdrop with some: that is why the app
 *    ships none on its L 0.18 page, and why this canvas can carry one.
 *
 * BOTH RUN IN BOTH MODES. What changes with the appearance is not whether they
 * apply but which way the ladder points; every mode-dependent number is measured
 * and lives in `ARC_TUNING` or `ARC_SETTLED`, and nothing below branches on
 * `resolved` except to read one of those.
 *
 * It sits above its neighbours — `gradient.ts` owns the canvas, `derive.ts` owns
 * the paper, and elevation is the one thing that needs to know about both — so
 * nothing here may be imported back into either.
 */

import { compositeHex, hexChannels, hexToOklch, oklchToHex } from "../color";
import type { ThemeTokens } from "../tokens";
import { baseFillHex, effectiveStopHexes } from "./gradient";
import { settled } from "./settled";
import { ARC_TUNING } from "./tuning";
import type { Canvas, ResolvedAppearance } from "./types";

/** One tier's overlay, and what it lands on. */
export interface CanvasLiftTier {
  /** The overlay as a paintable `rgb(R G B / a)`, or `transparent` at share 0. */
  veil: string;
  /**
   * What the tier composites to over every pool AND the base fill — the pixels
   * text on this tier will really sit on.
   */
  surfaces: string[];
}

/** The three `box-shadow` tiers a canvas casts. */
export interface CanvasShadows {
  raised: string;
  card: string;
  overlay: string;
}

export interface CanvasElevation {
  /**
   * Outward from the canvas: the chrome band and project rail first, the inner
   * sidebar second. Always as many as `ARC_TUNING.lift.shares`, so a stylesheet
   * can index them by position rather than by name.
   */
  tiers: CanvasLiftTier[];
  /**
   * Where the sidebar ends up between the canvas and the paper, 0–1 — the number
   * the window's arrangement is really about. A sidebar at 0 or 1 is one of the
   * two materials the window already has; anything in between is a third, which
   * is exactly what reads as an unexplained band. Reported rather than used, so
   * an editor can show the position instead of the alpha that produced it.
   */
  sidebarTowardPaper: number;
  /** Every tier's composited surfaces, flattened — what `canvasInk` scores against. */
  surfaces: string[];
  /**
   * The shadow set. Returned here rather than also exported on its own: it is one
   * value, and a second door to it is a second thing to keep in step.
   */
  shadows: CanvasShadows;
  /**
   * The overlay wash — one `rgb(R G B / a)` for every dialog, sheet and palette
   * scrim in the app.
   *
   * IT IS THE SHADOW'S OWN INK, and that is the whole idea rather than a
   * shortcut: a scrim is the window's shadow spread over everything instead of
   * pooled under one edge, so the color that is already solved to sit below
   * every canvas this mode can produce is exactly the color that should dim it.
   * The sites this replaces were `bg-black/30` and `bg-black/35 dark:bg-black/55`
   * — neutral black over a warm gradient, which desaturates the pixels beneath
   * it and reads as dirt rather than as an absence of light, and which no canvas
   * could ever move.
   *
   * NOT scaled by the shadow strength dial. A user who turns shadows off is
   * asking for flat surfaces, not for a modal that stops separating from the
   * page behind it.
   */
  scrim: string;
}

/**
 * Which of the two canvas inks lies on the far side of the canvas from the
 * paper — MEASURED, never assumed, and the one line that lets a single signed
 * lift serve both appearances.
 *
 * "Sink" means away from the paper, and the paper is not always the lighter end:
 * in light it sits above the canvas and in dark below it, because the dark card
 * is a well cut into a bright wash. Hardcoding the dark ink — which is what this
 * did while the mechanism was light-only — would send both signs the same way in
 * dark, and dark's settled lift is the negative one.
 *
 * Comparing the two lightnesses rather than branching on the appearance is
 * deliberate beyond tidiness: the light band runs to L 0.90 and a dark canvas
 * reaches 0.44, so the mode is a proxy for the thing that actually matters and
 * this is the thing itself. Only one arm of it is reachable at the settled lift,
 * which is why it is a function rather than an expression buried in one.
 */
export function awayFromPaper(paper: string, base: string, hue: number): string {
  const { lightL, lightC, darkL, darkC } = ARC_TUNING.ink;
  const away =
    hexToOklch(paper).L > hexToOklch(base).L ? { L: darkL, C: darkC } : { L: lightL, C: lightC };
  return oklchToHex(away.L, away.C, hue);
}

/**
 * What the lift moves toward, and how hard.
 *
 * The target is a TOKEN rather than a color computed here, and that is why this
 * module takes the token set: a frosted sidebar that walked toward some
 * locally-invented "paper" would drift away from the card as the card's own tint
 * changed, and the two surfaces reading as the same material is the entire
 * effect. Sinking walks toward a canvas ink for the same reason — it is the far
 * end of the canvas's own family, so a sunk tier stays in the family instead of
 * turning grey, and WHICH ink that is comes from {@link awayFromPaper}.
 *
 * Always an answer, never null. It used to admit the flush case, back when the
 * lift was a slider that ran through zero; the settled pair does not, so the only
 * thing that can pin a tier to the canvas now is a share of zero — which is a
 * statement about which tiers are surfaces, and belongs one level up.
 */
function liftTarget(
  canvas: Canvas,
  resolved: ResolvedAppearance,
  tokens: ThemeTokens,
): { hex: string; alpha: number } {
  const { liftAlpha, sinkAlpha } = ARC_TUNING.lift;
  const { lift } = settled(resolved);
  const paper = tokens["--background"];
  if (lift > 0) return { hex: paper, alpha: lift * liftAlpha[resolved] };
  const { h } = hexToOklch(canvas.stops[canvas.primaryIndex].hex);
  return {
    hex: awayFromPaper(paper, baseFillHex(canvas, resolved), h),
    alpha: -lift * sinkAlpha[resolved],
  };
}

/**
 * The three shadow tiers, as `box-shadow` values.
 *
 * Two layers each, always: a tight one that draws the contact edge and a wide one
 * that draws the distance. A single layer can do one or the other and reads as a
 * smudge attempting both.
 *
 * The color is the canvas's own hue at low lightness rather than neutral black,
 * and on a pastel canvas that is the difference between a shadow and a stain —
 * grey over a warm wash desaturates the pixels beneath it.
 */
function shadowSet(
  canvas: Canvas,
  resolved: ResolvedAppearance,
): { shadows: CanvasShadows; scrim: string } {
  const { shadow: strength } = settled(resolved);
  const { color, raised, card, overlay, scrim } = ARC_TUNING.shadow;
  const { h } = hexToOklch(canvas.stops[canvas.primaryIndex].hex);
  const { L, C } = color[resolved];
  const [r, g, b] = hexChannels(oklchToHex(L, C, h));
  const layers = (spec: readonly { y: number; blur: number; spread: number; alpha: number }[]) =>
    spec
      .map(
        ({ y, blur, spread, alpha }) =>
          `0 ${y}px ${blur}px ${spread}px rgb(${r} ${g} ${b} / ${(alpha * strength).toFixed(4)})`,
      )
      .join(", ");

  return {
    shadows: { raised: layers(raised), card: layers(card), overlay: layers(overlay) },
    scrim: `rgb(${r} ${g} ${b} / ${scrim[resolved]})`,
  };
}

/**
 * The elevation a canvas implies: the lift overlay for each on-canvas tier, what
 * it composites to, and the shadow set.
 *
 * Runs in both modes. Dark used to return the inert answer on the grounds that
 * its tiers were already separated by `--sidebar-veil` and a second mechanism
 * would double-count — but the two were never independent enough for that to
 * hold: `--sidebar` sits BELOW a dark canvas, so the veil was already walking the
 * sidebar toward the card, at a fixed amount, with nothing to turn it off with.
 * The canvas layer drops that veil whenever a canvas is armed, and this is the
 * one mechanism that positions the on-canvas tiers.
 *
 * Two things fall out of that, both wanted. Lift 0 means the same thing in both
 * modes — every tier IS the canvas — and the share row applies in dark as well,
 * so the chrome band and rail genuinely stay on the gradient there instead of
 * only claiming to.
 */
export function canvasElevation(
  canvas: Canvas,
  resolved: ResolvedAppearance,
  tokens: ThemeTokens,
): CanvasElevation {
  const inert: CanvasLiftTier = { veil: "transparent", surfaces: [] };
  const shares = ARC_TUNING.lift.shares;

  // Every pool plus the base fill: a tier spans the whole window, so it sits on
  // all of them and its worst reading is the one that counts.
  const beneath = [...effectiveStopHexes(canvas, resolved), baseFillHex(canvas, resolved)];
  const target = liftTarget(canvas, resolved, tokens);
  const tiers = shares.map((share) => {
    // A share of zero says the tier is not a surface at all — which is what the
    // outer one is. Returning the inert answer rather than a 0-alpha overlay
    // keeps that a structural statement: nothing to paint, and nothing added to
    // the list of surfaces the ink has to survive, since the bare canvas is
    // already in it.
    if (share === 0) return inert;
    const alpha = target.alpha * share;
    const [r, g, b] = hexChannels(target.hex);
    return {
      veil: `rgb(${r} ${g} ${b} / ${alpha.toFixed(4)})`,
      surfaces: beneath.map((under) => compositeHex(target.hex, alpha, under)),
    };
  });

  // An alpha toward `--background` IS the share of the way to paper — but only
  // while the lift is positive, which is light's case and not dark's. Sinking
  // walks the other way entirely, so there is no position between canvas and
  // paper to report and 0 is the honest one.
  const inner = shares[shares.length - 1];
  const sidebarTowardPaper = settled(resolved).lift > 0 ? target.alpha * inner : 0;

  const { shadows, scrim } = shadowSet(canvas, resolved);

  return {
    tiers,
    surfaces: tiers.flatMap((tier) => tier.surfaces),
    sidebarTowardPaper,
    shadows,
    scrim,
  };
}
