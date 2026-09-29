#!/usr/bin/env node
/**
 * VC-462: summarize an interleaved before/after run of the VC-445 bench.
 *
 * The A/B protocol runs the bench once per build and pair, alternating which
 * build goes first, into `<dir>/<build>-<pair>/` (for example `before-1`,
 * `after-1`, `after-2`, `before-2`, …), all against one frozen fixture. This
 * reads every run's `raw.json.gz` and prints, per arm and build, the figures
 * the ticket judges: the hydration window's loop-delay max, tick-gap max and
 * IPC echo max; the same launch's idle-paired deltas; the steady window's
 * deltas; bind wall time; post-GC heap growth; and each launch's host load.
 * Warm-up and failed launches are left out. Nothing is re-measured.
 *
 *   node apps/desktop/e2e/bench/pi-context-scaling/ab-compare.mjs <dir> [--rows]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const directory = resolve(process.argv[2] ?? "");
const showRows = process.argv.includes("--rows");

function finite(values) {
  return values.filter(Number.isFinite).toSorted((a, b) => a - b);
}

/** Nearest-rank percentile. */
function percentile(values, fraction) {
  const sorted = finite(values);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function median(values) {
  const sorted = finite(values);
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

const maximum = (values) => (values.length === 0 ? Number.NaN : Math.max(...values));
const gaps = (window) => window.main.tickGaps.map(([, gap]) => gap);
const echo = (window) =>
  window.renderer.echo.filter((sample) => sample[2] === 1).map((sample) => sample[1]);

function launchRow(build, pair, launch) {
  const { idle, hydration, steady } = launch.windows;
  return {
    build,
    pair,
    arm: launch.arm.bound === 0 ? "control" : `${launch.arm.bound}x${launch.arm.historyEntries}`,
    load: Math.max(launch.host.before.loadavg[0], launch.host.after.loadavg[0]),
    idleEldMax: idle.main.eventLoopDelay.maxMs,
    hydrationEldMax: hydration.main.eventLoopDelay.maxMs,
    hydrationGapMax: maximum(gaps(hydration)),
    hydrationEchoMax: maximum(echo(hydration)),
    deltaEldMax: hydration.main.eventLoopDelay.maxMs - idle.main.eventLoopDelay.maxMs,
    deltaGapP95: percentile(gaps(hydration), 0.95) - percentile(gaps(idle), 0.95),
    deltaEchoP95: percentile(echo(hydration), 0.95) - percentile(echo(idle), 0.95),
    steadyDeltaGapP95: percentile(gaps(steady), 0.95) - percentile(gaps(idle), 0.95),
    steadyDeltaEchoP95: percentile(echo(steady), 0.95) - percentile(echo(idle), 0.95),
    bindMs: hydration.perSession?.[0]?.ms ?? Number.NaN,
    heapDeltaMiB:
      (launch.memory.post.processMemory.heapUsed - launch.memory.pre.processMemory.heapUsed) /
      2 ** 20,
  };
}

const rows = [];
for (const name of readdirSync(directory).toSorted()) {
  const match = /^(before|after)-(\d+)$/.exec(name);
  const file = join(directory, name, "raw.json.gz");
  if (match === null || !existsSync(file)) continue;
  const raw = JSON.parse(gunzipSync(readFileSync(file)).toString());
  for (const launch of raw.launches) {
    if (launch.warmup || launch.failures.length > 0) continue;
    rows.push(launchRow(match[1], Number(match[2]), launch));
  }
}

const format = (value) => (Number.isFinite(value) ? value.toFixed(1) : "—");
const spread = (values) =>
  `${format(median(values))} [${format(Math.min(...values))}–${format(Math.max(...values))}]`;
const columns = [
  ["load", "1-min load"],
  ["hydrationEldMax", "hydration ELD max"],
  ["hydrationGapMax", "hydration tick-gap max"],
  ["hydrationEchoMax", "hydration IPC echo max"],
  ["deltaEldMax", "Δ ELD max"],
  ["deltaGapP95", "Δ tick-gap p95"],
  ["deltaEchoP95", "Δ IPC echo p95"],
  ["steadyDeltaGapP95", "steady Δ tick-gap p95"],
  ["steadyDeltaEchoP95", "steady Δ IPC echo p95"],
  ["bindMs", "bind ms"],
  ["heapDeltaMiB", "heap Δ MiB"],
];

console.log(
  "Median [min–max] across launches, ms unless named. Δ = the same launch's idle window subtracted.\n",
);
console.log(`| arm | build | n | ${columns.map(([, label]) => label).join(" | ")} |`);
console.log(`|---|---|---:|${columns.map(() => "---").join("|")}|`);
const arms = [...new Set(rows.map((row) => row.arm))].toSorted().toReversed();
for (const arm of arms) {
  for (const build of ["before", "after"]) {
    const selected = rows.filter((row) => row.arm === arm && row.build === build);
    if (selected.length === 0) continue;
    const cells = columns.map(([key]) => spread(selected.map((row) => row[key])));
    console.log(`| ${arm} | ${build} | ${selected.length} | ${cells.join(" | ")} |`);
  }
}

if (showRows) {
  console.log(`\n| arm | pair | build | ${columns.map(([, label]) => label).join(" | ")} |`);
  console.log(`|---|---:|---|${columns.map(() => "---:").join("|")}|`);
  const ordered = rows.toSorted(
    (a, b) => a.arm.localeCompare(b.arm) || a.pair - b.pair || a.build.localeCompare(b.build),
  );
  for (const row of ordered) {
    const cells = columns.map(([key]) => format(row[key]));
    console.log(`| ${row.arm} | ${row.pair} | ${row.build} | ${cells.join(" | ")} |`);
  }
}
