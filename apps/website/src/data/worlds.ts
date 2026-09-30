/**
 * The worlds the site's pictures float in (BRAND.md §2).
 *
 * Each world is a real Volli canvas — the same `{stops, vibrancy, grain}` a
 * person authors in Settings → Appearance — and it is painted at build time by
 * the app's own canvas engine in `@volli/shared`, so the light behind a still
 * of the app is the light that app actually wears. The palette is the release
 * film's (`apps/desktop/src/flute/kit/world.tsx`): the site and the film tell
 * the same release in the same colours.
 *
 * Only build-time code reads this module. Nothing here reaches the browser but
 * the CSS strings it produces.
 */
import {
  canvasBackground,
  DEFAULT_CANVAS,
  effectiveStopHexes,
  type Canvas,
  type CanvasStop,
} from "@volli/shared";

const canvas = (stops: CanvasStop[], vibrancy: number, grain = 0.16): Canvas => ({
  stops,
  primaryIndex: 0,
  vibrancy,
  grain,
});

export const WORLDS = {
  /** The shipped default canvas: one ember pool, high right. Home. */
  ember: DEFAULT_CANVAS,
  /** Deep teal into blue — Automations. */
  lagoon: canvas(
    [
      { hex: "#12b5a0", x: 0.25, y: 0.2 },
      { hex: "#2f6bff", x: 0.85, y: 0.85 },
    ],
    0.8,
  ),
  /** Electric blue and violet — the agent's tools. */
  cobalt: canvas(
    [
      { hex: "#3d6bff", x: 0.7, y: 0.25 },
      { hex: "#b04dff", x: 0.15, y: 0.75 },
      { hex: "#00c2ff", x: 0.9, y: 0.95 },
    ],
    0.85,
  ),
  /** Violet over teal — the shared browser. */
  aurora: canvas(
    [
      { hex: "#7b5cff", x: 0.72, y: 0.22 },
      { hex: "#19c3b4", x: 0.18, y: 0.82 },
    ],
    0.85,
  ),
  /** Rose and plum — side by side. */
  rose: canvas(
    [
      { hex: "#ff4f8b", x: 0.2, y: 0.25 },
      { hex: "#7a3cff", x: 0.85, y: 0.8 },
    ],
    0.8,
  ),
  /** Gold into ember — limits. */
  gold: canvas(
    [
      { hex: "#ffb31a", x: 0.7, y: 0.2 },
      { hex: "#ff5a3c", x: 0.2, y: 0.9 },
    ],
    0.75,
  ),
  /** Acid lime — models. */
  lime: canvas([{ hex: "#9be13c", x: 0.3, y: 0.25 }], 0.75),
} satisfies Record<string, Canvas>;

export type WorldName = keyof typeof WORLDS;

/** One drifting pool of light: an authored stop, unpulled, as the film draws it. */
export interface WorldPool {
  hex: string;
  x: number;
  y: number;
  primary: boolean;
}

export interface PaintedWorld {
  /** The app's own `--canvas` background for this canvas, grain included. */
  background: string;
  /** The authored stops as light (a lone stop gets its mirror, so it never reads flat). */
  pools: WorldPool[];
  /** The primary as the dark theme paints it — the bloom behind the subject. */
  bloom: string;
}

export function paintWorld(name: WorldName): PaintedWorld {
  const world: Canvas = WORLDS[name];
  const stops =
    world.stops.length > 1
      ? world.stops
      : [
          ...world.stops,
          { ...world.stops[0]!, x: 1 - world.stops[0]!.x, y: 1 - world.stops[0]!.y },
        ];
  return {
    background: canvasBackground(world, "dark"),
    pools: stops.map((stop, index) => ({
      hex: stop.hex,
      x: stop.x,
      y: stop.y,
      primary: index === world.primaryIndex,
    })),
    bloom: effectiveStopHexes(world, "dark")[world.primaryIndex]!,
  };
}

/**
 * A world as numbers a shader can paint (the opt-in animated background,
 * `WorldShader.tsx`). Everything is read back out of the same `canvasBackground`
 * string the static world paints, so the shader starts from the exact light the
 * build-time canvas shows and the fade between them is a change of motion, not
 * of colour.
 */
export interface WorldShaderPool {
  /** The pool as the canvas paints it (dark band, vibrancy applied). */
  hex: string;
  /** Centre, as fractions of the frame. */
  x: number;
  y: number;
  /** Ellipse radii, as fractions of the frame. */
  rx: number;
  ry: number;
  /** Where the pool has faded to transparent, as a fraction of its radius. */
  fade: number;
}

export interface WorldShaderPalette {
  /** The flat fill under every pool. */
  base: string;
  /** Canvas pools, bottom first (the primary, then the others). */
  canvas: WorldShaderPool[];
  /** The world's own light pools: the authored stops, unpulled. */
  light: WorldPool[];
  bloom: string;
  grain: number;
}

const POOL_LAYER =
  /radial-gradient\(ellipse ([\d.]+)% ([\d.]+)% at ([\d.]+)% ([\d.]+)%, (#[0-9a-f]{6}), transparent ([\d.]+)%\)/gi;

export function shaderPalette(name: WorldName): WorldShaderPalette {
  const painted = paintWorld(name);
  const layers = [...painted.background.matchAll(POOL_LAYER)].map(
    ([, rx, ry, x, y, hex, fade]): WorldShaderPool => ({
      hex: hex!,
      x: Number(x) / 100,
      y: Number(y) / 100,
      rx: Number(rx) / 100,
      ry: Number(ry) / 100,
      fade: Number(fade) / 100,
    }),
  );
  const base = painted.background.split(", ").at(-1)!.trim();
  if (layers.length === 0 || !/^#[0-9a-f]{6}$/i.test(base)) {
    throw new Error(`worlds: cannot read the painted canvas of "${name}" back as shader data`);
  }
  return {
    base,
    // The CSS lists the topmost layer first; a shader paints bottom-up.
    canvas: layers.toReversed(),
    light: painted.pools,
    bloom: painted.bloom,
    grain: WORLDS[name].grain,
  };
}
