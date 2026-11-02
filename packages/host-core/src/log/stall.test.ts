import type { LogRecord } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { withTrace } from "./context";
import { installHostLog } from "./root";
import { MAIN_STALL_DEFAULTS, startMainStallMonitor, type MainStallMonitor } from "./stall";

/** A pinned clock: `performance.now` is what door spans and the monitor both read. */
let clock = 0;
let records: LogRecord[] = [];
let undoLog: () => void = () => {};
const monitors: MainStallMonitor[] = [];

beforeEach(() => {
  clock = 1_000;
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

function start(options: Parameters<typeof startMainStallMonitor>[0] = {}): MainStallMonitor {
  const monitor = startMainStallMonitor({ tickMs: 50, ...options });
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

  it("times only the outermost door, and still reports one that throws", () => {
    start();
    expect(() =>
      withTrace(null, { door: "agent-socket", operation: "outer" }, () => {
        door({ door: "ipc", operation: "inner" }, 250);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(stalls().map((record) => [record.operation, record.durationMs])).toEqual([
      ["outer", 250],
    ]);
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

  it("names a door call that carried no door or operation as unknown", () => {
    start();
    door({}, 210);
    blockThenTick(0);
    blockThenTick(230);
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
        top: [
          { door: "agent-socket", operation: "b", count: 1, totalMs: 600, maxMs: 600 },
          { door: "ipc", operation: "a", count: 2, totalMs: 500, maxMs: 300 },
        ],
      }),
    ]);
    // The window resets: the next roll-up counts only what came after.
    clock += 1_000;
    vi.advanceTimersByTime(50);
    expect(loads()[1]).toMatchObject({ stalls: 1, top: [{ operation: "unattributed" }] });
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
  });
});
