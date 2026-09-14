import { describe, expect, it } from "vite-plus/test";
import { isolatePerformanceObserver, readOptionalPerformanceClock } from "./performance-observer";

describe("readOptionalPerformanceClock", () => {
  it("reads the tap's own clock when it has one", () => {
    expect(readOptionalPerformanceClock({ now: () => 42 })).toBe(42);
  });

  it("falls back to the ambient clock when the tap has none", () => {
    const before = performance.now();
    const reading = readOptionalPerformanceClock({});
    expect(reading).not.toBeNull();
    expect(reading).toBeGreaterThanOrEqual(before);
  });

  it("has no reading at all when there is no observer", () => {
    expect(readOptionalPerformanceClock(undefined)).toBeNull();
  });

  it("reports null rather than a plausible zero when the clock throws", () => {
    // The whole point: a caller pairs two readings and skips the sample unless
    // both are numbers. Returning 0 here would publish a zero-duration round
    // trip, which is indistinguishable from a very fast one and would drag
    // every percentile down.
    expect(
      readOptionalPerformanceClock({
        now: () => {
          throw new Error("clock is broken");
        },
      }),
    ).toBeNull();
  });
});

describe("isolatePerformanceObserver", () => {
  it("runs the measurement side effect", () => {
    let recorded = 0;
    isolatePerformanceObserver(() => {
      recorded += 1;
    });
    expect(recorded).toBe(1);
  });

  it("swallows a throwing observer so it cannot change what it measures", () => {
    expect(() =>
      isolatePerformanceObserver(() => {
        throw new Error("observer is broken");
      }),
    ).not.toThrow();
  });
});
