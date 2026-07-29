/**
 * The canvas as math: one to three authored color pools in, one CSS
 * `background` out.
 *
 * This is Arc's Space gradient rather than the near-black backdrop the app
 * shipped first, and the difference is the whole point. The old generator
 * band-clamped every canvas toward the ladder, which is the right call for a
 * surface that has to stay readable under every seed and the wrong one for a
 * genuinely *vivid* canvas: freely-placed pools, a light/dark transform that is
 * a real change of color rather than a dimming, and (in `ink.ts`) a foreground
 * chosen against the WORST pool on screen instead of the average one.
 *
 * Every number here comes from `ARC_TUNING`. Nothing in this module knows what
 * an appearance IS — it takes a resolved one and reads the table.
 */

import { clamp, hexToOklch, lerp, oklchToHex, type Oklch } from "../color";
import { ARC_TUNING } from "./tuning";
import type { Canvas, CanvasStop, ResolvedAppearance } from "./types";

/**
 * How much of an authored chroma survives into the painted canvas — the
 * vibrancy curve and the per-mode cap, on their own.
 *
 * Split out of {@link effectiveOklch} because the token derivation needs exactly
 * this number and nothing else around it: `derive.ts` seeds the app's generator
 * with `oklch(L Ceff h)` at an arbitrary L, so it wants the canvas's saturation
 * without the canvas's lightness band. Copying the expression there would put
 * the same tuning in two files, and the whole point of `ARC_TUNING` is that
 * there is one place to turn the dial.
 */
export function effectiveChroma(
  authoredChroma: number,
  resolved: ResolvedAppearance,
  vibrancy: number,
): number {
  const { chroma } = ARC_TUNING;
  const light = resolved === "light";
  const gain = lerp(
    chroma.floor,
    light ? chroma.lightGain : chroma.darkGain,
    clamp(vibrancy, 0, 1) ** chroma.vibrancyExponent,
  );
  return Math.min(authoredChroma * gain, light ? chroma.lightCap : chroma.darkCap);
}

/**
 * The ACCENT's chroma — the same vibrancy curve as {@link effectiveChroma}, with
 * neither the per-mode gain nor the per-mode cap.
 *
 * It sits here rather than in `derive.ts` because the two are one decision
 * expressed twice, and the only way to keep them one decision is to be able to
 * read them together. Where they diverge is the whole point:
 *
 *  - **Vibrancy still governs.** A near-neutral wash must still yield
 *    near-neutral chrome, so the accent is coupled to the same slider on the same
 *    exponent — the shared low-half emphasis, unchanged.
 *  - **The ceiling is the AUTHORED chroma, not the background's.** `darkGain`
 *    0.62 and `darkCap` 0.09 exist so a saturated *backdrop* does not fight the
 *    ink standing on it. An accent is not a backdrop: it is a 32px button fill
 *    and an icon. Holding it to the background's ceiling made the brand color
 *    unreachable in dark at ANY setting (ember capped at 51% of its own chroma),
 *    which is a bug in the model rather than a taste.
 *
 * So vibrancy 1 lands on the authored color exactly — for the shipped canvas,
 * ember `#e8652a`, which is an exact fixed point of the accent math in
 * `generate.ts`. There is no mode in the signature because there is no mode in
 * the formula: one curve, both appearances, so a light↔dark flip moves every
 * surface in the window and leaves the accent where it was.
 */
export function accentChroma(authoredChroma: number, vibrancy: number): number {
  const { chroma } = ARC_TUNING;
  return authoredChroma * lerp(chroma.floor, 1, clamp(vibrancy, 0, 1) ** chroma.vibrancyExponent);
}

/**
 * The authored color as the window will actually paint it.
 *
 * Lightness is banded rather than scaled, so "light" and "dark" are two
 * genuinely different canvases built from one authored intent — the same seed
 * cannot produce a light canvas that is merely a brightened dark one. Chroma is
 * scaled by vibrancy and then capped: the cap is what stops a neon seed from
 * out-shouting the app's own accent, and it is per-mode because a dark pool
 * turns muddy at a chroma a light one carries comfortably.
 */
function effectiveOklch(hex: string, resolved: ResolvedAppearance, vibrancy: number): Oklch {
  const { L, C, h } = hexToOklch(hex);
  const { lightBand, darkBand } = ARC_TUNING;
  const bandedL =
    resolved === "light"
      ? clamp(L, lightBand.min, lightBand.max)
      : clamp(L + darkBand.shift, darkBand.min, darkBand.max);
  return { L: bandedL, C: effectiveChroma(C, resolved, vibrancy), h };
}

function toHex({ L, C, h }: Oklch): string {
  return oklchToHex(L, C, h);
}

/** Every stop's authored color as painted, in stop order. */
export function effectiveStopHexes(canvas: Canvas, resolved: ResolvedAppearance): string[] {
  return canvas.stops.map((stop) => toHex(effectiveOklch(stop.hex, resolved, canvas.vibrancy)));
}

/**
 * The flat fill under every pool — the primary, a touch darker.
 *
 * Derived from the primary rather than authored, because it is what the window
 * shows wherever no pool reaches, and a base that did not belong to the family
 * would put a seam around the whole canvas.
 */
export function baseFillHex(canvas: Canvas, resolved: ResolvedAppearance): string {
  const primary = effectiveOklch(canvas.stops[canvas.primaryIndex].hex, resolved, canvas.vibrancy);
  const drop = resolved === "light" ? ARC_TUNING.baseFill.lightDrop : ARC_TUNING.baseFill.darkDrop;
  return toHex({ ...primary, L: primary.L - drop });
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

function pool(stop: CanvasStop, hex: string, width: number, height: number, fade: number): string {
  return `radial-gradient(ellipse ${width}% ${height}% at ${percent(stop.x)} ${percent(stop.y)}, ${hex}, transparent ${fade.toFixed(1)}%)`;
}

/**
 * The whole canvas as one CSS `background` value, topmost layer first: grain,
 * then the non-primary pools, then the primary's pool beneath them, then the
 * base fill.
 *
 * The primary sits UNDER the others despite being the dominant color — its pool
 * is large enough to cover them, and painting it on top would make every other
 * stop invisible the moment its fade reached them.
 */
export function canvasBackground(canvas: Canvas, resolved: ResolvedAppearance): string {
  const { width, height, primaryWidth, primaryHeight, fadeMin, fadeMax, primaryFadeBonus } =
    ARC_TUNING.pool;
  const effective = effectiveStopHexes(canvas, resolved);
  const fade = lerp(fadeMin, fadeMax, clamp(canvas.vibrancy, 0, 1));
  const layers: string[] = [];

  const grain = grainLayer(canvas.grain);
  if (grain !== null) layers.push(grain);

  canvas.stops.forEach((stop, index) => {
    if (index === canvas.primaryIndex) return;
    layers.push(pool(stop, effective[index], width, height, fade));
  });

  const primary = canvas.stops[canvas.primaryIndex];
  layers.push(
    pool(
      primary,
      effective[canvas.primaryIndex],
      primaryWidth,
      primaryHeight,
      fade + primaryFadeBonus,
    ),
  );
  // Last, and a bare color: only the final layer of the shorthand may carry the
  // background-color.
  layers.push(baseFillHex(canvas, resolved));

  return layers.join(", ");
}
