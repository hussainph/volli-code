import { describe, expect, it } from "vitest";

import {
  deterministicUuid,
  distributeCapped,
  largestRemainder,
  seededRandom,
  seededShuffle,
} from "./deterministic.mjs";

describe("performance fixture deterministic primitives", () => {
  it("derives stable ids without path or process state", () => {
    expect(deterministicUuid("event", "session-1:4")).toBe(
      deterministicUuid("event", "session-1:4"),
    );
    expect(deterministicUuid("event", "session-1:4")).not.toBe(
      deterministicUuid("event", "session-2:4"),
    );
    expect(deterministicUuid("event", "session-1:4")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("allocates largest remainders exactly with index tie-breaking", () => {
    expect(largestRemainder(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(largestRemainder(7, [0, 2, 1])).toEqual([0, 5, 2]);
    expect(largestRemainder(5, [0, 0])).toEqual([3, 2]);
    expect(largestRemainder(13, [2, 1, 1]).reduce((sum, value) => sum + value, 0)).toBe(13);
  });

  it("keeps capped distributions exact", () => {
    expect(distributeCapped(8, [4, 2, 1], [2, 2, 8])).toEqual([2, 2, 4]);
  });

  it("keeps random streams and shuffles repeatable", () => {
    expect(Array.from({ length: 8 }, seededRandom(353))).toEqual(
      Array.from({ length: 8 }, seededRandom(353)),
    );
    expect(seededShuffle([1, 2, 3, 4], 353)).toEqual(seededShuffle([1, 2, 3, 4], 353));
  });
});
