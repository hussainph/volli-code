import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { CORE_E2E, SMOKE_QUARANTINE, parseArgs, runOne, selectSmokes } from "./run-smokes.mjs";
import { createSmokeReporter, runWithRetry, smokeAttemptEnvironment } from "./smoke-results.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function fixture(t) {
  mkdirSync(join(REPO, ".tmp"), { recursive: true });
  const dir = mkdtempSync(join(REPO, ".tmp", "smoke-runner-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const attempt = (code, ms = 10) => ({ code, ms, signal: null, output: `exit ${code}` });

test("first-attempt success runs once", async () => {
  const calls = [];
  const result = await runWithRetry("probe.mjs", async (name, number) => {
    calls.push([name, number]);
    return attempt(0);
  });
  assert.deepEqual(calls, [["probe.mjs", 1]]);
  assert.equal(result.status, "PASS");
  assert.equal(result.flaky, false);
  assert.equal(result.ms, 10);
});

test("retry-green retains BOTH attempts and reports FLAKY", async () => {
  const result = await runWithRetry("probe.mjs", async (_, number) =>
    attempt(number === 1 ? 3 : 0, number * 10),
  );
  assert.equal(result.code, 0);
  assert.equal(result.status, "FLAKY");
  assert.equal(result.flaky, true);
  assert.equal(result.ms, 30);
  assert.deepEqual(
    result.attempts.map((value) => value.output),
    ["exit 3", "exit 0"],
  );
});

test("two failures stay red with no third attempt", async () => {
  let calls = 0;
  const result = await runWithRetry("probe.mjs", async () => {
    calls += 1;
    return attempt(7);
  });
  assert.equal(calls, 2);
  assert.equal(result.code, 7);
  assert.equal(result.status, "FAIL");
  assert.equal(result.flaky, false);
});

test("interruption prevents retries", async () => {
  let calls = 0;
  const result = await runWithRetry(
    "probe.mjs",
    async () => {
      calls += 1;
      return attempt(1);
    },
    () => true,
  );
  assert.equal(calls, 1);
  assert.equal(result.code, 1);
});

test("attempt environment scrubs reusable profile and Node-mode without mutating caller", () => {
  const environment = { ELECTRON_RUN_AS_NODE: "1", VOLLI_SMOKE_DIR: "/shared", PATH: "/bin" };
  const env = smokeAttemptEnvironment(environment);
  assert.equal(env.VOLLI_SMOKE_DIR, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.VOLLI_QUIET_WINDOWS, "1");
  assert.equal(env.PATH, "/bin");
  assert.equal(environment.VOLLI_SMOKE_DIR, "/shared");
  assert.equal(smokeAttemptEnvironment({ VOLLI_QUIET_WINDOWS: "0" }).VOLLI_QUIET_WINDOWS, "0");
});

test("real child retry has fresh profiles, durable first-failure log and a job summary", async (t) => {
  const dir = fixture(t);
  const name = "fixture-smoke.mjs";
  const reportDir = join(dir, "report");
  const summaryPath = join(dir, "github-summary.md");
  writeFileSync(
    join(dir, name),
    `
    import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const profile = mkdtempSync(join(process.env.PROFILE_ROOT, 'profile-'));
    console.log(JSON.stringify({ profile, shared: process.env.VOLLI_SMOKE_DIR ?? null,
      nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null, quiet: process.env.VOLLI_QUIET_WINDOWS }));
    const marker = join(process.env.PROFILE_ROOT, 'once');
    const failed = !existsSync(marker);
    writeFileSync(marker, 'done');
    console.error(failed ? 'first-attempt-failure' : 'retry-success');
    process.exitCode = failed ? 1 : 0;
  `,
  );
  const reporter = createSmokeReporter({
    reportDir,
    summaryPath,
    names: [name],
    metadata: { tier: "core", shard: null, sha: "test-sha" },
  });
  const result = await runWithRetry(name, (probe, number) =>
    runOne(probe, number, {
      reporter,
      e2eDir: dir,
      repoRoot: dir,
      environment: {
        ...process.env,
        PROFILE_ROOT: dir,
        VOLLI_SMOKE_DIR: "/shared",
        ELECTRON_RUN_AS_NODE: "1",
      },
    }),
  );
  reporter.recordResult(result);
  reporter.finish();
  const profiles = result.attempts.map((value) => JSON.parse(value.output.split("\n")[0]));
  assert.notEqual(profiles[0].profile, profiles[1].profile);
  for (const profile of profiles) {
    assert.equal(profile.shared, null);
    assert.equal(profile.nodeMode, null);
    assert.equal(profile.quiet, "1");
  }
  const report = JSON.parse(readFileSync(join(reportDir, "results.json"), "utf8"));
  assert.equal(report.completed, true);
  assert.equal(report.sha, "test-sha");
  assert.equal(report.results[0].status, "FLAKY");
  assert.deepEqual(
    report.results[0].attempts.map((value) => value.code),
    [1, 0],
  );
  assert.equal(report.results[0].attempts.length, 2);
  assert.match(
    readFileSync(join(reportDir, report.results[0].attempts[0].log), "utf8"),
    /first-attempt-failure/,
  );
  assert.match(readFileSync(summaryPath, "utf8"), /1 flakes \(passed on retry\)/);
  assert.match(readFileSync(summaryPath, "utf8"), /FLAKY \(passed on retry\)/);
});

test("signal exits are failures and retain signal metadata", async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "signal-smoke.mjs"), "process.kill(process.pid, 'SIGTERM');\n");
  const result = await runWithRetry("signal-smoke.mjs", (name, number) =>
    runOne(name, number, { e2eDir: dir, repoRoot: dir }),
  );
  assert.equal(result.status, "FAIL");
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(
    result.attempts.map((value) => value.signal),
    ["SIGTERM", "SIGTERM"],
  );
});

test("checkpoint preserves in-flight logs and missing work is never called a pass", (t) => {
  const dir = fixture(t);
  const reporter = createSmokeReporter({
    reportDir: dir,
    names: ["running.mjs", "queued.mjs"],
    metadata: { tier: "rest" },
  });
  reporter.startAttempt("running.mjs", 1).output("partial failure evidence\n");
  let report = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
  assert.equal(report.completed, false);
  assert.equal(report.results[0].status, "running");
  assert.equal(report.results[1].status, "pending");
  assert.match(
    readFileSync(join(dir, report.results[0].attempts[0].log), "utf8"),
    /partial failure/,
  );
  report = reporter.finish("SIGTERM");
  assert.equal(report.completed, false);
  assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /Incomplete run: SIGTERM/);
  assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /2 unfinished/);
});

test("report persistence failures are not silently swallowed", (t) => {
  const dir = fixture(t);
  const notDirectory = join(dir, "file");
  writeFileSync(notDirectory, "not a directory");
  assert.throws(() => createSmokeReporter({ reportDir: notDirectory, names: [], metadata: {} }));
});

test("core, rest and quarantine selections partition runnable probes without overlap", () => {
  const core = selectSmokes(parseArgs(["--tier", "core"]));
  const rest = selectSmokes(parseArgs(["--tier", "rest"]));
  const quarantine = selectSmokes(parseArgs(["--tier", "quarantine"]));
  const all = selectSmokes(parseArgs([]));
  assert.deepEqual(new Set(core), CORE_E2E);
  assert.deepEqual(new Set(quarantine), new Set(SMOKE_QUARANTINE.keys()));
  assert.deepEqual([...core, ...rest].toSorted(), all);
  assert.equal(
    new Set([...core, ...rest, ...quarantine]).size,
    core.length + rest.length + quarantine.length,
  );
  assert.ok(core.includes("database-recovery-smoke.mjs"));
  assert.ok(core.includes("canvas-theming-smoke.mjs"));
  assert.ok(core.includes("agent-cli-roundtrip-smoke.mjs"));
  assert.ok(core.includes("session-rpc-transport-smoke.mjs"));
  assert.ok(rest.includes("vc418-contrast-smoke.mjs"), "cheap contrast repair stays gating");
  const shards = [1, 2, 3].flatMap((index) =>
    selectSmokes(parseArgs(["--tier", "rest", "--shard", `${index}/3`])),
  );
  assert.deepEqual(shards.toSorted(), rest);
  assert.deepEqual(selectSmokes(parseArgs(["--tier", "boot"])), core);
});

test("new smoke joins gate by default; credentials/legacy exclusions do not", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "new-smoke.mjs"), "// new assertion\n");
  writeFileSync(join(dir, "live-smoke.mjs"), "ensurePiAuthInto(home);\n");
  writeFileSync(join(dir, "sigstop-smoke.mjs"), "// needs missing CLI\n");
  assert.deepEqual(selectSmokes(parseArgs([]), dir), ["new-smoke.mjs"]);
  assert.throws(() => selectSmokes(parseArgs(["--tier", "core"]), dir), /core e2e smoke missing/);
  assert.deepEqual(selectSmokes(parseArgs(["--tier", "quarantine"]), dir), []);
  const missing = "missing-quarantine-smoke.mjs";
  SMOKE_QUARANTINE.set(missing, "test-only missing quarantine entry");
  try {
    assert.throws(
      () => selectSmokes(parseArgs(["--tier", "quarantine"]), dir),
      /quarantined smoke missing/,
    );
  } finally {
    SMOKE_QUARANTINE.delete(missing);
  }
});

test("CLI validates tiers/jobs/shards and lowers jobs to Session concurrency budget", () => {
  assert.equal(parseArgs(["--jobs", "4"], "1").jobs, 1);
  assert.equal(parseArgs([], "8").jobs, 4);
  assert.equal(
    parseArgs([], undefined).jobs,
    Math.min(4, Number(process.env.VOLLI_CONCURRENCY_HINT) || 4),
  );
  assert.throws(() => parseArgs(["--tier", "unknown"]), /--tier must/);
  assert.throws(() => parseArgs(["--jobs", "0"]), /positive integer/);
  assert.throws(() => selectSmokes(parseArgs(["--shard", "0/3"])), /out of range/);
  assert.throws(() => selectSmokes(parseArgs(["--shard", "wrong"])), /must look like/);
  assert.throws(() => parseArgs(["--unknown"]), /unknown argument/);
});

test("CI gates core/rest and always uploads evidence; quarantine is separate and non-red", () => {
  const ci = parse(readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8"));
  const nightly = parse(readFileSync(join(REPO, ".github/workflows/smoke-quarantine.yml"), "utf8"));
  assert.ok(ci.jobs.gate.needs.includes("smoke-boot"));
  assert.ok(ci.jobs.gate.needs.includes("smoke-rest"));
  for (const lane of ["smoke-boot", "smoke-rest"]) {
    const steps = ci.jobs[lane].steps;
    const smoke = steps.find((step) => step.run?.includes("smoke-quiet-check.mjs"));
    assert.match(smoke.run, lane === "smoke-boot" ? /--tier core/ : /--tier rest/);
    assert.equal(smoke.env.VOLLI_SMOKE_REPORT_DIR, "${{ runner.temp }}/smoke-results");
    const upload = steps.find((step) => step.with?.name?.startsWith("smoke-results-"));
    assert.equal(upload.if, "always()");
    assert.equal(upload.with["retention-days"], 30);
  }
  assert.ok(nightly.on.schedule.length);
  assert.equal(nightly.on.pull_request, undefined);
  const smoke = nightly.jobs.quarantine.steps.find((step) =>
    step.run?.includes("smoke-quiet-check.mjs"),
  );
  assert.equal(smoke["continue-on-error"], true);
  assert.match(smoke.run, /--tier quarantine/);
  assert.ok(!ci.jobs.gate.needs.includes("quarantine"));
});
