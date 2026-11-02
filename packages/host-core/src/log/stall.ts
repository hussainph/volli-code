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
 *   at all. The line never claims that
 *   operation's trace. Lag can undercount a block by up to one tick.
 *
 * - **Labelled spans, exact** (VC-1090). Work no door starts carries a span
 *   of its own ({@link withMainSpan}): a Session's runtime (`door:
 *   "runtime"`), a host timer (`"timer"`), a fan-out to windows
 *   (`"broadcast"`). One over the threshold is logged as `attribution:
 *   "span"` with its `door`, `operation` and `sessionId`. Spans nest: the
 *   innermost span over the threshold wins, and names the span it ran in
 *   (`parentDoor`, `parentOperation`).
 * - **Garbage collection.** A block no span explains is held one tick, so
 *   V8's `gc` entries for it can arrive; pauses inside it that hold at least
 *   half of it log it as `attribution: "gc"` (`door: "gc"`, `operation`: the
 *   longest pause's kind, `gcMs`).
 * - **Off the CPU.** A block in which main's own thread used less than half
 *   its time in CPU is logged as `attribution: "off-cpu"` (`door: "off-cpu"`,
 *   `cpuMs`): main was waiting in a blocking call (a synchronous file or
 *   process call, a lock) or was not scheduled at all, not running code a
 *   label could name. Every unexplained line carries `cpuMs`.
 * - **Many short spans, summed.** Lag no single span explains, but which
 *   short spans since the previous tick account for at least half of, is
 *   logged as `attribution: "aggregate"` naming the operation that ran
 *   longest (`spanMs`, `spanCount`, and `coveredMs` for every span).
 *
 * Every tick's lag also goes into a histogram, and once an hour (and once
 * more when the monitor stops) a `main stall load` line rolls the window up: stall count, loop-delay p95
 * and max, the share of stall time nothing explained (`unattributedShare`)
 * and the share main spent off the CPU (`offCpuShare`),
 * the totals per door, and the operations that stalled most.
 *
 * Logs only. Nothing here changes what an operation does or when.
 */
import {
  constants as perfConstants,
  createHistogram,
  PerformanceObserver,
  type RecordableHistogram,
} from "node:perf_hooks";

import {
  observeMainSpans,
  withRootLogContext,
  type MainSpan,
  type MainSpanObserver,
} from "./context";
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
  /** Where garbage-collection pauses come from; V8's own `gc` entries unless a test scripts them. */
  readonly observeGc?: GcPauseSource;
  /** Main's own CPU time in milliseconds; `process.threadCpuUsage` unless a test pins it. */
  readonly threadCpuMs?: () => number;
}

/** This thread's CPU time (user and system) in milliseconds. */
export function threadCpuMs(): number {
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / 1000;
}

/**
 * Reports each garbage-collection pause on main (start and duration on the
 * monitor's clock, and its kind) until the returned undo runs.
 */
export type GcPauseSource = (
  onPause: (startMs: number, durationMs: number, kind: string) => void,
) => () => void;

const GC_KINDS: Readonly<Record<number, string>> = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};

/** A `gc` entry's `detail` as a short kind label: `major`, `minor`, … or `unknown`. */
export function gcPauseKind(detail: unknown): string {
  const kind = (detail as { kind?: unknown } | null)?.kind;
  return (typeof kind === "number" ? GC_KINDS[kind] : undefined) ?? "unknown";
}

/** V8's `gc` performance entries, which Node delivers shortly after each pause. */
export const V8_GC_PAUSES: GcPauseSource = (onPause) => {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      onPause(entry.startTime, entry.duration, gcPauseKind((entry as { detail?: unknown }).detail));
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  return () => observer.disconnect();
};

export interface MainStallMonitor {
  /** Stops the probe and the span timing, and rolls up the window so far. Idempotent. */
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

/** One door's stalls in the current window. */
interface DoorLoad {
  readonly door: string;
  count: number;
  totalMs: number;
}

/** One operation's synchronous time since the previous tick. */
interface TickLoad {
  readonly door: string;
  readonly operation: string;
  count: number;
  ms: number;
}

const UNATTRIBUTED = "unattributed";
const OFF_CPU = "off-cpu";

/** How many recent GC pauses are kept to explain a block with. */
const GC_PAUSES_KEPT = 64;

interface GcPause {
  readonly startMs: number;
  readonly durationMs: number;
  readonly kind: string;
}

/** A block no span explained, held one tick so the GC pauses inside it can arrive. */
interface PendingBlock {
  readonly from: number;
  readonly to: number;
  readonly lateMs: number;
  /** Main's CPU time across the late tick. */
  readonly cpuMs: number;
  readonly hint: Readonly<Record<string, string | number>>;
}

/** `part` of `whole` to two decimals; a window without stalls has nothing unexplained. */
function share(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100) / 100;
}

/** The parent hint: the span this one ran inside, when there is one. */
function parentHint(span: MainSpan): { parentDoor?: string; parentOperation?: string } {
  return span.parent === null
    ? {}
    : { parentDoor: span.parent.door, parentOperation: span.parent.operation };
}

/**
 * Starts the stall monitor. One per process: a second start replaces the
 * first's span timing, so stop the old one first.
 */
export function startMainStallMonitor(options: MainStallMonitorOptions = {}): MainStallMonitor {
  const thresholdMs = options.thresholdMs ?? MAIN_STALL_DEFAULTS.thresholdMs;
  const tickMs = options.tickMs ?? MAIN_STALL_DEFAULTS.tickMs;
  const summaryIntervalMs = options.summaryIntervalMs ?? MAIN_STALL_DEFAULTS.summaryIntervalMs;
  const now = options.now ?? (() => performance.now());
  const observeGc = options.observeGc ?? V8_GC_PAUSES;
  const cpu = options.threadCpuMs ?? threadCpuMs;

  let lastTick = now();
  let lastCpu = cpu();
  /** When the most recent logged span stall ended: the lag it caused is already logged. */
  let spanStallAt = Number.NEGATIVE_INFINITY;
  /** The most recent span to finish its synchronous part: a reference, never a copy. */
  let lastSpan: MainSpan | null = null;
  let lastSpanAt = 0;
  /** Every span's own time since the previous tick, by operation. */
  const tickLoads = new Map<string, TickLoad>();
  let tickCoveredMs = 0;
  /** Recent GC pauses, oldest first. */
  let gcPauses: GcPause[] = [];
  let pending: PendingBlock | null = null;

  let windowStartedAt = lastTick;
  let stalls = 0;
  let stallMs = 0;
  let maxStallMs = 0;
  let unattributedMs = 0;
  let offCpuMs = 0;
  let operations = new Map<string, OperationLoad>();
  let doors = new Map<string, DoorLoad>();
  const lag: RecordableHistogram = createHistogram();

  const count = (door: string, operation: string, ms: number): void => {
    stalls += 1;
    stallMs += ms;
    maxStallMs = Math.max(maxStallMs, ms);
    if (door === UNATTRIBUTED) unattributedMs += ms;
    if (door === OFF_CPU) offCpuMs += ms;
    const key = `${door}\u0000${operation}`;
    const load = operations.get(key) ?? { door, operation, count: 0, totalMs: 0, maxMs: 0 };
    load.count += 1;
    load.totalMs += ms;
    load.maxMs = Math.max(load.maxMs, ms);
    operations.set(key, load);
    const doorLoad = doors.get(door) ?? { door, count: 0, totalMs: 0 };
    doorLoad.count += 1;
    doorLoad.totalMs += ms;
    doors.set(door, doorLoad);
  };

  const observer: MainSpanObserver = (syncMs, selfMs, span) => {
    lastSpan = span;
    lastSpanAt = now();
    tickCoveredMs += selfMs;
    const key = `${span.door}\u0000${span.operation}`;
    const tally = tickLoads.get(key);
    if (tally === undefined) {
      tickLoads.set(key, { door: span.door, operation: span.operation, count: 1, ms: selfMs });
    } else {
      tally.count += 1;
      tally.ms += selfMs;
    }
    if (syncMs < thresholdMs || span.nestedStall) return false;
    spanStallAt = lastSpanAt;
    const durationMs = Math.round(syncMs);
    if (span.kind === "door") {
      // Inside the call's own context: the line carries its trace, door and operation.
      log.warn("main stall", { durationMs, attribution: "door", thresholdMs, ...parentHint(span) });
    } else {
      log.warn("main stall", {
        durationMs,
        attribution: "span",
        thresholdMs,
        door: span.door,
        operation: span.operation,
        ...(span.sessionId === undefined ? {} : { sessionId: span.sessionId }),
        ...parentHint(span),
      });
    }
    count(span.door, span.operation, durationMs);
    return true;
  };
  const undoSpans = observeMainSpans(observer);
  const undoGc = observeGc((startMs, durationMs, kind) => {
    gcPauses.push({ startMs, durationMs, kind });
    if (gcPauses.length > GC_PAUSES_KEPT) gcPauses = gcPauses.slice(-GC_PAUSES_KEPT / 2);
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
      unattributedShare: share(unattributedMs, stallMs),
      offCpuShare: share(offCpuMs, stallMs),
      // Zero for a window stopped before its first tick.
      loopDelayP95Ms: lag.percentile(95),
      loopDelayMaxMs: lag.max,
      thresholdMs,
      doors: [...doors.values()]
        .toSorted((a, b) => b.totalMs - a.totalMs)
        .map((load) => ({ door: load.door, count: load.count, totalMs: load.totalMs })),
      top,
    });
    windowStartedAt = at;
    stalls = 0;
    stallMs = 0;
    maxStallMs = 0;
    unattributedMs = 0;
    offCpuMs = 0;
    operations = new Map();
    doors = new Map();
    lag.reset();
  };

  /** The operation that ran longest since the previous tick, if any span ran. */
  const busiest = (): TickLoad | null => {
    let found: TickLoad | null = null;
    for (const load of tickLoads.values()) if (found === null || load.ms > found.ms) found = load;
    return found;
  };

  const unexplained = (at: number, lateMs: number, cpuMs: number): void => {
    const durationMs = Math.round(lateMs);
    const top = busiest();
    // Short spans that together held at least half the block explain it.
    if (top !== null && tickCoveredMs >= lateMs / 2) {
      log.warn("main stall", {
        durationMs,
        attribution: "aggregate",
        thresholdMs,
        door: top.door,
        operation: top.operation,
        spanMs: Math.round(top.ms),
        spanCount: top.count,
        coveredMs: Math.round(tickCoveredMs),
      });
      count(top.door, top.operation, durationMs);
      return;
    }
    pending = {
      from: at - lateMs,
      to: at,
      lateMs,
      cpuMs,
      hint: {
        ...(lastSpan === null
          ? {}
          : {
              lastDoor: lastSpan.door,
              lastOperation: lastSpan.operation,
              lastOperationAgoMs: Math.round(at - lastSpanAt),
            }),
        ...(tickCoveredMs > 0 ? { coveredMs: Math.round(tickCoveredMs) } : {}),
      },
    };
  };

  /**
   * A held block, now that the GC pauses inside it have arrived: a pause or
   * pauses holding at least half of it explain it (`attribution: "gc"`,
   * named by the longest pause's kind); otherwise it is unattributed.
   */
  const resolvePending = (): void => {
    if (pending === null) return;
    const block = pending;
    pending = null;
    let gcMs = 0;
    // A block is never empty (it is over the threshold), so any overlap names a pause.
    let longest: GcPause = { startMs: 0, durationMs: -1, kind: "unknown" };
    for (const pause of gcPauses) {
      const overlap =
        Math.min(block.to, pause.startMs + pause.durationMs) - Math.max(block.from, pause.startMs);
      if (overlap <= 0) continue;
      gcMs += overlap;
      if (pause.durationMs > longest.durationMs) longest = pause;
    }
    const durationMs = Math.round(block.lateMs);
    if (gcMs >= block.lateMs / 2) {
      log.warn("main stall", {
        durationMs,
        attribution: "gc",
        thresholdMs,
        door: "gc",
        operation: longest.kind,
        gcMs: Math.round(gcMs),
      });
      count("gc", longest.kind, durationMs);
      return;
    }
    const cpuMs = Math.round(block.cpuMs);
    // Main was not running for most of it: waiting in a blocking call, or not scheduled.
    const offCpu = block.cpuMs < block.lateMs / 2;
    log.warn("main stall", {
      durationMs,
      attribution: offCpu ? OFF_CPU : UNATTRIBUTED,
      thresholdMs,
      // Filed as the roll-up files it; an unattributed line names no door at all.
      ...(offCpu ? { door: OFF_CPU, operation: "wait" } : {}),
      cpuMs,
      ...block.hint,
      ...(gcMs > 0 ? { gcMs: Math.round(gcMs) } : {}),
    });
    if (offCpu) count(OFF_CPU, "wait", durationMs);
    else count(UNATTRIBUTED, UNATTRIBUTED, durationMs);
  };

  const tick = (): void => {
    const at = now();
    const lateMs = Math.max(0, at - lastTick - tickMs);
    const previousTick = lastTick;
    lastTick = at;
    const cpuAt = cpu();
    const cpuMs = cpuAt - lastCpu;
    lastCpu = cpuAt;
    // A histogram holds integers from 1: a punctual tick is its floor.
    lag.record(Math.max(1, Math.round(lateMs)));
    resolvePending();
    if (lateMs >= thresholdMs && spanStallAt <= previousTick) unexplained(at, lateMs, cpuMs);
    tickLoads.clear();
    tickCoveredMs = 0;
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
      undoSpans();
      undoGc();
      resolvePending();
      // The window so far: a quit, or a run shorter than the interval, still reports.
      summarize(now());
    },
  };
}
