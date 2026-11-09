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

import { baseFillHex, canvasBackground, effectiveStopHexes, grainLayer } from "./gradient";
import { DEFAULT_CANVAS } from "./parse";
import { ARC_TUNING } from "./tuning";

// Peak pixels use the same alpha as the CSS; hostile stored vibrancy is bounded.
describe("authored mesh", () => {
  it("keeps authored hues and measured footprints in both appearances", () => {
    for (const mode of ["light", "dark"] as const) {
      const value = canvasBackground({ ...DEFAULT_CANVAS, grain: 0 }, mode);
      expect(value).toContain("radial-gradient(62% 70% at 12.0% 8.0%");
      expect(value).toContain("radial-gradient(58% 70% at 88.0% 38.0%");
      expect(value).toContain("radial-gradient(70% 62% at 30.0% 100.0%");
      expect(value).toContain(`#e8652a ${mode === "light" ? "62.0" : "58.0"}%`);
      expect(value).toContain("transparent 74%");
      expect(value.endsWith(baseFillHex(DEFAULT_CANVAS, mode))).toBe(true);
      expect(canvasBackground({ ...DEFAULT_CANVAS, grain: 0 }, mode, false)).not.toContain(
        baseFillHex(DEFAULT_CANVAS, mode),
      );
      expect(effectiveStopHexes({ ...DEFAULT_CANVAS, vibrancy: 0 }, mode)).toEqual(
        Array(3).fill(baseFillHex(DEFAULT_CANVAS, mode)),
      );
      expect(canvasBackground({ ...DEFAULT_CANVAS, vibrancy: -1 }, mode)).toBe(
        canvasBackground({ ...DEFAULT_CANVAS, vibrancy: 0 }, mode),
      );
      expect(canvasBackground({ ...DEFAULT_CANVAS, vibrancy: 9 }, mode)).toBe(
        canvasBackground({ ...DEFAULT_CANVAS, vibrancy: 1 }, mode),
      );
    }
  });
  it("does not turn dark ember brown or near-black", () => {
    expect(baseFillHex(DEFAULT_CANVAS, "dark")).toBe("#45291e");
    expect(effectiveStopHexes(DEFAULT_CANVAS, "dark")[0]).toBe("#a44c25");
  });
});

describe("the background value", () => {
  it("stacks grain then authored pools and the base", () => {
    const painted = canvasBackground(DEFAULT_CANVAS, "dark");
    expect(painted.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(painted.match(/radial-gradient/g)).toHaveLength(3);
    expect(painted.indexOf("#e8652a")).toBeLessThan(painted.indexOf("#e0457b"));
    expect(painted.endsWith(baseFillHex(DEFAULT_CANVAS, "dark"))).toBe(true);
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
