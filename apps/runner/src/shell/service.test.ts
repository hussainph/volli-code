import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

import { BootError, EXIT_CONFIG } from "./boot-error";
import type { ShellLogger } from "./log";
import { drain, runService, SHUTDOWN_DEADLINE_MS, type ServiceProcess } from "./service";

type LogFn = ShellLogger["info"];

function harness() {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const target: ServiceProcess = {
    on: (event: string, listener: (value: never) => void) =>
      emitter.on(event, listener as (...args: unknown[]) => void),
    exit: (code: number) => {
      exits.push(code);
    },
  };
  const logger = {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };
  return {
    emitter,
    exits,
    timers,
    logger,
    options: {
      logger,
      process: target,
      setTimer: (run: () => void, ms: number) => timers.push({ run, ms }),
    },
  };
}

const settle = () => new Promise((done) => setImmediate(done));

describe("running a service", () => {
  it("exits 0 after a clean stop on SIGTERM, and arms the deadline", async () => {
    const h = harness();
    const stop = vi.fn((_reason: string) => Promise.resolve(true));
    const code = runService({ ...h.options, start: async () => ({ stop }) });
    await settle();
    h.emitter.emit("SIGTERM");
    expect(await code).toBe(0);
    expect(stop).toHaveBeenCalledWith("SIGTERM");
    expect(h.timers.map((timer) => timer.ms)).toEqual([SHUTDOWN_DEADLINE_MS]);
    // The deadline, when it fires, exits 1 whatever the stop is doing.
    h.timers[0]!.run();
    expect(h.exits).toEqual([1]);
    expect(h.logger.error).toHaveBeenCalledWith("shutdown deadline passed; exiting", {
      deadlineMs: SHUTDOWN_DEADLINE_MS,
    });
  });

  it("exits at once on a second signal", async () => {
    const h = harness();
    const code = runService({
      ...h.options,
      deadlineMs: 5,
      start: async () => ({ stop: () => new Promise<boolean>(() => {}) }),
    });
    await settle();
    h.emitter.emit("SIGINT");
    h.emitter.emit("SIGTERM");
    expect(h.exits).toEqual([1]);
    expect(h.timers.map((timer) => timer.ms)).toEqual([5]);
    void code;
  });

  it("exits 1 when the stop was not clean, or failed", async () => {
    const unclean = harness();
    const first = runService({
      ...unclean.options,
      start: async () => ({ stop: async () => false }),
    });
    await settle();
    unclean.emitter.emit("SIGTERM");
    expect(await first).toBe(1);

    const failing = harness();
    const second = runService({
      ...failing.options,
      start: async () => ({ stop: () => Promise.reject(new Error("stuck")) }),
    });
    await settle();
    failing.emitter.emit("SIGTERM");
    expect(await second).toBe(1);
    expect(failing.logger.error).toHaveBeenCalledWith("shutdown failed", {
      error: expect.any(Error),
    });
  });

  it("stops non-zero on an uncaught exception or an unhandled rejection", async () => {
    for (const [event, payload] of [
      ["uncaughtException", new Error("boom")],
      ["unhandledRejection", "nope"],
    ] as const) {
      const h = harness();
      const stop = vi.fn(async () => true);
      const code = runService({ ...h.options, start: async () => ({ stop }) });
      await settle();
      h.emitter.emit(event, payload);
      // A later signal is folded into the stop already under way.
      h.emitter.emit("SIGTERM");
      expect(await code).toBe(1);
      expect(stop).toHaveBeenCalledTimes(1);
    }
  });

  it("waits for boot before stopping when asked to stop during it", async () => {
    const h = harness();
    let booted!: () => void;
    const stop = vi.fn(async () => true);
    const code = runService({
      ...h.options,
      start: () =>
        new Promise((resolve) => {
          booted = () => resolve({ stop });
        }),
    });
    h.emitter.emit("SIGTERM");
    expect(stop).not.toHaveBeenCalled();
    booted();
    expect(await code).toBe(0);
    expect(stop).toHaveBeenCalledWith("SIGTERM");
  });

  it("answers EX_CONFIG for a boot refusal and 1 for any other boot failure", async () => {
    const refused = harness();
    expect(
      await runService({
        ...refused.options,
        start: () => Promise.reject(new BootError("data-dir", "bad dir", { dataDir: "/d" })),
      }),
    ).toBe(EXIT_CONFIG);
    expect(refused.logger.error).toHaveBeenCalledWith("bad dir", {
      reason: "data-dir",
      dataDir: "/d",
    });

    const failed = harness();
    expect(
      await runService({ ...failed.options, start: () => Promise.reject(new Error("x")) }),
    ).toBe(1);
    expect(failed.logger.error).toHaveBeenCalledWith("boot failed", {
      error: expect.any(Error),
      stack: expect.any(String),
    });
  });

  it("uses the real process and timer by default", async () => {
    const events = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"] as const;
    const before = new Map(events.map((event) => [event, process.listeners(event)]));
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as never);
    try {
      const code = runService({
        logger: harness().logger,
        start: async () => ({ stop: async () => true }),
      });
      await settle();
      process.emit("SIGTERM");
      expect(await code).toBe(0);
      expect(timer).toHaveBeenCalledWith(expect.any(Function), SHUTDOWN_DEADLINE_MS);
    } finally {
      timer.mockRestore();
      for (const event of events) {
        for (const listener of process.listeners(event)) {
          if (!before.get(event)!.includes(listener))
            process.removeListener(event, listener as never);
        }
      }
    }
  });
});

describe("draining requests", () => {
  it("is done at once with none, and when they settle in time", async () => {
    expect(await drain(new Set(), 10)).toBe(true);
    expect(await drain(new Set([Promise.resolve(1), Promise.reject(new Error("x"))]), 1_000)).toBe(
      true,
    );
  });

  it("gives up at the timeout", async () => {
    expect(await drain(new Set([new Promise(() => {})]), 5)).toBe(false);
  });
});
