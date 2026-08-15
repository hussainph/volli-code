import { describe, expect, it, vi } from "vite-plus/test";

import { MAX_TIMER_DELAY_MS, delayUntil } from "./boundary-timer";

describe("delayUntil", () => {
  it("waits until just past the instant, so the wake lands in the new state", () => {
    expect(delayUntil(5_000, 1_000)).toBe(4_001);
  });

  it("wakes on the next tick for an instant that has already passed", () => {
    // What this protects: a boundary computed against a clock that is
    // deliberately behind the wall clock can be in the past by the time it is
    // armed. A negative delay fires immediately either way, but 0 would leave
    // "already past" and "due right now" indistinguishable to a reader.
    expect(delayUntil(1_000, 5_000)).toBe(1);
    expect(delayUntil(1_000, 1_000)).toBe(1);
  });

  it("clamps a wait no browser timer can hold", () => {
    // Past 2^31-1 the delay overflows to a signed 32-bit int and fires at once,
    // which for a self-re-arming timer is a spin rather than a late wake.
    expect(delayUntil(Number.MAX_SAFE_INTEGER, 0)).toBe(MAX_TIMER_DELAY_MS);
  });

  it("measures against the wall clock when no `now` is given", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      expect(delayUntil(5_000)).toBe(4_001);
    } finally {
      vi.useRealTimers();
    }
  });
});
