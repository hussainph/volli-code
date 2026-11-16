import type { LogRecord } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { withMainSpan, withTrace } from "./context";
import { installHostLog } from "./root";
import { constants } from "node:perf_hooks";

import {
  gcPauseKind,
  type GcPauseSource,
  V8_GC_PAUSES,
  MAIN_STALL_DEFAULTS,
  startMainStallMonitor,
  type MainStallMonitor,
  processWaitCounters,
  threadCpuMs,
} from "./stall";

/** A pinned clock: `performance.now` is what door spans and the monitor both read. */
let clock = 0;
let records: LogRecord[] = [];
let undoLog: () => void = () => {};
const monitors: MainStallMonitor[] = [];

beforeEach(() => {
  clock = 1_000;
  cpuClock = null;
  majorFaults = 0;
  involuntarySwitches = 0;
  records = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  undoLog = installHostLog({ level: "debug", sink: { write: (record) => records.push(record) } });
});

afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  undoLog();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Main's CPU clock when a test freezes it; otherwise it runs with the wall clock. */
let cpuClock: number | null = null;

/** The process's scripted wait counters: a test bumps them. */
let majorFaults = 0;
let involuntarySwitches = 0;

/** Scripted GC pauses: a test reports one with `gcPause`. */
let gcPause: (startMs: number, durationMs: number, kind: string) => void = () => {};
const scriptedGc: GcPauseSource = (onPause) => {
  gcPause = onPause;
  return () => {
    gcPause = () => {};
  };
};

function start(options: Parameters<typeof startMainStallMonitor>[0] = {}): MainStallMonitor {
  const monitor = startMainStallMonitor({
    tickMs: 50,
    observeGc: scriptedGc,
    // On the CPU the whole time, unless a test freezes it.
    threadCpuMs: () => cpuClock ?? clock,
    waitCounters: () => ({ majorFaults, involuntarySwitches }),
    ...options,
  });
  monitors.push(monitor);
  return monitor;
}

/** The loop was busy for `ms` more than one tick, then the probe fires. */
function blockThenTick(ms: number): void {
  clock += 50 + ms;
  vi.advanceTimersByTime(50);
}

/** A door call whose synchronous part holds the loop `ms`. */
function door(fields: Record<string, string>, ms: number): void {
  withTrace(null, fields, () => {
    clock += ms;
  });
}

const stalls = () => records.filter((record) => record.msg === "main stall");

describe("the main stall monitor", () => {
  it("defaults to a 200 ms threshold, an hourly roll-up and the performance clock", () => {
    expect(MAIN_STALL_DEFAULTS).toMatchObject({ thresholdMs: 200, summaryIntervalMs: 3_600_000 });
    startMainStallMonitor().stop();
    const monitor = startMainStallMonitor();
    monitors.push(monitor);
    door({ door: "ipc", operation: "slow" }, 200);
    door({ door: "ipc", operation: "fast" }, 199);
    expect(stalls().map((record) => record.operation)).toEqual(["slow"]);
  });

  it("logs a door's synchronous block inside its own trace, once, and not the lag it caused", () => {
    start();
    door({ door: "ipc", operation: "volli:projects-select" }, 320);
    blockThenTick(320);
    expect(stalls()).toEqual([
      expect.objectContaining({
        level: "warn",
        component: "main-stall",
        door: "ipc",
        operation: "volli:projects-select",
        attribution: "door",
        durationMs: 320,
        thresholdMs: 200,
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
      }),
    ]);
  });

  it("lets the innermost span over the threshold win, names its parent, and still reports one that throws", () => {
    start();
    expect(() =>
      withTrace(null, { door: "agent-socket", operation: "outer" }, () => {
        door({ door: "ipc", operation: "inner" }, 250);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "door",
        door: "ipc",
        operation: "inner",
        durationMs: 250,
        parentDoor: "agent-socket",
        parentOperation: "outer",
      }),
    ]);
  });

  it("names the outer span when no nested span reaches the threshold alone", () => {
    start();
    withMainSpan({ door: "timer", operation: "worktree-watch" }, () => {
      clock += 120;
      withMainSpan({ door: "broadcast", operation: "volli:data-changed" }, () => {
        clock += 150;
      });
    });
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "span",
        door: "timer",
        operation: "worktree-watch",
        durationMs: 270,
      }),
    ]);
    expect(stalls()[0]).not.toHaveProperty("parentDoor");
  });

  it.each([
    [{ door: "runtime", operation: "observe", sessionId: "s-1" }],
    [{ door: "runtime", operation: "tool:bash", sessionId: "s-2" }],
    [{ door: "timer", operation: "session-watchdog" }],
    [{ door: "broadcast", operation: "volli:session-activity" }],
    [{ door: "ipc", operation: "volli:terminal-write" }],
  ])("attributes a blocking %o span to its own labels, once", (labels) => {
    start();
    const result = withMainSpan(labels, () => {
      clock += 300;
      return "kept";
    });
    expect(result).toBe("kept");
    blockThenTick(300);
    expect(stalls()).toEqual([
      expect.objectContaining({
        level: "warn",
        component: "main-stall",
        attribution: "span",
        durationMs: 300,
        ...labels,
      }),
    ]);
  });

  it("times only a span's synchronous part, and returns its promise unchanged", async () => {
    start();
    const pending = withMainSpan({ door: "runtime", operation: "observe" }, async () => {
      clock += 10;
      await Promise.resolve();
      clock += 500;
      return 7;
    });
    await expect(pending).resolves.toBe(7);
    expect(stalls()).toEqual([]);
  });

  it("explains a block of many short spans by the operation that ran longest", () => {
    start();
    for (let i = 0; i < 40; i += 1) {
      withMainSpan({ door: "runtime", operation: "translate", sessionId: "s-1" }, () => {
        clock += 6;
      });
    }
    withMainSpan({ door: "broadcast", operation: "volli:session-activity" }, () => {
      clock += 20;
    });
    clock += 40;
    // The tick is late by what ran since the last one.
    vi.advanceTimersByTime(50);
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "aggregate",
        door: "runtime",
        operation: "translate",
        durationMs: 250,
        spanMs: 240,
        spanCount: 40,
        coveredMs: 260,
      }),
    ]);
    // The tally starts over each tick.
    clock += 50;
    for (let i = 0; i < 3; i += 1) {
      withMainSpan({ door: "runtime", operation: "translate" }, () => {
        clock += 10;
      });
    }
    clock += 270;
    vi.advanceTimersByTime(50);
    // Held one tick, for the GC pauses inside it to arrive.
    blockThenTick(0);
    expect(stalls()[1]).toMatchObject({
      attribution: "unattributed",
      durationMs: 300,
      lastDoor: "runtime",
      lastOperation: "translate",
      coveredMs: 30,
    });
  });

  it("keeps separate caller tallies for the same inner projection operation", () => {
    start();
    for (const [operation, count, ms] of [
      ["listing", 3, 40],
      ["resume", 2, 70],
    ] as const) {
      for (let i = 0; i < count; i += 1) {
        withMainSpan({ door: "timer", operation }, () => {
          withMainSpan({ door: "projection", operation: "get-session" }, () => {
            clock += ms;
          });
        });
      }
    }
    vi.advanceTimersByTime(50);
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "aggregate",
        operation: "get-session",
        parentDoor: "timer",
        parentOperation: "resume",
        spanCount: 2,
        spanMs: 140,
        coveredMs: 260,
      }),
    ]);
  });

  it("names the requesting door after its async roster reader has yielded", async () => {
    start();
    await withTrace(null, { door: "agent-socket", operation: "session.list" }, async () => {
      await Promise.resolve();
      for (let i = 0; i < 32; i += 1) {
        withMainSpan({ door: "projection", operation: "get-session" }, () => {
          clock += 8;
        });
      }
    });
    vi.advanceTimersByTime(50);
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "aggregate",
        parentDoor: "agent-socket",
        parentOperation: "session.list",
        spanCount: 32,
        spanMs: 256,
      }),
    ]);
    expect(stalls()[0]).not.toHaveProperty("traceId");
    await withTrace(null, { door: "ipc", operation: "session.listing" }, async () => {
      await Promise.resolve();
      withMainSpan({ door: "projection", operation: "get-session" }, () => {
        clock += 250;
      });
    });
    expect(stalls()[1]).toMatchObject({
      attribution: "span",
      parentDoor: "ipc",
      parentOperation: "session.listing",
    });
  });

  it("explains a block mostly spent in garbage collection by the longest pause's kind", () => {
    start();
    clock += 50;
    const from = clock;
    gcPause(from + 10, 40, "minor");
    gcPause(from + 60, 180, "major");
    gcPause(from + 250, 10, "minor");
    clock += 300;
    vi.advanceTimersByTime(50);
    expect(stalls()).toEqual([]);
    // A pause outside the next block, and one too short to explain it.
    gcPause(clock + 60, 30, "minor");
    clock += 50 + 300;
    vi.advanceTimersByTime(50);
    blockThenTick(0);
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "gc",
        door: "gc",
        operation: "major",
        durationMs: 300,
        gcMs: 230,
      }),
      expect.objectContaining({ attribution: "unattributed", durationMs: 300, gcMs: 30 }),
    ]);
  });

  it("resolves a held block when it stops, and keeps only recent pauses", () => {
    const monitor = start();
    for (let i = 0; i < 70; i += 1) gcPause(i, 1, "weakcb");
    gcPause(clock + 60, 280, "incremental");
    blockThenTick(300);
    monitor.stop();
    expect(stalls()).toEqual([
      expect.objectContaining({ attribution: "gc", operation: "incremental", gcMs: 280 }),
    ]);
  });

  it("reads V8's own gc entries by default, naming each pause's kind", async () => {
    const seen: string[] = [];
    const undo = V8_GC_PAUSES((_start, durationMs, kind) => {
      if (durationMs >= 0) seen.push(kind);
    });
    try {
      // Enough short-lived garbage for at least one scavenge.
      let junk: Array<{ i: number; s: string }> = [];
      let made = 0;
      for (let i = 0; i < 400_000; i += 1) {
        junk.push({ i, s: String(i) });
        made += 1;
        if (junk.length > 10_000) junk = [];
      }
      expect(made).toBeGreaterThan(0);
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 2_000 });
    } finally {
      undo();
    }
    expect(seen.every((kind) => ["major", "minor", "incremental", "weakcb"].includes(kind))).toBe(
      true,
    );
    expect(gcPauseKind({ kind: constants.NODE_PERFORMANCE_GC_MAJOR })).toBe("major");
    expect(gcPauseKind({ kind: 999 })).toBe("unknown");
    expect(gcPauseKind(null)).toBe("unknown");
  });

  it("names a block main spent off the CPU, and keeps the CPU time on every unexplained line", () => {
    start({ summaryIntervalMs: 1_200 });
    cpuClock = clock;
    blockThenTick(400);
    cpuClock += 100;
    blockThenTick(300);
    cpuClock = null;
    blockThenTick(250);
    blockThenTick(0);
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "off-cpu",
        door: "off-cpu",
        operation: "wait",
        durationMs: 400,
        cpuMs: 0,
      }),
      expect.objectContaining({ attribution: "off-cpu", durationMs: 300, cpuMs: 100 }),
      expect.objectContaining({ attribution: "unattributed", durationMs: 250 }),
    ]);
    blockThenTick(0);
    expect(records.find((record) => record.msg === "main stall load")).toMatchObject({
      stalls: 3,
      offCpuShare: 0.74,
      unattributedShare: 0.26,
      doors: [
        { door: "off-cpu", count: 2, totalMs: 700 },
        { door: "unattributed", count: 1, totalMs: 250 },
      ],
    });
  });

  it("says why main waited: its own CPU, and the process's page-ins and preemptions, on every line", () => {
    start();
    // A door that waited (a checkpoint's fsync, say): long, little CPU, no paging.
    cpuClock = clock;
    withTrace(null, { door: "ipc", operation: "volli:app-state-set" }, () => {
      clock += 400;
      cpuClock = (cpuClock ?? 0) + 30;
    });
    // A span that paged: its window counts the faults since the previous tick.
    majorFaults += 120;
    withMainSpan({ door: "runtime", operation: "observe", sessionId: "s-1" }, () => {
      clock += 300;
    });
    // The lag those two caused is already logged.
    blockThenTick(0);
    // An unexplained block while the scheduler kept main off the CPU.
    involuntarySwitches += 900;
    majorFaults += 3;
    blockThenTick(500);
    cpuClock = null;
    blockThenTick(0);
    // Many short spans, mostly paging.
    majorFaults += 40;
    for (let i = 0; i < 30; i += 1) {
      withMainSpan({ door: "projection", operation: "get-session" }, () => {
        clock += 9;
      });
    }
    vi.advanceTimersByTime(50);
    // A garbage-collection pause, with its window's cost.
    gcPause(clock + 60, 260, "minor");
    involuntarySwitches += 5;
    blockThenTick(300);
    blockThenTick(0);
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "door",
        operation: "volli:app-state-set",
        durationMs: 400,
        cpuMs: 30,
        majorFaults: 0,
        involuntarySwitches: 0,
      }),
      expect.objectContaining({
        attribution: "span",
        operation: "observe",
        durationMs: 300,
        cpuMs: 0,
        majorFaults: 120,
        involuntarySwitches: 0,
      }),
      expect.objectContaining({
        attribution: "off-cpu",
        durationMs: 500,
        cpuMs: 0,
        majorFaults: 3,
        involuntarySwitches: 900,
      }),
      expect.objectContaining({
        attribution: "aggregate",
        operation: "get-session",
        cpuMs: 270,
        majorFaults: 40,
        involuntarySwitches: 0,
      }),
      expect.objectContaining({
        attribution: "gc",
        operation: "minor",
        cpuMs: 350,
        majorFaults: 0,
        involuntarySwitches: 5,
      }),
    ]);
  });

  it("reads the process's wait counters by default", () => {
    const counters = processWaitCounters();
    expect(counters.majorFaults).toBeGreaterThanOrEqual(0);
    expect(counters.involuntarySwitches).toBeGreaterThanOrEqual(0);
  });

  it("reads main's own thread CPU time by default", () => {
    const before = threadCpuMs();
    let spin = 0;
    for (let i = 0; i < 1_000_000; i += 1) spin += i;
    expect(spin).toBeGreaterThan(0);
    expect(threadCpuMs()).toBeGreaterThanOrEqual(before);
  });

  it("costs nothing but the call while no monitor runs", () => {
    let ran = 0;
    expect(
      withMainSpan({ door: "timer", operation: "idle" }, () => {
        ran += 1;
        clock += 500;
        return ran;
      }),
    ).toBe(1);
    expect(stalls()).toEqual([]);
  });

  it("logs lag no door explains as unattributed, naming the last door call as a hint", () => {
    start();
    blockThenTick(400);
    door({ door: "ipc", operation: "volli:data-bootstrap" }, 3);
    clock += 20;
    blockThenTick(250);
    blockThenTick(199);
    const [first, second, ...rest] = stalls();
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ attribution: "unattributed", durationMs: 400 });
    expect(first).not.toHaveProperty("lastOperation");
    expect(first).not.toHaveProperty("traceId");
    expect(second).toMatchObject({
      attribution: "unattributed",
      durationMs: 273,
      lastDoor: "ipc",
      lastOperation: "volli:data-bootstrap",
      lastOperationAgoMs: 320,
    });
    expect(second).not.toHaveProperty("operation");
  });

  it("rolls up a window without stalls as nothing unexplained", () => {
    start({ summaryIntervalMs: 100 });
    blockThenTick(0);
    blockThenTick(0);
    expect(records.find((record) => record.msg === "main stall load")).toMatchObject({
      stalls: 0,
      unattributedShare: 0,
      doors: [],
      top: [],
    });
  });

  it("keeps a door call's Session on its stall line", () => {
    start();
    door({ door: "ipc", operation: "volli:session-open", sessionId: "s-9" }, 210);
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "door",
        operation: "volli:session-open",
        sessionId: "s-9",
      }),
    ]);
  });

  it("names a door call that carried no door or operation as unknown", () => {
    start();
    door({}, 210);
    blockThenTick(0);
    blockThenTick(230);
    blockThenTick(0);
    expect(stalls()).toMatchObject([
      { attribution: "door", durationMs: 210 },
      { attribution: "unattributed", lastDoor: "unknown", lastOperation: "unknown" },
    ]);
  });

  it("rolls each window up: stall count, loop delay, and the operations that stalled most", () => {
    start({ summaryIntervalMs: 1_000 });
    door({ door: "ipc", operation: "a" }, 300);
    door({ door: "ipc", operation: "a" }, 200);
    door({ door: "agent-socket", operation: "b" }, 600);
    blockThenTick(0);
    const loads = () => records.filter((record) => record.msg === "main stall load");
    expect(loads()).toEqual([
      expect.objectContaining({
        level: "info",
        component: "main-stall",
        windowMs: 1_150,
        stalls: 3,
        stallMs: 1_100,
        maxStallMs: 600,
        loopDelayP95Ms: expect.any(Number),
        loopDelayMaxMs: expect.any(Number),
        unattributedShare: 0,
        doors: [
          { door: "agent-socket", count: 1, totalMs: 600 },
          { door: "ipc", count: 2, totalMs: 500 },
        ],
        top: [
          { door: "agent-socket", operation: "b", count: 1, totalMs: 600, maxMs: 600 },
          { door: "ipc", operation: "a", count: 2, totalMs: 500, maxMs: 300 },
        ],
      }),
    ]);
    // The window resets: the next roll-up counts only what came after. A
    // block no span explains is counted the tick after it, in that tick's window.
    clock += 1_000;
    vi.advanceTimersByTime(50);
    expect(loads()[1]).toMatchObject({ stalls: 0, unattributedShare: 0 });
    clock += 1_000;
    vi.advanceTimersByTime(50);
    expect(loads()[2]).toMatchObject({
      stalls: 1,
      unattributedShare: 1,
      doors: [{ door: "unattributed", count: 1 }],
      top: [{ operation: "unattributed" }],
    });
  });

  it("stops timing doors and probing once stopped, and a stale stop leaves a newer monitor alone", () => {
    const old = start();
    const current = start();
    old.stop();
    old.stop();
    door({ door: "ipc", operation: "still-watched" }, 250);
    expect(stalls()).toHaveLength(1);
    current.stop();
    door({ door: "ipc", operation: "unwatched" }, 250);
    blockThenTick(500);
    expect(stalls()).toHaveLength(1);
    // Each stop rolls up its own window once: the stale one saw nothing.
    expect(records.filter((record) => record.msg === "main stall load")).toMatchObject([
      { stalls: 0, loopDelayMaxMs: 0 },
      { stalls: 1, top: [{ operation: "still-watched" }] },
    ]);
  });
});
