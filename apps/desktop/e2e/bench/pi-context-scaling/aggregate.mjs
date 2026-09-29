/**
 * VC-445 aggregation: raw launches in, one arm table out.
 *
 * Pure functions over the records `pi-context-scaling-bench.mjs` writes, kept
 * apart from the runner so they are unit-tested without Electron
 * (`aggregate.test.mjs`, on the bench lane only).
 *
 * Percentiles are VC-353's nearest-rank (`summarize` from the performance
 * matrix), so a p95 here means what it means in every other desktop baseline.
 * Two poolings are used and they are not interchangeable:
 *
 * - **Latency and loop-gap samples are pooled** across a arm's repetitions:
 *   every IPC round trip and every 10 ms tick gap is one sample, so the p95 is
 *   taken over hundreds or thousands of them.
 * - **Per-launch figures are summarized across launches**: memory, GC totals
 *   and the `monitorEventLoopDelay` histogram's own percentiles are one value
 *   per launch, and a p95 over five launches would only relabel the maximum.
 *   They are reported as median / min / max with `n` launches.
 */

import { summarize } from "../performance/run.mjs";

export const WINDOW_NAMES = Object.freeze(["idle", "hydration", "steady"]);
const MIB = 1024 * 1024;
const round3 = (value) => Math.round(value * 1000) / 1000;
const round4 = (value) => Math.round(value * 10_000) / 10_000;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function armKey(arm) {
  return arm.attached === 0 ? "control" : `n${arm.attached}-h${arm.historyEntries}`;
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
  };
}

/**
 * Pearson correlation of per-bin maxima: the worst main-loop gap and the worst
 * renderer→main round trip that STARTED in the same bin. Epoch clocks are
 * aligned only to the millisecond across processes, which is why the bins are
 * coarse (100 ms) and why only bins holding both kinds of sample count.
 */
export function binnedCorrelation(tickGaps, ipcSamples, binMs = 100) {
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

function latencies(samples) {
  return samples.filter((sample) => sample[2] === 1).map((sample) => sample[1]);
}

function aggregateWindow(launches, name) {
  const windows = launches.map((launch) => launch.windows[name]).filter(Boolean);
  if (windows.length === 0) return null;
  const tickGaps = windows.flatMap((window) => window.main.tickGaps);
  const echo = windows.flatMap((window) => window.renderer.echo);
  const rpc = windows.flatMap((window) => window.renderer.rpc);
  const failures = [...echo, ...rpc].filter((sample) => sample[2] !== 1).length;
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
    ipcFailures: failures,
    gc: {
      countPerLaunch: acrossLaunches(windows.map((window) => window.main.gc.count)),
      totalMsPerLaunch: acrossLaunches(windows.map((window) => window.main.gc.totalMs)),
      pauseMs: summarize(
        windows.flatMap((window) => window.main.gc.entries.map((e) => e.durationMs)),
      ),
    },
    loopVsEcho: binnedCorrelation(
      tickGaps,
      echo.filter((sample) => sample[2] === 1),
    ),
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

/** Summarize one arm's non-warm-up launches. */
export function aggregateArm(arm, launches) {
  const hydrations = launches.flatMap((launch) => launch.windows.hydration?.perSession ?? []);
  return {
    key: armKey(arm),
    attached: arm.attached,
    historyEntries: arm.historyEntries,
    launches: launches.length,
    boundVerified: launches.every(
      (launch) =>
        launch.bindings.before.live === 0 &&
        launch.bindings.after.live === arm.attached &&
        launch.bindings.after.unexpectedLive.length === 0,
    ),
    sidecar: {
      entriesPerSession: acrossLaunches(launches.flatMap((launch) => launch.sidecarEntries ?? [])),
      bytesPerSession: acrossLaunches(launches.flatMap((launch) => launch.sidecarBytes ?? [])),
    },
    hydrationPerSessionMs: summarize(hydrations.map((entry) => entry.ms)),
    hydrationTotalMs: acrossLaunches(
      launches.map((launch) => launch.windows.hydration?.main.wallMs ?? Number.NaN),
    ),
    memory: aggregateMemory(launches),
    windows: Object.fromEntries(
      WINDOW_NAMES.map((name) => [name, aggregateWindow(launches, name)]),
    ),
  };
}

/** Least-squares slope and intercept of y on x. */
export function linearFit(points) {
  const usable = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (usable.length < 2) return null;
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
  const control = arms.find((arm) => arm.attached === 0);
  const histories = [
    ...new Set(arms.filter((arm) => arm.attached > 0).map((arm) => arm.historyEntries)),
  ];
  return histories
    .toSorted((a, b) => a - b)
    .map((historyEntries) => {
      const points = arms
        .filter((arm) => arm.attached > 0 && arm.historyEntries === historyEntries)
        .map((arm) => [arm.attached, arm.memory[metric]?.delta?.median]);
      if (control) points.push([0, control.memory[metric]?.delta?.median]);
      return { historyEntries, metric, fit: linearFit(points) };
    });
}

export function aggregateRun(launches) {
  const measured = launches.filter((launch) => !launch.warmup);
  const byArm = new Map();
  for (const launch of measured) {
    const key = armKey(launch.arm);
    const group = byArm.get(key) ?? { arm: launch.arm, launches: [] };
    group.launches.push(launch);
    byArm.set(key, group);
  }
  const arms = [...byArm.values()]
    .map(({ arm, launches: group }) => aggregateArm(arm, group))
    .toSorted((a, b) => a.historyEntries - b.historyEntries || a.attached - b.attached);
  return {
    arms,
    fits: {
      mainHeapUsedMiB: contextCostFits(arms, "mainHeapUsedMiB"),
      mainWorkingSetMiB: contextCostFits(arms, "mainWorkingSetMiB"),
      mainRssMiB: contextCostFits(arms, "mainRssMiB"),
    },
    tripwire: {
      blocked: launches.flatMap((launch) => launch.tripwire?.blocked ?? []),
      chromiumBlocked: launches.flatMap((launch) => launch.tripwire?.chromiumBlocked ?? []),
    },
  };
}
