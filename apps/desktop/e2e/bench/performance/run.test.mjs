import { describe, expect, it } from "vitest";

import { summarize } from "./run.mjs";

describe("performance benchmark statistics", () => {
  it("reports nearest-rank tails and population variance", () => {
    expect(summarize(Array.from({ length: 20 }, (_value, index) => index + 1))).toEqual({
      n: 20,
      min: 1,
      p50: 10,
      p95: 19,
      max: 20,
      mean: 10.5,
      variance: 33.25,
    });
  });

  it("ignores unavailable measurements and refuses an empty summary", () => {
    expect(summarize([null, Number.NaN, 4, 8])).toMatchObject({ n: 2, p50: 4, p95: 8 });
    expect(summarize([null, Number.NaN])).toBeNull();
  });
});
