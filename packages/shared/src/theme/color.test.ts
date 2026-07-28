import { APCAcontrast, sRGBtoY } from "apca-w3";
import { converter } from "culori";
import { describe, expect, it } from "vite-plus/test";

import {
  apcaLc,
  clamp,
  compositeHex,
  gamutMap,
  hexChannels,
  hexToOklch,
  hexToRgb,
  isHexColor,
  isInGamut,
  lerp,
  linearToSrgb,
  oklabToOklch,
  oklchToHex,
  oklchToOklab,
  rgbToHex,
  srgbToLinear,
} from "./color";

describe("clamp and lerp", () => {
  it("clamps to both bounds and passes anything already inside", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(4, 0, 1)).toBe(1);
    expect(clamp(0.25, 0, 1)).toBe(0.25);
  });

  it("interpolates, including backwards ranges", () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    // Backwards on purpose: several tuning ranges run high → low, so a lerp that
    // assumed an ordering would silently reverse half the tables.
    expect(lerp(0.55, 0.1, 1)).toBeCloseTo(0.1, 10);
  });
});

describe("hexChannels", () => {
  it("returns the three bytes the compositor works in", () => {
    expect(hexChannels("#e8652a")).toEqual([232, 101, 42]);
    expect(hexChannels("#000000")).toEqual([0, 0, 0]);
    expect(hexChannels("#ffffff")).toEqual([255, 255, 255]);
  });

  it("accepts everything hexToRgb does, and rejects what it rejects", () => {
    expect(hexChannels("#fa0")).toEqual(hexChannels("#ffaa00"));
    // The hand-rolled slice/parseInt copies this replaces answered NaN here and
    // poisoned whatever they were mixed into.
    expect(() => hexChannels("rebeccapurple")).toThrow(/rebeccapurple/);
  });
});

describe("compositeHex", () => {
  it("returns the under color at alpha 0 and the over color at alpha 1", () => {
    expect(compositeHex("#ffffff", 0, "#e8652a")).toBe("#e8652a");
    expect(compositeHex("#ffffff", 1, "#e8652a")).toBe("#ffffff");
  });

  it("mixes in 8-bit sRGB, because that is what the browser paints", () => {
    // A perceptual mix would predict a pixel the compositor never produces, and
    // every Lc measured against it would be measuring a surface that is not on
    // screen. Half of 0 and 255 is 128 in bytes, not the OKLCH midpoint.
    expect(compositeHex("#ffffff", 0.5, "#000000")).toBe("#808080");
  });

  it("clamps an alpha outside 0–1 rather than emitting a channel that cannot exist", () => {
    expect(compositeHex("#ffffff", 2, "#000000")).toBe("#ffffff");
    expect(compositeHex("#ffffff", -1, "#000000")).toBe("#000000");
  });
});

describe("hexToRgb", () => {
  it("parses #rrggbb into 0–1 channels", () => {
    expect(hexToRgb("#ffffff")).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("expands #rgb shorthand", () => {
    expect(hexToRgb("#f00")).toEqual(hexToRgb("#ff0000"));
    expect(hexToRgb("#abc")).toEqual(hexToRgb("#aabbcc"));
  });

  it("is case-insensitive", () => {
    expect(hexToRgb("#E8652A")).toEqual(hexToRgb("#e8652a"));
  });

  it("names the offending value when the input is not a hex color", () => {
    expect(() => hexToRgb("rebeccapurple")).toThrow(/rebeccapurple/);
    expect(() => hexToRgb("#ff00")).toThrow(/#rgb or #rrggbb/);
  });
});

describe("isHexColor", () => {
  it("accepts the same shapes as hexToRgb", () => {
    for (const hex of ["#e8652a", "e8652a", "#abc", "abc", "  #fff  "]) {
      expect(isHexColor(hex)).toBe(true);
    }
  });

  it("rejects anything hexToRgb would throw on", () => {
    for (const value of ["blue", "#ff00", "", " #00aa "]) {
      expect(isHexColor(value)).toBe(false);
    }
  });
});

describe("rgbToHex", () => {
  it("emits lowercase #rrggbb", () => {
    expect(rgbToHex({ r: 1, g: 1, b: 1 })).toBe("#ffffff");
    expect(rgbToHex({ r: 232 / 255, g: 101 / 255, b: 42 / 255 })).toBe("#e8652a");
  });

  it("round-trips every 8-bit grey", () => {
    for (let v = 0; v < 256; v += 1) {
      const hex = `#${v.toString(16).padStart(2, "0").repeat(3)}`;
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
    }
  });

  it("clamps channels that float just outside 0–1", () => {
    expect(rgbToHex({ r: -1e-9, g: 1 + 1e-9, b: 0.5 })).toBe("#00ff80");
  });
});

describe("sRGB transfer function", () => {
  it("pins the endpoints and the 0.5 midpoint", () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBe(1);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.2140411, 6);
  });

  it("uses the linear segment below the 0.04045 knee", () => {
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 12);
  });

  it("inverts exactly", () => {
    for (let v = 0; v <= 1.0001; v += 1 / 512) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 12);
    }
  });

  it("survives negative inputs without producing NaN", () => {
    expect(srgbToLinear(-0.2)).toBeCloseTo(-srgbToLinear(0.2), 12);
    expect(linearToSrgb(-0.2)).toBeCloseTo(-linearToSrgb(0.2), 12);
  });
});

/** A spread that exercises every hue sector, both poles, and pure primaries. */
const SAMPLE_HEXES = [
  "#000000",
  "#ffffff",
  "#808080",
  "#e8652a",
  "#ff0000",
  "#00ff00",
  "#0000ff",
  "#00ffff",
  "#ff00ff",
  "#ffff00",
  "#111111",
  "#e5484d",
  "#1b1412",
  "#9a9a9a",
  "#4a3227",
  "#123456",
  "#7f00ff",
  "#0d0d0d",
];

describe("OKLCH conversion", () => {
  const toOklch = converter("oklch");

  it("matches culori for a spread of colors", () => {
    for (const hex of SAMPLE_HEXES) {
      const ours = hexToOklch(hex);
      const theirs = toOklch(hex)!;
      // 7 decimals is ~1e-5 of an 8-bit step; the residual is culori
      // carrying more digits in its matrices, not a difference in method.
      expect(ours.L).toBeCloseTo(theirs.l, 7);
      expect(ours.C).toBeCloseTo(theirs.c, 7);
      // Hue is undefined for achromatic colors; culori reports it as
      // undefined, we report 0.
      if (ours.C > 1e-6) {
        expect(ours.h).toBeCloseTo(theirs.h ?? 0, 4);
      }
    }
  });

  it("round-trips hex → OKLCH → hex", () => {
    for (const hex of SAMPLE_HEXES) {
      const { L, C, h } = hexToOklch(hex);
      expect(oklchToHex(L, C, h)).toBe(hex);
    }
  });

  it("round-trips OKLab ⇄ OKLCH", () => {
    for (const hex of SAMPLE_HEXES) {
      const lch = hexToOklch(hex);
      const back = oklabToOklch(oklchToOklab(lch));
      expect(back.L).toBeCloseTo(lch.L, 12);
      expect(back.C).toBeCloseTo(lch.C, 12);
    }
  });
});

describe("gamutMap", () => {
  const toRgb = converter("rgb");

  it("leaves an in-gamut color untouched", () => {
    for (const hex of SAMPLE_HEXES) {
      const { L, C, h } = hexToOklch(hex);
      expect(gamutMap(L, C, h)).toEqual({ L, C, h });
    }
  });

  it("holds L and h exactly while reducing C", () => {
    // C 0.4 is outside sRGB at every hue for these lightnesses.
    for (let h = 0; h < 360; h += 7) {
      for (const L of [0.155, 0.3, 0.5, 0.661, 0.9]) {
        const mapped = gamutMap(L, 0.4, h);
        expect(mapped.L).toBe(L);
        expect(mapped.h).toBe(h);
        expect(mapped.C).toBeLessThan(0.4);
        expect(isInGamut(mapped.L, mapped.C, mapped.h)).toBe(true);
      }
    }
  });

  it("finds the same cusp chroma as a bisection over culori's converter", () => {
    // culori's own `clampChroma` is NOT a cusp finder — it accepts a clipped
    // color once the ΔE is small, and returns c = 0 outright at some hues.
    // The honest cross-check is the same bisection run against culori's
    // OKLCH → sRGB math, which is what this compares our cusp against.
    const inGamutPerCulori = (L: number, C: number, h: number) => {
      const { r, g, b } = toRgb({ mode: "oklch", l: L, c: C, h })!;
      // Same in-gamut tolerance the implementation uses, so what this
      // compares is the conversion math and not the choice of epsilon.
      return Math.min(r, g, b) >= -1e-5 && Math.max(r, g, b) <= 1 + 1e-5;
    };
    for (let h = 0; h < 360; h += 11) {
      for (const L of [0.155, 0.2, 0.45, 0.661, 0.85]) {
        let low = 0;
        let high = 0.4;
        for (let i = 0; i < 40; i += 1) {
          const mid = (low + high) / 2;
          if (inGamutPerCulori(L, mid, h)) low = mid;
          else high = mid;
        }
        expect(gamutMap(L, 0.4, h).C).toBeCloseTo(low, 4);
      }
    }
  });

  it("never RGB-clips: the emitted hex keeps L and h, only losing C", () => {
    // Clipping is the failure this exists to avoid — it drags hue and
    // lightness with it. Round-tripping a heavily-mapped color must land back
    // on the same L and h.
    const mapped = gamutMap(0.5, 0.4, 150);
    const back = hexToOklch(oklchToHex(mapped.L, mapped.C, mapped.h));
    expect(back.L).toBeCloseTo(0.5, 2);
    expect(back.h).toBeCloseTo(150, 0);
  });
});

/** 8-bit channel triple, the form apca-w3 takes. */
function toBytes(hex: string): [number, number, number] {
  const { r, g, b } = hexToRgb(hex);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * The same Lc computed by apca-w3 itself — the independent oracle. The design
 * doc is explicit that APCA must never be verified against the generator's
 * own math, so every floor in this file is checked against this.
 */
function referenceLc(text: string, background: string): number {
  return Math.abs(APCAcontrast(sRGBtoY(toBytes(text)), sRGBtoY(toBytes(background))));
}

describe("apcaLc", () => {
  it("reproduces APCA-W3 0.1.9's black/white extremes, both polarities", () => {
    // The two are NOT equal — APCA weights light-on-dark and dark-on-light
    // with different exponents, which is exactly why it is the right metric
    // for a dark theme and WCAG 2's symmetric ratio is not.
    expect(apcaLc("#ffffff", "#000000")).toBeCloseTo(107.88, 2);
    expect(apcaLc("#000000", "#ffffff")).toBeCloseTo(106.04, 2);
  });

  it("returns the magnitude, so both polarities are positive", () => {
    expect(apcaLc("#f5f5f5", "#111111")).toBeGreaterThan(0);
    expect(apcaLc("#111111", "#f5f5f5")).toBeGreaterThan(0);
  });

  it("returns 0 for a color on itself", () => {
    for (const hex of SAMPLE_HEXES) expect(apcaLc(hex, hex)).toBe(0);
  });

  it("matches apca-w3 across every pair in the spread", () => {
    for (const text of SAMPLE_HEXES) {
      for (const background of SAMPLE_HEXES) {
        expect(apcaLc(text, background)).toBeCloseTo(referenceLc(text, background), 9);
      }
    }
  });

  it("matches apca-w3 over a grey ramp on the app's own surfaces", () => {
    for (const background of ["#111111", "#0d0d0d", "#161616", "#e8652a"]) {
      for (let v = 0; v < 256; v += 1) {
        const text = `#${v.toString(16).padStart(2, "0").repeat(3)}`;
        expect(apcaLc(text, background)).toBeCloseTo(referenceLc(text, background), 9);
      }
    }
  });

  it("scores the two shipped tokens that sit below the body-copy floor", () => {
    expect(apcaLc("#9a9a9a", "#111111")).toBeCloseTo(47, 0);
    expect(apcaLc("#e8652a", "#111111")).toBeCloseTo(41, 0);
  });
});
