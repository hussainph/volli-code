import { describe, expect, it } from "vite-plus/test";

import {
  SLIDER_SQUIGGLE_AMPLITUDE,
  SLIDER_SQUIGGLE_FLOOR,
  SLIDER_SQUIGGLE_WAVELENGTH,
  SLIDER_SQUIGGLE_WIDTH,
  SLIDER_THUMB_WIDTH,
  sliderSeam,
  sliderSquigglePath,
  sliderSquiggleScale,
} from "./slider-squiggle";

describe("the wave's geometry", () => {
  it("peaks at the amplitude it was asked for, not at the control point", () => {
    // A quadratic's midpoint takes HALF its control's offset, so the control
    // has to sit at 2×amplitude — the constant the path bakes in. Pin it via
    // the first segment's control coordinate.
    const path = sliderSquigglePath(24, SLIDER_SQUIGGLE_WAVELENGTH, SLIDER_SQUIGGLE_AMPLITUDE);
    expect(path).toBe("M 0 0 Q 18 10 36 0");
  });

  it("runs to the half-wave boundary at or past the width, never short of it", () => {
    // The trough clips the overshoot for free; an undershoot would leave the
    // far end of the groove bare. 20 / 6 half-waves → 4 segments ending at 24.
    expect(sliderSquigglePath(20, 12, 2).endsWith("T 24 0")).toBe(true);
    // An exact multiple ends exactly on the width.
    expect(sliderSquigglePath(24, 12, 2).endsWith("T 24 0")).toBe(true);
  });

  it("covers a width narrower than one half-wave with the opening segment", () => {
    expect(sliderSquigglePath(4, 12, 2)).toBe("M 0 0 Q 3 4 6 0");
  });

  it("reads degenerate inputs as no wave rather than dividing by them", () => {
    expect(sliderSquigglePath(0, 12, 2)).toBe("");
    expect(sliderSquigglePath(SLIDER_SQUIGGLE_WIDTH, 0, 2)).toBe("");
  });

  it("lays a handful of relaxed cycles across the fader, not the pill's ~15", () => {
    // The regression the redesign exists to prevent: inheriting the effort
    // pill's 12px wavelength put a crest every 6px on a 176px track, which
    // read as noise rather than as a wave.
    const cycles = SLIDER_SQUIGGLE_WIDTH / SLIDER_SQUIGGLE_WAVELENGTH;
    expect(cycles).toBeGreaterThan(4);
    expect(cycles).toBeLessThan(7);
  });
});

describe("how much of the wave is standing", () => {
  it("rests at the floor rather than flat, so the control keeps its shape at 0", () => {
    expect(sliderSquiggleScale(0)).toBe(SLIDER_SQUIGGLE_FLOOR);
    expect(SLIDER_SQUIGGLE_FLOOR).toBeGreaterThan(0);
  });

  it("stands full at the top of the range and climbs linearly between", () => {
    expect(sliderSquiggleScale(1)).toBeCloseTo(1);
    expect(sliderSquiggleScale(0.5)).toBeCloseTo(
      SLIDER_SQUIGGLE_FLOOR + (1 - SLIDER_SQUIGGLE_FLOOR) / 2,
    );
  });

  it("clamps, so a malformed canvas payload cannot invert the wave", () => {
    expect(sliderSquiggleScale(-3)).toBe(SLIDER_SQUIGGLE_FLOOR);
    expect(sliderSquiggleScale(99)).toBeCloseTo(1);
  });
});

describe("where the fill ends and the thumb sits", () => {
  it("insets the travel by half a thumb at each end, so the capsule stays in the trough", () => {
    expect(sliderSeam(0, SLIDER_SQUIGGLE_WIDTH, SLIDER_THUMB_WIDTH)).toBe(SLIDER_THUMB_WIDTH / 2);
    expect(sliderSeam(1, SLIDER_SQUIGGLE_WIDTH, SLIDER_THUMB_WIDTH)).toBe(
      SLIDER_SQUIGGLE_WIDTH - SLIDER_THUMB_WIDTH / 2,
    );
  });

  it("puts the midpoint at the fader's centre", () => {
    expect(sliderSeam(0.5, SLIDER_SQUIGGLE_WIDTH, SLIDER_THUMB_WIDTH)).toBe(
      SLIDER_SQUIGGLE_WIDTH / 2,
    );
  });

  it("clamps with the wave, so seam and amplitude never disagree", () => {
    expect(sliderSeam(-1, SLIDER_SQUIGGLE_WIDTH, SLIDER_THUMB_WIDTH)).toBe(SLIDER_THUMB_WIDTH / 2);
    expect(sliderSeam(9, SLIDER_SQUIGGLE_WIDTH, SLIDER_THUMB_WIDTH)).toBe(
      SLIDER_SQUIGGLE_WIDTH - SLIDER_THUMB_WIDTH / 2,
    );
  });

  it("gives a fader narrower than its own thumb no travel rather than negative travel", () => {
    expect(sliderSeam(1, 10, SLIDER_THUMB_WIDTH)).toBe(SLIDER_THUMB_WIDTH / 2);
  });
});
