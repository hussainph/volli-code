#!/usr/bin/env node
// Whether a test shard's timed-out tests coincided with a runner disk stall
// (VC-1233), written into the job summary of a failed shard.
//
// It reads only what the shard already kept in its diagnostics directory: the
// raw output tail (`coverage.log`) for which tests failed on "Test timed out",
// the preload's JSONL (`events-*.jsonl`) for when each of them ran, and
// `runner-health.log` (VC-1209) for the VM's I/O wait over the same seconds.
// A sample at or above STALL_IOWAIT_PERCENT that overlaps the test is a disk
// stall: in the artifacts read for VC-1233 a stall sample read 50 to 55%
// iowait while the rest of each job stayed at 25% or less.
//
// Usage: ci-timeout-stall-summary.mjs <diagnostics-dir>
// Appends markdown to $GITHUB_STEP_SUMMARY, or prints it when that is unset.
// Writes nothing when no test timed out. An observer: it always exits 0, so it
// can neither fail a green job nor hide a red one.
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const STALL_IOWAIT_PERCENT = 30;

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** A file and its older rotated generation, oldest first. */
function generations(path) {
  return read(`${path}.previous`) + read(path);
}

/**
 * The tests Vitest reported as timed out: each `FAIL` header whose error is
 * "Test timed out in N ms". The header names the file, then the title path.
 */
export function timedOutTests(output) {
  const lines = stripVTControlCharacters(output).split("\n");
  const found = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^\s*FAIL\s+(?:\S+\s{2,})?(\S+\.[cm]?[jt]sx?) > (.+?)\s*$/u.exec(lines[index]);
    if (!header) continue;
    const timeout = /^Error: Test timed out in (\d+)ms\./u.exec(lines[index + 1] ?? "");
    if (!timeout) continue;
    const [, file, title] = header;
    found.set(`${file} > ${title}`, { file, title, limitMs: Number(timeout[1]) });
  }
  return [...found.values()];
}

/** When each test ran, from the preload's `test-start` / `test-finished` events. */
export function testRuns(jsonlTexts) {
  const runs = new Map();
  for (const text of jsonlTexts) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof event.id !== "string" || typeof event.at !== "number") continue;
      if (event.event === "test-start") {
        runs.set(event.id, { file: event.file, name: event.name, startedAt: event.at });
      } else if (event.event === "test-finished" && runs.has(event.id)) {
        runs.get(event.id).finishedAt = event.at;
      } else if (event.event === "test-trace" && runs.has(event.id)) {
        runs.get(event.id).pending ??= pendingAwaits(event.trace);
      }
    }
  }
  return [...runs.values()];
}

/**
 * The awaits a suite's phase trace (VC-1220) reported still pending: the
 * indented lines under "Still pending", outermost first.
 */
export function pendingAwaits(trace) {
  if (!Array.isArray(trace)) return [];
  const from = trace.findIndex(
    (line) => typeof line === "string" && line.startsWith("Still pending"),
  );
  if (from < 0) return [];
  const pending = [];
  for (const line of trace.slice(from + 1)) {
    if (typeof line !== "string" || !line.startsWith("  ")) break;
    pending.push(line.trim());
  }
  return pending;
}

/**
 * The runner-health samples as intervals. Each line's clock is the END of the
 * interval it describes; it began at the previous line (or the start header).
 */
export function healthSamples(text) {
  const samples = [];
  let day;
  let previous;
  for (const line of text.split("\n")) {
    const start = /^# start=(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)Z/u.exec(line);
    if (start) {
      day = start[1];
      previous = Date.parse(`${start[1]}T${start[2]}Z`);
      continue;
    }
    const sample = /^(\d\d:\d\d:\d\d) (.*)$/u.exec(line);
    if (!sample || day === undefined) continue;
    let end = Date.parse(`${day}T${sample[1]}Z`);
    // Past midnight UTC: the clock went backwards, so the day moved on.
    if (previous !== undefined && end < previous) {
      end += 24 * 60 * 60 * 1000;
      day = new Date(end).toISOString().slice(0, 10);
    }
    const fields = Object.fromEntries(
      sample[2]
        .split(" ")
        .map((pair) => pair.split("="))
        .filter((pair) => pair.length === 2),
    );
    const iowait = Number.parseFloat(fields.iowait);
    samples.push({
      clock: sample[1],
      start: previous ?? end,
      end,
      iowait: Number.isFinite(iowait) ? iowait : undefined,
      ioFull: fields.io_full,
    });
    previous = end;
  }
  return samples;
}

function clock(at) {
  return new Date(at).toISOString().slice(11, 19);
}

function reading(sample) {
  const io = sample.ioFull === undefined ? "" : ` io_full=${sample.ioFull}`;
  return `${sample.clock} iowait=${sample.iowait ?? "?"}%${io}`;
}

/** One line per timed-out test: did a disk stall cover it? */
export function summarize({ output, jsonlTexts, health }) {
  const failures = timedOutTests(output);
  if (failures.length === 0) return "";
  const runs = testRuns(jsonlTexts);
  const samples = healthSamples(health);
  const lines = [
    "### Timed-out tests against runner health",
    "",
    `A disk stall is a \`runner-health.log\` sample at ${STALL_IOWAIT_PERCENT}% iowait or more while the test ran. One that lasts a few seconds explains a test a few seconds over its limit, not a hang (VC-1233, \`docs/development/ci.md\`).`,
    "",
  ];
  for (const failure of failures) {
    const name = `\`${failure.file} > ${failure.title}\``;
    const run = runs.findLast(
      (candidate) =>
        typeof candidate.file === "string" &&
        candidate.file.endsWith(`/${failure.file}`) &&
        (failure.title === candidate.name || failure.title.endsWith(` > ${candidate.name}`)),
    );
    if (!run) {
      lines.push(`- ${name} (${failure.limitMs} ms): no start event in the diagnostics.`);
      continue;
    }
    const until = run.finishedAt ?? run.startedAt + failure.limitMs;
    const ran =
      run.finishedAt === undefined
        ? `started ${clock(run.startedAt)} UTC, no finish event`
        : `ran ${run.finishedAt - run.startedAt} ms, ${clock(run.startedAt)}–${clock(until)} UTC`;
    const head = `- ${name} (limit ${failure.limitMs} ms; ${ran})`;
    const awaiting =
      run.pending && run.pending.length > 0
        ? ` Its trace had pending: ${run.pending
            .slice(0, 3)
            .map((label) => `\`${label}\``)
            .join(", ")}.`
        : "";
    const covering = samples.filter((sample) => sample.end > run.startedAt && sample.start < until);
    const stalled = covering.filter(
      (sample) => sample.iowait !== undefined && sample.iowait >= STALL_IOWAIT_PERCENT,
    );
    if (covering.length === 0) {
      lines.push(`${head}: no runner-health sample covers it.${awaiting}`);
    } else if (stalled.length > 0) {
      lines.push(
        `${head}: **disk stall** while it ran, ${stalled.map(reading).join(", ")}.${awaiting}`,
      );
    } else {
      const worst = covering.reduce((a, b) => ((b.iowait ?? -1) > (a.iowait ?? -1) ? b : a));
      lines.push(`${head}: no disk stall while it ran, highest ${reading(worst)}.${awaiting}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Everything the shard's diagnostics directory holds for this summary. */
export function summarizeDirectory(directory) {
  const names = existsSync(directory) ? readdirSync(directory) : [];
  const jsonl = names.filter((name) => /^events-.*\.jsonl$/u.test(name));
  return summarize({
    output: generations(join(directory, "coverage.log")),
    jsonlTexts: jsonl.map((name) => generations(join(directory, name))),
    health: read(join(directory, "runner-health.log")),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const markdown = summarizeDirectory(process.argv[2] ?? ".");
    if (markdown) {
      const target = process.env.GITHUB_STEP_SUMMARY;
      if (target) appendFileSync(target, markdown);
      else process.stdout.write(markdown);
    }
  } catch (error) {
    process.stderr.write(`[test-diagnostics] timeout summary unavailable: ${error?.name}\n`);
  }
}
