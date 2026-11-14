import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  healthSamples,
  pendingAwaits,
  summarize,
  timedOutTests,
} from "./ci-timeout-stall-summary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/ci-timeout-stall-summary.mjs");

const FILE = "src/session-runtime/crash-recovery.integration.test.ts";
const TITLE =
  "crash recovery through the durable Pi binding (VC-753) > does not bypass a genuine configuration_invalid blocker";
const NAME = "does not bypass a genuine configuration_invalid blocker";
// Run 43526276245's shape: the test ran 23:21:03.4 to 23:21:08.6 UTC.
const STARTED = Date.parse("2026-11-13T23:21:03.400Z");
const FINISHED = STARTED + 5_160;

// What Vitest's default reporter leaves in coverage.log, colours included.
const output = [
  " \x1b[31m×\x1b[39m passes 12ms",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  ` \x1b[41m FAIL \x1b[49m ${FILE} > ${TITLE}`,
  "Error: Test timed out in 5000ms.",
  'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
  ` FAIL  src/other.test.ts > fails on an assertion`,
  "AssertionError: expected 1 to be 2",
].join("\n");

function events({ trace } = {}) {
  const common = { pid: 1, threadId: 0, id: "t1", file: `/runner/packages/host-core/${FILE}` };
  return [
    JSON.stringify({ ...common, at: STARTED - 400, event: "process-start" }),
    JSON.stringify({ ...common, at: STARTED, event: "test-start", name: NAME }),
    ...(trace ? [JSON.stringify({ ...common, at: FINISHED - 1, event: "test-trace", trace })] : []),
    JSON.stringify({ ...common, at: FINISHED, event: "test-finished", name: NAME }),
    "",
  ].join("\n");
}

function health(stallIowait) {
  return [
    "# start=2026-11-13T23:20:53Z nproc=4 cpu=x kernel=y",
    "# percentages are of the last interval; *_some/*_full are /proc/pressure avg10",
    "23:20:58 user=67% sys=14% idle=9% iowait=10% steal=0% running=1 blocked=4 io_full=10.56",
    "23:21:03 user=46% sys=13% idle=26% iowait=15% steal=0% running=4 blocked=0 io_full=12.52",
    `23:21:08 user=11% sys=3% idle=32% iowait=${stallIowait}% steal=0% running=1 blocked=4 io_full=26.70`,
    "23:21:13 user=52% sys=16% idle=19% iowait=13% steal=0% running=6 blocked=1 io_full=23.21",
    "23:21:18 user=55% sys=17% idle=18% iowait=40% steal=0% running=8 blocked=0 io_full=19.24",
    "",
  ].join("\n");
}

test("finds only the tests that failed on a timeout, with their limit", () => {
  assert.deepEqual(timedOutTests(output), [{ file: FILE, title: TITLE, limitMs: 5000 }]);
  // A desktop shard names its project between FAIL and the file.
  assert.deepEqual(
    timedOutTests(
      " FAIL   main  src/main/data-ipc.test.ts > a > b\nError: Test timed out in 15000ms.",
    ),
    [{ file: "src/main/data-ipc.test.ts", title: "a > b", limitMs: 15000 }],
  );
});

test("reads each sample as the interval that ends on its clock, across midnight", () => {
  const samples = healthSamples(
    "# start=2026-11-13T23:59:55Z nproc=4\n00:00:00 iowait=55% io_full=1\n00:00:05 iowait=2%\n",
  );
  assert.deepEqual(
    samples.map(({ start, end, iowait }) => [start, end, iowait]),
    [
      [Date.parse("2026-11-13T23:59:55Z"), Date.parse("2026-11-14T00:00:00Z"), 55],
      [Date.parse("2026-11-14T00:00:00Z"), Date.parse("2026-11-14T00:00:05Z"), 2],
    ],
  );
});

test("names a disk stall that covered the timed-out test, and only the samples that did", () => {
  const markdown = summarize({ output, jsonlTexts: [events()], health: health(55) });
  assert.match(markdown, /^### Timed-out tests against runner health/mu);
  assert.match(
    markdown,
    /configuration_invalid blocker` \(limit 5000 ms; ran 5160 ms, 23:21:03–23:21:08 UTC\): \*\*disk stall\*\* while it ran, 23:21:08 iowait=55% io_full=26\.70\.$/mu,
  );
  // 23:21:18 is a stall too, but after the test finished.
  assert.doesNotMatch(markdown, /23:21:18/u);
  assert.doesNotMatch(markdown, /other\.test\.ts/u);
});

test("says there was no stall, with the worst sample, when the runner was healthy", () => {
  const markdown = summarize({ output, jsonlTexts: [events()], health: health(12) });
  // 23:21:03's sample ended before the test began; 23:21:13's began before it ended.
  assert.match(
    markdown,
    /: no disk stall while it ran, highest 23:21:13 iowait=13% io_full=23\.21\.$/mu,
  );
  assert.doesNotMatch(markdown, /\*\*disk stall\*\*/u);
});

test("repeats the awaits a hung test's trace left pending", () => {
  const trace = [
    "Failed at +15016 ms.",
    "Still pending, oldest (outermost) first:",
    "  restart (since +139 ms)",
    "  host.close (since +140 ms)",
    "Provider requests: 1",
  ];
  assert.deepEqual(pendingAwaits(trace), ["restart (since +139 ms)", "host.close (since +140 ms)"]);
  assert.deepEqual(pendingAwaits(["Nothing the fixture traced was pending."]), []);
  const markdown = summarize({ output, jsonlTexts: [events({ trace })], health: health(12) });
  assert.match(
    markdown,
    /Its trace had pending: `restart \(since \+139 ms\)`, `host\.close \(since \+140 ms\)`\.$/mu,
  );
});

test("says what it could not see rather than guessing", () => {
  assert.match(
    summarize({ output, jsonlTexts: [events()], health: "" }),
    /: no runner-health sample covers it\.$/mu,
  );
  assert.match(
    summarize({ output, jsonlTexts: [], health: health(55) }),
    /\(5000 ms\): no start event in the diagnostics\.$/mu,
  );
  assert.equal(summarize({ output: "Tests 4 passed", jsonlTexts: [], health: "" }), "");
});

test("appends to the job summary from a shard's diagnostics directory, and never fails", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "timeout-stall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The rotated generation holds the failure; the current one only the tail.
  writeFileSync(join(dir, "coverage.log.previous"), output);
  writeFileSync(join(dir, "coverage.log"), "[test-diagnostics] CAPTURE TRUNCATED\n");
  writeFileSync(join(dir, "events-1-0.jsonl"), events());
  writeFileSync(join(dir, "runner-health.log"), health(55));
  const summary = join(dir, "summary.md");
  const run = spawnSync(process.execPath, [script, dir], {
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(summary, "utf8"), /\*\*disk stall\*\* while it ran/u);

  const missing = spawnSync(process.execPath, [script, join(dir, "absent")], {
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    encoding: "utf8",
  });
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, "");
});
