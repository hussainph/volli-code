/**
 * The perf store's arithmetic (VC-1092): grouping stalls, their percentiles,
 * how long the app was actually watching, and the rates that make two builds
 * comparable.
 *
 * Kept apart from the SQL on purpose. The store's job is selecting rows by
 * time and process cheaply; what a group is, what its p95 means and how a
 * build that ran for ten minutes is weighed against one that ran all day are
 * judgements, written once here and tested without a database.
 *
 * A count of stalls alone cannot compare builds: a build that ran an hour
 * has fewer stalls than one that ran a day for no reason of its own. So every
 * answer carries `observedMs` — how long a monitored app was running inside
 * the window, from the store's run rows — and compare speaks in stalls and
 * stalled milliseconds **per hour observed**.
 */
import type { PerfGrouping, PerfProcess } from "@volli/shared";

/** One stall as the store reads it back: its row, and the run that recorded it. */
export interface PerfStallRecord {
  readonly at: number;
  readonly process: PerfProcess;
  /** Main: how the stall was attributed (`door`, `span`, `aggregate`, `unattributed`). Renderer: `frame` or `input`. */
  readonly kind: string;
  readonly door: string;
  readonly operation: string;
  readonly label: string | null;
  readonly sessionId: string | null;
  readonly windowId: number | null;
  readonly durationMs: number;
  /** Sum of attributed scripts; absent when Chromium supplies no attribution. */
  readonly scriptTotalMs?: number;
  readonly blockingMs?: number;
  /** Inclusive renderStart → frame end, not a phase to add to styleLayoutMs. */
  readonly renderMs?: number;
  /** styleAndLayoutStart → frame end: a subset of renderMs. */
  readonly styleLayoutMs?: number;
  /** Top script's sanitized basename, function and closed invoker category. */
  readonly scriptFile?: string;
  readonly scriptFunction?: string;
  readonly scriptInvoker?: string;
  readonly scriptMs?: number;
  /** An unattributed main stall's last door operation before it: a hint, never a claim. */
  readonly hint: string | null;
  readonly version: string;
  readonly build: string | null;
}

/** One launch of a monitored app: when it ran, and which build it was. */
export interface PerfRun {
  readonly startedAt: number;
  readonly lastSeenAt: number;
  readonly version: string;
  readonly build: string | null;
}

/** One group's stalls. */
export interface PerfGroupStats {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

/**
 * A build as one word: the app version, and the build label after a `+` when
 * the run had one (`0.3.0-canary.4+1a2b3c4`), as semver writes build metadata.
 */
export function perfVersionKey(version: string, build: string | null): string {
  return build === null ? version : `${version}+${build}`;
}

/**
 * Whether a run is the build a caller named: its whole key, its version (every
 * build of it), or its build label alone.
 */
export function perfVersionMatches(
  selector: string,
  run: { readonly version: string; readonly build: string | null },
): boolean {
  return (
    selector === run.version ||
    (run.build !== null &&
      (selector === run.build || selector === perfVersionKey(run.version, run.build)))
  );
}

/** The group a stall falls in along one dimension; `null` for a stall that has none (no label, no Session). */
export function perfGroupKey(stall: PerfStallRecord, by: PerfGrouping): string | null {
  switch (by) {
    case "operation":
      return `${stall.door}/${stall.operation}`;
    case "door":
      return stall.door;
    case "label":
      return stall.label;
    case "version":
      return perfVersionKey(stall.version, stall.build);
    case "session":
      return stall.sessionId;
  }
}

/** Nearest-rank percentile of an ascending list; 0 for an empty one. */
export function nearestRank(sorted: ArrayLike<number>, percentile: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/** The stats of a set of durations. A typed sort: numeric, and fast at a store's size. */
export function perfStats(durations: readonly number[]): PerfGroupStats {
  // A typed array sorts numerically without a comparator.
  const sorted = Float64Array.from(durations).toSorted();
  let totalMs = 0;
  for (const ms of sorted) totalMs += ms;
  return {
    count: sorted.length,
    totalMs,
    maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
    p50Ms: nearestRank(sorted, 50),
    p95Ms: nearestRank(sorted, 95),
  };
}

/** Durations per group, in first-seen order, folded one stall at a time. */
export class DurationGroups {
  readonly groups = new Map<string | null, number[]>();
  count = 0;
  totalMs = 0;

  constructor(private readonly by: PerfGrouping) {}

  add(stall: PerfStallRecord): void {
    const key = perfGroupKey(stall, this.by);
    const list = this.groups.get(key);
    if (list === undefined) this.groups.set(key, [stall.durationMs]);
    else list.push(stall.durationMs);
    this.count += 1;
    this.totalMs += stall.durationMs;
  }
}

/** One LoAF metric's coverage and total; unknown is never a measured zero. */
export interface PerfLoafMetric {
  readonly measuredFrames: number;
  readonly totalMs: number | null;
  /** Per hour of the answer's observed runtime, not an estimate of unmeasured frames. */
  readonly msPerHour: number | null;
}

/** Overlapping signals, not additive phases. Render includes the style/layout subset. */
export interface PerfLoafSummary {
  readonly script: PerfLoafMetric;
  readonly blocking: PerfLoafMetric;
  readonly render: PerfLoafMetric;
  readonly styleLayout: PerfLoafMetric;
}

/** Fold only measured renderer frames, retaining independent coverage for each signal. */
export class LoafTotals {
  private readonly metrics = {
    script: { measuredFrames: 0, totalMs: 0 },
    blocking: { measuredFrames: 0, totalMs: 0 },
    render: { measuredFrames: 0, totalMs: 0 },
    styleLayout: { measuredFrames: 0, totalMs: 0 },
  };

  add(stall: PerfStallRecord): void {
    if (
      stall.process !== "renderer" ||
      stall.kind !== "frame" ||
      stall.operation !== "long-animation-frame"
    ) {
      return;
    }
    const values = {
      script: stall.scriptTotalMs,
      blocking: stall.blockingMs,
      render: stall.renderMs,
      styleLayout: stall.styleLayoutMs,
    };
    for (const key of Object.keys(values) as (keyof typeof values)[]) {
      const value = values[key];
      if (value === undefined) continue;
      this.metrics[key].measuredFrames += 1;
      this.metrics[key].totalMs += value;
    }
  }

  summary(observed: number): PerfLoafSummary | undefined {
    const metric = (key: keyof PerfLoafSummary): PerfLoafMetric => {
      const { measuredFrames, totalMs } = this.metrics[key];
      return {
        measuredFrames,
        totalMs: measuredFrames === 0 ? null : totalMs,
        msPerHour: measuredFrames === 0 ? null : perHour(totalMs, observed),
      };
    };
    if (Object.values(this.metrics).every((value) => value.measuredFrames === 0)) return undefined;
    return {
      script: metric("script"),
      blocking: metric("blocking"),
      render: metric("render"),
      styleLayout: metric("styleLayout"),
    };
  }
}

/**
 * How long the runs were alive inside `[since, until]`: each run's overlap
 * with the window, summed. Runs never overlap (one monitored app per
 * profile), so the sum is wall time watched.
 */
export function observedMs(runs: readonly PerfRun[], since: number, until: number): number {
  let total = 0;
  for (const run of runs) {
    const from = Math.max(run.startedAt, since);
    const to = Math.min(run.lastSeenAt, until);
    if (to > from) total += to - from;
  }
  return total;
}

/** `value` per hour of `observed` ms, to two decimals; null when nothing was observed. */
export function perHour(value: number, observed: number): number | null {
  if (observed <= 0) return null;
  return Math.round((value / (observed / 3_600_000)) * 100) / 100;
}
