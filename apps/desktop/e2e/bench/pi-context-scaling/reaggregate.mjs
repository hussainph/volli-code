#!/usr/bin/env node
/**
 * Rebuild a VC-445 run's `aggregate.json` and `tables.md` from its own
 * `raw.json.gz`, keeping the run's recorded header (command, environment,
 * protocol, fixture). Nothing is re-measured: this is how a reader checks that
 * the published aggregate is what the raw samples say, and how an aggregation
 * fix is applied to a run without retaking it.
 *
 *   node apps/desktop/e2e/bench/pi-context-scaling/reaggregate.mjs docs/research/perf/pi-context-scaling-vc445
 */
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { aggregateRun, loadThresholdFor } from "./aggregate.mjs";
import { markdownTables } from "./tables.mjs";

const directory = resolve(process.argv[2] ?? "");
const previous = JSON.parse(await fs.readFile(join(directory, "aggregate.json"), "utf8"));
const raw = JSON.parse(gunzipSync(await fs.readFile(join(directory, "raw.json.gz"))).toString());
const header = Object.fromEntries(
  [
    "ticket",
    "generatedAt",
    "durationMinutes",
    "command",
    "environment",
    "protocol",
    "fixture",
    "failedLaunches",
  ].map((key) => [key, previous[key]]),
);
const aggregate = {
  ...header,
  reaggregatedAt: new Date().toISOString(),
  ...aggregateRun(raw.launches, { loadThreshold: loadThresholdFor(raw.environment.machine.cores) }),
};
await fs.writeFile(join(directory, "aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
await fs.writeFile(join(directory, "tables.md"), markdownTables(aggregate));
console.log(`re-aggregated ${raw.launches.length} launches into ${directory}`);
