import { describe, expect, it } from "vite-plus/test";

import {
  SLIDER_SQUIGGLE_AMPLITUDE,
  SLIDER_SQUIGGLE_WAVELENGTH,
  sliderSquigglePath,
  sliderSquiggleScale,
} from "./slider-squiggle";

describe("the wave's geometry", () => {
  it("peaks at the amplitude it was asked for, not at the control point", () => {
    // A quadratic's midpoint takes HALF its control's offset, so the control
    // has to sit at 2×amplitude — the constant the path bakes in. Pin it via
    // the first segment's control coordinate.
    const path = sliderSquigglePath(24, SLIDER_SQUIGGLE_WAVELENGTH, SLIDER_SQUIGGLE_AMPLITUDE);
    expect(path).toBe("M 0 0 Q 3 4 6 0 T 12 0 T 18 0 T 24 0");
  });

  it("runs to the half-wave boundary at or past the width, never short of it", () => {
    // The seam clips the overshoot for free; an undershoot would leave the
    // last share bare. 20 / 6 half-waves → 4 segments ending at 24.
    const path = sliderSquigglePath(20, 12, 2);
    expect(path.endsWith("T 24 0")).toBe(true);
    // An exact multiple ends exactly on the width.
    expect(sliderSquigglePath(24, 12, 2).endsWith("T 24 0")).toBe(true);
  });

  it("covers a width narrower than one half-wave with the opening segment", () => {
    expect(sliderSquigglePath(4, 12, 2)).toBe("M 0 0 Q 3 4 6 0");
  });

  it("reads degenerate inputs as no wave rather than dividing by them", () => {
    expect(sliderSquigglePath(0, 12, 2)).toBe("");
    expect(sliderSquigglePath(176, 0, 2)).toBe("");
  });
});

describe("how much of the wave is standing", () => {
  it("is flat at zero vibrancy and full at one", () => {
    expect(sliderSquiggleScale(0)).toBe(0);
    expect(sliderSquiggleScale(1)).toBe(1);
    expect(sliderSquiggleScale(0.36)).toBe(0.36);
  });

  it("clamps, so a malformed canvas payload cannot invert the wave", () => {
    expect(sliderSquiggleScale(-3)).toBe(0);
    expect(sliderSquiggleScale(99)).toBe(1);
  });
});
