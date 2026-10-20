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

import { summarize } from "../performance/run.mjs";
import {
  acrossLaunches,
  armKey,
  launchFailed,
  launchLoad,
  memoryFigures,
  okSamples,
} from "./aggregate.mjs";

const directory = resolve(process.argv[2] ?? "");
const showRows = process.argv.includes("--rows");

/** Nearest-rank p95 and max, as the bench's own tables compute them. */
const p95 = (values) => summarize(values)?.p95 ?? Number.NaN;
const max = (values) => summarize(values)?.max ?? Number.NaN;
const gaps = (window) => window.main.tickGaps.map(([, gap]) => gap);
const echo = (window) => okSamples(window.renderer.echo).map((sample) => sample[1]);

function launchRow(build, pair, launch) {
  const { idle, hydration, steady } = launch.windows;
  return {
    build,
    pair,
    arm: armKey(launch.arm),
    historyEntries: launch.arm.historyEntries,
    load: launchLoad(launch),
    hydrationEldMax: hydration.main.eventLoopDelay.maxMs,
    hydrationGapMax: max(gaps(hydration)),
    hydrationEchoMax: max(echo(hydration)),
    deltaEldMax: hydration.main.eventLoopDelay.maxMs - idle.main.eventLoopDelay.maxMs,
    deltaGapP95: p95(gaps(hydration)) - p95(gaps(idle)),
    deltaEchoP95: p95(echo(hydration)) - p95(echo(idle)),
    steadyDeltaGapP95: p95(gaps(steady)) - p95(gaps(idle)),
    steadyDeltaEchoP95: p95(echo(steady)) - p95(echo(idle)),
    bindMs: hydration.perSession?.[0]?.ms ?? Number.NaN,
    heapDeltaMiB:
      memoryFigures(launch.memory.post).mainHeapUsedMiB -
      memoryFigures(launch.memory.pre).mainHeapUsedMiB,
  };
}

const rows = [];
for (const name of readdirSync(directory).toSorted()) {
  const match = /^(before|after)-(\d+)$/.exec(name);
  const file = join(directory, name, "raw.json.gz");
  if (match === null || !existsSync(file)) continue;
  const raw = JSON.parse(gunzipSync(readFileSync(file)).toString());
  for (const launch of raw.launches) {
    if (launch.warmup || launchFailed(launch)) continue;
    rows.push(launchRow(match[1], Number(match[2]), launch));
  }
}

const format = (value) => (Number.isFinite(value) ? value.toFixed(1) : "—");
function spread(values) {
  const across = acrossLaunches(values);
  return across === null
    ? "—"
    : `${format(across.median)} [${format(across.min)}–${format(across.max)}]`;
}
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
// Largest sidecar first, the control last.
const byHistory = (a, b) => b.historyEntries - a.historyEntries;
const arms = [...new Set(rows.toSorted(byHistory).map((row) => row.arm))];
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
    (a, b) => byHistory(a, b) || a.pair - b.pair || a.build.localeCompare(b.build),
  );
  for (const row of ordered) {
    const cells = columns.map(([key]) => format(row[key]));
    console.log(`| ${row.arm} | ${row.pair} | ${row.build} | ${cells.join(" | ")} |`);
  }
}
