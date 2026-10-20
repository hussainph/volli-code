/**
 * VC-445 aggregation: raw launches in, one arm table out.
 *
 * Pure functions over the records `pi-context-scaling-bench.mjs` writes, kept
 * apart from the runner so they are unit-tested without Electron
 * (`aggregate.test.mjs`, on the bench lane only).
 *
 * Percentiles are VC-353's nearest-rank (`summarize` from the performance
 * matrix), so a p95 here means what it means in every other desktop baseline —
 * including that below 20 samples a nearest-rank p95 IS the maximum. The
 * tables mark those cells rather than let them pass as a tail estimate.
 *
 * Two poolings are used and they are not interchangeable:
 *
 * - **Latency and loop-gap samples are pooled** across an arm's repetitions:
 *   every IPC round trip and every 10 ms tick gap is one sample, so the p95 is
 *   taken over hundreds or thousands of them.
 * - **Per-launch figures are summarized across launches**: memory, GC totals,
 *   the `monitorEventLoopDelay` histogram's own percentiles and every
 *   within-launch delta are one value per launch, reported as median / min /
 *   max with `n` launches.
 *
 * A launch that failed any of the runner's checks (binding census, tripwire,
 * a refused request) is counted and excluded, never summarized.
 */

import { summarize } from "../performance/run.mjs";

export const WINDOW_NAMES = Object.freeze(["idle", "hydration", "steady"]);
/** Latency is re-derived without launches whose 1-minute load exceeded this many × cores. */
export const LOAD_THRESHOLD_PER_CORE = 1.5;
/** Below this many samples a nearest-rank p95 is the maximum. */
export const P95_MIN_SAMPLES = 20;
/** Correlation bin width. Cross-process epoch clocks align only to the millisecond. */
export const CORRELATION_BIN_MS = 100;

const MIB = 1024 * 1024;
const round3 = (value) => Math.round(value * 1000) / 1000;
const round4 = (value) => Math.round(value * 10_000) / 10_000;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function loadThresholdFor(cores) {
  return cores * LOAD_THRESHOLD_PER_CORE;
}

/**
 * How many Sessions the arm bound. Runs before the flag was renamed recorded
 * it as `attached`; every Session in the fixture is attached, and the arm is
 * about how many are BOUND, so new runs say so.
 */
export function boundOf(arm) {
  return arm.bound ?? arm.attached;
}

export function armKey(arm) {
  const bound = boundOf(arm);
  return bound === 0 ? "control" : `n${bound}-h${arm.historyEntries}`;
}

/** Median, min and max of one value per launch. */
export function acrossLaunches(values) {
  const usable = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (usable.length === 0) return null;
  const middle = Math.floor(usable.length / 2);
  const median =
    usable.length % 2 === 1 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
  return {
    n: usable.length,
    median: round3(median),
    min: round3(usable[0]),
    max: round3(usable.at(-1)),
  };
}

function rendererWorkingSetKiB(snapshot) {
  const tabs = snapshot.metrics.filter((metric) => metric.type === "Tab");
  if (tabs.length === 0) return null;
  return tabs.reduce((sum, metric) => sum + (metric.workingSetKiB ?? 0), 0);
}

/** The memory figures the report compares, in MiB. */
export function memoryFigures(snapshot) {
  return {
    mainWorkingSetMiB: (snapshot.mainMetric?.workingSetKiB ?? Number.NaN) / 1024,
    mainRssMiB: snapshot.processMemory.rss / MIB,
    mainHeapUsedMiB: snapshot.processMemory.heapUsed / MIB,
    mainHeapTotalMiB: snapshot.processMemory.heapTotal / MIB,
    mainExternalMiB: snapshot.processMemory.external / MIB,
    rendererWorkingSetMiB: (rendererWorkingSetKiB(snapshot) ?? Number.NaN) / 1024,
    mainFootprintMiB: (snapshot.footprint?.mainBytes ?? Number.NaN) / MIB,
    rendererFootprintMiB:
      snapshot.footprint === undefined || snapshot.footprint.rendererBytes.includes(null)
        ? Number.NaN
        : snapshot.footprint.rendererBytes.reduce((sum, bytes) => sum + bytes, 0) / MIB,
  };
}

/**
 * Pearson correlation of per-bin maxima: the worst main-loop gap and the worst
 * renderer→main round trip that STARTED in the same bin. Only bins holding
 * both kinds of sample count. Tick gaps, not the `monitorEventLoopDelay`
 * histogram, carry this: a histogram has no timestamps to bin by.
 */
export function binnedCorrelation(tickGaps, ipcSamples, binMs = CORRELATION_BIN_MS) {
  const bins = new Map();
  const bin = (epochMs) => Math.floor(epochMs / binMs);
  for (const [epochMs, gapMs] of tickGaps) {
    const key = bin(epochMs - gapMs); // attribute a gap to where it began
    const entry = bins.get(key) ?? { gap: -Infinity, ipc: -Infinity };
    entry.gap = Math.max(entry.gap, gapMs);
    bins.set(key, entry);
  }
  for (const [epochMs, latencyMs] of ipcSamples) {
    const key = bin(epochMs);
    const entry = bins.get(key) ?? { gap: -Infinity, ipc: -Infinity };
    entry.ipc = Math.max(entry.ipc, latencyMs);
    bins.set(key, entry);
  }
  const pairs = [...bins.values()].filter(
    (entry) => Number.isFinite(entry.gap) && Number.isFinite(entry.ipc),
  );
  if (pairs.length < 3) return { bins: pairs.length, pearson: null };
  const gaps = pairs.map((pair) => pair.gap);
  const ipcs = pairs.map((pair) => pair.ipc);
  const gapMean = mean(gaps);
  const ipcMean = mean(ipcs);
  let covariance = 0;
  let gapVariance = 0;
  let ipcVariance = 0;
  for (let index = 0; index < pairs.length; index += 1) {
    covariance += (gaps[index] - gapMean) * (ipcs[index] - ipcMean);
    gapVariance += (gaps[index] - gapMean) ** 2;
    ipcVariance += (ipcs[index] - ipcMean) ** 2;
  }
  const pearson =
    gapVariance === 0 || ipcVariance === 0
      ? null
      : round3(covariance / Math.sqrt(gapVariance * ipcVariance));
  return { bins: pairs.length, pearson };
}

/** Successful samples only: a failed request's latency measures the failure. */
export function okSamples(samples) {
  return samples.filter((sample) => sample[2] === 1);
}

function latencies(samples) {
  return okSamples(samples).map((sample) => sample[1]);
}

function p95(values) {
  return summarize(values)?.p95 ?? Number.NaN;
}

function aggregateWindow(launches, name) {
  const windows = launches.map((launch) => launch.windows[name]).filter(Boolean);
  if (windows.length === 0) return null;
  const tickGaps = windows.flatMap((window) => window.main.tickGaps);
  const echo = windows.flatMap((window) => window.renderer.echo);
  const rpc = windows.flatMap((window) => window.renderer.rpc);
  return {
    launches: windows.length,
    wallMs: acrossLaunches(windows.map((window) => window.main.wallMs)),
    mainCpuMs: acrossLaunches(windows.map((window) => window.main.mainCpuMs)),
    eventLoopDelay: {
      samples: windows.reduce((sum, window) => sum + window.main.eventLoopDelay.count, 0),
      p50Ms: acrossLaunches(windows.map((window) => window.main.eventLoopDelay.p50Ms)),
      p95Ms: acrossLaunches(windows.map((window) => window.main.eventLoopDelay.p95Ms)),
      maxMs: acrossLaunches(windows.map((window) => window.main.eventLoopDelay.maxMs)),
    },
    tickGapMs: summarize(tickGaps.map(([, gap]) => gap)),
    ipcEchoMs: summarize(latencies(echo)),
    sessionRpcMs: summarize(latencies(rpc)),
    ipcFailures: echo.length + rpc.length - okSamples(echo).length - okSamples(rpc).length,
    gc: {
      countPerLaunch: acrossLaunches(windows.map((window) => window.main.gc.count)),
      totalMsPerLaunch: acrossLaunches(windows.map((window) => window.main.gc.totalMs)),
      pauseMs: summarize(
        windows.flatMap((window) => window.main.gc.entries.map((entry) => entry.durationMs)),
      ),
    },
    loopVsEcho: binnedCorrelation(tickGaps, okSamples(echo)),
  };
}

/**
 * Loop and IPC as DELTAS, paired inside each launch: a window's figure minus
 * the same launch's idle window. Pairing removes whatever the host was doing
 * during that launch, which on a shared machine is most of the variance.
 */
function windowDeltas(launches, name) {
  const pairs = launches
    .map((launch) => [launch.windows.idle, launch.windows[name]])
    .filter(([idle, window]) => idle !== undefined && window !== undefined);
  const delta = (read) => acrossLaunches(pairs.map(([idle, window]) => read(window) - read(idle)));
  return {
    eventLoopDelayP95Ms: delta((window) => window.main.eventLoopDelay.p95Ms),
    eventLoopDelayMaxMs: delta((window) => window.main.eventLoopDelay.maxMs),
    tickGapP95Ms: delta((window) => p95(window.main.tickGaps.map(([, gap]) => gap))),
    ipcEchoP95Ms: delta((window) => p95(latencies(window.renderer.echo))),
    sessionRpcP95Ms: delta((window) => p95(latencies(window.renderer.rpc))),
  };
}

function aggregateMemory(launches) {
  const pre = launches.map((launch) => memoryFigures(launch.memory.pre));
  const post = launches.map((launch) => memoryFigures(launch.memory.post));
  const result = {};
  for (const key of Object.keys(pre[0] ?? {})) {
    const deltas = pre.map((before, index) => post[index][key] - before[key]);
    result[key] = {
      pre: acrossLaunches(pre.map((figures) => figures[key])),
      post: acrossLaunches(post.map((figures) => figures[key])),
      delta: acrossLaunches(deltas),
    };
  }
  return result;
}

/** Summarize one arm's measured, passing launches. */
export function aggregateArm(arm, launches) {
  const bound = boundOf(arm);
  const hydrations = launches.flatMap((launch) => launch.windows.hydration?.perSession ?? []);
  return {
    key: armKey(arm),
    bound,
    historyEntries: arm.historyEntries,
    launches: launches.length,
    boundVerified: launches.every(
      (launch) =>
        launch.bindings.before.live === 0 &&
        launch.bindings.after.live === bound &&
        launch.bindings.after.unexpectedLive.length === 0,
    ),
    sidecar: {
      entriesPerSession: acrossLaunches(launches.flatMap((launch) => launch.sidecarEntries ?? [])),
      bytesPerSession: acrossLaunches(launches.flatMap((launch) => launch.sidecarBytes ?? [])),
    },
    hydrationPerSessionMs: summarize(hydrations.map((entry) => entry.ms)),
    // The first bind after boot also pays one-time lazy costs (tool and
    // environment setup shared by every later bind); the rest are the
    // per-context cost.
    hydrationFirstMs: summarize(
      launches.map((launch) => launch.windows.hydration?.perSession?.[0]?.ms ?? Number.NaN),
    ),
    hydrationLaterMs: summarize(
      launches.flatMap((launch) =>
        (launch.windows.hydration?.perSession ?? []).slice(1).map((entry) => entry.ms),
      ),
    ),
    hydrationTotalMs: acrossLaunches(
      launches.map((launch) => launch.windows.hydration?.main.wallMs ?? Number.NaN),
    ),
    memory: aggregateMemory(launches),
    // Process topology: descendants of main by parent pid, before and after
    // binding. Unchanged counts are the evidence that a bound context is work
    // inside main, not a process.
    descendants: {
      pre: acrossLaunches(
        launches.map((launch) => launch.memory.pre.descendants?.length ?? Number.NaN),
      ),
      post: acrossLaunches(
        launches.map((launch) => launch.memory.post.descendants?.length ?? Number.NaN),
      ),
      appMetricsPre: acrossLaunches(launches.map((launch) => launch.memory.pre.metrics.length)),
      appMetricsPost: acrossLaunches(launches.map((launch) => launch.memory.post.metrics.length)),
    },
    // The second forced full GC of each pair: a stop-the-world mark-compact of
    // what is live, before hydration and after it.
    fullGcPauseMs: {
      pre: acrossLaunches(launches.map((launch) => launch.fullGcPauseMs?.pre?.[1] ?? Number.NaN)),
      post: acrossLaunches(launches.map((launch) => launch.fullGcPauseMs?.post?.[1] ?? Number.NaN)),
    },
    windows: Object.fromEntries(
      WINDOW_NAMES.map((name) => [name, aggregateWindow(launches, name)]),
    ),
    deltasVsIdle: {
      hydration: windowDeltas(launches, "hydration"),
      steady: windowDeltas(launches, "steady"),
    },
  };
}

/**
 * Least-squares slope and intercept of y on x. Fewer than three points is not
 * a fit — two points always give r² = 1 — so it answers null.
 */
export function linearFit(points) {
  const usable = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (usable.length < 3) return null;
  const n = usable.length;
  const meanX = usable.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = usable.reduce((sum, [, y]) => sum + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of usable) {
    sxx += (x - meanX) ** 2;
    sxy += (x - meanX) * (y - meanY);
    syy += (y - meanY) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { n, slope: round4(slope), intercept: round4(meanY - slope * meanX), r2: round4(r2) };
}

/**
 * Per-context cost: for each history length, the slope of the post-GC delta
 * against the number of bound contexts, the control arm supplying N = 0.
 */
export function contextCostFits(arms, metric = "mainHeapUsedMiB") {
  const control = arms.find((arm) => arm.bound === 0);
  const histories = [
    ...new Set(arms.filter((arm) => arm.bound > 0).map((arm) => arm.historyEntries)),
  ];
  return histories
    .toSorted((a, b) => a - b)
    .map((historyEntries) => {
      const points = arms
        .filter((arm) => arm.bound > 0 && arm.historyEntries === historyEntries)
        .map((arm) => [arm.bound, arm.memory[metric]?.delta?.median]);
      if (control) points.push([0, control.memory[metric]?.delta?.median]);
      return { historyEntries, metric, fit: linearFit(points) };
    });
}

function groupByArm(launches) {
  const byArm = new Map();
  for (const launch of launches) {
    const key = armKey(launch.arm);
    const group = byArm.get(key) ?? { arm: launch.arm, launches: [] };
    group.launches.push(launch);
    byArm.set(key, group);
  }
  return [...byArm.values()]
    .map(({ arm, launches: group }) => aggregateArm(arm, group))
    .toSorted((a, b) => a.historyEntries - b.historyEntries || a.bound - b.bound);
}

/** The worst 1-minute load average seen at either end of a launch. */
export function launchLoad(launch) {
  return Math.max(launch.host?.before?.loadavg?.[0] ?? 0, launch.host?.after?.loadavg?.[0] ?? 0);
}

/**
 * The machine is shared, so every latency figure is re-derived from only the
 * launches whose load stayed under `threshold`. If the headline and this
 * disagree, load, not the arm, moved the number.
 */
function loadSensitivity(measured, threshold) {
  const kept = measured.filter((launch) => launchLoad(launch) <= threshold);
  return {
    threshold,
    launchesKept: kept.length,
    launchesDropped: measured.length - kept.length,
    arms: groupByArm(kept).map((arm) => ({
      key: arm.key,
      launches: arm.launches,
      heapUsedDeltaMiB: arm.memory.mainHeapUsedMiB.delta,
      hydrationLaterMs: arm.hydrationLaterMs,
      hydrationTickGapMs: arm.windows.hydration?.tickGapMs ?? null,
      hydrationIpcEchoMs: arm.windows.hydration?.ipcEchoMs ?? null,
      steadyTickGapMs: arm.windows.steady?.tickGapMs ?? null,
      steadyIpcEchoMs: arm.windows.steady?.ipcEchoMs ?? null,
    })),
  };
}

export function launchFailed(launch) {
  return (launch.failures?.length ?? 0) > 0;
}

export function aggregateRun(launches, { loadThreshold = Number.POSITIVE_INFINITY } = {}) {
  const nonWarmup = launches.filter((launch) => !launch.warmup);
  const measured = nonWarmup.filter((launch) => !launchFailed(launch));
  const arms = groupByArm(measured);
  return {
    excludedFailedLaunches: nonWarmup.length - measured.length,
    arms,
    fits: {
      mainHeapUsedMiB: contextCostFits(arms, "mainHeapUsedMiB"),
      mainWorkingSetMiB: contextCostFits(arms, "mainWorkingSetMiB"),
      mainRssMiB: contextCostFits(arms, "mainRssMiB"),
      mainFootprintMiB: contextCostFits(arms, "mainFootprintMiB"),
    },
    hostLoad: {
      launchLoad1m: summarize(measured.map(launchLoad)),
      memoryPressureLevels: [
        ...new Set(
          measured.flatMap((launch) => [
            launch.host?.before?.memoryPressureLevel,
            launch.host?.after?.memoryPressureLevel,
          ]),
        ),
      ].filter((level) => level !== undefined && level !== null),
      power: [...new Set(measured.map((launch) => launch.host?.before?.power ?? null))],
    },
    ...(Number.isFinite(loadThreshold)
      ? { lowLoad: loadSensitivity(measured, loadThreshold) }
      : {}),
    tripwire: {
      blocked: launches.flatMap((launch) => launch.tripwire?.blocked ?? []),
      chromiumBlocked: launches.flatMap((launch) => launch.tripwire?.chromiumBlocked ?? []),
      // Runs recorded before the self-test existed carry no result at all; they
      // are counted apart rather than as failures.
      selfTestsRecorded: launches.filter((launch) => launch.tripwireSelfTest !== undefined).length,
      selfTestsPassed: launches.filter(
        (launch) => launch.tripwireSelfTest?.node === true && launch.tripwireSelfTest?.chromium,
      ).length,
      launches: launches.length,
    },
  };
}
