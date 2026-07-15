import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createDebouncer } from "./debounce";

describe("createDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once after the idle delay elapses", () => {
    const run = vi.fn();
    const d = createDebouncer(run, 1500);
    d.schedule();
    expect(d.pending).toBe(true);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(run).toHaveBeenCalledTimes(1);
    expect(d.pending).toBe(false);
  });

  it("resets the timer on each schedule (only the last one fires)", () => {
    const run = vi.fn();
    const d = createDebouncer(run, 1500);
    d.schedule();
    vi.advanceTimersByTime(1000);
    d.schedule();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flush runs a pending run immediately and clears the timer", () => {
    const run = vi.fn();
    const d = createDebouncer(run, 1500);
    d.schedule();
    d.flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(d.pending).toBe(false);
    // The original timer must not also fire.
    vi.advanceTimersByTime(1500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flush with nothing pending is a no-op", () => {
    const run = vi.fn();
    const d = createDebouncer(run, 1500);
    d.flush();
    expect(run).not.toHaveBeenCalled();
  });

  it("cancel drops a pending run without executing it", () => {
    const run = vi.fn();
    const d = createDebouncer(run, 1500);
    d.schedule();
    d.cancel();
    expect(d.pending).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(run).not.toHaveBeenCalled();
  });
});
