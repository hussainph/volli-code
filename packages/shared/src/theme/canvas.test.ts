import { describe, expect, it } from "vite-plus/test";

import { apcaLc, hexToOklch, oklchToHex } from "./color";
import { DEFAULT_THEME } from "./definition";
import { generateThemeTokens, neutralChroma } from "./generate";
import {
  CANVAS_BAND,
  CANVAS_CHROMA_RAMP,
  CANVAS_MIN_STOP_GAP,
  CANVAS_STOP_COUNT,
  canvasStopColors,
  deriveCanvasStops,
  canvasLayerBackground,
  MESH_HUE_SPREAD,
} from "./canvas";

/** Ember, the shipped seed. */
const EMBER = "#e8652a";

/** The Lc `--muted-foreground` is solved to, and therefore the floor to hold. */
const MUTED_FOREGROUND_LC = 60;

/**
 * Seeds spanning the hue circle at five chromas, including one below the
 * generator's grey guard. A single seed proves nothing about a floor whose
 * ceiling moves with hue.
 */
const SWEEP: string[] = [];
for (let h = 0; h < 360; h += 10) {
  for (const C of [0.01, 0.06, 0.12, 0.2, 0.35]) SWEEP.push(oklchToHex(0.661, C, h));
}

/**
 * How far an emitted stop's measured `L` may sit outside the band. The band is
 * specified on the derived color; down at the floor one 8-bit step is worth
 * ~0.005 `L`, which is exactly the rounding the 0.170 ceiling was chosen to
 * absorb (measured emitted range over the sweep: 0.1005–0.1720).
 */
const QUANTIZATION_L = 0.005;

/** Every `#rrggbb` in an emitted CSS background value, in order. */
function readStops(css: string): string[] {
  return css.match(/#[0-9a-f]{6}/g) ?? [];
}

/** Circular hue distance in degrees. */
function hueGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

describe("deriveCanvasStops", () => {
  it("never derives more than Arc's three stops, and keeps the seed's one hue", () => {
    const seed = hexToOklch(EMBER);

    for (const count of [2, 3]) {
      const colors = canvasStopColors({ seed: EMBER, kind: "gradient", count });

      expect(colors).toHaveLength(count);
      expect(count).toBeLessThanOrEqual(3);
      for (const color of colors) expect(hueGap(color.h, seed.h)).toBe(0);
    }

    expect(deriveCanvasStops({ seed: EMBER, kind: "gradient" })).toHaveLength(CANVAS_STOP_COUNT);
  });

  it("spreads a mesh's pools in hue, and only a mesh's, and only barely", () => {
    const seed = hexToOklch(EMBER);
    const mesh = canvasStopColors({ seed: EMBER, kind: "mesh", count: 3 });

    // Enough that three pools don't read as one blurred blob; far short of a
    // second color. Two hues is a sunset — one hue is a material.
    const gaps = mesh.map((color) => hueGap(color.h, seed.h));
    expect(Math.max(...gaps)).toBe(MESH_HUE_SPREAD);
    expect(new Set(mesh.map((color) => color.h)).size).toBe(3);
    // A gradient is one axis in one hue: rotating it would make the ramp read
    // as a colour transition rather than as a lit surface.
    for (const color of canvasStopColors({ seed: EMBER, kind: "gradient", count: 3 })) {
      expect(color.h).toBe(seed.h);
    }
  });

  it("keeps every stop inside the legibility band, at every seed and stop count", () => {
    for (const seed of SWEEP) {
      for (const count of [2, 3]) {
        for (const kind of ["gradient", "mesh"] as const) {
          for (const { L } of canvasStopColors({ seed, kind, count })) {
            expect(L).toBeGreaterThanOrEqual(CANVAS_BAND.min);
            expect(L).toBeLessThanOrEqual(CANVAS_BAND.max);
          }
        }
      }
    }
  });

  it("ramps chroma with lightness and never leaves the neutral ladder's window", () => {
    for (const seed of SWEEP) {
      const ceiling = neutralChroma(hexToOklch(seed).C) * CANVAS_CHROMA_RAMP.max;
      const colors = canvasStopColors({ seed, kind: "gradient", count: 3 });

      for (const { C } of colors) expect(C).toBeLessThanOrEqual(ceiling);
      // Rising with L, not constant: a flat chroma reads as the surface
      // draining of color as it lightens. Index 0 is the lightest stop.
      expect(colors[0]!.C).toBeGreaterThanOrEqual(colors[1]!.C);
      expect(colors[1]!.C).toBeGreaterThanOrEqual(colors[2]!.C);
    }
  });

  it("keeps adjacent stops far enough apart to out-run 8-bit banding", () => {
    for (const seed of SWEEP) {
      for (const count of [2, 3]) {
        const colors = canvasStopColors({ seed, kind: "gradient", count });
        for (let i = 1; i < colors.length; i += 1) {
          expect(colors[i - 1]!.L - colors[i]!.L).toBeGreaterThanOrEqual(CANVAS_MIN_STOP_GAP);
        }
      }
    }
  });

  it("is deterministic per seed, and two seeds do not collide", () => {
    const first = deriveCanvasStops({ seed: EMBER, kind: "gradient" });

    expect(deriveCanvasStops({ seed: EMBER, kind: "gradient" })).toEqual(first);
    expect(deriveCanvasStops({ seed: "#2a7de8", kind: "gradient" })).not.toEqual(first);
  });

  it("holds the APCA floor for the dimmest sidebar text, swept across hues", () => {
    // The measurement the whole band exists to satisfy. `--muted-foreground` is
    // solved to Lc exactly 60.0 on `--background`, so it has NO headroom — and
    // in the Arc arrangement it is drawn straight onto these stops. One sample
    // proves nothing here: the ceiling moves with hue and with chroma, so this
    // sweeps both and asserts the worst case.
    let worst = Number.POSITIVE_INFINITY;
    for (const seed of SWEEP) {
      const tokens = generateThemeTokens({ ...DEFAULT_THEME, seed });
      for (const kind of ["gradient", "mesh"] as const) {
        for (const count of [2, 3]) {
          for (const stop of deriveCanvasStops({ seed, kind, count })) {
            worst = Math.min(worst, apcaLc(tokens["--muted-foreground"]!, stop));
          }
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(MUTED_FOREGROUND_LC);
  });
});

describe("canvasLayerBackground", () => {
  it("paints solid as the flat fill the backdrop already paints — nothing added", () => {
    // The safety property the whole layer rests on: until someone picks a
    // gradient, the window is byte-for-byte what it was before it existed.
    expect(canvasLayerBackground({ kind: "solid" }, "var(--rail)")).toBe("var(--rail)");
  });

  it("gives mesh a different geometry from gradient on the same seed", () => {
    const stops = deriveCanvasStops({ seed: EMBER, kind: "gradient" });
    const gradient = canvasLayerBackground({ kind: "gradient", stops }, "var(--rail)");
    const mesh = canvasLayerBackground({ kind: "mesh", stops }, "var(--rail)");

    // One axis versus none — the only difference between the two that is
    // restrained enough to ship. Same band, same hue, same seed.
    expect(gradient).toContain("linear-gradient(180deg");
    expect(mesh).not.toContain("linear-gradient");
    expect(mesh.match(/radial-gradient/g)).toHaveLength(3);
    // Lightest at the top of the ramp, darkest at the bottom, where the card's
    // mass sits — a bright stop in the 8px frame reads as a glow.
    expect(readStops(gradient)).toEqual(stops);
    expect(hexToOklch(readStops(gradient).at(-1)!).L).toBeLessThan(
      hexToOklch(readStops(gradient)[0]!).L,
    );
    // The mesh's base fill is the darkest stop.
    expect(readStops(mesh).at(-1)).toBe(stops.at(-1));
  });

  it("degrades a stopless gradient to the flat fill rather than to broken CSS", () => {
    // Theme files are hand-editable, so every reader of one is a reader of
    // something a person can empty out. A malformed `linear-gradient()` would
    // drop the layer silently; the flat fill is the look they already had.
    expect(canvasLayerBackground({ kind: "gradient", stops: [] }, "var(--rail)")).toBe(
      "var(--rail)",
    );
    expect(canvasLayerBackground({ kind: "mesh", stops: ["#160d0a"] }, "var(--rail)")).toBe(
      "var(--rail)",
    );
  });

  it("drags a hand-edited stop back into the band on the way to the screen", () => {
    // Clamping on READ, not only on write, is what makes the band
    // non-bypassable: theme files are hand-editable and shareable (#71), so
    // "the generator would never emit that" is not a guarantee about what
    // reaches the DOM. There is no path to paint that skips this.
    const tokens = generateThemeTokens(DEFAULT_THEME);
    const smuggled = canvasLayerBackground(
      { kind: "gradient", stops: ["#ffffff", "#7c1fbf", "#000000"] },
      "var(--rail)",
    );

    expect(smuggled).not.toContain("#ffffff");
    expect(smuggled).not.toContain("#000000");
    for (const stop of readStops(smuggled)) {
      expect(hexToOklch(stop).L).toBeLessThanOrEqual(CANVAS_BAND.max + QUANTIZATION_L);
      expect(hexToOklch(stop).L).toBeGreaterThanOrEqual(CANVAS_BAND.min - QUANTIZATION_L);
      expect(apcaLc(tokens["--muted-foreground"]!, stop)).toBeGreaterThanOrEqual(
        MUTED_FOREGROUND_LC,
      );
    }
  });
});
