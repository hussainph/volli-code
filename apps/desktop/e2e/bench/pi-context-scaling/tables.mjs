/**
 * VC-445: the aggregate as Markdown tables, generated so the published report
 * quotes numbers the run produced rather than numbers someone retyped.
 */

import { P95_MIN_SAMPLES, WINDOW_NAMES } from "./aggregate.mjs";

const fixed = (value, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);

/** `median [min–max]` of a per-launch figure. */
const spread = (stat, digits = 1) =>
  stat === null || stat === undefined
    ? "—"
    : `${fixed(stat.median, digits)} [${fixed(stat.min, digits)}–${fixed(stat.max, digits)}]`;

/**
 * `p50 / p95 / max (n)` of pooled samples. Below {@link P95_MIN_SAMPLES} the
 * nearest-rank p95 is the maximum, and the cell says so with a dagger.
 */
const pooled = (stat, digits = 2) => {
  if (stat === null || stat === undefined) return "—";
  const dagger = stat.n < P95_MIN_SAMPLES ? "†" : "";
  return `${fixed(stat.p50, digits)} / ${fixed(stat.p95, digits)}${dagger} / ${fixed(stat.max, digits)} (${stat.n})`;
};

const label = (arm) => (arm.bound === 0 ? "control (0)" : `${arm.bound}`);
const history = (arm) => (arm.bound === 0 ? "—" : `${arm.historyEntries}`);
const DAGGER_NOTE = `† fewer than ${P95_MIN_SAMPLES} samples: the nearest-rank p95 is the maximum, not a tail estimate.`;

export function markdownTables(aggregate) {
  const arms = aggregate.arms;
  const lines = [];
  if (aggregate.excludedFailedLaunches > 0) {
    lines.push(
      `**${aggregate.excludedFailedLaunches} launch(es) failed a check and are excluded below.**`,
      "",
    );
  }
  lines.push("### Main memory after forced GC (MiB; median [min–max] across launches)", "");
  lines.push(
    "| bound | entries | launches | main heapUsed pre → Δ | heapUsed Δ per context | main heapTotal Δ | main footprint pre → Δ | main working set pre → Δ | main RSS Δ | renderer footprint Δ | renderer working set Δ |",
    "|---:|---:|---:|---|---:|---|---|---|---|---|---|",
  );
  for (const arm of arms) {
    const m = arm.memory;
    const perContext =
      arm.bound === 0 ? "—" : fixed((m.mainHeapUsedMiB.delta?.median ?? Number.NaN) / arm.bound, 2);
    lines.push(
      `| ${label(arm)} | ${history(arm)} | ${arm.launches} | ${fixed(m.mainHeapUsedMiB.pre?.median)} → ${spread(m.mainHeapUsedMiB.delta, 2)} | ${perContext} | ${spread(m.mainHeapTotalMiB.delta)} | ${fixed(m.mainFootprintMiB.pre?.median)} → ${spread(m.mainFootprintMiB.delta)} | ${fixed(m.mainWorkingSetMiB.pre?.median)} → ${spread(m.mainWorkingSetMiB.delta)} | ${spread(m.mainRssMiB.delta)} | ${spread(m.rendererFootprintMiB.delta)} | ${spread(m.rendererWorkingSetMiB.delta)} |`,
    );
  }
  lines.push(
    "",
    "### Process topology (count; median [min–max] across launches)",
    "",
    "| bound | entries | descendants of main by parent pid, pre → post | `app.getAppMetrics()` processes, pre → post |",
    "|---:|---:|---|---|",
  );
  for (const arm of arms) {
    const d = arm.descendants;
    lines.push(
      `| ${label(arm)} | ${history(arm)} | ${spread(d.pre, 0)} → ${spread(d.post, 0)} | ${spread(d.appMetricsPre, 0)} → ${spread(d.appMetricsPost, 0)} |`,
    );
  }
  lines.push(
    "",
    "### Forced full GC pause over the live heap (ms; median [min–max] across launches)",
    "",
    "| bound | entries | before hydration | after hydration |",
    "|---:|---:|---|---|",
  );
  for (const arm of arms) {
    lines.push(
      `| ${label(arm)} | ${history(arm)} | ${spread(arm.fullGcPauseMs.pre, 1)} | ${spread(arm.fullGcPauseMs.post, 1)} |`,
    );
  }
  for (const windowName of WINDOW_NAMES) {
    lines.push(
      "",
      `### ${windowName} window — main loop and renderer→main IPC (ms)`,
      "",
      "Loop-delay histogram (ELD) columns are median [min–max] across launches of each launch's own percentile, with the histogram's total sample count beside them; pooled columns are `p50 / p95 / max (samples)` over every launch's raw samples.",
      "",
      "| bound | entries | window ms | ELD samples | ELD p50 | ELD p95 | ELD max | 10 ms tick gap (pooled) | IPC echo (pooled) | Session RPC (pooled) | GCs / launch | GC ms / launch | GC pause (pooled) | r(loop, echo) |",
      "|---:|---:|---|---:|---|---|---|---|---|---|---|---|---|---:|",
    );
    for (const arm of arms) {
      const w = arm.windows[windowName];
      if (w === null) continue;
      lines.push(
        `| ${label(arm)} | ${history(arm)} | ${spread(w.wallMs, 0)} | ${w.eventLoopDelay.samples} | ${spread(w.eventLoopDelay.p50Ms, 2)} | ${spread(w.eventLoopDelay.p95Ms, 2)} | ${spread(w.eventLoopDelay.maxMs, 1)} | ${pooled(w.tickGapMs, 1)} | ${pooled(w.ipcEchoMs)} | ${pooled(w.sessionRpcMs)} | ${spread(w.gc.countPerLaunch, 0)} | ${spread(w.gc.totalMsPerLaunch, 1)} | ${pooled(w.gc.pauseMs, 2)} | ${w.loopVsEcho.pearson === null ? "—" : `${fixed(w.loopVsEcho.pearson, 2)} (${w.loopVsEcho.bins})`} |`,
      );
    }
    lines.push("", DAGGER_NOTE);
  }
  lines.push(
    "",
    "### Loop and IPC deltas against the same launch's idle window (ms; median [min–max] across launches)",
    "",
    "| bound | entries | hydration ΔELD p95 | hydration ΔELD max | hydration Δtick-gap p95 | hydration ΔIPC echo p95 | steady ΔELD p95 | steady ΔELD max | steady Δtick-gap p95 | steady ΔIPC echo p95 | steady ΔSession RPC p95 |",
    "|---:|---:|---|---|---|---|---|---|---|---|---|",
  );
  for (const arm of arms) {
    const h = arm.deltasVsIdle.hydration;
    const s = arm.deltasVsIdle.steady;
    lines.push(
      `| ${label(arm)} | ${history(arm)} | ${spread(h.eventLoopDelayP95Ms, 2)} | ${spread(h.eventLoopDelayMaxMs, 1)} | ${spread(h.tickGapP95Ms, 1)} | ${spread(h.ipcEchoP95Ms, 2)} | ${spread(s.eventLoopDelayP95Ms, 2)} | ${spread(s.eventLoopDelayMaxMs, 1)} | ${spread(s.tickGapP95Ms, 1)} | ${spread(s.ipcEchoP95Ms, 2)} | ${spread(s.sessionRpcP95Ms, 2)} |`,
    );
  }
  lines.push(
    "",
    "Hydration windows are short (tens to hundreds of ms), so a single launch's hydration p95 often rests on few samples; read those deltas beside the pooled hydration table above.",
    "",
    "### Hydration: one `model.select` that rebinds one Session (ms)",
    "",
    "| bound | entries | every bind p50 / p95 / max (n) | first bind after boot | later binds | whole window median [min–max] |",
    "|---:|---:|---|---|---|---|",
  );
  for (const arm of arms.filter((candidate) => candidate.bound > 0)) {
    lines.push(
      `| ${label(arm)} | ${history(arm)} | ${pooled(arm.hydrationPerSessionMs, 1)} | ${pooled(arm.hydrationFirstMs, 1)} | ${pooled(arm.hydrationLaterMs, 1)} | ${spread(arm.hydrationTotalMs, 0)} |`,
    );
  }
  lines.push(
    "",
    DAGGER_NOTE,
    "",
    "### Per-context slope of the post-GC delta (MiB per bound context; control arm as N = 0)",
    "",
    "A fit needs at least three arms; with fewer it is left blank rather than reported with a meaningless r² of 1.",
    "",
    "| entries | heapUsed slope (r²) | main footprint slope (r²) | main working set slope (r²) | main RSS slope (r²) |",
    "|---:|---|---|---|---|",
  );
  const fits = aggregate.fits;
  const cell = (fit) => (fit === null ? "—" : `${fixed(fit.slope, 3)} (${fixed(fit.r2, 2)})`);
  for (const [index, row] of fits.mainHeapUsedMiB.entries()) {
    lines.push(
      `| ${row.historyEntries} | ${cell(row.fit)} | ${cell(fits.mainFootprintMiB[index].fit)} | ${cell(fits.mainWorkingSetMiB[index].fit)} | ${cell(fits.mainRssMiB[index].fit)} |`,
    );
  }
  if (aggregate.hostLoad) {
    const load = aggregate.hostLoad.launchLoad1m;
    lines.push(
      "",
      `Host 1-minute load across measured launches (worst of start/end): p50 ${fixed(load?.p50, 2)}, p95 ${fixed(load?.p95, 2)}, max ${fixed(load?.max, 2)} (${load?.n ?? 0} launches); memory-pressure levels seen: ${aggregate.hostLoad.memoryPressureLevels.join(", ") || "—"}.`,
    );
  }
  if (aggregate.lowLoad) {
    const low = aggregate.lowLoad;
    lines.push(
      "",
      `### Load sensitivity: only launches with 1-minute load ≤ ${fixed(low.threshold, 1)} (${low.launchesKept} kept, ${low.launchesDropped} dropped)`,
      "",
      "| arm | launches | heapUsed Δ MiB | later binds ms | hydration tick gap | hydration IPC echo | steady tick gap | steady IPC echo |",
      "|---|---:|---|---|---|---|---|---|",
    );
    for (const arm of low.arms) {
      lines.push(
        `| ${arm.key} | ${arm.launches} | ${spread(arm.heapUsedDeltaMiB, 2)} | ${pooled(arm.hydrationLaterMs, 1)} | ${pooled(arm.hydrationTickGapMs, 1)} | ${pooled(arm.hydrationIpcEchoMs)} | ${pooled(arm.steadyTickGapMs, 1)} | ${pooled(arm.steadyIpcEchoMs)} |`,
      );
    }
    lines.push("", DAGGER_NOTE);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
