import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createAutoReapWatch } from "./auto-reap-watch";
import type { OrphanProcessService } from "./orphan-processes";

function service(autoReap: OrphanProcessService["autoReap"]): OrphanProcessService {
  return { autoReap } as OrphanProcessService;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the automatic reap's tick", () => {
  it("says nothing when the policy declined, and one line when it killed something", async () => {
    const lines: string[] = [];
    const declining = createAutoReapWatch(
      service(async () => ({ reaped: [], declined: "Automatic reaping is off." })),
      { log: (line) => lines.push(line) },
    );
    await declining.tick();
    expect(lines).toEqual([]);

    const reaping = createAutoReapWatch(
      service(async () => ({ reaped: [{} as never, {} as never], declined: null })),
      { log: (line) => lines.push(line) },
    );
    await reaping.tick();
    expect(lines).toEqual(["[orphan-processes] reaped 2 under memory pressure"]);
  });

  it("logs a failure rather than raising it: nobody asked for this work", async () => {
    const lines: string[] = [];
    const watch = createAutoReapWatch(
      service(async () => {
        throw new Error("lsof refused");
      }),
      { log: (line) => lines.push(line) },
    );

    await expect(watch.tick()).resolves.toBeUndefined();
    expect(lines[0]).toContain("lsof refused");
  });

  it("ticks after the first delay and on the interval, and stops when told", async () => {
    vi.useFakeTimers();
    const autoReap = vi.fn(async () => ({ reaped: [], declined: null }));
    const watch = createAutoReapWatch(service(autoReap), {
      firstDelayMs: 1_000,
      intervalMs: 10_000,
      log: () => {},
    });

    watch.start();
    // A second start is a no-op rather than a second pair of timers.
    watch.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(autoReap).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(autoReap).toHaveBeenCalledTimes(2);

    watch.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(autoReap).toHaveBeenCalledTimes(2);
    // Stopping twice is harmless.
    expect(() => watch.stop()).not.toThrow();
  });
});
