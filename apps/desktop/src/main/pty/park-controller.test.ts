import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ParkConfig, ProcessInspector } from "../park";
import { ParkController } from "./park-controller";
import type { ParkableSession } from "./park-controller";

// These tests drive the controller DIRECTLY (issue #99): a fake inspector, a
// plain Map of hand-built ParkableSession objects, and recorded flush /
// pushParkState callbacks — no PtyManager, no electron, no db. The manager's
// benchmark (pty.test.ts) proves end-to-end equivalence; this suite pins the
// controller's own race-handling contract in isolation.

/** A fake ProcessInspector: no `ps`/`pgrep`/`lsof` spawning, no real signals. */
function makeInspector() {
  const descendants = vi.fn(async (_pid: number): Promise<number[]> => []);
  const cpuPercents = vi.fn(async (_pids: readonly number[]) => new Map<number, number>());
  const listeningPids = vi.fn(async (_pids: readonly number[]) => new Set<number>());
  const signal = vi.fn((_pid: number, _sig: "SIGSTOP" | "SIGCONT"): boolean => true);
  const inspector: ProcessInspector = { descendants, cpuPercents, listeningPids, signal };
  return { inspector, descendants, cpuPercents, listeningPids, signal };
}

const ENABLED_CONFIG: ParkConfig = {
  idleThresholdMs: 1000,
  sweepIntervalMs: 1000,
  cpuBusyPercent: 0.5,
  quietSamplesRequired: 2,
  breatheWindowMs: 5,
  enabled: true,
};

let pidSeq = 5000;
/** A distinct fake pid per session so park-tree assertions can't collide. */
const nextPid = () => (pidSeq += 1);

function makeSession(pid = nextPid()): ParkableSession {
  return {
    pty: { pid },
    parkedPids: null,
    parkedManually: false,
    quietCpuSamples: 0,
    visible: false,
    keepAwake: false,
    lastActivityAt: Date.now(),
  };
}

/** A `now` comfortably past the idle threshold from a fresh session. */
const idleNow = () => Date.now() + 10_000;
/** Real-time pause; mid-window actions land inside the 5ms breathe window. */
const tick = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** A controller wired to a fresh fake inspector + empty session map. */
function harness(config: ParkConfig = ENABLED_CONFIG) {
  const parts = makeInspector();
  const sessions = new Map<string, ParkableSession>();
  const flush = vi.fn((_id: string): void => {});
  const pushParkState = vi.fn((_id: string): void => {});
  const controller = new ParkController({
    config,
    inspector: parts.inspector,
    sessions,
    flush,
    pushParkState,
  });
  const register = (id: string, pid?: number): ParkableSession => {
    const session = makeSession(pid);
    sessions.set(id, session);
    return session;
  };
  /** Pids sent a given signal, in call order. */
  const signalledWith = (sig: "SIGSTOP" | "SIGCONT"): number[] =>
    parts.signal.mock.calls.filter((call) => call[1] === sig).map((call) => call[0]);
  const stopCalls = () => signalledWith("SIGSTOP");
  const contCalls = () => signalledWith("SIGCONT");
  return { ...parts, sessions, flush, pushParkState, controller, register, stopCalls, contCalls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ParkController.park", () => {
  it("refuses even a manual park when parking is disabled", async () => {
    const { controller, register, signal } = harness({ ...ENABLED_CONFIG, enabled: false });
    register("s");
    expect(await controller.park("s", { manual: true })).toEqual({
      ok: false,
      error: "Session parking is disabled",
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it("errors on an unknown session", async () => {
    const { controller } = harness();
    expect(await controller.park("nope", { manual: true })).toEqual({
      ok: false,
      error: "Unknown terminal session",
    });
  });

  it.each([
    ["visible", (s: ParkableSession) => (s.visible = true)],
    ["kept awake", (s: ParkableSession) => (s.keepAwake = true)],
  ])("auto-park refuses a %s session before any SIGSTOP", async (_label, flip) => {
    const { controller, register, stopCalls } = harness();
    const session = register("s");
    flip(session);
    expect(await controller.park("s", { manual: false })).toEqual({
      ok: false,
      error: "Session is visible or kept awake",
    });
    expect(stopCalls()).toEqual([]);
  });

  it("auto-park refuses at entry when activity already passed the baseline", async () => {
    const { controller, register, stopCalls } = harness();
    const session = register("s");
    // A baseline BELOW the session's current activity: it resumed work before parking.
    expect(
      await controller.park("s", { manual: false, activityBaseline: session.lastActivityAt - 1 }),
    ).toEqual({ ok: false, error: "Session became active while parking" });
    expect(stopCalls()).toEqual([]);
  });

  it("auto-park refuses, before any SIGSTOP, when output lands during the initial collect", async () => {
    const { controller, register, descendants, stopCalls } = harness();
    const session = register("s");
    const baseline = session.lastActivityAt;
    descendants.mockImplementationOnce(async () => {
      session.lastActivityAt = baseline + 1000; // resumed work mid-collect
      return [200];
    });
    expect(await controller.park("s", { manual: false })).toEqual({
      ok: false,
      error: "Session became active while parking",
    });
    expect(stopCalls()).toEqual([]);
  });

  it("CONTs the half-stopped tree in reverse when activity lands during a rescan round", async () => {
    const { controller, register, descendants, stopCalls, contCalls } = harness();
    const session = register("s");
    const baseline = session.lastActivityAt;
    descendants.mockResolvedValueOnce([200]).mockImplementationOnce(async () => {
      session.lastActivityAt = baseline + 1000; // drains after the SIGSTOPs
      return [200];
    });
    expect(await controller.park("s", { manual: false })).toEqual({
      ok: false,
      error: "Session became active while parking",
    });
    expect(stopCalls()).toEqual([session.pty.pid, 200]);
    expect(contCalls()).toEqual([200, session.pty.pid]); // reverse of the stop order
  });

  it("stops parent first, then descendants, and re-collects a newly spawned child", async () => {
    const { controller, register, descendants, stopCalls } = harness();
    const session = register("s");
    descendants
      .mockResolvedValueOnce([200]) // initial collect
      .mockResolvedValueOnce([200, 300]) // round 0: 300 appeared
      .mockResolvedValueOnce([200, 300]); // round 1: stable → break
    expect(await controller.park("s", { manual: true })).toEqual({ ok: true });
    expect(stopCalls()).toEqual([session.pty.pid, 200, 300]);
  });

  it("bounds the re-collect loop at three rounds", async () => {
    const { controller, register, descendants, stopCalls } = harness();
    const session = register("s");
    descendants
      .mockResolvedValueOnce([200])
      .mockResolvedValueOnce([200, 300])
      .mockResolvedValueOnce([200, 300, 400])
      .mockResolvedValueOnce([200, 300, 400, 500]);
    await controller.park("s", { manual: true });
    expect(stopCalls()).toEqual([session.pty.pid, 200, 300, 400, 500]);
  });

  it("bails without stopping anything when the session vanishes during the initial collect", async () => {
    const { controller, register, sessions, descendants, stopCalls } = harness();
    register("s");
    descendants.mockImplementationOnce(async () => {
      sessions.delete("s"); // the session ended mid-collect
      return [200];
    });
    expect(await controller.park("s", { manual: true })).toEqual({
      ok: false,
      error: "Session ended while parking",
    });
    expect(stopCalls()).toEqual([]);
  });

  it("continues the already-stopped tree when the session vanishes during a rescan", async () => {
    const { controller, register, sessions, descendants, stopCalls, contCalls } = harness();
    const session = register("s");
    descendants.mockResolvedValueOnce([200]).mockImplementationOnce(async () => {
      // Death lands between the stop pass and the rescan: park must CONT what it
      // stopped so the kill's pending SIGHUP can act on the tree.
      sessions.delete("s");
      return [200];
    });
    expect(await controller.park("s", { manual: true })).toEqual({
      ok: false,
      error: "Session ended while parking",
    });
    expect(stopCalls()).toEqual([session.pty.pid, 200]);
    expect(contCalls()).toEqual([200, session.pty.pid]);
  });

  it("CONTs the stopped tree and propagates when a rescan round itself fails", async () => {
    const { controller, register, descendants, stopCalls, contCalls } = harness();
    const session = register("s");
    descendants.mockResolvedValueOnce([200]).mockRejectedValueOnce(new Error("pgrep unavailable"));
    await expect(controller.park("s", { manual: true })).rejects.toThrow("pgrep unavailable");
    expect(stopCalls()).toEqual([session.pty.pid, 200]);
    expect(contCalls()).toEqual([200, session.pty.pid]); // no frozen-tree leak
  });

  it("upgrades an already-parked auto session to manual without re-signalling", async () => {
    const { controller, register, signal } = harness();
    const session = register("s");
    await controller.park("s", { manual: false });
    expect(session.parkedManually).toBe(false);
    signal.mockClear();
    expect(await controller.park("s", { manual: true })).toEqual({ ok: true });
    expect(session.parkedManually).toBe(true);
    expect(signal).not.toHaveBeenCalled();
  });

  it("flushes before the first SIGSTOP, then records the stop order and pushes park state", async () => {
    const { controller, register, flush, signal, pushParkState } = harness();
    const session = register("s");
    expect(await controller.park("s", { manual: true })).toEqual({ ok: true });
    expect(flush).toHaveBeenCalledWith("s");
    // Flush happened before any signal was delivered.
    const flushOrder = flush.mock.invocationCallOrder[0];
    const firstStop = signal.mock.invocationCallOrder[0];
    expect(flushOrder).toBeLessThan(firstStop);
    expect(session.parkedPids).toEqual([session.pty.pid]);
    expect(session.parkedManually).toBe(true);
    expect(pushParkState).toHaveBeenCalledWith("s");
  });
});

describe("ParkController.wake", () => {
  it("continues the tree in reverse and resets the park state", async () => {
    const { controller, register, descendants, contCalls, pushParkState } = harness();
    const session = register("s");
    descendants.mockResolvedValueOnce([200, 300]).mockResolvedValueOnce([200, 300]);
    await controller.park("s", { manual: true });
    session.quietCpuSamples = 3; // pretend a quiet streak had accrued
    const before = session.lastActivityAt;
    pushParkState.mockClear();
    expect(controller.wake("s")).toEqual({ ok: true });
    expect(contCalls()).toEqual([300, 200, session.pty.pid]);
    expect(session.parkedPids).toBeNull();
    expect(session.parkedManually).toBe(false);
    expect(session.quietCpuSamples).toBe(0);
    expect(session.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(pushParkState).toHaveBeenCalledWith("s");
  });

  it("is a no-op on a running session", () => {
    const { controller, register, signal } = harness();
    register("s");
    expect(controller.wake("s")).toEqual({ ok: true });
    expect(signal).not.toHaveBeenCalled();
  });

  it("errors on an unknown session", () => {
    const { controller } = harness();
    expect(controller.wake("nope")).toEqual({ ok: false, error: "Unknown terminal session" });
  });
});

describe("ParkController.sweep", () => {
  it("does nothing when parking is disabled", async () => {
    const { controller, register, descendants } = harness({ ...ENABLED_CONFIG, enabled: false });
    register("s");
    await controller.sweep(idleNow());
    expect(descendants).not.toHaveBeenCalled();
  });

  it("skips a visible session at stage 1 without inspecting", async () => {
    const { controller, register, descendants, stopCalls } = harness();
    const session = register("s");
    session.visible = true;
    await controller.sweep(idleNow());
    expect(stopCalls()).toEqual([]);
    expect(descendants).not.toHaveBeenCalled();
  });

  it("skips a recently-active session at stage 1", async () => {
    const { controller, register, stopCalls } = harness();
    register("s");
    await controller.sweep(Date.now()); // within the idle threshold
    expect(stopCalls()).toEqual([]);
  });

  it("requires two consecutive CPU-quiet sweeps, and a busy sweep resets the streak", async () => {
    const { controller, register, cpuPercents, stopCalls } = harness();
    const session = register("s");
    await controller.sweep(idleNow()); // quiet sample 1
    expect(stopCalls()).toEqual([]);
    cpuPercents.mockResolvedValueOnce(new Map([[session.pty.pid, 5]])); // busy
    await controller.sweep(idleNow()); // streak reset to 0
    expect(stopCalls()).toEqual([]);
    await controller.sweep(idleNow()); // quiet sample 1
    expect(stopCalls()).toEqual([]);
    await controller.sweep(idleNow()); // quiet sample 2 → park
    expect(stopCalls()).toEqual([session.pty.pid]);
  });

  it("never parks a tree holding a LISTEN socket, but retries once it clears", async () => {
    const { controller, register, listeningPids, stopCalls } = harness();
    const session = register("s");
    listeningPids.mockResolvedValue(new Set([session.pty.pid]));
    await controller.sweep(idleNow()); // sample 1
    await controller.sweep(idleNow()); // sample 2 → stage 3 → listener → skip (streak kept)
    expect(stopCalls()).toEqual([]);
    listeningPids.mockResolvedValue(new Set());
    await controller.sweep(idleNow()); // listener gone → park
    expect(stopCalls()).toEqual([session.pty.pid]);
  });

  it("never parks a session whose activity advanced during the sweep's async stages", async () => {
    const { controller, register, listeningPids, stopCalls } = harness();
    const session = register("s");
    const baseline = session.lastActivityAt;
    await controller.sweep(idleNow()); // quiet sample 1
    listeningPids.mockImplementationOnce(async () => {
      session.lastActivityAt = baseline + 5000; // activity after eligibility, before park()
      return new Set<number>();
    });
    await controller.sweep(idleNow()); // quiet sample 2 → park attempt refused
    expect(stopCalls()).toEqual([]);
  });

  it("logs and parks nothing when inspection fails — never an unhandled rejection", async () => {
    const { controller, register, cpuPercents, stopCalls } = harness();
    register("s");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    cpuPercents.mockRejectedValue(new Error("ps unavailable"));
    await expect(controller.sweep(idleNow())).resolves.toBeUndefined();
    expect(stopCalls()).toEqual([]);
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("skips the overlapping tick while a slow sweep is still running", async () => {
    const { controller, register, descendants } = harness();
    let release!: (pids: number[]) => void;
    descendants.mockImplementationOnce(
      () =>
        new Promise<number[]>((resolve) => {
          release = resolve;
        }),
    );
    register("s");
    const first = controller.sweep(idleNow()); // suspends at descendants
    await controller.sweep(idleNow()); // sweeping flag set → returns at once
    expect(descendants).toHaveBeenCalledTimes(1);
    release([]);
    await first;
  });
});

describe("ParkController.breathe (via sweep)", () => {
  /** Registers a hidden session, auto-parks it, and clears signal/push history. */
  async function autoParked(config: ParkConfig = ENABLED_CONFIG) {
    const h = harness(config);
    const session = h.register("s");
    await h.controller.park("s", { manual: false });
    h.signal.mockClear();
    h.pushParkState.mockClear();
    return { ...h, session };
  }

  it("re-freezes a session whose breathe window stays quiet", async () => {
    const { controller, session, contCalls, stopCalls } = await autoParked();
    await controller.sweep(idleNow());
    expect(contCalls()).toEqual([session.pty.pid]);
    expect(stopCalls()).toEqual([session.pty.pid]);
  });

  it("wakes on activity during the window instead of re-freezing", async () => {
    const { controller, session, stopCalls, pushParkState } = await autoParked();
    const sweepDone = controller.sweep(idleNow());
    await tick(1);
    session.lastActivityAt = Date.now() + 100; // output/input during the window
    await sweepDone;
    expect(stopCalls()).toEqual([]);
    expect(pushParkState).toHaveBeenCalledWith("s");
  });

  it("wakes when the tree shows CPU after the window", async () => {
    const { controller, session, cpuPercents, stopCalls, pushParkState } = await autoParked();
    cpuPercents.mockResolvedValue(new Map([[session.pty.pid, 5]]));
    await controller.sweep(idleNow());
    expect(stopCalls()).toEqual([]);
    expect(pushParkState).toHaveBeenCalledWith("s");
  });

  it("wakes when the tree forked a new child during the window", async () => {
    const { controller, descendants, stopCalls, pushParkState } = await autoParked();
    descendants.mockResolvedValue([999]);
    await controller.sweep(idleNow());
    expect(stopCalls()).toEqual([]);
    expect(pushParkState).toHaveBeenCalledWith("s");
  });

  it("wakes when a listener appeared in the tree", async () => {
    const { controller, session, listeningPids, stopCalls, pushParkState } = await autoParked();
    listeningPids.mockResolvedValue(new Set([session.pty.pid]));
    await controller.sweep(idleNow());
    expect(stopCalls()).toEqual([]);
    expect(pushParkState).toHaveBeenCalledWith("s");
  });

  it("never breathes a manually parked session", async () => {
    const { controller, register, signal, contCalls, stopCalls } = harness();
    register("s");
    await controller.park("s", { manual: true });
    signal.mockClear();
    await controller.sweep(idleNow());
    expect(contCalls()).toEqual([]);
    expect(stopCalls()).toEqual([]);
  });

  it("lets a Park Now landing mid-window beat a busy verdict and stay manual", async () => {
    const { controller, session, cpuPercents, signal, stopCalls, contCalls } = await autoParked();
    cpuPercents.mockResolvedValue(new Map([[session.pty.pid, 5]])); // would wake
    const sweepDone = controller.sweep(idleNow());
    await tick(1);
    expect(await controller.park("s", { manual: true })).toEqual({ ok: true });
    await sweepDone;
    expect(stopCalls()).toEqual([session.pty.pid]); // re-frozen despite the busy tree
    expect(session.parkedManually).toBe(true);
    // Now exempt from the duty cycle: a further sweep leaves it frozen.
    signal.mockClear();
    await controller.sweep(idleNow());
    expect(contCalls()).toEqual([]);
    expect(session.parkedPids).not.toBeNull();
  });

  it("fails open — wakes instead of re-freezing — when inspection dies mid-breathe", async () => {
    const { controller, session, descendants, stopCalls, contCalls, pushParkState } =
      await autoParked();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    descendants.mockRejectedValueOnce(new Error("pgrep unavailable"));
    await expect(controller.sweep(idleNow())).resolves.toBeUndefined();
    expect(stopCalls()).toEqual([]); // nothing re-frozen
    // CONT'd for the window, then CONT'd again by the fail-open wake.
    expect(contCalls()).toEqual([session.pty.pid, session.pty.pid]);
    expect(pushParkState).toHaveBeenCalledWith("s");
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("stays awake and syncs the badge when late activity refuses the re-freeze", async () => {
    const { controller, session, descendants, stopCalls, pushParkState } = await autoParked();
    const baseline = session.lastActivityAt;
    descendants
      .mockResolvedValueOnce([]) // breathe's tree walk: quiet verdict
      .mockImplementationOnce(async () => {
        session.lastActivityAt = baseline + 5000; // lands inside the re-freeze park()
        return [];
      });
    await controller.sweep(idleNow());
    expect(stopCalls()).toEqual([]);
    expect(pushParkState).toHaveBeenCalledWith("s");
  });
});
