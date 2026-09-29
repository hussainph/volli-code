import { describe, expect, it } from "vitest";

import { BUSY_LOAD_PROFILE, busyLoadName, startBusyLoad } from "./background-load.mjs";

describe("fixed-duration background load", () => {
  it("runs every worker to one shared deadline and records expiry metadata", async () => {
    const load = await startBusyLoad(1, 40, { warmupMs: 0 });
    const summary = await load.finish({ completeExposure: true, reason: "unused" });

    expect(load.name).toBe("1-busy-core-for-40ms");
    expect(summary).toMatchObject({
      profile: BUSY_LOAD_PROFILE,
      configuredDurationMs: 40,
      warmupMs: 0,
      completion: "fixed-duration-complete",
    });
    expect(summary.exposureDurationMs).toBeGreaterThanOrEqual(40);
    expect(summary.workers).toEqual([
      expect.objectContaining({
        index: 0,
        ready: true,
        expired: true,
        stopped: false,
        exitCode: 0,
      }),
    ]);
  });

  it("makes a quick-smoke early stop explicit instead of waiting for the deadline", async () => {
    const load = await startBusyLoad(1, 10_000, { warmupMs: 0 });
    const started = performance.now();
    const summary = await load.finish({
      completeExposure: false,
      reason: "quick-smoke-early-stop",
    });

    expect(busyLoadName(1, 10_000)).toBe("1-busy-core-for-10s");
    expect(summary.completion).toBe("quick-smoke-early-stop");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(summary.workers[0]).toMatchObject({ stopped: true, expired: false, exitCode: 0 });
  });

  it("rejects a measurement that reaches load expiry", async () => {
    const load = await startBusyLoad(1, 30, { warmupMs: 0 });
    await expect(
      load.run(
        "overrun probe",
        (signal) =>
          new Promise((resolvePromise) => {
            signal.addEventListener("abort", resolvePromise, { once: true });
          }),
      ),
    ).rejects.toThrow("background load unavailable during overrun probe");
    await load.finish({ completeExposure: false, reason: "failed-arm-early-stop" });
  });
});
