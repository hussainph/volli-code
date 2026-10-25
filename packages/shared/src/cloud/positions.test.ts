import { describe, expect, test } from "vite-plus/test";

import {
  InvalidPositionError,
  POSITION_REBALANCE_LENGTH,
  comparePositions,
  isPositionKey,
  needsRebalance,
  positionBetween,
  positionsBetween,
  rebalancedPositions,
} from "./positions";

describe("positionBetween", () => {
  test("produces the classic base-62 keys", () => {
    const first = positionBetween(null, null);
    expect(first).toBe("a0");
    const second = positionBetween(first, null);
    expect(second).toBe("a1");
    expect(positionBetween(null, first)).toBe("Zz");
    expect(positionBetween(first, second)).toBe("a0V");
  });

  test("always sorts strictly between its neighbours under plain comparison", () => {
    let low = positionBetween(null, null);
    const high = positionBetween(low, null);
    for (let i = 0; i < 400; i++) {
      const next = positionBetween(low, high);
      expect(comparePositions(low, next)).toBe(-1);
      expect(comparePositions(next, high)).toBe(-1);
      low = next;
    }
    // Repeated inserts at one spot lengthen keys until a rebalance is due.
    expect(needsRebalance(low)).toBe(true);
  });

  test("refuses neighbours out of order or malformed, with a typed error", () => {
    expect(() => positionBetween("a1", "a0")).toThrow(InvalidPositionError);
    expect(() => positionBetween("a1", "a1")).toThrow(/a1 >= a1/);
    expect(() => positionBetween("!!", null)).toThrow(
      expect.objectContaining({ code: "invalid_position" }),
    );
  });
});

describe("positionsBetween", () => {
  test("spaces a group evenly and in order", () => {
    expect(positionsBetween(null, null, 3)).toEqual(["a0", "a1", "a2"]);
    const keys = positionsBetween("a0", "a1", 4);
    expect(keys).toHaveLength(4);
    expect(keys.toSorted(comparePositions)).toEqual(keys);
    expect(positionsBetween("a0", null, 0)).toEqual([]);
  });

  test("refuses a bad count", () => {
    expect(() => positionsBetween(null, null, -1)).toThrow(InvalidPositionError);
    expect(() => positionsBetween(null, null, 1.5)).toThrow(/non-negative integer/);
  });
});

describe("validation and order", () => {
  test("isPositionKey", () => {
    expect(isPositionKey("a0")).toBe(true);
    expect(isPositionKey("Zz")).toBe(true);
    expect(isPositionKey("a0V")).toBe(true);
    expect(isPositionKey("a00")).toBe(false); // trailing zero
    expect(isPositionKey("")).toBe(false);
    expect(isPositionKey(7)).toBe(false);
  });

  test("comparePositions is case-sensitive code-unit order", () => {
    expect(comparePositions("Zz", "a0")).toBe(-1);
    expect(comparePositions("a0", "Zz")).toBe(1);
    expect(comparePositions("a0", "a0")).toBe(0);
  });

  test("rebalance threshold and fresh keys", () => {
    expect(needsRebalance("a".repeat(POSITION_REBALANCE_LENGTH))).toBe(false);
    expect(needsRebalance("a".repeat(POSITION_REBALANCE_LENGTH + 1))).toBe(true);
    const fresh = rebalancedPositions(100);
    expect(fresh).toHaveLength(100);
    expect(fresh.every((key) => !needsRebalance(key))).toBe(true);
    expect(fresh.toSorted(comparePositions)).toEqual(fresh);
  });
});
