import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createHostLifecycle,
  HostStoppedError,
  type HostLifecyclePorts,
  type HostLifecycleStep,
} from "./host-lifecycle";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets every queued continuation run, without a timer. */
async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function recordingPorts(overrides: Partial<HostLifecyclePorts> = {}) {
  const calls: string[] = [];
  const failures: Array<{ step: HostLifecycleStep; error: unknown }> = [];
  const ports: HostLifecyclePorts = {
    start: () => {
      calls.push("start");
    },
    stopProducers: () => {
      calls.push("stop-producers");
    },
    stopMaintenance: () => {
      calls.push("stop-maintenance");
    },
    closeRuntime: async () => {
      calls.push("close-runtime");
    },
    closeSocket: async () => {
      calls.push("close-socket");
    },
    drainDetached: async () => {
      calls.push("drain-detached");
    },
    stopActivity: () => {
      calls.push("stop-activity");
    },
    closeDatabase: () => {
      calls.push("close-database");
    },
    reportFailure: (step, error) => {
      calls.push(`failed:${step}`);
      failures.push({ step, error });
    },
    ...overrides,
  };
  return { ports, calls, failures };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("host lifecycle start", () => {
  it("runs the start port once and answers every call with the same promise", async () => {
    const { ports, calls } = recordingPorts();
    const host = createHostLifecycle(ports);
    expect(host.state()).toBe("idle");
    const first = host.start();
    expect(host.state()).toBe("starting");
    expect(host.start()).toBe(first);
    await first;
    expect(host.state()).toBe("running");
    await host.start();
    expect(calls).toEqual(["start"]);
  });

  it("rejects to its caller and records a failed start, which a stop still tears down", async () => {
    const failure = new Error("migration failed");
    const { ports, calls, failures } = recordingPorts({
      start: async () => {
        calls.push("start");
        throw failure;
      },
    });
    const host = createHostLifecycle(ports);
    await expect(host.start()).rejects.toBe(failure);
    expect(host.state()).toBe("failed");
    await expect(host.start()).rejects.toBe(failure);
    const report = await host.stop("boot failed");
    // The start's rejection reached its caller; it does not make the stop unclean.
    expect(report).toEqual({ reason: "boot failed", clean: true });
    expect(failures).toEqual([]);
    expect(calls).toEqual([
      "start",
      "stop-producers",
      "stop-maintenance",
      "close-runtime",
      "close-socket",
      "drain-detached",
      "stop-activity",
      "close-database",
    ]);
  });

  it("refuses a start once a stop has begun, without running the start port", async () => {
    const { ports, calls } = recordingPorts();
    const host = createHostLifecycle(ports);
    const stopped = host.stop("signal");
    await expect(host.start()).rejects.toBeInstanceOf(HostStoppedError);
    await stopped;
    await expect(host.start()).rejects.toThrow("The host is stopping.");
    expect(calls).not.toContain("start");
    expect(host.state()).toBe("stopped");
  });

  it("refuses a start asked from inside a producer stop", async () => {
    let inner: Promise<void> | undefined;
    const { ports, calls } = recordingPorts();
    const host = createHostLifecycle({
      ...ports,
      stopProducers: () => {
        calls.push("stop-producers");
        inner = host.start();
      },
    });
    await host.stop("quit");
    await expect(inner).rejects.toBeInstanceOf(HostStoppedError);
    expect(calls).not.toContain("start");
  });
});

describe("host lifecycle stop", () => {
  it.each(["desktop-quit", "drain-and-close"] as const)(
    "%s warns once with the first unclean-step reason, without changing the stop",
    async (policy) => {
      const warn = vi.fn();
      const stamp = vi.fn();
      const { ports } = recordingPorts({
        closeRuntime: async () => false,
        closeSocket: async () => {
          throw new Error("socket failed");
        },
        stampCleanClose: stamp,
        reportSkippedCleanClose: warn,
      });
      const host = createHostLifecycle(ports, policy);
      expect(await host.stop("quit")).toEqual({ reason: "quit", clean: false });
      await host.stop("repeat");
      host.warnIfCleanCloseSkipped("shutdown deadline expired");
      expect(warn).toHaveBeenCalledExactlyOnceWith("quit: close-runtime reported an unclean stop");
      expect(stamp).not.toHaveBeenCalled();
    },
  );

  it("warns once when a lifecycle step throws", async () => {
    const warn = vi.fn();
    const { ports } = recordingPorts({
      stopProducers: () => {
        throw new Error("scheduler failed");
      },
      stampCleanClose: vi.fn(),
      reportSkippedCleanClose: warn,
    });
    expect((await createHostLifecycle(ports).stop("SIGTERM")).clean).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "SIGTERM: stop-producers failed: scheduler failed",
    );
  });

  it("warns once about a deadline while the drain remains pending, then observes a late failure", async () => {
    const close = deferred();
    const warn = vi.fn();
    const stamp = vi.fn();
    const { ports } = recordingPorts({
      closeRuntime: () => close.promise,
      stampCleanClose: stamp,
      reportSkippedCleanClose: warn,
    });
    const host = createHostLifecycle(ports, "desktop-quit");
    const stopped = host.stop("quit");
    await settleMicrotasks();
    host.warnIfCleanCloseSkipped("quit: shutdown deadline expired after 15000ms");
    host.warnIfCleanCloseSkipped("repeat deadline");
    expect(warn).toHaveBeenCalledExactlyOnceWith("quit: shutdown deadline expired after 15000ms");
    expect(host.state()).toBe("stopping");
    expect(stamp).not.toHaveBeenCalled();
    close.reject(new Error("late close error"));
    expect((await stopped).clean).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a deadline warning never suppresses a late successful stamp", async () => {
    const close = deferred();
    const warn = vi.fn();
    const stamp = vi.fn();
    const { ports } = recordingPorts({
      closeRuntime: () => close.promise,
      stampCleanClose: stamp,
      reportSkippedCleanClose: warn,
    });
    const host = createHostLifecycle(ports);
    const stopped = host.stop("quit");
    host.warnIfCleanCloseSkipped("shutdown deadline expired");
    close.resolve();
    expect((await stopped).clean).toBe(true);
    expect(stamp).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not warn about a late deadline or DB-close error when the watermark was stamped", async () => {
    const warn = vi.fn();
    const { ports } = recordingPorts({
      stampCleanClose: vi.fn(),
      reportSkippedCleanClose: warn,
      closeDatabase: () => {
        throw new Error("database busy");
      },
    });
    const host = createHostLifecycle(ports);
    expect((await host.stop("quit")).clean).toBe(false);
    host.warnIfCleanCloseSkipped("other shutdown task exceeded deadline");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns if stamping is unavailable without changing the stop's result", async () => {
    const warn = vi.fn();
    const { ports } = recordingPorts({ reportSkippedCleanClose: warn });
    expect((await createHostLifecycle(ports).stop("quit")).clean).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith("quit: clean-close stamping is unavailable");
  });

  it("a failed warning reporter cannot change teardown or its result", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ports, calls } = recordingPorts({
      reportSkippedCleanClose: () => {
        throw new Error("logger failed");
      },
    });
    expect((await createHostLifecycle(ports).stop("quit")).clean).toBe(true);
    expect(calls.at(-1)).toBe("close-database");
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      "[host] failed to report a skipped clean-close watermark",
      { error: expect.objectContaining({ name: "Error", message: "logger failed" }) },
    );
  });

  it.each(["desktop-quit", "drain-and-close"] as const)(
    "%s stamps only after a clean drain, before any database close",
    async (policy) => {
      const { ports, calls } = recordingPorts({ stampCleanClose: () => calls.push("stamp") });
      await createHostLifecycle(ports, policy).stop("quit");
      expect(calls.indexOf("stamp")).toBeGreaterThan(calls.indexOf("stop-activity"));
      if (policy === "drain-and-close") {
        expect(calls.indexOf("stamp")).toBeGreaterThan(calls.indexOf("drain-detached"));
        expect(calls.indexOf("stamp")).toBeLessThan(calls.indexOf("close-database"));
      }
    },
  );

  it("does not stamp an unclean drain", async () => {
    const stampCleanClose = vi.fn();
    const { ports } = recordingPorts({ closeRuntime: async () => false, stampCleanClose });
    await createHostLifecycle(ports).stop("quit");
    expect(stampCleanClose).not.toHaveBeenCalled();
  });

  it("reports a failed stamp but still closes the database", async () => {
    const warn = vi.fn();
    const error = new Error("stamp unavailable");
    const { ports, calls, failures } = recordingPorts({
      reportSkippedCleanClose: warn,
      stampCleanClose: () => {
        throw error;
      },
    });
    expect((await createHostLifecycle(ports).stop("quit")).clean).toBe(false);
    expect(failures).toEqual([{ step: "stamp-clean-close", error }]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "quit: stamp-clean-close failed: stamp unavailable",
    );
    expect(calls.at(-1)).toBe("close-database");
  });
  it("desktop quit adds no start/detached joins or database close", async () => {
    const boot = deferred();
    const { ports, calls } = recordingPorts({
      start: () => boot.promise,
      drainDetached: () => new Promise(() => {}),
    });
    const host = createHostLifecycle(ports, "desktop-quit");
    const started = host.start();
    expect(await host.stop("quit")).toEqual({ reason: "quit", clean: true });
    expect(calls).toEqual([
      "stop-producers",
      "stop-maintenance",
      "close-runtime",
      "close-socket",
      "stop-activity",
    ]);
    expect(host.state()).toBe("stopped");
    boot.resolve();
    await started;
    expect(host.state()).toBe("stopped");
  });

  it("stops producers synchronously, in the stop call's own frame", () => {
    const { ports, calls } = recordingPorts({
      closeRuntime: () => new Promise(() => {}),
    });
    const host = createHostLifecycle(ports);
    void host.stop("quit");
    expect(host.state()).toBe("stopping");
    expect(calls).toEqual(["stop-producers", "stop-maintenance"]);
  });

  it("closes runtime and socket concurrently, then detached work, activity and the database", async () => {
    const runtime = deferred();
    const socket = deferred();
    const { ports, calls } = recordingPorts({
      closeRuntime: () => {
        calls.push("close-runtime");
        return runtime.promise;
      },
      closeSocket: () => {
        calls.push("close-socket");
        return socket.promise;
      },
    });
    const host = createHostLifecycle(ports);
    const stopped = host.stop("quit");
    await settleMicrotasks();
    expect(calls).toEqual(["stop-producers", "stop-maintenance", "close-runtime", "close-socket"]);
    socket.resolve();
    await settleMicrotasks();
    // The socket alone does not release the database: the runtime may still write.
    expect(calls).not.toContain("drain-detached");
    runtime.resolve();
    expect(await stopped).toEqual({ reason: "quit", clean: true });
    expect(calls).toEqual([
      "stop-producers",
      "stop-maintenance",
      "close-runtime",
      "close-socket",
      "drain-detached",
      "stop-activity",
      "close-database",
    ]);
    expect(host.state()).toBe("stopped");
  });

  it("runs nothing beside the runtime when the host has no socket port", async () => {
    const { ports, calls } = recordingPorts({ closeSocket: undefined });
    const host = createHostLifecycle(ports);
    await host.stop("sigterm");
    expect(calls).toEqual([
      "stop-producers",
      "stop-maintenance",
      "close-runtime",
      "drain-detached",
      "stop-activity",
      "close-database",
    ]);
  });

  it("answers every stop with the first one's promise and reason", async () => {
    const { ports, calls } = recordingPorts();
    const host = createHostLifecycle(ports);
    const first = host.stop("sigterm");
    expect(host.stop("sigint")).toBe(first);
    expect(await first).toEqual({ reason: "sigterm", clean: true });
    expect(await host.stop("again")).toEqual({ reason: "sigterm", clean: true });
    expect(calls.filter((call) => call === "close-database")).toHaveLength(1);
  });

  it("joins an in-flight start after the runtime close unblocks it, before draining", async () => {
    const boot = deferred();
    const { ports, calls } = recordingPorts({
      start: () => {
        calls.push("start");
        return boot.promise;
      },
      closeRuntime: async () => {
        calls.push("close-runtime");
        // Closing the runtime is what releases a boot waiting on recovery.
        boot.reject(new Error("closing"));
      },
    });
    const host = createHostLifecycle(ports);
    const started = host.start();
    const stopped = host.stop("quit");
    await expect(started).rejects.toThrow("closing");
    // A start that fails because the host is stopping is not a failed host.
    expect(host.state()).not.toBe("failed");
    expect(await stopped).toEqual({ reason: "quit", clean: true });
    expect(calls.indexOf("close-runtime")).toBeLessThan(calls.indexOf("drain-detached"));
  });

  it("waits for a start still running when no close unblocks it", async () => {
    const boot = deferred();
    const { ports, calls } = recordingPorts({
      start: () => {
        calls.push("start");
        return boot.promise;
      },
    });
    const host = createHostLifecycle(ports);
    void host.start();
    const stopped = host.stop("quit");
    await settleMicrotasks();
    expect(calls).not.toContain("drain-detached");
    boot.resolve();
    await stopped;
    expect(calls.at(-1)).toBe("close-database");
    // A boot that finished during the stop does not flip the host back to running.
    expect(host.state()).toBe("stopped");
  });

  it("keeps going after every failing step and reports each one", async () => {
    const errors = {
      producers: new Error("scheduler"),
      maintenance: new Error("retention"),
      runtime: new Error("runtime"),
      socket: new Error("socket"),
      detached: new Error("trim"),
      activity: new Error("activity"),
      database: new Error("busy"),
    };
    const { ports, calls, failures } = recordingPorts({
      stopProducers: () => {
        throw errors.producers;
      },
      stopMaintenance: () => {
        throw errors.maintenance;
      },
      closeRuntime: async () => {
        throw errors.runtime;
      },
      closeSocket: () => Promise.reject(errors.socket),
      drainDetached: async () => {
        throw errors.detached;
      },
      stopActivity: () => {
        throw errors.activity;
      },
      closeDatabase: () => {
        throw errors.database;
      },
    });
    const host = createHostLifecycle(ports);
    expect(await host.stop("quit")).toEqual({ reason: "quit", clean: false });
    expect(failures).toEqual([
      { step: "stop-producers", error: errors.producers },
      { step: "stop-maintenance", error: errors.maintenance },
      { step: "close-runtime", error: errors.runtime },
      { step: "close-socket", error: errors.socket },
      { step: "drain-detached", error: errors.detached },
      { step: "stop-activity", error: errors.activity },
      { step: "close-database", error: errors.database },
    ]);
    expect(calls).toHaveLength(7);
  });

  it("reports a socket rejection as it happens, while still waiting for the runtime", async () => {
    const runtime = deferred();
    const failure = new Error("socket");
    const { ports, calls } = recordingPorts({
      closeRuntime: () => runtime.promise,
      closeSocket: () => Promise.reject(failure),
    });
    const host = createHostLifecycle(ports);
    const stopped = host.stop("quit");
    await settleMicrotasks();
    expect(calls).toEqual(["stop-producers", "stop-maintenance", "failed:close-socket"]);
    runtime.resolve();
    expect((await stopped).clean).toBe(false);
    expect(calls.at(-1)).toBe("close-database");
  });

  it("treats a step that answers false as unclean without reporting it again", async () => {
    for (const port of ["closeRuntime", "closeSocket", "drainDetached"] as const) {
      const { ports, failures } = recordingPorts({ [port]: async () => false });
      expect((await createHostLifecycle(ports).stop("quit")).clean).toBe(false);
      expect(failures).toEqual([]);
    }
    const { ports, failures } = recordingPorts({ closeDatabase: () => false });
    expect((await createHostLifecycle(ports).stop("quit")).clean).toBe(false);
    expect(failures).toEqual([]);
  });

  it("still closes the database when the failure reporter itself throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ports, calls } = recordingPorts({
      closeRuntime: async () => {
        throw new Error("runtime");
      },
      reportFailure: () => {
        throw new Error("logger gone");
      },
    });
    const report = await createHostLifecycle(ports).stop("quit");
    expect(report.clean).toBe(false);
    expect(calls.at(-1)).toBe("close-database");
    expect(consoleError).toHaveBeenCalledWith("[host] failed to report a shutdown step failure", {
      step: "close-runtime",
      error: expect.objectContaining({ name: "Error", message: "logger gone" }),
    });
  });
});
