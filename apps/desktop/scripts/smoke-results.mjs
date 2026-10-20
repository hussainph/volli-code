/** Retry policy and durable, per-attempt evidence for the desktop smoke runner. */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Never let an ambient reusable profile turn a retry into the same launch. */
export function smokeAttemptEnvironment(environment) {
  const env = { ...environment };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VOLLI_SMOKE_DIR;
  env.VOLLI_QUIET_WINDOWS = env.VOLLI_QUIET_WINDOWS === "0" ? "0" : "1";
  return env;
}

/** At most two NEW probe processes; a cancellation is not a retry opportunity. */
export async function runWithRetry(name, runAttempt, isInterrupted = () => false) {
  const attempts = [await runAttempt(name, 1)];
  if (attempts[0].code !== 0 && !isInterrupted()) attempts.push(await runAttempt(name, 2));
  const last = attempts.at(-1);
  const flaky = attempts.length === 2 && last.code === 0;
  return {
    name,
    code: last.code,
    flaky,
    status: last.code !== 0 ? "FAIL" : flaky ? "FLAKY" : "PASS",
    ms: attempts.reduce((total, attempt) => total + attempt.ms, 0),
    attempts,
  };
}

const seconds = (ms) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`);

/** A summary explicitly distinguishes green retries from first-attempt passes. */
export function smokeSummary(report) {
  const counts = (status) => report.results.filter((result) => result.status === status).length;
  const unfinished = report.results.filter(
    (result) => !["PASS", "FLAKY", "FAIL"].includes(result.status),
  ).length;
  return [
    `## Desktop smoke results (${report.tier}${report.shard ? ` ${report.shard}` : ""})`,
    "",
    `${counts("PASS")} first-attempt passes; **${counts("FLAKY")} flakes (passed on retry)**; ` +
      `**${counts("FAIL")} failures**; ${unfinished} unfinished.`,
    ...(report.completed
      ? []
      : [
          "",
          `**Incomplete run${report.interruptedBy ? `: ${report.interruptedBy}` : ""}. Do not interpret missing results as passes.**`,
        ]),
    "",
    "Both attempt logs and exit/signal/timing metadata are in the smoke-results artifact (30-day CI retention).",
    "",
    "| Smoke | Result | First attempt | Retry | Total |",
    "|---|---|---:|---:|---:|",
    ...report.results.map(
      (result) =>
        `| ${result.name} | ${result.status === "FLAKY" ? "FLAKY (passed on retry)" : result.status} | ` +
        `${seconds(result.attempts[0]?.ms)} | ${seconds(result.attempts[1]?.ms)} | ${seconds(result.ms)} |`,
    ),
    "",
  ].join("\n");
}

/**
 * Checkpoint on every attempt/result, not just on success. Stream logs as they
 * arrive so a timed-out/cancelled CI job still uploads first-failure evidence.
 * The JSON starts incomplete; only a fully drained run marks it complete.
 */
export function createSmokeReporter({ reportDir, summaryPath, names, metadata }) {
  mkdirSync(reportDir, { recursive: true });
  const report = {
    schemaVersion: 1,
    ...metadata,
    startedAt: new Date().toISOString(),
    completed: false,
    interruptedBy: null,
    profileIsolation:
      "New probe process per attempt; inherited VOLLI_SMOKE_DIR removed; probe owns fresh scratch/profile",
    results: names.map((name) => ({ name, status: "pending", attempts: [] })),
  };
  const resultFor = (name) => {
    const result = report.results.find((candidate) => candidate.name === name);
    if (!result) throw new Error(`unselected smoke: ${name}`);
    return result;
  };
  const checkpoint = () => {
    writeFileSync(join(reportDir, "results.json.tmp"), `${JSON.stringify(report, null, 2)}\n`);
    renameSync(join(reportDir, "results.json.tmp"), join(reportDir, "results.json"));
  };
  checkpoint();
  return {
    startAttempt(name, number) {
      const result = resultFor(name);
      const log = `${name}.attempt-${number}.log`;
      const attempt = { number, startedAt: new Date().toISOString(), log };
      result.status = "running";
      result.attempts.push(attempt);
      writeFileSync(join(reportDir, log), "");
      checkpoint();
      return {
        output(chunk) {
          appendFileSync(join(reportDir, log), chunk);
        },
        finish({ code, signal, ms }) {
          Object.assign(attempt, { code, signal, ms, finishedAt: new Date().toISOString() });
          checkpoint();
        },
      };
    },
    recordResult(result) {
      Object.assign(resultFor(result.name), {
        status: result.status,
        code: result.code,
        ms: result.ms,
      });
      checkpoint();
    },
    finish(interruptedBy = null) {
      report.interruptedBy = interruptedBy;
      report.completed =
        !interruptedBy &&
        report.results.every((result) => ["PASS", "FLAKY", "FAIL"].includes(result.status));
      report.finishedAt = new Date().toISOString();
      checkpoint();
      const summary = smokeSummary(report);
      writeFileSync(join(reportDir, "summary.md"), summary);
      if (summaryPath) appendFileSync(summaryPath, `${summary}\n`);
      return report;
    },
  };
}
