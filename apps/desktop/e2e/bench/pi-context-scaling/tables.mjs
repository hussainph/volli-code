/**
 * VC-445: the aggregate as Markdown tables, generated so the published report
 * quotes numbers the run produced rather than numbers someone retyped.
 */

const fixed = (value, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);

/** `median [min–max]` of a per-launch figure. */
const spread = (stat, digits = 1) =>
  stat === null || stat === undefined
    ? "—"
    : `${fixed(stat.median, digits)} [${fixed(stat.min, digits)}–${fixed(stat.max, digits)}]`;

/** `p50 / p95 / max (n)` of pooled samples. */
const pooled = (stat, digits = 2) =>
  stat === null || stat === undefined
    ? "—"
    : `${fixed(stat.p50, digits)} / ${fixed(stat.p95, digits)} / ${fixed(stat.max, digits)} (${stat.n})`;

const label = (arm) => (arm.attached === 0 ? "control (0)" : `${arm.attached}`);
const history = (arm) => (arm.attached === 0 ? "—" : `${arm.historyEntries}`);

export function markdownTables(aggregate) {
  const arms = aggregate.arms;
  const lines = [];
  lines.push("### Main memory after forced GC (MiB; median [min–max] across launches)", "");
  lines.push(
    "| bound | entries | launches | main heapUsed pre → Δ | heapUsed Δ per context | main heapTotal Δ | main footprint pre → Δ | main working set pre → Δ | main RSS Δ | renderer footprint Δ | renderer working set Δ |",
    "|---:|---:|---:|---|---:|---|---|---|---|---|---|",
  );
  for (const arm of arms) {
    const m = arm.memory;
    const perContext =
      arm.attached === 0
        ? "—"
        : fixed((m.mainHeapUsedMiB.delta?.median ?? Number.NaN) / arm.attached, 2);
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
  if (
    arms.some((arm) => arm.fullGcPauseMs?.post !== null && arm.fullGcPauseMs?.post !== undefined)
  ) {
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
  }
  for (const windowName of ["idle", "hydration", "steady"]) {
    lines.push(
      "",
      `### ${windowName} window — main loop and renderer→main IPC (ms)`,
      "",
      "Loop-delay histogram columns are median [min–max] across launches of each launch's own percentile; pooled columns are `p50 / p95 / max (samples)` over every launch's raw samples.",
      "",
      "| bound | entries | window ms | ELD p50 | ELD p95 | ELD max | 10 ms tick gap (pooled) | IPC echo (pooled) | Session RPC (pooled) | GCs / launch | GC ms / launch | GC pause (pooled) | r(loop, echo) |",
      "|---:|---:|---|---|---|---|---|---|---|---|---|---|---:|",
    );
    for (const arm of arms) {
      const w = arm.windows[windowName];
      if (w === null) continue;
      lines.push(
        `| ${label(arm)} | ${history(arm)} | ${spread(w.wallMs, 0)} | ${spread(w.eventLoopDelay.p50Ms, 2)} | ${spread(w.eventLoopDelay.p95Ms, 2)} | ${spread(w.eventLoopDelay.maxMs, 1)} | ${pooled(w.tickGapMs, 1)} | ${pooled(w.ipcEchoMs)} | ${pooled(w.sessionRpcMs)} | ${spread(w.gc.countPerLaunch, 0)} | ${spread(w.gc.totalMsPerLaunch, 1)} | ${pooled(w.gc.pauseMs, 2)} | ${w.loopVsEcho.pearson === null ? "—" : `${fixed(w.loopVsEcho.pearson, 2)} (${w.loopVsEcho.bins})`} |`,
      );
    }
  }
  lines.push(
    "",
    "### Hydration: one `model.select` that rebinds one Session (ms)",
    "",
    "| bound | entries | every bind p50 / p95 / max (n) | first bind after boot | later binds | whole window median [min–max] |",
    "|---:|---:|---|---|---|---|",
  );
  for (const arm of arms.filter((candidate) => candidate.attached > 0)) {
    lines.push(
      `| ${label(arm)} | ${history(arm)} | ${pooled(arm.hydrationPerSessionMs, 1)} | ${pooled(arm.hydrationFirstMs, 1)} | ${pooled(arm.hydrationLaterMs, 1)} | ${spread(arm.hydrationTotalMs, 0)} |`,
    );
  }
  lines.push(
    "",
    "### Per-context slope of the post-GC delta (MiB per bound context; control arm as N = 0)",
    "",
    "| entries | heapUsed slope (r²) | main footprint slope (r²) | main working set slope (r²) | main RSS slope (r²) |",
    "|---:|---|---|---|---|",
  );
  const fits = aggregate.fits;
  for (const [index, row] of fits.mainHeapUsedMiB.entries()) {
    const cell = (fit) => (fit === null ? "—" : `${fixed(fit.slope, 3)} (${fixed(fit.r2, 2)})`);
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
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
