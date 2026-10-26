import { describe, expect, test } from "vite-plus/test";

import { transcriptCanonicalJson } from "./transcript-canonical-json";

describe("transcriptCanonicalJson", () => {
  test("sorts keys at every depth and keeps JSON.stringify's values", () => {
    expect(transcriptCanonicalJson({ b: 1, a: { d: [1, "x"], c: null }, e: true })).toBe(
      '{"a":{"c":null,"d":[1,"x"]},"b":1,"e":true}',
    );
    expect(transcriptCanonicalJson("✓")).toBe('"✓"');
    expect(transcriptCanonicalJson(Object.assign(Object.create(null), { z: 1, y: 2 }))).toBe(
      '{"y":2,"z":1}',
    );
  });

  test("drops undefined members and writes undefined or missing array slots as null", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(transcriptCanonicalJson({ a: undefined, b: [undefined, , 1] })).toBe(
      '{"b":[null,null,1]}',
    );
  });

  test("refuses what JSON cannot say: undefined, cycles, class instances", () => {
    expect(() => transcriptCanonicalJson(undefined)).toThrow("undefined");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => transcriptCanonicalJson(cycle)).toThrow("circular");
    expect(() => transcriptCanonicalJson({ at: new Date(0) })).toThrow("non-plain");
    // A repeated (not circular) reference is fine.
    const shared = { x: 1 };
    expect(transcriptCanonicalJson([shared, shared])).toBe('[{"x":1},{"x":1}]');
  });
});
