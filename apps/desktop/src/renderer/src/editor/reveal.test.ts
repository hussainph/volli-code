import { describe, expect, it } from "vite-plus/test";

import { intersects, selectionTouches } from "./reveal";

describe("intersects", () => {
  it("is true for overlapping spans", () => {
    expect(intersects(0, 10, 5, 15)).toBe(true);
    expect(intersects(5, 15, 0, 10)).toBe(true);
  });

  it("is true when one span contains the other", () => {
    expect(intersects(0, 20, 5, 8)).toBe(true);
    expect(intersects(5, 8, 0, 20)).toBe(true);
  });

  it("treats touching endpoints as intersecting (cursor at a boundary)", () => {
    // A zero-width cursor (from === to) sitting exactly on a delimiter edge.
    expect(intersects(4, 4, 4, 6)).toBe(true); // cursor at node start
    expect(intersects(6, 6, 4, 6)).toBe(true); // cursor at node end
  });

  it("is false for fully disjoint spans", () => {
    expect(intersects(0, 3, 5, 9)).toBe(false);
    expect(intersects(5, 9, 0, 3)).toBe(false);
  });
});

describe("selectionTouches", () => {
  it("is false for an empty selection list", () => {
    expect(selectionTouches([], 0, 10)).toBe(false);
  });

  it("is true when any range touches the span", () => {
    const selection = [
      { from: 0, to: 1 },
      { from: 40, to: 42 },
    ];
    expect(selectionTouches(selection, 41, 50)).toBe(true);
    expect(selectionTouches(selection, 100, 200)).toBe(false);
  });

  it("matches a bare cursor resting against the span edge", () => {
    expect(selectionTouches([{ from: 6, to: 6 }], 6, 12)).toBe(true);
  });
});
