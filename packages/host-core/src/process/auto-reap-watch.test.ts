import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { LogFields } from "../log/logger";
import { captureHostLog } from "../testing/log";
import { createAutoReapWatch } from "./auto-reap-watch";
import type { OrphanProcessService } from "./orphan-processes";

/** A log seam that writes each line into `lines` as `msg key=value…`, an Error as its message. */
function into(lines: string[]): (msg: string, fields?: LogFields) => void {
  return (msg, fields = {}) => {
    const parts = Object.entries(fields).map(
      ([key, value]) => `${key}=${value instanceof Error ? value.message : String(value)}`,
    );
    lines.push([msg, ...parts].join(" "));
  };
}

function service(autoReap: OrphanProcessService["autoReap"]): OrphanProcessService {
  return { autoReap } as OrphanProcessService;
}

type ReapOutcome = Awaited<ReturnType<OrphanProcessService["autoReap"]>>;

/** A reap the test releases by hand, so an event log can show what waited for what. */
function gatedReap(): {
  service: OrphanProcessService;
  release: (outcome: ReapOutcome) => void;
  fail: (error: Error) => void;
  /** Reaps asked and not yet released. */
  pending: () => number;
} {
  const gates: Array<{ resolve: (o: ReapOutcome) => void; reject: (e: Error) => void }> = [];
  return {
    service: service(
      () =>
        new Promise<ReapOutcome>((resolve, reject) => {
          gates.push({ resolve, reject });
        }),
    ),
    release: (outcome) => gates.shift()!.resolve(outcome),
    fail: (error) => gates.shift()!.reject(error),
    pending: () => gates.length,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the automatic reap's tick", () => {
  it("says nothing when the policy declined, and one line when it killed something", async () => {
    const lines: string[] = [];
    const declining = createAutoReapWatch(
      service(async () => ({ reaped: [], declined: "Automatic reaping is off." })),
      { log: into(lines) },
    );
    await declining.tick();
    expect(lines).toEqual([]);

    const reaping = createAutoReapWatch(
      service(async () => ({ reaped: [{} as never, {} as never], declined: null })),
      { log: into(lines) },
    );
    await reaping.tick();
    expect(lines).toEqual(["reaped orphan processes under memory pressure reaped=2"]);
  });

  it("writes to the main log when no logger was supplied", async () => {
    const log = captureHostLog();
    try {
      await createAutoReapWatch(
        service(async () => ({ reaped: [{} as never], declined: null })),
      ).tick();
      expect(log.of("orphan-processes")).toEqual([
        expect.objectContaining({
          level: "info",
          msg: "reaped orphan processes under memory pressure",
          reaped: 1,
        }),
      ]);
    } finally {
      log.restore();
    }
  });

  it("logs a failure rather than raising it: nobody asked for this work", async () => {
    const lines: string[] = [];
    const watch = createAutoReapWatch(
      service(async () => {
        throw new Error("lsof refused");
      }),
      { log: into(lines) },
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

describe("the automatic reap's drain (VC-627)", () => {
  it("settles at once when no tick is running, however often it is asked", async () => {
    const watch = createAutoReapWatch(service(vi.fn()), { log: () => {} });
    await expect(watch.settled()).resolves.toBeUndefined();
    await expect(Promise.all([watch.settled(), watch.settled()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("stop() during a timer-fired reap leaves it running; settled() waits for it, then nothing more runs", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const reap = gatedReap();
    const watch = createAutoReapWatch(reap.service, {
      firstDelayMs: 1_000,
      intervalMs: 10_000,
      log: into(events),
    });
    watch.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reap.pending()).toBe(1);

    watch.stop();
    const drained = watch.settled().then(() => events.push("settled"));
    await vi.advanceTimersByTimeAsync(0);
    // The reap is still asking the service: the drain must not be over yet.
    expect(events).toEqual([]);

    events.push("reap finished");
    reap.release({ reaped: [{} as never], declined: null });
    await drained;
    expect(events).toEqual([
      "reap finished",
      "reaped orphan processes under memory pressure reaped=1",
      "settled",
    ]);

    // Stopped and drained: no timer is left to start another reap.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reap.pending()).toBe(0);
    expect(events).toHaveLength(3);
  });

  it("waits for a tick that starts while it is already waiting", async () => {
    const events: string[] = [];
    const reap = gatedReap();
    const watch = createAutoReapWatch(reap.service, { log: into(events) });
    void watch.tick();
    const drained = watch.settled().then(() => events.push("settled"));
    void watch.tick();
    expect(reap.pending()).toBe(2);

    reap.release({ reaped: [], declined: null });
    // A macrotask flushes every microtask: the first reap is long done.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);

    reap.fail(new Error("lsof refused"));
    await drained;
    // A failed reap keeps its existing log line, and the drain still ends.
    expect(events).toEqual(["automatic orphan sweep failed error=lsof refused", "settled"]);
  });

  it("a tick that rejects still rejects to its caller, and never fails the drain", async () => {
    const reap = gatedReap();
    const watch = createAutoReapWatch(reap.service, {
      log: () => {
        throw new Error("log sink gone");
      },
    });
    const ticked = watch.tick();
    const drained = watch.settled();
    reap.fail(new Error("lsof refused"));
    await expect(ticked).rejects.toThrow("log sink gone");
    await expect(drained).resolves.toBeUndefined();
    await expect(watch.settled()).resolves.toBeUndefined();
  });
});
