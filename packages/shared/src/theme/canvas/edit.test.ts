/**
 * The editor's transitions, held to the rules that make a multi-stop canvas read
 * as one family — and to the two asymmetries that look like bugs and are not:
 * promotion re-derives nothing, and "−" never takes the primary.
 */
import { describe, expect, it } from "vite-plus/test";

import { hexToOklch } from "../color";
import { addStop, moveStop, removeStop, withPrimaryHex, withPrimaryIndex } from "./edit";
import { DEFAULT_CANVAS } from "./parse";
import { ARC_TUNING, MAX_STOPS } from "./tuning";

describe("harmony", () => {
  it("rotates every other stop by its offset and keeps the family's lightness", () => {
    const three = addStop(addStop(DEFAULT_CANVAS));
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

  it("re-derives the whole family when the primary's colour changes", () => {
    const three = withPrimaryHex(addStop(addStop(DEFAULT_CANVAS)), "#2e6f8e");
    const primary = hexToOklch(three.stops[three.primaryIndex].hex);
    expect(primary.h).toBeCloseTo(hexToOklch("#2e6f8e").h, 1);
    for (const stop of three.stops.slice(1)) {
      expect(hexToOklch(stop.hex).L).toBeCloseTo(primary.L, 2);
    }
  });

  it("promotes without touching a single color, because the sets are rotation-closed", () => {
    for (const canvas of [addStop(DEFAULT_CANVAS), addStop(addStop(DEFAULT_CANVAS))]) {
      const promoted = withPrimaryIndex(canvas, canvas.stops.length - 1);
      expect(promoted.primaryIndex).toBe(canvas.stops.length - 1);
      // Every hue offset a family uses is present from ANY of its members, so
      // there is nothing to re-derive — and re-deriving would push each hex back
      // through the gamut map and quantise it a little flatter.
      expect(promoted.stops).toEqual(canvas.stops);
    }
  });

  it("round-trips a promotion losslessly — A→B→A is the canvas it started in", () => {
    const three = addStop(addStop(DEFAULT_CANVAS));
    expect(withPrimaryIndex(withPrimaryIndex(three, 2), 0)).toEqual(three);
  });

  it("ignores a promotion that names no stop, rather than producing one that paints nothing", () => {
    const three = addStop(addStop(DEFAULT_CANVAS));
    expect(withPrimaryIndex(three, -1)).toBe(three);
    expect(withPrimaryIndex(three, three.stops.length)).toBe(three);
    expect(withPrimaryIndex(three, three.primaryIndex)).toBe(three);
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
    const { newStop } = ARC_TUNING;
    let canvas = DEFAULT_CANVAS;
    for (let i = 0; i < MAX_STOPS + 2; i += 1) canvas = addStop(canvas);
    expect(canvas.stops).toHaveLength(MAX_STOPS);
    expect(canvas.stops[canvas.primaryIndex].hex).toBe(DEFAULT_CANVAS.stops[0].hex);
    for (const stop of canvas.stops.slice(1)) {
      expect(stop.x).toBeGreaterThanOrEqual(newStop.min);
      expect(stop.x).toBeLessThanOrEqual(newStop.max);
      expect(stop.y).toBeGreaterThanOrEqual(newStop.min);
      expect(stop.y).toBeLessThanOrEqual(newStop.max);
    }

    const promoted = withPrimaryIndex(canvas, MAX_STOPS - 1);
    const shrunk = removeStop(promoted);
    // The primary was the last stop, so removal had to drop the one below it and
    // walk the index back rather than take the family's own color away.
    expect(shrunk.stops).toHaveLength(MAX_STOPS - 1);
    expect(shrunk.stops[shrunk.primaryIndex].hex).toBe(promoted.stops[promoted.primaryIndex].hex);
    expect(shrunk.primaryIndex).toBe(promoted.primaryIndex - 1);

    let floor = shrunk;
    for (let i = 0; i < MAX_STOPS + 2; i += 1) floor = removeStop(floor);
    expect(floor.stops).toHaveLength(1);
  });

  it("drops the last stop and leaves the index alone when the primary is not it", () => {
    // The other arm of the same rule: with the primary at slot 0 the list
    // shortens from the end and nothing about the color on screen changes.
    const three = addStop(addStop(DEFAULT_CANVAS));
    const shrunk = removeStop(three);
    expect(shrunk.primaryIndex).toBe(three.primaryIndex);
    expect(shrunk.stops[0]).toEqual(three.stops[0]);
    expect(shrunk.stops).toHaveLength(2);
  });

  it("places a new pool away from the ones already on the pad", () => {
    // The point of the diagonal search: two pools stacked on one another read as
    // one, so "+" has to land somewhere with room.
    const two = addStop(DEFAULT_CANVAS);
    const [primary, added] = two.stops;
    expect(Math.hypot(primary.x - added.x, primary.y - added.y)).toBeGreaterThan(0.2);
  });
});

describe("moveStop", () => {
  it("moves the named stop only, clamped away from the very edges", () => {
    const { min, max } = ARC_TUNING.dragBounds;
    const two = addStop(DEFAULT_CANVAS);
    const moved = moveStop(two, 1, 5, -5);
    expect(moved.stops[0]).toEqual(two.stops[0]);
    expect(moved.stops[1].x).toBe(max);
    expect(moved.stops[1].y).toBe(min);
    // A pool anchored in the very corner only shows a quarter of itself.
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThan(1);
  });
});
