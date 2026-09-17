/**
 * The arithmetic behind a bounded column (VC-316).
 *
 * These are the rules a windowed board is only safe because of, so they are
 * asserted on the pure functions rather than through a rendered column: what a
 * column HOLDS is never bounded, a window never shrinks while a card is in the
 * air, and a selection outside the window is answered by scrolling to it
 * rather than by mounting everything in between.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  COLUMN_ROW_STRIDE_FALLBACK,
  COLUMN_WINDOW_MINIMUM,
  columnWindow,
  measuredRowStride,
  mergeColumnWindows,
  scrollOffsetForRow,
  shouldAdoptRowStride,
} from "./column-window";

const STRIDE = 100;

function window(input: Partial<Parameters<typeof columnWindow>[0]> = {}) {
  return columnWindow({
    count: 1_000,
    scrollTop: 0,
    viewportHeight: 800,
    rowStride: STRIDE,
    ...input,
  });
}

describe("columnWindow", () => {
  it("mounts a short column whole, so an ordinary board is untouched", () => {
    expect(window({ count: COLUMN_WINDOW_MINIMUM })).toEqual({
      first: 0,
      last: COLUMN_WINDOW_MINIMUM,
    });
    expect(window({ count: 7 })).toEqual({ first: 0, last: 7 });
    expect(window({ count: 0 })).toEqual({ first: 0, last: 0 });
  });

  it("follows the scroll offset with overscan on both sides", () => {
    const at = window({ scrollTop: 50 * STRIDE });
    expect(at.first).toBeLessThan(50);
    expect(at.last).toBeGreaterThan(58);
    // Bounded: this is the whole point of the module.
    expect(at.last - at.first).toBeLessThan(100);
  });

  it("never runs past either end of the column", () => {
    expect(window({ scrollTop: 0 }).first).toBe(0);
    expect(window({ scrollTop: 10_000 * STRIDE, count: 1_000 }).last).toBe(1_000);
    expect(window({ scrollTop: -500 }).first).toBe(0);
  });

  it("holds the minimum when the viewport is short, or has not been measured", () => {
    for (const viewportHeight of [0, Number.NaN, 20]) {
      const range = window({ viewportHeight });
      expect(range.last - range.first).toBeGreaterThanOrEqual(COLUMN_WINDOW_MINIMUM);
    }
  });

  it("extends downward first when the minimum is what binds", () => {
    // A tiny viewport at the top of the column: the reader is about to scroll
    // down, so the minimum is spent below them rather than above.
    const range = window({ scrollTop: 0, viewportHeight: 10 });
    expect(range.first).toBe(0);
    expect(range.last).toBe(COLUMN_WINDOW_MINIMUM);
  });

  it("falls back to a fixed stride rather than dividing by zero", () => {
    for (const rowStride of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const range = window({ rowStride, scrollTop: 10 * COLUMN_ROW_STRIDE_FALLBACK });
      expect(Number.isFinite(range.first)).toBe(true);
      expect(Number.isFinite(range.last)).toBe(true);
      expect(range.last).toBeGreaterThan(range.first);
    }
  });
});

describe("mergeColumnWindows", () => {
  it("only ever grows, so a drag cannot unmount a measured droppable", () => {
    expect(mergeColumnWindows({ first: 10, last: 50 }, { first: 40, last: 90 })).toEqual({
      first: 10,
      last: 90,
    });
    expect(mergeColumnWindows({ first: 10, last: 50 }, { first: 20, last: 30 })).toEqual({
      first: 10,
      last: 50,
    });
  });
});

describe("scrollOffsetForRow", () => {
  const range = { first: 10, last: 50 };

  it("says nothing when the row is already mounted", () => {
    for (const index of [10, 30, 49]) {
      expect(
        scrollOffsetForRow({
          index,
          window: range,
          rowStride: STRIDE,
          viewportHeight: 800,
          maxScrollTop: 99_200,
        }),
      ).toBeNull();
    }
  });

  it("says nothing when nothing is selected", () => {
    expect(
      scrollOffsetForRow({
        index: -1,
        window: range,
        rowStride: STRIDE,
        viewportHeight: 800,
        maxScrollTop: 99_200,
      }),
    ).toBeNull();
  });

  it("centres a row below the window", () => {
    expect(
      scrollOffsetForRow({
        index: 500,
        window: range,
        rowStride: STRIDE,
        viewportHeight: 800,
        maxScrollTop: 99_200,
      }),
    ).toBe(500 * STRIDE - 350);
  });

  it("clamps at both ends of the scroller", () => {
    expect(
      scrollOffsetForRow({
        index: 0,
        window: { first: 100, last: 140 },
        rowStride: STRIDE,
        viewportHeight: 800,
        maxScrollTop: 99_200,
      }),
    ).toBe(0);
    expect(
      scrollOffsetForRow({
        index: 999,
        window: range,
        rowStride: STRIDE,
        viewportHeight: 800,
        maxScrollTop: 1_000,
      }),
    ).toBe(1_000);
  });
});

describe("measuredRowStride", () => {
  it("averages the mounted rows and adds the gap", () => {
    expect(measuredRowStride([70, 90], 8)).toBe(88);
  });

  it("ignores rows that measured nothing, and gives up when all of them did", () => {
    expect(measuredRowStride([0, 80, Number.NaN], 8)).toBe(88);
    expect(measuredRowStride([], 8)).toBeNull();
    expect(measuredRowStride([0, 0], 8)).toBeNull();
  });
});

describe("shouldAdoptRowStride", () => {
  it("has a deadband, so a measure→write→measure loop cannot start", () => {
    expect(shouldAdoptRowStride(84, 84.4)).toBe(false);
    expect(shouldAdoptRowStride(84, 84.9)).toBe(false);
    expect(shouldAdoptRowStride(84, 92)).toBe(true);
    expect(shouldAdoptRowStride(84, 70)).toBe(true);
  });
});
