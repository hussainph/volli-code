/**
 * The storage boundary, and the appearance resolver beside it — the two places
 * a value from outside this package becomes something it will paint.
 */
import { describe, expect, it } from "vite-plus/test";

import { isAppearance, resolveAppearance } from "./appearance";
import { DEFAULT_CANVAS, parseCanvas } from "./parse";

describe("parseCanvas", () => {
  it("round-trips a canvas it can paint", () => {
    expect(parseCanvas(JSON.parse(JSON.stringify(DEFAULT_CANVAS)))).toEqual(DEFAULT_CANVAS);
  });

  it("rejects anything whose shape leaves a question open", () => {
    const valid = DEFAULT_CANVAS;
    const junk: unknown[] = [
      null,
      undefined,
      "#e8652a",
      [],
      {},
      { ...valid, stops: [] },
      { ...valid, stops: [...valid.stops, ...valid.stops, ...valid.stops, ...valid.stops] },
      { ...valid, stops: [7] },
      { ...valid, stops: [null] },
      { ...valid, stops: [{ x: 0.5, y: 0.5 }] },
      { ...valid, stops: [{ hex: "not-a-color", x: 0.5, y: 0.5 }] },
      { ...valid, stops: [{ hex: "#e8652a", x: "0.5", y: 0.5 }] },
      { ...valid, stops: [{ hex: "#e8652a", x: 0.5, y: Number.NaN }] },
      { ...valid, primaryIndex: 1 },
      { ...valid, primaryIndex: -1 },
      { ...valid, primaryIndex: 0.5 },
      { ...valid, primaryIndex: "0" },
      { ...valid, vibrancy: "loud" },
      { ...valid, grain: "heavy" },
    ];
    for (const value of junk) expect(parseCanvas(value)).toBeNull();
  });

  it("normalizes every hex it accepts into the one form that paints", () => {
    for (const authored of ["e8652a", " #E8652A ", "#E8652A", "#e8652a"]) {
      const guarded = parseCanvas({
        ...DEFAULT_CANVAS,
        stops: [{ hex: authored, x: 0.5, y: 0.5 }],
      });
      // `isHexColor` accepts all of these; CSS, an editor's `===` against its
      // swatch presets, and a readout chip accept only the last.
      expect(guarded?.stops[0].hex).toBe("#e8652a");
    }
    // Shorthand expands rather than reaching CSS as a form an orb's style and a
    // chip print back differently.
    expect(
      parseCanvas({ ...DEFAULT_CANVAS, stops: [{ hex: "#FA0", x: 0, y: 0 }] })?.stops[0].hex,
    ).toBe("#ffaa00");
  });

  it("clamps ranges instead, because a stale number still says what was meant", () => {
    expect(
      parseCanvas({
        ...DEFAULT_CANVAS,
        stops: [{ hex: "#e8652a", x: 1.4, y: -3 }],
        vibrancy: 4,
        grain: -1,
      }),
    ).toEqual({
      ...DEFAULT_CANVAS,
      stops: [{ hex: "#e8652a", x: 1, y: 0 }],
      vibrancy: 1,
      grain: 0,
    });
  });

  it("loads a canvas stored while the settled settings were still dials", () => {
    // The freeze's compatibility clause, and the port's. Stored entries carry
    // `lift`, `cardTint`, `surfaceSpread`, `textWeight` and `shadow` from when
    // they were dials, and `mode` from when appearance rode along on the canvas.
    // Every one of them now names a decision this shape does not carry.
    //
    // So they are IGNORED rather than read or rejected. Reading them would
    // resurrect a tuning pass that has already been settled; rejecting the entry
    // would throw away the gradient that was actually authored, which is the only
    // part of it that was ever the user's.
    const stored = {
      ...DEFAULT_CANVAS,
      mode: "dark",
      lift: 0.55,
      cardTint: 0.05,
      surfaceSpread: 0.5,
      textWeight: 0.5,
      shadow: 0.6,
      seam: "continuous",
    };
    expect(parseCanvas(stored)).toEqual(DEFAULT_CANVAS);
    // …including an entry whose extra fields are junk. They are not read, so
    // they cannot fail a guard either — and `mode: "sepia"`, which the lab's
    // guard rejected outright, is now simply not this type's business.
    expect(parseCanvas({ ...DEFAULT_CANVAS, mode: "sepia", lift: "frosted", seam: 7 })).toEqual(
      DEFAULT_CANVAS,
    );
  });
});

describe("resolveAppearance", () => {
  it("answers auto from the system, and leaves an explicit choice alone", () => {
    expect(resolveAppearance("auto", true)).toBe("dark");
    expect(resolveAppearance("auto", false)).toBe("light");
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
  });
});

describe("isAppearance", () => {
  it("admits the three words migration 014's CHECK admits", () => {
    expect(isAppearance("light")).toBe(true);
    expect(isAppearance("dark")).toBe(true);
    expect(isAppearance("auto")).toBe(true);
  });

  it("rejects anything else that could be sitting in a column", () => {
    for (const junk of [null, undefined, "", "Light", "system", 0, {}, ["auto"]]) {
      expect(isAppearance(junk)).toBe(false);
    }
  });
});
