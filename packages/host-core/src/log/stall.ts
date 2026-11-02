/**
 * Main-thread stall telemetry (VC-1073): a line for every event-loop block
 * over a threshold, saying what was running.
 *
 * Electron main hosts the synchronous SQLite and every Session's agent loop,
 * so a block there freezes the whole app. Two cheap measurements, no stack
 * capture:
 *
 * - **Door spans, exact.** Every door ({@link withTrace}: Electron IPC, the
 *   Session RPC bridge, the agent socket) times the synchronous part of its
 *   call — two clock reads. A span over the threshold is logged inside the
 *   call's own context, so the line names its `door`, `operation`, `traceId`
 *   and `spanId` (`attribution: "door"`).
 * - **Loop lag, for everything else.** A short unref'd interval measures how
 *   late it fires. Lag over the threshold that no door span explains is
 *   logged as `attribution: "unattributed"` with the last door call that ran
 *   before it as a hint (`lastOperation`, `lastOperationAgoMs`) — work that
 *   call scheduled (an await continuation, a timer), or work no door started
 *   at all (an agent loop, a host timer). The line never claims that
 *   operation's trace. Lag can undercount a block by up to one tick.
 *
 * Every tick's lag also goes into a histogram, and once an hour a
 * `main stall load` line rolls the window up: stall count, loop-delay p95
 * and max, and the operations that stalled most.
 *
 * Logs only. Nothing here changes what an operation does or when.
 */
import { createHistogram, type RecordableHistogram } from "node:perf_hooks";

import { logContext, observeDoorSpans, withRootLogContext } from "./context";
import { hostLogger } from "./root";

const log = hostLogger("main-stall");

/** The defaults: a block a person notices, checked often enough to see it. */
export const MAIN_STALL_DEFAULTS = Object.freeze({
  thresholdMs: 200,
  tickMs: 50,
  summaryIntervalMs: 60 * 60 * 1000,
  topOperations: 5,
});

export interface MainStallMonitorOptions {
  /** A block at least this long is a stall. */
  readonly thresholdMs?: number;
  /** How often the lag probe wakes. */
  readonly tickMs?: number;
  /** How often the roll-up line is written. */
  readonly summaryIntervalMs?: number;
  /** A monotonic clock in milliseconds; `performance.now` unless a test pins it. */
  readonly now?: () => number;
}

export interface MainStallMonitor {
  /** Stops the probe and the door timing. Idempotent. */
  stop(): void;
}

/** One operation's stalls in the current window. */
interface OperationLoad {
  readonly door: string;
  readonly operation: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

const UNATTRIBUTED = "unattributed";

/** A context field as a short label, or the fallback when it is absent. */
function field(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Starts the stall monitor. One per process: a second start replaces the
 * first's door timing, so stop the old one first.
 */
export function startMainStallMonitor(options: MainStallMonitorOptions = {}): MainStallMonitor {
  const thresholdMs = options.thresholdMs ?? MAIN_STALL_DEFAULTS.thresholdMs;
  const tickMs = options.tickMs ?? MAIN_STALL_DEFAULTS.tickMs;
  const summaryIntervalMs = options.summaryIntervalMs ?? MAIN_STALL_DEFAULTS.summaryIntervalMs;
  const now = options.now ?? (() => performance.now());

  let lastTick = now();
  /** When the most recent door stall ended: the lag it caused is already logged. */
  let doorStallAt = Number.NEGATIVE_INFINITY;
  /** The most recent door call to finish its synchronous part: a reference, never a copy. */
  let lastDoor: Readonly<Record<string, unknown>> | null = null;
  let lastDoorAt = 0;

  let windowStartedAt = lastTick;
  let stalls = 0;
  let stallMs = 0;
  let maxStallMs = 0;
  let operations = new Map<string, OperationLoad>();
  const lag: RecordableHistogram = createHistogram();

  const count = (door: string, operation: string, ms: number): void => {
    stalls += 1;
    stallMs += ms;
    maxStallMs = Math.max(maxStallMs, ms);
    const key = `${door}\u0000${operation}`;
    const load = operations.get(key) ?? { door, operation, count: 0, totalMs: 0, maxMs: 0 };
    load.count += 1;
    load.totalMs += ms;
    load.maxMs = Math.max(load.maxMs, ms);
    operations.set(key, load);
  };

  const undoDoors = observeDoorSpans((syncMs) => {
    const context = logContext();
    lastDoor = context;
    lastDoorAt = now();
    if (syncMs < thresholdMs) return;
    doorStallAt = lastDoorAt;
    const durationMs = Math.round(syncMs);
    log.warn("main stall", { durationMs, attribution: "door", thresholdMs });
    count(field(context["door"], "unknown"), field(context["operation"], "unknown"), durationMs);
  });

  const summarize = (at: number): void => {
    const top = [...operations.values()]
      .toSorted((a, b) => b.totalMs - a.totalMs)
      .slice(0, MAIN_STALL_DEFAULTS.topOperations)
      .map((load) => ({
        door: load.door,
        operation: load.operation,
        count: load.count,
        totalMs: load.totalMs,
        maxMs: load.maxMs,
      }));
    log.info("main stall load", {
      windowMs: Math.round(at - windowStartedAt),
      stalls,
      stallMs,
      maxStallMs,
      // Never empty: only a tick summarizes, after recording its own lag.
      loopDelayP95Ms: lag.percentile(95),
      loopDelayMaxMs: lag.max,
      thresholdMs,
      top,
    });
    windowStartedAt = at;
    stalls = 0;
    stallMs = 0;
    maxStallMs = 0;
    operations = new Map();
    lag.reset();
  };

  const tick = (): void => {
    const at = now();
    const lateMs = Math.max(0, at - lastTick - tickMs);
    const previousTick = lastTick;
    lastTick = at;
    // A histogram holds integers from 1: a punctual tick is its floor.
    lag.record(Math.max(1, Math.round(lateMs)));
    if (lateMs >= thresholdMs && doorStallAt <= previousTick) {
      const durationMs = Math.round(lateMs);
      log.warn("main stall", {
        durationMs,
        attribution: UNATTRIBUTED,
        thresholdMs,
        ...(lastDoor === null
          ? {}
          : {
              lastDoor: field(lastDoor["door"], "unknown"),
              lastOperation: field(lastDoor["operation"], "unknown"),
              lastOperationAgoMs: Math.round(at - lastDoorAt),
            }),
      });
      count(UNATTRIBUTED, UNATTRIBUTED, durationMs);
    }
    if (at - windowStartedAt >= summaryIntervalMs) summarize(at);
  };

  // A root context: the probe carries no trace of whatever operation started it.
  const timer = withRootLogContext({}, () => setInterval(tick, tickMs));
  timer.unref();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      undoDoors();
    },
  };
}
