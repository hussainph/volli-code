/**
 * The canvas layer's renderer-side half: what it paints, and when a repaint of
 * it eases instead of cutting.
 *
 * The element itself lives in `theme-canvas.tsx` — this is the part with
 * decisions in it, split out for the same reason `grain.ts` is split from
 * `grain-overlay.tsx`.
 */

import { canvasLayerBackground, type ThemeCanvas } from "@volli/shared";

/**
 * What `kind: "solid"` paints.
 *
 * `--rail` and not `--background`: the canvas replaces the fill the backdrop
 * row carried before this layer existed, so solid has to BE that fill for the
 * app to stay pixel-identical to a build without a canvas. That identity is
 * what makes shipping this low-risk, so it is a named constant rather than a
 * string in a JSX attribute.
 */
export const CANVAS_SOLID_FILL = "var(--rail)";

/**
 * The CSS `background` a canvas paints, band-clamped on the way through.
 *
 * Takes the canvas rather than the whole theme so the Background picker can
 * paint a sample of an option it has not committed, through the same one
 * function the window itself is painted with — a preview that could drift from
 * the real thing would be worse than no preview.
 */
export function canvasBackground(canvas: ThemeCanvas): string {
  return canvasLayerBackground(canvas, CANVAS_SOLID_FILL);
}

/**
 * The two stacked layers a canvas paints.
 *
 * Two, rather than one whose `background` changes, because CSS
 * `background-image` **does not interpolate**: a solid and a mesh have no
 * intermediate value, so a project switch would hard-cut the canvas while every
 * other token in the window eased — a visible seam in exactly the transition
 * that is supposed to carry the signal. Opacity interpolates between any two
 * canvases, and it is compositor-friendly.
 */
export interface CanvasLayers {
  /** The canvas now in force. Always at full opacity, underneath. */
  current: string;
  /** The canvas being faded out over it, or null when nothing is fading. */
  outgoing: string | null;
}

/**
 * The layer pair after a background change.
 *
 * `eased` comes from the root attribute `beginScopeRepaint()` already sets, so
 * the canvas is armed by the same signal as every other token and needs no
 * timing of its own. Deliberately NOT eased: picking a Background in the
 * editor, and hovering one. Those are direct responses to a keystroke, where a
 * 300ms lag between arrowing down the list and seeing the result would make
 * three options feel like a queue of stale frames.
 */
export function nextCanvasLayers(
  layers: CanvasLayers,
  background: string,
  eased: boolean,
): CanvasLayers {
  // Same canvas: not a repaint at all. Returning the identical object keeps a
  // re-render from restarting a fade that is already halfway through.
  if (background === layers.current) return layers;
  return { current: background, outgoing: eased ? layers.current : null };
}
