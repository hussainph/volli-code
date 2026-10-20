import { describe, expect, it, vi } from "vite-plus/test";
import { ExecutionSlots, Mutex, RunClock } from "./schedule";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Mutex", () => {
  it("runs one holder at a time, first in first out, even after a holder throws", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const first = mutex.run(async () => {
      order.push("first");
      await tick();
      throw new Error("first failed");
    });
    const second = mutex.run(async () => {
      order.push("second");
      return 2;
    });
    await expect(first).rejects.toThrow("first failed");
    expect(await second).toBe(2);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("ExecutionSlots", () => {
  it("refuses a waiter whose signal already fired, holding nothing", async () => {
    const slots = new ExecutionSlots(2);
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(slots.run(true, controller.signal, async () => 1)).rejects.toThrow("gone");
    const plain = new AbortController();
    plain.abort("not an error");
    await expect(slots.run(true, plain.signal, async () => 1)).rejects.toThrow(
      "The run was cancelled.",
    );
    expect(await slots.run(false, undefined, async () => 3)).toBe(3);
  });

  it("drops a queued waiter whose signal fires, and admits the next", async () => {
    const slots = new ExecutionSlots(1);
    let release!: () => void;
    const held = slots.run(
      false,
      undefined,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const controller = new AbortController();
    const dropped = slots.run(true, controller.signal, async () => "never");
    const next = slots.run(true, undefined, async () => "next");
    controller.abort();
    await expect(dropped).rejects.toThrow("aborted");
    release();
    await held;
    expect(await next).toBe("next");
  });

  it("treats a limit below one as one", async () => {
    const slots = new ExecutionSlots(0);
    await Promise.all([slots.run(true, undefined, tick), slots.run(true, undefined, tick)]);
    expect(slots.peak).toBe(1);
  });
});

describe("RunClock", () => {
  it("spends only running time, nests pauses, and expires once", () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const expired = vi.fn();
      const clock = new RunClock(100, () => now, expired);
      now = 40;
      clock.pause();
      clock.pause();
      now = 1_000;
      vi.advanceTimersByTime(1_000);
      expect(expired).not.toHaveBeenCalled();
      clock.resume();
      expect(clock.spentMs).toBe(40);
      clock.resume();
      clock.resume();
      expect(clock.pausedMs).toBe(960);
      now = 1_030;
      expect(clock.spentMs).toBe(70);
      vi.advanceTimersByTime(60);
      expect(expired).toHaveBeenCalledTimes(1);
      // Spent: nothing it is told now changes anything.
      clock.pause();
      clock.resume();
      clock.dispose();
      expect(expired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops counting when disposed", () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const clock = new RunClock(10, () => 0, expired);
      clock.dispose();
      vi.advanceTimersByTime(100);
      expect(expired).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
