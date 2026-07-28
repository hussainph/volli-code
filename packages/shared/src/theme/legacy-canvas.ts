/**
 * The canvas layer's derivation (#74, docs/plans/theming-engine.md § Canvas +
 * shaders): one seed in, the two or three colors the layer behind the whole app
 * is painted with out.
 *
 * Same load-bearing idea as the token generator next door — **the user picks
 * hue and chroma, never lightness.** Every `L` here is a constant in this file,
 * so no seed can produce a canvas bright enough to drop the dimmest sidebar
 * text below its contrast floor.
 */

import { hexToOklch, oklchToHex, type Oklch } from "./color";
import type { ThemeCanvas } from "./definition";
import { NEUTRAL_CHROMA_RANGE, neutralChroma } from "./generate";

/**
 * The lightness band every stop lives in.
 *
 * This is the whole safety story, so it is worth stating why these two numbers.
 * `--muted-foreground` is *solved by construction* to APCA Lc exactly 60.0 on
 * `--background` (L 0.178) — it has zero headroom — and the sidebar's dimmest
 * text is drawn straight onto this layer. So the ceiling has to sit under the
 * `--background` rung, not merely near it:
 *
 * | stop chroma (k × Cn) | max stop L still holding Lc ≥ 60 |
 * |----------------------|----------------------------------|
 * | k 0.8                | 0.1786                           |
 * | k 1.2                | 0.1768                           |
 * | k 1.6                | 0.1763                           |
 *
 * (measured across 36 hues with the foreground re-solved per hue).
 *
 * **Ceiling 0.170, not 0.178**: it buys ~1.5 Lc of margin over that exact-60
 * solve, absorbs the 8-bit rounding of the emitted stop, and sits under the
 * worst-hue ceiling at every chroma in range. **Floor 0.105**: below it the
 * stops quantize to near-identical hexes and the ramp bands. And the band's
 * midpoint is `--rail`'s own L 0.155, so a two-stop gradient's mean equals
 * today's flat fill — switching to a gradient does not make the app read
 * darker or lighter, only shaped.
 */
export const CANVAS_BAND = { min: 0.105, max: 0.17 } as const;

/**
 * The chroma multiplier over {@link neutralChroma}, ramped alongside `L` for
 * the same reason the neutral ladder ramps its own: a constant chroma reads as
 * *draining* of color as a surface lightens. `1.6` is the ceiling because
 * `Cn × 1.6` (≤ 0.022) is the window the neutral ladder already lives in —
 * above it the canvas stops being a tinted near-black and starts being a color.
 */
export const CANVAS_CHROMA_RAMP = { min: 0.8, max: 1.6 } as const;

/**
 * The anti-banding floor: adjacent stops must differ by at least this much `L`.
 *
 * Measured, because "gradients band" is otherwise folklore: the widest band
 * this layer can produce resolves to ~37 distinct 8-bit steps over an 800px
 * column — one step per 22px, which *is* visible on an OLED at high brightness.
 * Keeping the authored stops well apart leaves Chromium's own gradient
 * dithering something to work with. The fix is emphatically **not** a noise
 * tile: that reintroduces exactly the per-pixel variance under nav text that
 * grain was shipped off for.
 */
export const CANVAS_MIN_STOP_GAP = 0.03;

/**
 * How many stops a derivation produces. **Two or three, never more** — Arc's
 * own ceiling, and also where the arithmetic lands: three stops across a band
 * 0.065 wide are ΔL 0.0325 apart, barely clear of
 * {@link CANVAS_MIN_STOP_GAP}, and a fourth would fall under it.
 *
 * One parameter, deliberately: which of two/three ships is a matter of taste
 * over the real window, and this is the single line that decides it.
 */
export const CANVAS_STOP_COUNT = 3;

/** The hard ceiling {@link isThemeCanvas} enforces at the storage boundary. */
export const CANVAS_MAX_STOPS = 3;

/**
 * How far apart a mesh's pools may sit in hue. Enough that three pools do not
 * read as one blurred blob; far short of a second color. Gradient gets none of
 * this — two hues on one axis is a sunset, and one hue is a material.
 */
export const MESH_HUE_SPREAD = 4;

/** What a derivation is asked for: a seed, a geometry, and how many stops. */
export interface CanvasStopInput {
  /** The theme's seed hex — hue and chroma only, exactly as the generator reads it. */
  seed: string;
  /** Which geometry the stops are for. Only `mesh` spreads hue. */
  kind: "gradient" | "mesh";
  /** Defaults to {@link CANVAS_STOP_COUNT}. */
  count?: number;
}

/**
 * The derived stops as colors, **before** 8-bit emission — in paint order, so
 * index 0 is the lightest (the top of a gradient, the first mesh pool).
 *
 * Exported alongside {@link deriveCanvasStops} because the hue and chroma rules
 * are properties of the *derivation* and cannot be asserted on the emitted hex:
 * down at the band's floor a stop is `#060303`, where 8 bits simply do not
 * resolve a hue — measured, the darkest stop's apparent hue wanders by up to
 * 150° from the seed's. The rules that survive quantization (the lightness
 * band, and the APCA floor it exists to protect) are asserted on the hexes.
 * Same reasoning as `solveLightnessForContrast`'s export next door.
 */
export function canvasStopColors({
  seed,
  kind,
  count = CANVAS_STOP_COUNT,
}: CanvasStopInput): Oklch[] {
  const { C, h } = hexToOklch(seed);
  const Cn = neutralChroma(C);
  const spread = kind === "mesh" ? MESH_HUE_SPREAD : 0;
  return Array.from({ length: count }, (_, index) => {
    // 0 at the lightest stop, 1 at the darkest.
    const t = index / (count - 1);
    return {
      L: CANVAS_BAND.max - (CANVAS_BAND.max - CANVAS_BAND.min) * t,
      C: Cn * (CANVAS_CHROMA_RAMP.max - (CANVAS_CHROMA_RAMP.max - CANVAS_CHROMA_RAMP.min) * t),
      h: h - spread + 2 * spread * t,
    };
  });
}

/** The derived stops as emitted `#rrggbb`, lightest first — what a theme persists. */
export function deriveCanvasStops(input: CanvasStopInput): string[] {
  return canvasStopColors(input).map(({ L, C, h }) => oklchToHex(L, C, h));
}

/** The absolute chroma ceiling — the ladder's own maximum, ramped. */
export const CANVAS_MAX_CHROMA = NEUTRAL_CHROMA_RANGE.max * CANVAS_CHROMA_RAMP.max;

/**
 * One persisted stop, dragged back inside the band.
 *
 * Hue survives untouched — that is the half of a stop a person might
 * legitimately have hand-authored (#71 lets a theme file carry intent the UI
 * cannot express), and hue is not what threatens legibility. Lightness and
 * chroma do not survive: those are the two axes the contrast floor is a
 * function of, and they are the generator's to own.
 */
export function clampCanvasStop(hex: string): string {
  const { L, C, h } = hexToOklch(hex);
  return oklchToHex(
    Math.min(CANVAS_BAND.max, Math.max(CANVAS_BAND.min, L)),
    Math.min(CANVAS_MAX_CHROMA, C),
    h,
  );
}

/**
 * A gradient's stop positions. The mid stop sits **above** centre so the darker
 * half owns the lower two-thirds, where the content card's mass is — a bright
 * stop landing in the card's 8px frame reads as a glow around it.
 */
const GRADIENT_POSITIONS: Record<number, readonly string[]> = {
  2: ["0%", "100%"],
  3: ["0%", "46%", "100%"],
};

/**
 * Where a mesh's pools sit, in the window's own coordinates rather than a
 * seed's. Anchoring to the corners is what keeps the geometry a property of
 * the *window*: resizing moves the pools with the edges instead of reshuffling
 * them, and two themes differ in color, never in composition.
 */
const MESH_POOL_POSITIONS = ["8% 4%", "96% 34%", "30% 96%"] as const;

/**
 * The CSS `background` value for a canvas — the ONE path from a persisted
 * canvas to the screen, which is why the band is enforced here rather than
 * only where stops are derived.
 *
 * `solid` returns `fill` verbatim, so it is literally the flat token the
 * backdrop painted before this layer existed.
 */
export function canvasLayerBackground(canvas: ThemeCanvas, fill: string): string {
  if (canvas.kind === "solid") return fill;
  // Read-time truncation as well as clamping: the guard rejects a fourth stop
  // at the storage boundary, but nothing stops a caller constructing one, and
  // the geometries below are written for two or three.
  const stops = canvas.stops.slice(0, CANVAS_MAX_STOPS).map(clampCanvasStop);
  // A file whose stops were deleted degrades to the flat fill rather than to a
  // malformed gradient — the same rule every other theme reader follows.
  if (stops.length < 2) return fill;
  return canvas.kind === "gradient" ? gradientLayer(stops) : meshLayer(stops);
}

/** One axis, monotone ramp, lightest at the top: every macOS window is lit from above. */
function gradientLayer(stops: string[]): string {
  const positions = GRADIENT_POSITIONS[stops.length]!;
  const ramp = stops.map((stop, index) => `${stop} ${positions[index]!}`).join(", ");
  return `linear-gradient(180deg, ${ramp})`;
}

/**
 * A multi-radial composite with no single axis: the darkest stop as a base
 * fill, then one pool per anchor.
 *
 * The pool list is the stops *above* the darkest, extended by repeating its
 * last entry — so all three anchors are used at either stop count, and a lower
 * pool is never lighter than an upper one.
 */
function meshLayer(stops: string[]): string {
  const base = stops[stops.length - 1]!;
  const pools = MESH_POOL_POSITIONS.map(
    (position, index) =>
      `radial-gradient(ellipse 110% 90% at ${position}, ${stops[Math.min(index, stops.length - 2)]!}, transparent 72%)`,
  );
  return `${pools.join(", ")}, ${base}`;
}
