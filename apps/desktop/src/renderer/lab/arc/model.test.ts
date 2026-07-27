/**
 * What the canvas math has to keep true no matter what is authored.
 *
 * The bands and the caps are the interesting cases, so the inputs here are
 * deliberately hostile — pure black, pure white, and the three sRGB primaries,
 * which sit at the chroma extremes where a formula that merely looks right on
 * ember stops holding. `ARC_TUNING` is read for the BOUNDS being asserted and
 * never for the expected values: a test that recomputes the implementation
 * would pass for the wrong reason.
 */
import { hexToOklch } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  addStop,
  arcCanvasBackground,
  arcInk,
  ARC_TUNING,
  clampArcCanvasState,
  DEFAULT_ARC_CANVAS,
  effectiveStopHexes,
  removeStop,
  resolveArcMode,
  withPrimaryHex,
  withPrimaryIndex,
  type ArcCanvasState,
} from "./model";

/** Every effective color makes a hex round trip, which costs up to ~0.0015 of L or C. */
const HEX_DUST = 0.002;

const EXTREMES = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff"];

/** A one-stop canvas on `hex`, with everything else at the defaults. */
function canvasOf(hex: string, patch: Partial<ArcCanvasState> = {}): ArcCanvasState {
  return { ...withPrimaryHex(DEFAULT_ARC_CANVAS, hex), ...patch };
}

function effectiveOf(state: ArcCanvasState, resolved: "light" | "dark") {
  return effectiveStopHexes(state, resolved).map(hexToOklch);
}

describe("mode transform", () => {
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
      const state = canvasOf(hex, { vibrancy: 1 });
      const [dark] = effectiveOf(state, "dark");
      const [light] = effectiveOf(state, "light");
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
      const state = canvasOf(hex, { vibrancy: 1 });
      expect(effectiveOf(state, "light")[0].C).toBeLessThanOrEqual(
        ARC_TUNING.chroma.lightCap + HEX_DUST,
      );
      expect(effectiveOf(state, "dark")[0].C).toBeLessThanOrEqual(
        ARC_TUNING.chroma.darkCap + HEX_DUST,
      );
    }
  });

  it("answers auto from the system, and leaves an explicit mode alone", () => {
    expect(resolveArcMode("auto", true)).toBe("dark");
    expect(resolveArcMode("auto", false)).toBe("light");
    expect(resolveArcMode("light", true)).toBe("light");
    expect(resolveArcMode("dark", false)).toBe("dark");
  });
});

describe("foreground flip", () => {
  it("flips polarity with the canvas, not with the authored color", () => {
    // One seed, both modes: the same authored hex has to end up with opposite
    // inks, which is the whole claim the two-candidate scheme rests on.
    const pastel = canvasOf("#f2ede4");
    const onLight = arcInk(pastel, "light");
    const onDark = arcInk(pastel, "dark");
    expect(hexToOklch(onLight.ink).L).toBeLessThan(0.4);
    expect(hexToOklch(onDark.ink).L).toBeGreaterThan(0.9);
    expect(onLight.worstLc).toBeGreaterThan(60);
    expect(onDark.worstLc).toBeGreaterThan(60);
  });

  it("clears the app's dark canvas comfortably on the shipped default", () => {
    const ink = arcInk(DEFAULT_ARC_CANVAS, "dark");
    expect(ink.worstLc).toBeGreaterThanOrEqual(60);
    expect(ink.worstLc).toBe(Math.max(ink.lightLc, ink.darkLc));
  });

  it("scores the worst pool, so a hostile stop can only ever lower the number", () => {
    const single = canvasOf("#ffffff", { vibrancy: 1 });
    const hostile: ArcCanvasState = {
      ...single,
      // Authored directly rather than through addStop: the point is a pool the
      // harmony would never produce, sitting under the same ink.
      stops: [single.stops[0], { hex: "#6f6f6f", x: 0.2, y: 0.8 }],
    };
    expect(arcInk(hostile, "light").worstLc).toBeLessThanOrEqual(arcInk(single, "light").worstLc);
  });
});

describe("harmony", () => {
  it("rotates every other stop by its offset and keeps the family's lightness", () => {
    const three = addStop(addStop(DEFAULT_ARC_CANVAS));
    const primary = hexToOklch(three.stops[three.primaryIndex].hex);
    const offsets = ARC_TUNING.harmony[2];
    three.stops.forEach((stop, index) => {
      const { L, h } = hexToOklch(stop.hex);
      const expected = (primary.h + offsets[index]) % 360;
      // Sub-degree drift is the hex round trip plus the gamut map giving up
      // chroma at hues sRGB cannot reach.
      expect(Math.abs(h - expected)).toBeLessThan(1);
      expect(L).toBeCloseTo(primary.L, 2);
    });
  });

  it("re-derives around a promoted stop without recoloring it", () => {
    const two = addStop(DEFAULT_ARC_CANVAS);
    const promoted = withPrimaryIndex(two, 1);
    expect(promoted.primaryIndex).toBe(1);
    expect(promoted.stops[1].hex).toBe(two.stops[1].hex);
    expect(promoted.stops[0].hex).not.toBe(two.stops[0].hex);
    // Positions are the one thing the user placed by hand — harmony never moves them.
    expect(promoted.stops.map((stop) => stop.x)).toEqual(two.stops.map((stop) => stop.x));
  });

  it("adds and removes stops within bounds, keeping the primary's own color", () => {
    const { maxStops, newStop } = ARC_TUNING;
    let state = DEFAULT_ARC_CANVAS;
    for (let i = 0; i < maxStops + 2; i += 1) state = addStop(state);
    expect(state.stops).toHaveLength(maxStops);
    expect(state.stops[state.primaryIndex].hex).toBe(DEFAULT_ARC_CANVAS.stops[0].hex);
    for (const stop of state.stops.slice(1)) {
      expect(stop.x).toBeGreaterThanOrEqual(newStop.min);
      expect(stop.x).toBeLessThanOrEqual(newStop.max);
      expect(stop.y).toBeGreaterThanOrEqual(newStop.min);
      expect(stop.y).toBeLessThanOrEqual(newStop.max);
    }

    const promoted = withPrimaryIndex(state, maxStops - 1);
    const shrunk = removeStop(promoted);
    // The primary was the last stop, so removal had to drop the one below it
    // and walk the index back rather than take the family's own color away.
    expect(shrunk.stops).toHaveLength(maxStops - 1);
    expect(shrunk.stops[shrunk.primaryIndex].hex).toBe(promoted.stops[promoted.primaryIndex].hex);

    let floor = shrunk;
    for (let i = 0; i < maxStops + 2; i += 1) floor = removeStop(floor);
    expect(floor.stops).toHaveLength(1);
  });
});

describe("background", () => {
  it("stacks grain, the other pools, the primary's pool, then the base fill", () => {
    const three = addStop(addStop(DEFAULT_ARC_CANVAS));
    const painted = arcCanvasBackground(three, "dark");
    expect(painted.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(painted.match(/radial-gradient/g)).toHaveLength(three.stops.length);
    // The primary's is the widest ellipse and has to come last of the gradients,
    // or its pool would paint over every other stop.
    expect(painted.lastIndexOf(`ellipse ${ARC_TUNING.pool.primaryWidth}%`)).toBeGreaterThan(
      painted.lastIndexOf(`ellipse ${ARC_TUNING.pool.width}%`),
    );
    // Only the final layer of the shorthand may carry a color.
    expect(painted.endsWith(effectiveStopHexes(three, "dark")[three.primaryIndex])).toBe(false);
    expect(/,\s*#[0-9a-f]{6}$/.test(painted)).toBe(true);
  });

  it("emits no noise layer at all when grain is off", () => {
    const painted = arcCanvasBackground({ ...DEFAULT_ARC_CANVAS, grain: 0 }, "dark");
    expect(painted).not.toContain("url(");
  });
});

describe("clampArcCanvasState", () => {
  it("round-trips a canvas it can paint", () => {
    expect(clampArcCanvasState(JSON.parse(JSON.stringify(DEFAULT_ARC_CANVAS)))).toEqual(
      DEFAULT_ARC_CANVAS,
    );
  });

  it("rejects anything whose shape leaves a question open", () => {
    const valid = DEFAULT_ARC_CANVAS;
    const junk: unknown[] = [
      null,
      undefined,
      "#e8652a",
      [],
      {},
      { ...valid, stops: [] },
      { ...valid, stops: [...valid.stops, ...valid.stops, ...valid.stops, ...valid.stops] },
      { ...valid, stops: [{ hex: "not-a-color", x: 0.5, y: 0.5 }] },
      { ...valid, stops: [{ hex: "#e8652a", x: "0.5", y: 0.5 }] },
      { ...valid, stops: [{ hex: "#e8652a", x: Number.NaN, y: 0.5 }] },
      { ...valid, mode: "sepia" },
      { ...valid, primaryIndex: 1 },
      { ...valid, primaryIndex: 0.5 },
      { ...valid, vibrancy: "loud" },
    ];
    for (const value of junk) expect(clampArcCanvasState(value)).toBeNull();
  });

  it("clamps ranges instead, because a stale number still says what was meant", () => {
    const clamped = clampArcCanvasState({
      ...DEFAULT_ARC_CANVAS,
      stops: [{ hex: "#e8652a", x: 1.4, y: -3 }],
      vibrancy: 4,
      grain: -1,
    });
    expect(clamped).toEqual({
      stops: [{ hex: "#e8652a", x: 1, y: 0 }],
      primaryIndex: 0,
      mode: "auto",
      vibrancy: 1,
      grain: 0,
    });
  });
});
