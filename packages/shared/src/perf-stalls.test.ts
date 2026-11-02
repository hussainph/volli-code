import { describe, expect, it } from "vite-plus/test";

import {
  isPerfGrouping,
  isPerfProcess,
  PERF_GROUP_LIMITS,
  PERF_GROUPINGS,
  PERF_PROCESSES,
  PERF_STALLS_LIMITS,
} from "./perf-stalls";

describe("perf store vocabulary", () => {
  it("names the two processes and the five groupings, in their published order", () => {
    // Scripts key on these words: adding is fine, renaming splits a series.
    expect(PERF_PROCESSES).toEqual(["main", "renderer"]);
    expect(PERF_GROUPINGS).toEqual(["operation", "door", "label", "version", "session"]);
  });

  it("accepts only its own words", () => {
    for (const process of PERF_PROCESSES) expect(isPerfProcess(process)).toBe(true);
    for (const grouping of PERF_GROUPINGS) expect(isPerfGrouping(grouping)).toBe(true);
    for (const value of ["worker", "", "Main", 1, null, undefined, ["main"]]) {
      expect(isPerfProcess(value)).toBe(false);
      expect(isPerfGrouping(value)).toBe(false);
    }
  });

  it("bounds every listing", () => {
    expect(PERF_STALLS_LIMITS.default).toBeLessThanOrEqual(PERF_STALLS_LIMITS.max);
    expect(PERF_GROUP_LIMITS.default).toBeLessThanOrEqual(PERF_GROUP_LIMITS.max);
  });
});
