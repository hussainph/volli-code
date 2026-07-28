/**
 * The on-canvas foreground: that it flips with the canvas rather than with the
 * authored color, that it is scored on the WORST surface rather than the average
 * one, and that the ladder under it degrades by getting shorter instead of by
 * getting unreadable.
 */
import { describe, expect, it } from "vite-plus/test";

import { hexToOklch } from "../color";
import { withPrimaryHex } from "./edit";
import { baseFillHex } from "./gradient";
import { canvasInk, maxReadableSlide, worstContrast } from "./ink";
import { DEFAULT_CANVAS } from "./parse";
import { ARC_SETTLED } from "./settled";
import { ARC_TUNING } from "./tuning";
import type { Canvas } from "./types";

const HEX_DUST = 0.002;

const EXTREMES = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff"];

/** A tuning range at a copy weight — `atWeight` in the module, restated. */
function at(range: { min: number; max: number }, t: number): number {
  return range.min + (range.max - range.min) * t;
}

function canvasOf(hex: string, patch: Partial<Canvas> = {}): Canvas {
  return { ...withPrimaryHex(DEFAULT_CANVAS, hex), ...patch };
}

describe("the foreground flip", () => {
  it("flips polarity with the canvas, not with the authored color", () => {
    // One seed, both modes: the same authored hex has to end up with opposite
    // inks, which is the whole claim the two-candidate scheme rests on.
    const pastel = canvasOf("#f2ede4");
    const onLight = canvasInk(pastel, "light");
    const onDark = canvasInk(pastel, "dark");
    expect(hexToOklch(onLight.ink).L).toBeLessThan(0.4);
    expect(hexToOklch(onDark.ink).L).toBeGreaterThan(0.9);
    expect(onLight.worstLc).toBeGreaterThan(60);
    expect(onDark.worstLc).toBeGreaterThan(60);
  });

  it("clears the app's dark canvas comfortably on the shipped default", () => {
    const ink = canvasInk(DEFAULT_CANVAS, "dark");
    expect(ink.worstLc).toBeGreaterThanOrEqual(60);
    expect(ink.worstLc).toBe(Math.max(ink.lightLc, ink.darkLc));
  });

  it("scores the worst pool, so a hostile stop can only ever lower the number", () => {
    const single = canvasOf("#ffffff", { vibrancy: 1 });
    const hostile: Canvas = {
      ...single,
      // Authored directly rather than through addStop: the point is a pool the
      // harmony would never produce, sitting under the same ink.
      stops: [single.stops[0], { hex: "#6f6f6f", x: 0.2, y: 0.8 }],
    };
    expect(canvasInk(hostile, "light").worstLc).toBeLessThanOrEqual(
      canvasInk(single, "light").worstLc,
    );
  });

  it("takes the minimum across surfaces, never the mean", () => {
    // Stated on the primitive as well as on the result, because this is the one
    // decision the whole module rests on: an average would happily pick an ink
    // that is unreadable over one pool because it is excellent over two others.
    expect(worstContrast("#ffffff", ["#000000", "#ffffff"])).toBe(0);
    expect(worstContrast("#ffffff", ["#000000"])).toBeGreaterThan(90);
  });
});

describe("the canvas ink ladder", () => {
  /** A surface list neither candidate ink can survive — see the degradation test. */
  const NO_ROOM = ["#000000", "#7f7f7f", "#ffffff"];

  it("slides each rung by the settled copy weight, per mode", () => {
    // Asserted as the ARITHMETIC the settled weight implies rather than as
    // hexes, so a retune of `mutedTowardBase` is caught here as a wrong slide
    // instead of as three unexplained colours.
    const { mutedTowardBase, labelTowardMuted } = ARC_TUNING.ink;
    for (const resolved of ["light", "dark"] as const) {
      const weight = ARC_SETTLED.textWeight[resolved];
      const canvas = canvasOf("#e8652a");
      const ink = canvasInk(canvas, resolved);
      const head = hexToOklch(ink.ink).L;
      const base = hexToOklch(baseFillHex(canvas, resolved)).L;
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
        const canvas = canvasOf(hex);
        const ink = canvasInk(canvas, resolved);
        const base = hexToOklch(baseFillHex(canvas, resolved)).L;
        const [head, label, muted] = [ink.ink, ink.inkLabel, ink.inkMuted].map(
          (candidate) => hexToOklch(candidate).L,
        );
        // Stated as a DISTANCE from the base fill rather than as "lighter" or
        // "darker", which is what makes one assertion cover both directions: the
        // ink is near-black over a pastel and near-white over a near-black, and
        // a ladder phrased in either direction would invert the moment the flip
        // did.
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
    // Why `labelTowardMuted` never reaches 0: every rung is asked to move toward
    // the head, and a label arriving exactly ON it would leave the sidebar with
    // the two inks this ladder was built to replace.
    for (const resolved of ["light", "dark"] as const) {
      const ink = canvasInk(canvasOf("#e8652a"), resolved);
      expect(new Set([ink.ink, ink.inkLabel, ink.inkMuted]).size).toBe(3);
    }
  });

  it("holds the bottom rung above its floor on every canvas that has room", () => {
    const { mutedFloor } = ARC_TUNING.ink;
    for (const hex of EXTREMES) {
      for (const resolved of ["light", "dark"] as const) {
        for (const vibrancy of [0, 1]) {
          const ink = canvasInk(canvasOf(hex, { vibrancy }), resolved);
          // "Above the floor, unless the HEAD was already under it" — the second
          // clause is the honest one, since a ladder cannot rank text above an
          // ink that is itself unreadable.
          expect(ink.mutedLc).toBeGreaterThanOrEqual(Math.min(ink.worstLc, mutedFloor) - 1);
        }
      }
    }
  });

  it("collapses to one rung rather than three unreadable ones when a canvas has no room", () => {
    // Reproduced as a hostile surface list rather than as a canvas, because what
    // strands the ladder is what the LIFT composited to and that belongs to
    // `elevation.ts` — this module only ever receives the result.
    const ink = canvasInk(canvasOf("#e8652a"), "light", NO_ROOM);
    expect(ink.worstLc).toBeLessThan(ARC_TUNING.ink.mutedFloor);
    // Flat: not inverted, not thrown, and not three rungs nobody can read.
    expect(ink.inkLabel).toBe(ink.ink);
    expect(ink.inkMuted).toBe(ink.ink);
  });

  it("spends the whole slide when the floor never binds", () => {
    // The other end of the search, which no real canvas reaches: a floor of 0 is
    // met everywhere, so the answer is the full travel rather than a bisection
    // that happens to converge near it.
    expect(maxReadableSlide(() => "#ffffff", ["#000000"], 0)).toBe(1);
    // …and a search that starts under the floor gives up at once rather than
    // bisecting toward a number it can never reach.
    expect(maxReadableSlide(() => "#000000", ["#000000"], 45)).toBe(0);
  });
});
