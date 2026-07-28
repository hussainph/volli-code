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
  arcBaseFillHex,
  arcCanvasBackground,
  arcInk,
  ARC_SETTLED,
  ARC_TUNING,
  MAX_STOPS,
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

/** A tuning range at a copy weight — `atWeight` in the module, restated. */
function at(range: { min: number; max: number }, t: number): number {
  return range.min + (range.max - range.min) * t;
}

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

describe("canvas ink ladder", () => {
  /** A surface list neither candidate ink can survive — see the degradation test. */
  const NO_ROOM = ["#000000", "#7f7f7f", "#ffffff"];

  it("slides each rung by the settled copy weight, per mode", () => {
    // What this replaced was a fixed 0.15 slide, which reached the card's three
    // tiers and nothing on the gradient at all. The weight is now a constant
    // again — but a per-mode one, read from the same table the card's floors
    // come from, so the sidebar out on the canvas and the paper beside it rank
    // their copy by one decision rather than two.
    //
    // Asserted as the ARITHMETIC the settled weight implies rather than as
    // hexes, so a retune of `mutedTowardBase` is caught here as a wrong slide
    // instead of as three unexplained colours.
    const { mutedTowardBase, labelTowardMuted } = ARC_TUNING.ink;
    for (const resolved of ["light", "dark"] as const) {
      const weight = ARC_SETTLED.textWeight[resolved];
      const state = canvasOf("#e8652a", { mode: resolved });
      const ink = arcInk(state, resolved);
      const head = hexToOklch(ink.ink).L;
      const base = hexToOklch(arcBaseFillHex(state, resolved)).L;
      const muted = at(mutedTowardBase, weight);
      const label = muted * at(labelTowardMuted, weight);
      expect({ resolved, L: hexToOklch(ink.inkMuted).L }).toEqual({
        resolved,
        L: expect.closeTo(head + (base - head) * muted, 2),
      });
      expect({ resolved, L: hexToOklch(ink.inkLabel).L }).toEqual({
        resolved,
        L: expect.closeTo(head + (base - head) * label, 2),
      });
    }
  });

  it("walks toward the canvas in both modes, so no rung can invert the flip", () => {
    for (const hex of EXTREMES) {
      for (const resolved of ["light", "dark"] as const) {
        const state = canvasOf(hex, { mode: resolved });
        const ink = arcInk(state, resolved);
        const base = hexToOklch(arcBaseFillHex(state, resolved)).L;
        const [head, label, muted] = [ink.ink, ink.inkLabel, ink.inkMuted].map(
          (candidate) => hexToOklch(candidate).L,
        );
        // Stated as a DISTANCE from the base fill rather than as "lighter" or
        // "darker", which is what makes one assertion cover both directions:
        // the ink is near-black over a pastel and near-white over a
        // near-black, and a ladder phrased in either direction would invert
        // the moment the flip did.
        expect(Math.abs(base - label)).toBeLessThanOrEqual(Math.abs(base - head) + HEX_DUST);
        expect(Math.abs(base - muted)).toBeLessThanOrEqual(Math.abs(base - label) + HEX_DUST);
        // …and the scores fall in the order the rungs are ranked in. The
        // tolerance is one 8-bit step of the slide, worth well under an Lc.
        expect(ink.labelLc).toBeLessThanOrEqual(ink.worstLc + 1);
        expect(ink.mutedLc).toBeLessThanOrEqual(ink.labelLc + 1);
      }
    }
  });

  it("keeps three distinct rungs in both modes, never two", () => {
    // Why `labelTowardMuted` never reaches 0: every rung is asked to move
    // toward the head, and a label arriving exactly ON it would leave the
    // sidebar with the two inks this ladder was built to replace. The settled
    // weights sit well inside that range, and this is what keeps a later one
    // from being pushed to its end.
    for (const resolved of ["light", "dark"] as const) {
      const ink = arcInk(canvasOf("#e8652a", { mode: resolved }), resolved);
      expect(new Set([ink.ink, ink.inkLabel, ink.inkMuted]).size).toBe(3);
    }
  });

  it("holds the bottom rung above its floor on every canvas that has room", () => {
    const { mutedFloor } = ARC_TUNING.ink;
    for (const hex of EXTREMES) {
      for (const resolved of ["light", "dark"] as const) {
        for (const vibrancy of [0, 1]) {
          const ink = arcInk(canvasOf(hex, { mode: resolved, vibrancy }), resolved);
          // "Above the floor, unless the HEAD was already under it" — the
          // second clause is the honest one, since a ladder cannot rank text
          // above an ink that is itself unreadable.
          expect(ink.mutedLc).toBeGreaterThanOrEqual(Math.min(ink.worstLc, mutedFloor) - 1);
        }
      }
    }
  });

  it("collapses to one rung rather than three unreadable ones when a canvas has no room", () => {
    // Reproduced as a hostile surface list rather than as a canvas, because
    // what strands the ladder is what the LIFT composited to and that belongs
    // to `surfaces.ts` — this module only ever receives the result.
    const ink = arcInk(canvasOf("#e8652a"), "light", NO_ROOM);
    expect(ink.worstLc).toBeLessThan(ARC_TUNING.ink.mutedFloor);
    // Flat: not inverted, not thrown, and not three rungs nobody can read.
    expect(ink.inkLabel).toBe(ink.ink);
    expect(ink.inkMuted).toBe(ink.ink);
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

  it("promotes without touching a single color, because the sets are rotation-closed", () => {
    for (const state of [addStop(DEFAULT_ARC_CANVAS), addStop(addStop(DEFAULT_ARC_CANVAS))]) {
      const promoted = withPrimaryIndex(state, state.stops.length - 1);
      expect(promoted.primaryIndex).toBe(state.stops.length - 1);
      // Every hue offset a family uses is present from ANY of its members, so
      // there is nothing to re-derive — and re-deriving would push each hex
      // back through the gamut map and quantise it a little flatter.
      expect(promoted.stops).toEqual(state.stops);
    }
  });

  it("round-trips a promotion losslessly — A→B→A is the state it started in", () => {
    const three = addStop(addStop(DEFAULT_ARC_CANVAS));
    expect(withPrimaryIndex(withPrimaryIndex(three, 2), 0)).toEqual(three);
  });

  it("takes its stop ceiling from the harmony table, so the two cannot disagree", () => {
    expect(MAX_STOPS).toBe(ARC_TUNING.harmony.length);
    // Every count the ceiling admits has a row to look up; the failure this
    // guards is an `undefined` row NaN-ing into `#NaNNaNNaN`.
    for (let count = 1; count <= MAX_STOPS; count += 1) {
      expect(ARC_TUNING.harmony[count - 1]).toHaveLength(count);
    }
  });

  it("adds and removes stops within bounds, keeping the primary's own color", () => {
    const maxStops = MAX_STOPS;
    const { newStop } = ARC_TUNING;
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

  it("normalizes every hex it accepts into the one form that paints", () => {
    for (const authored of ["e8652a", " #E8652A ", "#E8652A", "#e8652a"]) {
      const guarded = clampArcCanvasState({
        ...DEFAULT_ARC_CANVAS,
        stops: [{ hex: authored, x: 0.5, y: 0.5 }],
      });
      // `isHexColor` accepts all of these; CSS, the `===` against the swatch
      // presets, and the readout chips accept only the last.
      expect(guarded?.stops[0].hex).toBe("#e8652a");
    }
    // Shorthand expands rather than reaching CSS as a form the pad's orb style
    // and the chips print back differently.
    expect(
      clampArcCanvasState({ ...DEFAULT_ARC_CANVAS, stops: [{ hex: "#FA0", x: 0, y: 0 }] })?.stops[0]
        .hex,
    ).toBe("#ffaa00");
  });

  it("clamps ranges instead, because a stale number still says what was meant", () => {
    const clamped = clampArcCanvasState({
      ...DEFAULT_ARC_CANVAS,
      stops: [{ hex: "#e8652a", x: 1.4, y: -3 }],
      vibrancy: 4,
      grain: -1,
    });
    expect(clamped).toEqual({
      ...DEFAULT_ARC_CANVAS,
      stops: [{ hex: "#e8652a", x: 1, y: 0 }],
      vibrancy: 1,
      grain: 0,
    });
  });

  it("loads a canvas stored while the settled settings were still dials", () => {
    // The freeze's own compatibility clause. `localStorage` is full of entries
    // written when `lift`, `cardTint`, `surfaceSpread`, `textWeight`, `shadow`
    // and `seam` were fields on this shape, and every one of them now names a
    // decision that is no longer the user's to state.
    //
    // So they are IGNORED rather than read or rejected. Reading them would
    // resurrect a tuning pass that has already been settled; rejecting the
    // entry would throw away the gradient the owner actually authored, which is
    // the only part of it that was ever his. What comes back is the canvas, at
    // the settled everything-else.
    const stored = {
      ...DEFAULT_ARC_CANVAS,
      lift: 0.55,
      cardTint: 0.05,
      surfaceSpread: 0.5,
      textWeight: 0.5,
      shadow: 0.6,
      seam: "continuous",
    };
    expect(clampArcCanvasState(stored)).toEqual(DEFAULT_ARC_CANVAS);
    // …including an entry whose extra fields are junk. They are not read, so
    // they cannot fail a guard either.
    expect(clampArcCanvasState({ ...DEFAULT_ARC_CANVAS, lift: "frosted", seam: 7 })).toEqual(
      DEFAULT_ARC_CANVAS,
    );
  });
});
