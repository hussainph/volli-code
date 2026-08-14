import { describe, expect, it } from "vite-plus/test";

import { findBoundedSequenceDiff } from "./bounded-sequence-diff";

describe("findBoundedSequenceDiff", () => {
  it("returns the exact deterministic steps for a compound edit", () => {
    expect(
      findBoundedSequenceDiff("abc", "aXYZc", {
        maxDistance: 8,
        maxComparisons: 100,
      }),
    ).toEqual([
      { kind: "delete", index: 1 },
      { kind: "insert", index: 2, value: "X" },
      { kind: "insert", index: 2, value: "Y" },
      { kind: "insert", index: 2, value: "Z" },
    ]);
  });

  it("preserves deletion-first tie breaking for equally short scripts", () => {
    expect(
      findBoundedSequenceDiff("ab", "ba", {
        maxDistance: 2,
        maxComparisons: 20,
      }),
    ).toEqual([
      { kind: "delete", index: 0 },
      { kind: "insert", index: 2, value: "a" },
    ]);
  });

  it("indexes strings as UTF-16 code units", () => {
    expect(
      findBoundedSequenceDiff("🚀", "", {
        maxDistance: 2,
        maxComparisons: 20,
      }),
    ).toEqual([
      { kind: "delete", index: 0 },
      { kind: "delete", index: 1 },
    ]);
  });

  it("stops before beginning another search diagonal after the comparison budget", () => {
    expect(
      findBoundedSequenceDiff("", "abc", {
        maxDistance: 3,
        maxComparisons: 1,
      }),
    ).toBeNull();
  });

  it("stops while extending a matching diagonal after the comparison budget", () => {
    expect(
      findBoundedSequenceDiff("aa", "aa", {
        maxDistance: 0,
        maxComparisons: 1,
      }),
    ).toBeNull();
  });

  it("returns null when the shortest script exceeds the distance budget", () => {
    expect(
      findBoundedSequenceDiff("a", "b", {
        maxDistance: 1,
        maxComparisons: 100,
      }),
    ).toBeNull();
  });

  it.each([
    ["negative distance", { maxDistance: -1, maxComparisons: 100 }],
    ["fractional distance", { maxDistance: 1.5, maxComparisons: 100 }],
    ["non-finite distance", { maxDistance: Number.POSITIVE_INFINITY, maxComparisons: 100 }],
    ["NaN distance", { maxDistance: Number.NaN, maxComparisons: 100 }],
    ["negative comparisons", { maxDistance: 2, maxComparisons: -1 }],
    ["fractional comparisons", { maxDistance: 2, maxComparisons: 1.5 }],
    ["non-finite comparisons", { maxDistance: 2, maxComparisons: Number.POSITIVE_INFINITY }],
    ["NaN comparisons", { maxDistance: 2, maxComparisons: Number.NaN }],
  ])("rejects an invalid %s budget", (_label, budget) => {
    expect(findBoundedSequenceDiff("a", "b", budget)).toBeNull();
  });

  it("accepts a zero comparison budget and returns null", () => {
    expect(
      findBoundedSequenceDiff("", "", {
        maxDistance: 0,
        maxComparisons: 0,
      }),
    ).toBeNull();
  });
});
