import { describe, expect, it } from "vite-plus/test";

import { hueFan, rampFromBackground } from "./chart-color";
import { hexToOklch } from "./color";

const EMBER = "#e8652a";
const DARK_PAPER = "#1a1210";
const LIGHT_PAPER = "#fbf7f4";
const STOPS = [0.12, 0.42, 0.72, 1];

describe("rampFromBackground", () => {
  it("returns one colour per stop", () => {
    expect(rampFromBackground(DARK_PAPER, EMBER, STOPS)).toHaveLength(STOPS.length);
  });

  it("ends on the primary itself", () => {
    const ramp = rampFromBackground(DARK_PAPER, EMBER, STOPS);
    const tip = hexToOklch(ramp[ramp.length - 1] ?? "");
    const primary = hexToOklch(EMBER);
    expect(tip.L).toBeCloseTo(primary.L, 2);
    expect(tip.C).toBeCloseTo(primary.C, 2);
    expect(tip.h).toBeCloseTo(primary.h, 1);
  });

  it("travels in the primary's hue", () => {
    const hue = hexToOklch(EMBER).h;
    // Within a few degrees, not to a decimal: every step round-trips through
    // 8-bit hex, and the lower a step's chroma the coarser that quantisation is
    // on its hue — a property of the colour, not of this ramp.
    for (const step of rampFromBackground(LIGHT_PAPER, EMBER, STOPS)) {
      expect(Math.abs(hexToOklch(step).h - hue)).toBeLessThan(4);
    }
  });

  it("climbs in lightness from a dark canvas, so a busy day is brighter than an empty one", () => {
    const ramp = rampFromBackground(DARK_PAPER, EMBER, STOPS).map((hex) => hexToOklch(hex).L);
    for (let index = 1; index < ramp.length; index += 1) {
      expect(ramp[index]!).toBeGreaterThan(ramp[index - 1]!);
    }
  });

  it("descends in lightness from light paper — one ramp, no per-mode branch", () => {
    const ramp = rampFromBackground(LIGHT_PAPER, EMBER, STOPS).map((hex) => hexToOklch(hex).L);
    for (let index = 1; index < ramp.length; index += 1) {
      expect(ramp[index]!).toBeLessThan(ramp[index - 1]!);
    }
  });

  it("gains chroma as it travels, so the coldest step is nearly the paper itself", () => {
    const ramp = rampFromBackground(LIGHT_PAPER, EMBER, STOPS).map((hex) => hexToOklch(hex).C);
    expect(ramp[0]!).toBeLessThan(ramp[ramp.length - 1]!);
  });

  it("answers nothing for no stops", () => {
    expect(rampFromBackground(DARK_PAPER, EMBER, [])).toEqual([]);
  });
});

describe("hueFan", () => {
  it("returns one colour per series member", () => {
    expect(hueFan(EMBER, 5, 70)).toHaveLength(5);
  });

  it("holds lightness and chroma so no member outranks another", () => {
    const primary = hexToOklch(EMBER);
    for (const hex of hueFan(EMBER, 5, 70)) {
      const member = hexToOklch(hex);
      expect(member.L).toBeCloseTo(primary.L, 1);
      expect(member.C).toBeCloseTo(primary.C, 1);
    }
  });

  it("spreads symmetrically around the primary's hue", () => {
    const hue = hexToOklch(EMBER).h;
    const fan = hueFan(EMBER, 5, 70).map((hex) => hexToOklch(hex).h);
    expect(fan[2]!).toBeCloseTo(hue, 0);
    expect(fan[0]!).toBeCloseTo(hue - 35, 0);
    expect(fan[4]!).toBeCloseTo(hue + 35, 0);
  });

  it("wraps hues that fan past 0°", () => {
    const fan = hueFan("#e8652a", 3, 200).map((hex) => hexToOklch(hex).h);
    for (const hue of fan) {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("gives a lone member the primary itself", () => {
    expect(hueFan(EMBER, 1, 70)).toEqual([hueFan(EMBER, 1, 10)[0]]);
    expect(hueFan(EMBER, 1, 70)).toHaveLength(1);
  });

  it("answers nothing for an empty series", () => {
    expect(hueFan(EMBER, 0, 70)).toEqual([]);
  });
});
