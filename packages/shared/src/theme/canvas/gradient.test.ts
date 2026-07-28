/**
 * What the gradient math has to keep true no matter what is authored.
 *
 * The bands and the caps are the interesting cases, so the inputs here are
 * deliberately hostile — pure black, pure white, and the three sRGB primaries,
 * which sit at the chroma extremes where a formula that merely looks right on
 * ember stops holding. `ARC_TUNING` is read for the BOUNDS being asserted and
 * never for the expected values: a test that recomputes the implementation would
 * pass for the wrong reason.
 */
import { describe, expect, it } from "vite-plus/test";

import { hexToOklch } from "../color";
import { addStop, withPrimaryHex } from "./edit";
import {
  accentChroma,
  baseFillHex,
  canvasBackground,
  effectiveChroma,
  effectiveStopHexes,
  grainLayer,
} from "./gradient";
import { DEFAULT_CANVAS } from "./parse";
import { ARC_TUNING } from "./tuning";
import type { Canvas, ResolvedAppearance } from "./types";

/** Every effective color makes a hex round trip, which costs up to ~0.0015 of L or C. */
const HEX_DUST = 0.002;

const EXTREMES = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff"];

/** A one-stop canvas on `hex`, with everything else at the defaults. */
function canvasOf(hex: string, patch: Partial<Canvas> = {}): Canvas {
  return { ...withPrimaryHex(DEFAULT_CANVAS, hex), ...patch };
}

function effectiveOf(canvas: Canvas, resolved: ResolvedAppearance) {
  return effectiveStopHexes(canvas, resolved).map(hexToOklch);
}

describe("the appearance transform", () => {
  it("holds the light band for colors that start far outside it", () => {
    const { min, max } = ARC_TUNING.lightBand;
    for (const hex of EXTREMES) {
      const [{ L }] = effectiveOf(canvasOf(hex, { vibrancy: 1 }), "light");
      expect(L).toBeGreaterThanOrEqual(min - HEX_DUST);
      expect(L).toBeLessThanOrEqual(max + HEX_DUST);
    }
  });

  it("holds the dark band, and never lands lighter than the light one", () => {
    const { min, max } = ARC_TUNING.darkBand;
    for (const hex of EXTREMES) {
      const canvas = canvasOf(hex, { vibrancy: 1 });
      const [dark] = effectiveOf(canvas, "dark");
      const [light] = effectiveOf(canvas, "light");
      expect(dark.L).toBeGreaterThanOrEqual(min - HEX_DUST);
      expect(dark.L).toBeLessThanOrEqual(max + HEX_DUST);
      expect(dark.L).toBeLessThan(light.L);
    }
  });

  it("collapses to a near-neutral wash at vibrancy 0", () => {
    for (const hex of EXTREMES) {
      const authored = hexToOklch(hex).C;
      for (const resolved of ["light", "dark"] as const) {
        const [{ C }] = effectiveOf(canvasOf(hex, { vibrancy: 0 }), resolved);
        // A fraction of what was authored, and — since sRGB's deepest chroma is
        // ~0.31 — under 0.05 for anything representable at all.
        expect(C).toBeLessThanOrEqual(authored * ARC_TUNING.chroma.floor + HEX_DUST);
        expect(C).toBeLessThan(0.05);
      }
    }
  });

  it("caps chroma per mode even when the seed is fully saturated", () => {
    for (const hex of EXTREMES) {
      const canvas = canvasOf(hex, { vibrancy: 1 });
      expect(effectiveOf(canvas, "light")[0].C).toBeLessThanOrEqual(
        ARC_TUNING.chroma.lightCap + HEX_DUST,
      );
      expect(effectiveOf(canvas, "dark")[0].C).toBeLessThanOrEqual(
        ARC_TUNING.chroma.darkCap + HEX_DUST,
      );
    }
  });

  it("clamps a vibrancy the guard would never have passed through", () => {
    // `parseCanvas` clamps, so this is belt and braces — but the caps are what
    // the whole safety story rests on and they must not depend on a caller.
    for (const resolved of ["light", "dark"] as const) {
      expect(effectiveOf(canvasOf("#ff0000", { vibrancy: 9 }), resolved)[0].C).toBeLessThanOrEqual(
        effectiveOf(canvasOf("#ff0000", { vibrancy: 1 }), resolved)[0].C + HEX_DUST,
      );
    }
  });
});

describe("the accent's chroma", () => {
  /** The shipped canvas's authored chroma — the one the accent has to be able to reach. */
  const EMBER = hexToOklch("#e8652a").C;

  it("reaches the authored chroma exactly at vibrancy 1, in a way the gradient's cannot", () => {
    // The defect this function exists to fix, stated as the two numbers side by
    // side: at full vibrancy the BACKGROUND still gives up 38% of ember's chroma
    // to `darkGain` and then meets `darkCap` at roughly half of it, which is
    // correct for a wall and wrong for a button. The accent tops out on the
    // authored color itself.
    expect(accentChroma(EMBER, 1)).toBeCloseTo(EMBER, 12);
    expect(effectiveChroma(EMBER, "dark", 1)).toBeLessThan(EMBER * 0.55);
    expect(effectiveChroma(EMBER, "light", 1)).toBeLessThan(EMBER);
  });

  it("still bottoms out on the same near-neutral floor the gradient does", () => {
    // Vibrancy stays in charge, which is the half of the old behavior that was
    // right: a wash with no color in it must not leave a saturated accent
    // stranded on top of it.
    for (const hex of EXTREMES) {
      const authored = hexToOklch(hex).C;
      expect(accentChroma(authored, 0)).toBeCloseTo(authored * ARC_TUNING.chroma.floor, 12);
    }
  });

  it("climbs with vibrancy and never overshoots what was authored", () => {
    // The achromatic pair is left out on purpose: it has no chroma to climb, so
    // it would only test that 0 stays 0 — which the floor case above already
    // says. Every hue that HAS a chroma has to spend it monotonically.
    for (const hex of ["#e8652a", "#ff0000", "#00ff00", "#0000ff"]) {
      const authored = hexToOklch(hex).C;
      let previous = -1;
      for (let vibrancy = 0; vibrancy <= 1.0001; vibrancy += 0.05) {
        const chroma = accentChroma(authored, vibrancy);
        expect(chroma).toBeGreaterThan(previous);
        expect(chroma).toBeLessThanOrEqual(authored + HEX_DUST);
        previous = chroma;
      }
    }
  });

  it("clamps a vibrancy from outside the unit range, exactly as the gradient's does", () => {
    // `parseCanvas` clamps, but this is also called with dial values mid-drag.
    expect(accentChroma(EMBER, -1)).toBe(accentChroma(EMBER, 0));
    expect(accentChroma(EMBER, 4)).toBe(accentChroma(EMBER, 1));
  });
});

describe("the base fill", () => {
  it("sits under the pool it is derived from, in both modes", () => {
    for (const hex of EXTREMES) {
      for (const resolved of ["light", "dark"] as const) {
        const canvas = canvasOf(hex);
        const base = hexToOklch(baseFillHex(canvas, resolved)).L;
        const pool = effectiveOf(canvas, resolved)[0].L;
        expect({ hex, resolved, under: base < pool }).toEqual({ hex, resolved, under: true });
      }
    }
  });
});

describe("the background value", () => {
  it("stacks grain, the other pools, the primary's pool, then the base fill", () => {
    const three = addStop(addStop(DEFAULT_CANVAS));
    const painted = canvasBackground(three, "dark");
    expect(painted.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(painted.match(/radial-gradient/g)).toHaveLength(three.stops.length);
    // The primary's is the widest ellipse and has to come last of the gradients,
    // or its pool would paint over every other stop.
    expect(painted.lastIndexOf(`ellipse ${ARC_TUNING.pool.primaryWidth}%`)).toBeGreaterThan(
      painted.lastIndexOf(`ellipse ${ARC_TUNING.pool.width}%`),
    );
    // Only the final layer of the shorthand may carry a color.
    expect(painted.endsWith(effectiveStopHexes(three, "dark")[three.primaryIndex])).toBe(false);
    expect(painted.endsWith(baseFillHex(three, "dark"))).toBe(true);
  });

  it("emits no noise layer at all when grain is off", () => {
    const painted = canvasBackground({ ...DEFAULT_CANVAS, grain: 0 }, "dark");
    expect(painted).not.toContain("url(");
    expect(grainLayer(0)).toBeNull();
    // The threshold, not merely zero: below it the layer is invisible, so
    // emitting one would be paying for a tile nobody can see.
    expect(grainLayer(ARC_TUNING.grain.threshold)).toBeNull();
  });

  it("bakes the amount into the tile rather than into an element opacity", () => {
    const layer = grainLayer(1) ?? "";
    // The whole canvas has to stay ONE property, so the slope is the only place
    // the amount can live.
    expect(decodeURIComponent(layer)).toContain(
      `slope="${ARC_TUNING.grain.alphaScale.toFixed(3)}"`,
    );
    expect(layer).toContain(`${ARC_TUNING.grain.tilePx}px ${ARC_TUNING.grain.tilePx}px repeat`);
    // Clamped, for the same reason the caps are: a stored 4 is a stale number,
    // not a request for four times the noise.
    expect(grainLayer(4)).toBe(layer);
  });
});
