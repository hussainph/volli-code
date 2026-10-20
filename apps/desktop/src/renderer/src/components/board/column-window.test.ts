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
  boundedWindow,
  COLUMN_ROW_STRIDE_FALLBACK,
  COLUMN_WINDOW_MINIMUM,
  columnWindow,
  learnRowStride,
  measuredRowStride,
  mergeColumnWindows,
  type MountedRows,
  scrollOffsetForRow,
  scrollOffsetInRows,
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

describe("boundedWindow", () => {
  /**
   * The regression this function exists for: a multi-card drop grows the
   * destination column in the same render the tracked window is still the
   * pre-drop one. Rendering that stale window left the just-landed cards out of
   * the DOM, so `board.tsx`'s FLIP layout effect found no slot for them and the
   * drop animation was silently skipped.
   */
  it("mounts rows the count grew by in the same render", () => {
    expect(boundedWindow({ first: 0, last: 3 }, 5)).toEqual({ first: 0, last: 5 });
    expect(boundedWindow({ first: 0, last: COLUMN_WINDOW_MINIMUM }, 2_000).last).toBe(
      COLUMN_WINDOW_MINIMUM,
    );
  });

  it("renders a column that fits whole, whatever the tracked window says", () => {
    expect(boundedWindow({ first: 12, last: 14 }, 20)).toEqual({ first: 0, last: 20 });
    expect(boundedWindow({ first: 0, last: 0 }, 0)).toEqual({ first: 0, last: 0 });
  });

  it("clamps a window the count shrank underneath, and keeps the minimum", () => {
    expect(boundedWindow({ first: 10, last: 900 }, 100)).toEqual({ first: 10, last: 100 });
    const narrowed = boundedWindow({ first: 90, last: 95 }, 100);
    expect(narrowed.last - narrowed.first).toBe(COLUMN_WINDOW_MINIMUM);
    expect(narrowed.last).toBe(100);
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

describe("learnRowStride", () => {
  const everything = { has: () => true };

  it("answers the same stride for a window it has already seen, whatever came between", () => {
    // Mixed heights: the mounted-slice average would be 60+8 over the first
    // slice and differ over the second. The ledger's answer depends only on
    // WHICH cards it has seen, so a revisited window adopts nothing new.
    const ledger = new Map<string, number>();
    const first = learnRowStride(
      ledger,
      [
        ["a", 60],
        ["b", 60],
      ],
      everything,
      8,
    );
    const second = learnRowStride(
      ledger,
      [
        ["b", 60],
        ["c", 160],
      ],
      everything,
      8,
    );
    const again = learnRowStride(
      ledger,
      [
        ["a", 60],
        ["b", 60],
      ],
      everything,
      8,
    );
    expect(first).toBe(68);
    expect(second).toBeCloseTo((60 + 60 + 160) / 3 + 8);
    expect(again).toBe(second);
  });

  it("keeps a real height when the same card later measures nothing", () => {
    const ledger = new Map<string, number>([["a", 90]]);
    expect(
      learnRowStride(
        ledger,
        [
          ["a", 0],
          ["b", Number.NaN],
        ],
        everything,
        8,
      ),
    ).toBe(98);
    expect([...ledger]).toEqual([["a", 90]]);
  });

  it("forgets tickets the column no longer holds", () => {
    const ledger = new Map<string, number>([
      ["gone", 400],
      ["kept", 60],
    ]);
    const held = new Set(["kept", "new"]);
    expect(learnRowStride(ledger, [["new", 80]], held, 8)).toBe(78);
    expect([...ledger.keys()].toSorted()).toEqual(["kept", "new"]);
  });

  it("has nothing to learn from an empty ledger", () => {
    expect(learnRowStride(new Map(), [], everything, 8)).toBeNull();
  });
});

/** Cards laid out top to bottom from `top`, each `height` tall, `gap` apart. */
function rows(
  heights: readonly number[],
  { top = 0, gap = 8, firstIndex = 0 } = {},
): MountedRows & { reads: () => number } {
  let reads = 0;
  const tops: number[] = [];
  let y = top;
  for (const height of heights) {
    tops.push(y);
    y += height + gap;
  }
  return {
    count: heights.length,
    edgesAt: (i) => {
      reads += 1;
      return { top: tops[i]!, bottom: tops[i]! + heights[i]! };
    },
    indexAt: (i) => firstIndex + i,
    reads: () => reads,
  };
}

/** `scrollOffsetInRows` at a fold of 0 and a stride of 93. */
function readAtFold(rawScrollTop: number, mounted: MountedRows): number {
  return scrollOffsetInRows({ rawScrollTop, fold: 0, rows: mounted, rowStride: 93 });
}

describe("scrollOffsetInRows", () => {
  it("reads the card at the fold as its row × stride plus how far into it the fold is", () => {
    // Card 3 of the slice (row 13 of the column) straddles a fold at 250.
    const mounted = rows([60, 60, 60, 60, 60], { top: 0, firstIndex: 10 });
    expect(
      scrollOffsetInRows({ rawScrollTop: 9_999, fold: 250, rows: mounted, rowStride: 100 }),
    ).toBe(13 * 100 + (250 - 3 * 68));
  });

  it("does not move when anchoring moves the content and the offset together", () => {
    // The same card at the same place against the fold reads the same, whatever
    // `scrollTop` says — the property the column needs from scroll anchoring.
    const before = rows([160, 160, 60], { top: -100, firstIndex: 4 });
    const after = rows([160, 160, 60], { top: -100, firstIndex: 4 });
    expect(readAtFold(652, before)).toBe(readAtFold(877, after));
  });

  it("keeps a card taller than the stride inside its own row", () => {
    // 150px into a 160px card at stride 93: still row 4, never row 5.
    const mounted = rows([160], { top: -150, firstIndex: 4 });
    const offset = scrollOffsetInRows({ rawScrollTop: 0, fold: 0, rows: mounted, rowStride: 93 });
    expect(Math.floor(offset / 93)).toBe(4);
  });

  it("falls back to the raw offset when the fold is in the leading spacer", () => {
    const mounted = rows([60, 60], { top: 40, firstIndex: 20 });
    expect(scrollOffsetInRows({ rawScrollTop: 777, fold: 0, rows: mounted, rowStride: 68 })).toBe(
      777,
    );
  });

  it("falls back to the raw offset when the fold is in the trailing spacer", () => {
    const mounted = rows([60, 60], { top: -500 });
    expect(scrollOffsetInRows({ rawScrollTop: 777, fold: 0, rows: mounted, rowStride: 68 })).toBe(
      777,
    );
  });

  it("falls back to the raw offset with nothing mounted, or a card it cannot place", () => {
    expect(scrollOffsetInRows({ rawScrollTop: 5, fold: 0, rows: rows([]), rowStride: 68 })).toBe(5);
    const unplaced: MountedRows = { ...rows([60], { top: -10 }), indexAt: () => undefined };
    expect(scrollOffsetInRows({ rawScrollTop: 5, fold: 0, rows: unplaced, rowStride: 68 })).toBe(5);
  });

  it("reads the card after a gap when the fold falls between two cards", () => {
    // Card 0 ends at 60, card 1 starts at 68: a fold at 64 is in the gap and
    // reads as the START of row 1, not part-way into row 0.
    const mounted = rows([60, 60, 60]);
    expect(scrollOffsetInRows({ rawScrollTop: 0, fold: 64, rows: mounted, rowStride: 68 })).toBe(
      68,
    );
  });

  it("finds the card at the fold in a handful of reads, not one per mounted card", () => {
    const mounted = rows(Array.from({ length: 1_000 }, () => 60));
    scrollOffsetInRows({ rawScrollTop: 0, fold: 40_000, rows: mounted, rowStride: 68 });
    expect(mounted.reads()).toBeLessThanOrEqual(12);
  });
});
