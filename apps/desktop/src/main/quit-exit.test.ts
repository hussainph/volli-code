import { captureHostLog, type CapturedHostLog } from "@volli/host-core/testing";
import type { QuitExitDecision } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createQuitExit, type QuitExitPorts } from "./quit-exit";

/** `quit-exit.ts`'s grace for live workers, and its bound on its own writes. */
const WORKER_SETTLE_GRACE_MS = 1_000;
const IMMEDIATE_EXIT_FLUSH_MS = 2_000;

let log: CapturedHostLog | undefined;
afterEach(() => {
  log?.restore();
  log = undefined;
  vi.useRealTimers();
});

function ports(
  overrides: Partial<QuitExitPorts> = {},
): QuitExitPorts & { order: string[]; disarm: ReturnType<typeof vi.fn>; startWorker(): void } {
  const order: string[] = [];
  const listeners = new Set<() => void>();
  const disarm = vi.fn(() => {
    order.push("disarm");
  });
  return {
    order,
    disarm,
    startWorker: () => {
      for (const listener of listeners) listener();
    },
    now: () => 1000,
    liveWorkers: () => 0,
    endReadOnlyWorkers: vi.fn(() => {
      order.push("end");
      return 0;
    }),
    settleWorkers: vi.fn(async () => {
      order.push("settle");
    }),
    decide: vi.fn((): QuitExitDecision => "exit"),
    flush: vi.fn(async () => {
      order.push("flush");
    }),
    flushLog: vi.fn(async () => {
      order.push("flushLog");
    }),
    runExitHandlers: vi.fn(() => {
      order.push("exitHandlers");
    }),
    kill: vi.fn(() => {
      order.push("kill");
    }),
    stopChildren: vi.fn(() => {
      order.push("stopChildren");
    }),
    watchAvailable: vi.fn(() => true),
    watchExit: vi.fn(() => {
      order.push("watch");
      return { disarm };
    }),
    onWorkerStarted: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    ...overrides,
  };
}

function app(order: string[]) {
  return {
    name: "app",
    exit: vi.fn((code?: number) => {
      order.push(`app.exit(${code})`);
    }),
    getName(this: { name: string }) {
      return this.name;
    },
  };
}

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createQuitExit: the exit", () => {
  it("with no worker running, writes first, then watches the ordinary exit, and says so", async () => {
    log = captureHostLog("info");
    const p = ports();
    const target = app(p.order);
    const quit = createQuitExit(p);
    quit.accepted("update-install");
    quit.exitingApp(target).exit(0);
    await settled();
    // Everything that awaits first; the watch and the REAL exit last, in one tick,
    // so its grace is Electron's native shutdown only.
    expect(p.order).toEqual(["flush", "stopChildren", "flushLog", "watch", "app.exit(0)"]);
    expect(p.settleWorkers).not.toHaveBeenCalled();
    expect(p.endReadOnlyWorkers).not.toHaveBeenCalled();
    expect(p.decide).toHaveBeenCalledWith({ claim: true });
    expect(log.records).toContainEqual(
      expect.objectContaining({
        component: "quit",
        msg: "quit accepted",
        reason: "update-install",
      }),
    );
    expect(log.records).toContainEqual(
      expect.objectContaining({
        component: "quit",
        msg: "exit call",
        mode: "normal",
        liveWorkers: 0,
        sinceQuitMs: 0,
        afterDeadline: false,
        watch: "armed",
      }),
    );
  });

  it("gives live workers the grace first, and exits as before if they wait: no write, no watch", async () => {
    const p = ports({ liveWorkers: () => 1 });
    const quit = createQuitExit(p);
    quit.exitingApp(app(p.order)).exit(3);
    await settled();
    expect(p.settleWorkers).toHaveBeenCalledWith(WORKER_SETTLE_GRACE_MS);
    expect(p.order).toEqual(["end", "settle", "flushLog", "app.exit(3)"]);
    expect(p.watchExit).not.toHaveBeenCalled();
    expect(p.stopChildren).not.toHaveBeenCalled();
  });

  it("never watches an exit while an upgrade runs", async () => {
    const p = ports({ liveWorkers: () => 1, decide: vi.fn(() => "finish-upgrade-first" as const) });
    createQuitExit(p).exitingApp(app(p.order)).exit(0);
    await settled();
    expect(p.watchExit).not.toHaveBeenCalled();
    expect(p.kill).not.toHaveBeenCalled();
    expect(p.order.at(-1)).toBe("app.exit(0)");
  });

  it("watches the exit when the live workers ended during the grace", async () => {
    let live = 1;
    const p = ports({
      liveWorkers: () => live,
      settleWorkers: vi.fn(async () => {
        live = 0;
      }),
    });
    createQuitExit(p).exitingApp(app(p.order)).exit(0);
    await settled();
    expect(p.order).toEqual(["end", "flush", "stopChildren", "flushLog", "watch", "app.exit(0)"]);
  });

  it("does not watch when a worker starts during its writes, and says the exit changed", async () => {
    log = captureHostLog("info");
    let live = 0;
    const p = ports({
      liveWorkers: () => live,
      flush: vi.fn(async () => {
        live = 1;
      }),
    });
    createQuitExit(p).exitingApp(app(p.order)).exit(0);
    await settled();
    expect(p.watchExit).not.toHaveBeenCalled();
    expect(p.order.at(-1)).toBe("app.exit(0)");
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "exit call", mode: "normal", changed: true, liveWorkers: 1 }),
    );
  });

  it("exits unwatched, and says so, when the watch does not start", async () => {
    log = captureHostLog("info");
    const p = ports({ watchExit: vi.fn(() => null) });
    const target = app(p.order);
    createQuitExit(p).exitingApp(target).exit(0);
    await settled();
    expect(target.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(p.onWorkerStarted).not.toHaveBeenCalled();
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "exit watch failed", code: "spawn-failed" }),
    );
  });

  it("on a platform without the watch, still writes and stops children, and says unavailable", async () => {
    log = captureHostLog("info");
    const p = ports({ watchAvailable: vi.fn(() => false) });
    createQuitExit(p).exitingApp(app(p.order)).exit(0);
    await settled();
    expect(p.order).toEqual(["flush", "stopChildren", "flushLog", "app.exit(0)"]);
    expect(p.watchExit).not.toHaveBeenCalled();
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "exit call", mode: "normal", watch: "unavailable" }),
    );
  });

  it("does not arm when a worker starts while the log is written", async () => {
    log = captureHostLog("info");
    let live = 0;
    const p = ports({
      liveWorkers: () => live,
      flushLog: vi.fn(async () => {
        live = 1;
      }),
    });
    const target = app(p.order);
    createQuitExit(p).exitingApp(target).exit(0);
    await settled();
    expect(p.watchExit).not.toHaveBeenCalled();
    expect(target.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "exit watch not armed", reason: "worker-started" }),
    );
  });

  it.each([0, 1])("exits though the log's write fails (%i live workers)", async (liveWorkers) => {
    const p = ports({
      liveWorkers: () => liveWorkers,
      flushLog: () => Promise.reject(new Error("disk gone")),
    });
    const target = app(p.order);
    createQuitExit(p).exitingApp(target).exit(0);
    await settled();
    expect(target.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("goes on to the exit when stopping children throws", async () => {
    const p = ports({
      stopChildren: vi.fn(() => {
        throw new Error("EPERM");
      }),
    });
    const target = app(p.order);
    createQuitExit(p).exitingApp(target).exit(0);
    await settled();
    expect(p.watchExit).toHaveBeenCalledOnce();
    expect(target.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("writes the log before an exit that falls back from the immediate one", async () => {
    let asked = 0;
    const p = ports({
      liveWorkers: () => 1,
      decide: vi.fn(() => (++asked >= 2 ? ("exit" as const) : ("exit-now" as const))),
    });
    createQuitExit(p).exitingApp(app(p.order)).exit(0);
    await settled();
    expect(p.order.slice(-2)).toEqual(["flushLog", "app.exit(0)"]);
  });

  it("disarms the watch once when a worker starts after the exit call", async () => {
    log = captureHostLog("info");
    const p = ports();
    createQuitExit(p).exitingApp(app(p.order)).exit(0);
    await settled();
    expect(p.disarm).not.toHaveBeenCalled();
    p.startWorker();
    p.startWorker();
    expect(p.disarm).toHaveBeenCalledOnce();
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "exit watch disarmed", reason: "worker-started" }),
    );
  });

  it("never lets its writes hold the ordinary exit either", async () => {
    vi.useFakeTimers();
    const p = ports({ flush: () => new Promise(() => undefined) });
    const target = app(p.order);
    createQuitExit(p).exitingApp(target).exit(0);
    await vi.advanceTimersByTimeAsync(IMMEDIATE_EXIT_FLUSH_MS - 1);
    expect(target.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(p.order).toEqual(["stopChildren", "flushLog", "watch", "app.exit(0)"]);
  });

  it("ends the process itself once only read-only workers remain, after its own writes", async () => {
    log = captureHostLog("info");
    const p = ports({ liveWorkers: () => 2, decide: vi.fn(() => "exit-now" as const) });
    const target = app(p.order);
    createQuitExit(p).exitingApp(target).exit();
    await settled();
    // The exit listeners before the log's tail, so what they log is kept.
    expect(p.order).toEqual(["end", "settle", "flush", "exitHandlers", "flushLog", "kill"]);
    expect(target.exit).not.toHaveBeenCalled();
    expect(p.runExitHandlers).toHaveBeenCalledWith(0);
    // Asked before the writes, after them, and in the same tick as the kill.
    expect(p.decide).toHaveBeenCalledTimes(3);
    expect(p.decide).toHaveBeenNthCalledWith(3, { claim: true });
    expect(log.records).toContainEqual(
      expect.objectContaining({
        msg: "exit call",
        mode: "immediate",
        liveWorkers: 2,
        sinceQuitMs: null,
      }),
    );
  });

  it.each([2, 3])(
    "turns the kill into the ordinary exit when a worker it may not end starts meanwhile (answer %i)",
    async (changesAt) => {
      log = captureHostLog("info");
      let asked = 0;
      const p = ports({
        liveWorkers: () => 1,
        decide: vi.fn(() => (++asked >= changesAt ? ("exit" as const) : ("exit-now" as const))),
      });
      const target = app(p.order);
      createQuitExit(p).exitingApp(target).exit(0);
      await settled();
      expect(p.kill).not.toHaveBeenCalled();
      expect(target.exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(p.order.at(-1)).toBe("app.exit(0)");
      expect(log.records).toContainEqual(
        expect.objectContaining({ msg: "exit call", mode: "normal", changed: true }),
      );
    },
  );

  it("says when the exit comes after the drain's deadline", async () => {
    log = captureHostLog("info");
    const p = ports();
    const quit = createQuitExit(p);
    quit.accepted("quit");
    quit.drained(true);
    quit.exitingApp(app(p.order)).exit(0);
    await settled();
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "exit call", mode: "normal", afterDeadline: true }),
    );
  });

  it("never lets its own writes hold the exit: bounded, failures ignored, the kill always runs", async () => {
    vi.useFakeTimers();
    const p = ports({
      decide: () => "exit-now",
      flush: () => new Promise(() => undefined),
      flushLog: () => Promise.reject(new Error("log gone")),
      runExitHandlers: () => {
        throw new Error("a listener threw");
      },
    });
    createQuitExit(p).exitingApp(app(p.order)).exit(0);
    await vi.advanceTimersByTimeAsync(IMMEDIATE_EXIT_FLUSH_MS - 1);
    expect(p.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(p.kill).toHaveBeenCalledOnce();
  });

  it("survives a flush that rejects", async () => {
    const p = ports({ decide: () => "exit-now", flush: () => Promise.reject(new Error("gone")) });
    createQuitExit(p).exitingApp(app(p.order)).exit(0);
    await settled();
    expect(p.kill).toHaveBeenCalledOnce();
  });

  it("exits once however often it is asked, and leaves the rest of app as it was", async () => {
    const p = ports();
    const target = app(p.order);
    const wrapped = createQuitExit(p).exitingApp(target);
    wrapped.exit(0);
    wrapped.exit(0);
    await settled();
    expect(target.exit).toHaveBeenCalledOnce();
    expect(wrapped.getName()).toBe("app");
    expect(wrapped.name).toBe("app");
  });
});

describe("createQuitExit: the timeline", () => {
  it("records the first acceptance only, and the drain from it", () => {
    log = captureHostLog("info");
    let now = 100;
    const quit = createQuitExit(ports({ now: () => now }));
    quit.drained(false);
    quit.accepted("quit");
    now = 350;
    quit.accepted("update-install");
    quit.drained(true);
    const lines = log.records.filter((record) => record.component === "quit");
    expect(lines).toEqual([
      expect.objectContaining({
        msg: "shutdown drained",
        durationMs: null,
        deadlineExpired: false,
      }),
      expect.objectContaining({ msg: "quit accepted", reason: "quit" }),
      expect.objectContaining({ msg: "shutdown drained", durationMs: 250, deadlineExpired: true }),
    ]);
  });
});

describe("createQuitExit: an upgrade holds the quit", () => {
  it("lets a quit through when no upgrade runs", () => {
    const quit = createQuitExit(ports());
    const event = { preventDefault: vi.fn() };
    const hold = { reason: vi.fn(() => "quit" as const), showWaiting: vi.fn(), quit: vi.fn() };
    expect(quit.holdForUpgrade(event, hold)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(hold.showWaiting).not.toHaveBeenCalled();
    expect(quit.quitting()).toBe(false);
  });

  it("holds every quit while the upgrade runs, shows the wait once, and quits again after", async () => {
    log = captureHostLog("info");
    let upgrading = true;
    let finishUpgrade!: () => void;
    const settle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishUpgrade = () => {
            upgrading = false;
            resolve();
          };
        }),
    );
    const quit = createQuitExit(
      ports({
        decide: vi.fn(() => (upgrading ? "finish-upgrade-first" : "exit")),
        settleWorkers: settle,
      }),
    );
    const hold = { reason: vi.fn(() => "quit" as const), showWaiting: vi.fn(), quit: vi.fn() };
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };
    expect(quit.holdForUpgrade(first, hold)).toBe(true);
    expect(quit.holdForUpgrade(second, hold)).toBe(true);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(hold.showWaiting).toHaveBeenCalledOnce();
    expect(quit.quitting()).toBe(true);
    await settled();
    expect(hold.quit).not.toHaveBeenCalled();
    finishUpgrade();
    await settled();
    expect(settle).toHaveBeenCalledWith(WORKER_SETTLE_GRACE_MS);
    expect(hold.quit).toHaveBeenCalledOnce();
    // The quit asked again goes through.
    expect(quit.holdForUpgrade({ preventDefault: vi.fn() }, hold)).toBe(false);
    expect(quit.quitting()).toBe(true);
    expect(log.records).toContainEqual(
      expect.objectContaining({ component: "quit", msg: "quit waits for the database upgrade" }),
    );
  });
});
