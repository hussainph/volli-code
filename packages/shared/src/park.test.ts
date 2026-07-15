import { describe, it, expect } from "vite-plus/test";
import {
  breatheShouldWake,
  isParkCandidate,
  treeIsCpuQuiet,
  PARK_BREATHE_WINDOW_MS,
  PARK_IDLE_THRESHOLD_MS,
  PARK_SWEEP_INTERVAL_MS,
  PARK_CPU_BUSY_PERCENT,
  PARK_QUIET_SAMPLES_REQUIRED,
  type BreatheObservation,
  type ParkCandidateState,
} from "./park";

const base: ParkCandidateState = {
  parked: false,
  visible: false,
  keepAwake: false,
  lastActivityAt: 0,
};

describe("park constants", () => {
  it("hold the documented warm-tier tuning", () => {
    expect(PARK_IDLE_THRESHOLD_MS).toBe(5 * 60_000);
    expect(PARK_SWEEP_INTERVAL_MS).toBe(60_000);
    expect(PARK_CPU_BUSY_PERCENT).toBe(0.5);
    expect(PARK_QUIET_SAMPLES_REQUIRED).toBe(2);
    expect(PARK_BREATHE_WINDOW_MS).toBe(1_000);
  });
});

// A quiet breathe: nothing the window could surface, so the session re-freezes.
const quietBreathe: BreatheObservation = {
  activityAtStart: 100,
  activityAtEnd: 100,
  cpuQuiet: true,
  treeGrew: false,
  hasListener: false,
};

describe("breatheShouldWake", () => {
  it("re-freezes a session whose window surfaced nothing", () => {
    expect(breatheShouldWake(quietBreathe)).toBe(false);
  });

  it("wakes on output or input during the window", () => {
    expect(breatheShouldWake({ ...quietBreathe, activityAtEnd: 101 })).toBe(true);
  });

  it("wakes on tree CPU above the busy threshold", () => {
    expect(breatheShouldWake({ ...quietBreathe, cpuQuiet: false })).toBe(true);
  });

  it("wakes when the tree forked a new child", () => {
    expect(breatheShouldWake({ ...quietBreathe, treeGrew: true })).toBe(true);
  });

  it("wakes when a listener appeared in the tree", () => {
    expect(breatheShouldWake({ ...quietBreathe, hasListener: true })).toBe(true);
  });
});

describe("isParkCandidate", () => {
  it("accepts an idle, hidden, unpinned, running session", () => {
    expect(isParkCandidate(base, PARK_IDLE_THRESHOLD_MS, PARK_IDLE_THRESHOLD_MS)).toBe(true);
  });

  it("treats exactly the threshold of quiet time as eligible", () => {
    expect(isParkCandidate({ ...base, lastActivityAt: 0 }, 1000, 1000)).toBe(true);
  });

  it("rejects a session that was active more recently than the threshold", () => {
    expect(isParkCandidate({ ...base, lastActivityAt: 1 }, 1000, 1000)).toBe(false);
  });

  it("rejects an already-parked session", () => {
    expect(isParkCandidate({ ...base, parked: true }, 10_000, 1000)).toBe(false);
  });

  it("rejects a visible session", () => {
    expect(isParkCandidate({ ...base, visible: true }, 10_000, 1000)).toBe(false);
  });

  it("rejects a keep-awake session", () => {
    expect(isParkCandidate({ ...base, keepAwake: true }, 10_000, 1000)).toBe(false);
  });
});

describe("treeIsCpuQuiet", () => {
  it("is quiet when every pid is below the busy percent", () => {
    const cpu = new Map([
      [1, 0.1],
      [2, 0.4],
    ]);
    expect(treeIsCpuQuiet(cpu, [1, 2], PARK_CPU_BUSY_PERCENT)).toBe(true);
  });

  it("is busy when any pid is at or above the busy percent", () => {
    const cpu = new Map([
      [1, 0.1],
      [2, 0.5],
    ]);
    expect(treeIsCpuQuiet(cpu, [1, 2], PARK_CPU_BUSY_PERCENT)).toBe(false);
  });

  it("counts a pid missing from the sample as quiet (it exited)", () => {
    const cpu = new Map([[1, 0.1]]);
    expect(treeIsCpuQuiet(cpu, [1, 2], PARK_CPU_BUSY_PERCENT)).toBe(true);
  });

  it("is trivially quiet for an empty tree", () => {
    expect(treeIsCpuQuiet(new Map(), [], PARK_CPU_BUSY_PERCENT)).toBe(true);
  });
});
