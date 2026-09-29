import { converter, wcagContrast as referenceContrast } from "culori";
import { describe, expect, it } from "vite-plus/test";

import { APCA_VECTORS } from "./apca-reference";
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
  wcagContrast,
} from "./color";

describe("WCAG sRGB contrast", () => {
  it("matches published extremes and the independent culori implementation", () => {
    expect(wcagContrast("#000", "#fff")).toBe(21);
    expect(wcagContrast("#fff", "#fff")).toBe(1);
    for (const foreground of ["#010a20", "#d37550", "#767676", "#00ff00", "#ffffff"]) {
      for (const background of ["#000000", "#ffffff", "#ead7c9"]) {
        expect(wcagContrast(foreground, background)).toBeCloseTo(
          referenceContrast(foreground, background),
          12,
        );
        expect(wcagContrast(background, foreground)).toBe(wcagContrast(foreground, background));
      }
    }
  });
});

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

/**
 * APCA-W3 0.1.9's constant set, transcribed here a SECOND time — deliberately
 * not imported from `color.ts`, which does not export them.
 *
 * This is the half of the verification that replaced the `apca-w3` package
 * (VC-412). That package was an independent implementation, and what it
 * actually caught was a transcription slip: a constant typed wrong, a norm
 * exponent applied to the wrong side of the polarity split. Double entry
 * catches the same class — the constants below and the formula in `lcWith`
 * were written from the published `sRGBcalc` formulation rather than copied
 * from the implementation, so agreeing with `apcaLc` over the whole 8-bit
 * grey ramp means two transcriptions agree, not that one function equals
 * itself.
 *
 * What it cannot catch is the two of them being wrong the same way, which is
 * why the frozen vectors in `apca-reference.ts` — captured while the oracle
 * was still installed and verified against it — sit underneath both, and why
 * the invariants below test properties rather than numbers.
 */
interface ApcaConstants {
  trc: number;
  redCoefficient: number;
  greenCoefficient: number;
  blueCoefficient: number;
  blackThreshold: number;
  blackClamp: number;
  normBackground: number;
  normText: number;
  reverseText: number;
  reverseBackground: number;
  scale: number;
  lowOffset: number;
  lowClip: number;
  deltaYMin: number;
}

const PUBLISHED_APCA: ApcaConstants = {
  trc: 2.4,
  redCoefficient: 0.2126729,
  greenCoefficient: 0.7151522,
  blueCoefficient: 0.072175,
  blackThreshold: 0.022,
  // APCA's own black-clamp exponent, which merely lands near √2.
  // oxlint-disable-next-line approx-constant
  blackClamp: 1.414,
  normBackground: 0.56,
  normText: 0.57,
  reverseText: 0.62,
  reverseBackground: 0.65,
  scale: 1.14,
  lowOffset: 0.027,
  lowClip: 0.1,
  deltaYMin: 0.0005,
};

/** Lc from an arbitrary constant set — the published one, or a perturbed one. */
function lcWith(k: ApcaConstants, textHex: string, backgroundHex: string): number {
  const screenY = (hex: string): number => {
    const { r, g, b } = hexToRgb(hex);
    return (
      k.redCoefficient * r ** k.trc +
      k.greenCoefficient * g ** k.trc +
      k.blueCoefficient * b ** k.trc
    );
  };
  const clampBlack = (y: number): number =>
    y > k.blackThreshold ? y : y + (k.blackThreshold - y) ** k.blackClamp;

  const textY = clampBlack(screenY(textHex));
  const backgroundY = clampBlack(screenY(backgroundHex));
  if (Math.abs(backgroundY - textY) < k.deltaYMin) return 0;

  if (backgroundY > textY) {
    const raw = (backgroundY ** k.normBackground - textY ** k.normText) * k.scale;
    return raw < k.lowClip ? 0 : (raw - k.lowOffset) * 100;
  }
  const raw = (backgroundY ** k.reverseBackground - textY ** k.reverseText) * k.scale;
  return raw > -k.lowClip ? 0 : -(raw + k.lowOffset) * 100;
}

/**
 * How far each constant is nudged in the pinning test below, and why it takes
 * that much to be seen.
 *
 * 0.1% is the floor for eleven of the fourteen: they scale a luminance or an
 * exponent that every vector passes through. `lowClip` only moves a
 * threshold, and the vectors either side of it are one 8-bit step apart, so it
 * takes 5% to push a pair across.
 *
 * `deltaYMin` needs 100×, and that is a fact about APCA rather than a weakness
 * in the table: it is an early-out for pairs whose luminances differ by almost
 * nothing, and every such pair is already clipped to 0 by `lowClip` a moment
 * later. Under ~0.05 the guard cannot change an answer, so no table of
 * measured outputs can pin it tighter. It is listed rather than skipped so
 * that a future formulation where it DOES matter is covered by this test the
 * day it lands.
 */
const PINNING_PERTURBATION: Record<keyof ApcaConstants, number> = {
  trc: 1.001,
  redCoefficient: 1.001,
  greenCoefficient: 1.001,
  blueCoefficient: 1.001,
  blackThreshold: 1.001,
  blackClamp: 1.001,
  normBackground: 1.001,
  normText: 1.001,
  reverseText: 1.001,
  reverseBackground: 1.001,
  scale: 1.001,
  lowOffset: 1.001,
  lowClip: 1.05,
  deltaYMin: 100,
};

/** The tolerance the frozen vectors are asserted at: they carry four decimals. */
const VECTOR_TOLERANCE = 5e-4;

/** Every 8-bit grey, as `#rrggbb`. */
const GREY_RAMP = Array.from(
  { length: 256 },
  (_, v) => `#${v.toString(16).padStart(2, "0").repeat(3)}`,
);

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

  it("reproduces every frozen reference vector", () => {
    // The table these are read from is the repository's own record of what
    // this function computed when it was last measured against APCA-W3
    // itself. Any edit to a constant moves several of them at once.
    for (const [text, background, lc] of APCA_VECTORS) {
      expect(apcaLc(text, background), `${text} on ${background}`).toBeCloseTo(lc, 3);
    }
  });

  it("agrees with a second transcription of the formula across every pair in the spread", () => {
    for (const text of SAMPLE_HEXES) {
      for (const background of SAMPLE_HEXES) {
        expect(apcaLc(text, background), `${text} on ${background}`).toBeCloseTo(
          lcWith(PUBLISHED_APCA, text, background),
          9,
        );
      }
    }
  });

  it("agrees with it over a grey ramp on the app's own surfaces", () => {
    for (const background of ["#111111", "#0d0d0d", "#161616", "#e8652a"]) {
      for (const text of GREY_RAMP) {
        expect(apcaLc(text, background), `${text} on ${background}`).toBeCloseTo(
          lcWith(PUBLISHED_APCA, text, background),
          9,
        );
      }
    }
  });

  it("has a reference table that pins every published constant", () => {
    // The test that keeps the table above honest. A frozen table is only worth
    // the constants it can catch moving, so each one is nudged in turn and the
    // table must reject the result — if it does not, the vectors have stopped
    // covering that constant's region and the table needs a pair that does.
    for (const name of Object.keys(PUBLISHED_APCA) as (keyof ApcaConstants)[]) {
      const mutated: ApcaConstants = {
        ...PUBLISHED_APCA,
        [name]: PUBLISHED_APCA[name] * PINNING_PERTURBATION[name],
      };
      const caught = APCA_VECTORS.filter(
        ([text, background, lc]) =>
          Math.abs(lcWith(mutated, text, background) - lc) > VECTOR_TOLERANCE,
      );
      expect(
        caught.length,
        `no reference vector notices ${name} moving by ${PINNING_PERTURBATION[name]}×`,
      ).toBeGreaterThan(0);
    }
  });

  it("scores the two shipped tokens that sit below the body-copy floor", () => {
    expect(apcaLc("#9a9a9a", "#111111")).toBeCloseTo(47, 0);
    expect(apcaLc("#e8652a", "#111111")).toBeCloseTo(41, 0);
  });
});

/**
 * The properties the rest of the theme engine is entitled to assume, asserted
 * as properties rather than as numbers.
 *
 * Vectors catch a constant that moved; these catch a function that stopped
 * behaving like a contrast metric at all — a WCAG ratio swapped in, a polarity
 * dropped, a clamp that introduces a discontinuity. `generate.ts` binary-
 * searches lightness against this function, so the shape of its output is not
 * a nicety: a non-monotone Lc would make that search return whatever rung it
 * happened to land on.
 */
describe("apcaLc's invariants", () => {
  /** The surfaces the app actually draws on, plus the two poles. */
  const BACKGROUNDS = [
    "#000000",
    "#0d0d0d",
    "#111111",
    "#1c1310",
    "#808080",
    "#e8652a",
    "#fdded2",
    "#ffffff",
  ];

  it("is finite, non-negative and never exceeds APCA's own ceiling", () => {
    for (const background of BACKGROUNDS) {
      for (const text of GREY_RAMP) {
        const lc = apcaLc(text, background);
        expect(Number.isFinite(lc), `${text} on ${background}`).toBe(true);
        expect(lc, `${text} on ${background}`).toBeGreaterThanOrEqual(0);
        // 107.8847 is white on black, the most any 8-bit pair can score.
        expect(lc, `${text} on ${background}`).toBeLessThanOrEqual(108);
      }
    }
  });

  it("falls to its vertex at the background and rises away from it on both sides", () => {
    // The V that `solveLightnessForContrast` bisects over. Asserted on the
    // real ramp rather than on the two bounds, because a solver only needs one
    // interior inversion to walk off in the wrong direction.
    for (const background of BACKGROUNDS) {
      const ramp = GREY_RAMP.map((text) => apcaLc(text, background));
      const vertex = ramp.indexOf(Math.min(...ramp));
      for (let i = 1; i < ramp.length; i += 1) {
        const where = `${GREY_RAMP[i]} on ${background}`;
        if (i <= vertex) expect(ramp[i]!, where).toBeLessThanOrEqual(ramp[i - 1]!);
        else expect(ramp[i]!, where).toBeGreaterThanOrEqual(ramp[i - 1]!);
      }
    }
  });

  it("reports small contrasts as none at all, never as a small number", () => {
    // APCA's low clip, and the reason every border floor in this codebase is
    // stated in ΔL instead: around each background sits a dead band that scores
    // a flat 0, and the first score outside it is ~7.5. A metric that started
    // returning 0.4 there would let a solver believe it was making progress.
    let smallestNonZero = Infinity;
    for (const background of BACKGROUNDS) {
      for (const text of GREY_RAMP) {
        const lc = apcaLc(text, background);
        if (lc > 0) smallestNonZero = Math.min(smallestNonZero, lc);
      }
    }
    expect(smallestNonZero).toBeGreaterThan(7);
  });

  it("moves smoothly: one 8-bit step never jumps the score", () => {
    // Continuity everywhere except across the dead band's edge, which is a
    // genuine cliff (0 → ~7.5) and is asserted as one above. Measured maximum
    // step between two adjacent greys that both score is 0.66.
    for (const background of BACKGROUNDS) {
      const ramp = GREY_RAMP.map((text) => apcaLc(text, background));
      for (let i = 1; i < ramp.length; i += 1) {
        if (ramp[i] === 0 || ramp[i - 1] === 0) continue;
        expect(Math.abs(ramp[i]! - ramp[i - 1]!), `${GREY_RAMP[i]} on ${background}`).toBeLessThan(
          1,
        );
      }
    }
  });

  it("weighs the channels the way a display does: green, then red, then blue", () => {
    // Not an APCA fact but a luminance one — the same ordering any correct
    // screen-luminance model has to produce. It is what rules out a metric
    // that lost its coefficients and started treating the channels alike.
    for (const background of ["#000000", "#ffffff"]) {
      const green = apcaLc("#00ff00", background);
      const red = apcaLc("#ff0000", background);
      const blue = apcaLc("#0000ff", background);
      if (background === "#000000") {
        // On black, more luminance means more contrast.
        expect(green).toBeGreaterThan(red);
        expect(red).toBeGreaterThan(blue);
      } else {
        // On white the order inverts, which is the same fact seen from above.
        expect(green).toBeLessThan(red);
        expect(red).toBeLessThan(blue);
      }
    }
  });

  it("stays asymmetric under polarity, unlike a WCAG ratio", () => {
    // Swapping text and background must NOT return the same number. This is
    // the single property that separates APCA from the contrast ratio it
    // replaced, and the reason a dark theme can be measured honestly.
    for (const [text, background] of [
      ["#ffffff", "#000000"],
      ["#e8e4e2", "#1c1310"],
      ["#9a9a9a", "#111111"],
    ]) {
      expect(apcaLc(text!, background!)).not.toBeCloseTo(apcaLc(background!, text!), 1);
    }
  });
});
