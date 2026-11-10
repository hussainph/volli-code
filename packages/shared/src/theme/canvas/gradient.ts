/**
 * The canvas as math: one to three authored color pools in, one CSS
 * `background` out.
 *
 * Freely placed authored color pools form a vivid canvas. Appearance changes
 * the floor and alpha rather than muddying the hues; `ink.ts` chooses a
 * foreground against the worst pool on screen instead of the average one.
 *
 * Every number here comes from `ARC_TUNING`. Nothing in this module knows what
 * an appearance IS — it takes a resolved one and reads the table.
 */

import {
  clamp,
  compositeHex,
  hexToOklch,
  lerp,
  oklabToOklch,
  oklchToHex,
  oklchToOklab,
} from "../color";
import { ARC_TUNING } from "./tuning";
import type { Canvas, ResolvedAppearance } from "./types";

/** CSS color-mix(in oklab), also used for the synchronous window fill hint. */
function mixHex(over: string, alpha: number, under: string): string {
  const a = oklchToOklab(hexToOklch(over));
  const b = oklchToOklab(hexToOklch(under));
  const mixed = oklabToOklch({
    L: lerp(b.L, a.L, alpha),
    a: lerp(b.a, a.a, alpha),
    b: lerp(b.b, a.b, alpha),
  });
  return oklchToHex(mixed.L, mixed.C, mixed.h);
}

/** Vibrancy changes pool opacity, never bands or browns the authored hue. */
function poolAlpha(canvas: Canvas, resolved: ResolvedAppearance): number {
  return Math.min(1, clamp(canvas.vibrancy, 0, 1) * ARC_TUNING.mesh.alphaGain[resolved]);
}

/** The authored primary over the appearance's neutral window floor. */
export function baseFillHex(canvas: Canvas, resolved: ResolvedAppearance): string {
  const { floor, baseAlpha } = ARC_TUNING.mesh;
  return mixHex(canvas.stops[canvas.primaryIndex].hex, baseAlpha[resolved], floor[resolved]);
}

/** Peak pixels for the editor and on-canvas ink solve, in authored stop order. */
export function effectiveStopHexes(canvas: Canvas, resolved: ResolvedAppearance): string[] {
  const base = baseFillHex(canvas, resolved);
  return canvas.stops.map((stop) => compositeHex(stop.hex, poolAlpha(canvas, resolved), base));
}

/**
 * The noise layer, as a complete `background` layer — image, position, size and
 * repeat in one — or null when grain is off.
 *
 * Self-contained because the alternative is a companion `background-size` whose
 * layer count has to be kept in step with a list that changes length with the
 * stop count and the grain toggle. A per-layer `position / size` in the
 * shorthand cannot fall out of step with itself.
 *
 * The amount is baked into the URI rather than applied as an element opacity so
 * the whole canvas stays ONE property: the canvas layer drives a single
 * `background`, and a second element would have to be injected into it to carry
 * an opacity.
 */
export function grainLayer(grain: number): string | null {
  const { threshold, tilePx, baseFrequency, octaves, seed, alphaScale } = ARC_TUNING.grain;
  if (grain <= threshold) return null;
  const alpha = (clamp(grain, 0, 1) * alphaScale).toFixed(3);
  // `stitchTiles` and the pinned filter region are what make the tile seamless;
  // without them the default -10%/120% region shows a grid of edges.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tilePx}" height="${tilePx}">` +
    `<filter id="n" x="0" y="0" width="100%" height="100%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${baseFrequency}" numOctaves="${octaves}" seed="${seed}" stitchTiles="stitch"/>` +
    `<feColorMatrix type="luminanceToAlpha"/>` +
    `<feComponentTransfer><feFuncA type="linear" slope="${alpha}"/></feComponentTransfer>` +
    `</filter>` +
    `<rect width="100%" height="100%" filter="url(#n)"/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / ${tilePx}px ${tilePx}px repeat`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Window-coordinate mesh, in authored order. Appearance changes the neutral
 * floor and pool opacity, not the stop colours. The three measured footprints
 * keep the mesh airy instead of letting a single giant primary cover it.
 */
export function canvasBackground(
  canvas: Canvas,
  resolved: ResolvedAppearance,
  includeBase = true,
): string {
  const { sizes, fade } = ARC_TUNING.mesh;
  const layers: string[] = [];
  const grain = grainLayer(canvas.grain);
  if (grain !== null && includeBase) layers.push(grain);
  canvas.stops.forEach((stop, index) => {
    const [width, height] = sizes[index]!;
    layers.push(
      `radial-gradient(${width}% ${height}% at ${percent(stop.x)} ${percent(stop.y)}, color-mix(in oklab, ${stop.hex} ${(poolAlpha(canvas, resolved) * 100).toFixed(1)}%, transparent), transparent ${fade}%)`,
    );
  });
  if (includeBase) layers.push(baseFillHex(canvas, resolved));
  return layers.join(", ");
}
