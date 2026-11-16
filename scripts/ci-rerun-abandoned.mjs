// Re-request a CI run's failed jobs ONCE when GitHub never started a lane
// (VC-1221). GitHub sometimes assigns no runner to a job — on this repository
// the macOS `Smoke (core e2e)` lane, while GitHub reports limited macOS arm64
// capacity. The job ends `cancelled` after 15 to 35 minutes with no runner and
// no steps, and `CI gate` goes red on a commit nothing is wrong with
// (docs/development/ci.md, "abandoned").
//
// This file decides, from GitHub's own record of the run and its jobs, whether
// that is ALL that went wrong. It never reads logs, artifacts, annotations or
// the gate's text, and it never executes anything from the run it judges.
// `.github/workflows/ci-rerun-abandoned.yml` runs it from the default branch
// and, only on a `true` answer, a separate job asks GitHub to re-run the
// failed jobs. A re-run executes the same commit and re-judges every lane, so
// it can turn red into green only by running the lane that never ran.
//
// Every string read from the API (job names, branch names) can be chosen by a
// pull request's author. None reaches a shell; the log prints them only
// JSON-quoted after a fixed prefix, so none can start a workflow command.

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WORKFLOW_PATH = ".github/workflows/ci.yml";
// The summing job. It always runs and fails when a lane did not pass, so its
// own failure is the symptom, not a separate result: a re-run re-runs it as a
// dependent of the re-run lane and it judges every lane again.
export const GATE_JOB_NAME = "CI gate";
const GREEN = new Set(["success", "skipped", "neutral"]);

/**
 * GitHub's record of a job no runner ever picked up: completed as `cancelled`,
 * with no runner assigned and not one step recorded. A job that ran anything —
 * even only "Set up job" — has a runner and at least one step.
 */
export function neverStarted(job) {
  return (
    job.status === "completed" &&
    job.conclusion === "cancelled" &&
    Array.isArray(job.steps) &&
    job.steps.length === 0 &&
    (job.runner_id === 0 || job.runner_id === null || job.runner_id === undefined) &&
    (job.runner_name === "" || job.runner_name === null || job.runner_name === undefined)
  );
}

function no(reason) {
  return { rerun: false, reason, abandoned: [] };
}

/**
 * Decide whether to re-request the failed jobs of one ci.yml run.
 *
 * Re-request only when ALL hold:
 *  1. the event names attempt 1, and the run is still on attempt 1 (once only;
 *     a person who already re-ran it wins);
 *  2. the run is ci.yml, completed, conclusion `failure` (a cancelled run —
 *     superseded by a newer push, or stopped by a person — is left alone);
 *  3. at least one job never started (`neverStarted`);
 *  4. every other job that is not green is the gate, and the gate ran. Any
 *     other failed, timed-out or cancelled job that had a runner or a step is a
 *     result about the commit, so nothing is re-requested and it stays red;
 *  5. outside push runs, no newer ci.yml run exists for the same event, branch
 *     and head repository. ci.yml cancels a PR's older run when a newer one
 *     starts, so re-running a superseded PR run would cancel the newer one.
 *     Push runs are grouped per commit and never cancelled.
 *
 * @param {{ attempt: number, run: object, jobs: object[], siblings?: object[] }} input
 *   `attempt` is the run attempt the triggering event named; `run` and `jobs`
 *   are GitHub's run and that attempt's jobs; `siblings` are other ci.yml runs
 *   (only consulted outside push runs).
 * @returns {{ rerun: boolean, reason: string, abandoned: number[] }}
 */
export function decideRerun({ attempt, run, jobs, siblings = [] }) {
  if (attempt !== 1) return no(`attempt ${attempt} is not the first; re-request at most once`);
  if (run.run_attempt !== 1) return no(`run is already on attempt ${run.run_attempt}`);
  if (run.path !== WORKFLOW_PATH) return no("not the CI workflow");
  if (run.status !== "completed") return no(`run is ${run.status}, not completed`);
  if (run.conclusion !== "failure") return no(`run concluded ${run.conclusion}, not failure`);
  if (!Array.isArray(jobs) || jobs.length === 0) return no("run has no jobs");
  if (jobs.some((job) => job.run_attempt !== 1)) return no("job list is not attempt 1's");

  const abandoned = [];
  for (const job of jobs) {
    if (GREEN.has(job.conclusion)) continue;
    if (neverStarted(job)) {
      abandoned.push(job.id);
      continue;
    }
    if (job.name === GATE_JOB_NAME && job.steps?.length > 0) continue;
    return no(`job ${job.id} ran and concluded ${job.conclusion}: a real result stays red`);
  }
  if (abandoned.length === 0) return no("no job that never started");

  if (run.event !== "push") {
    const newer = siblings.find(
      (other) =>
        other.id !== run.id &&
        other.path === WORKFLOW_PATH &&
        other.event === run.event &&
        other.head_branch === run.head_branch &&
        other.head_repository?.id === run.head_repository?.id &&
        other.run_number > run.run_number,
    );
    if (newer) return no(`newer run ${newer.id} supersedes this one`);
  }

  return {
    rerun: true,
    reason: `${abandoned.length} job(s) never started and nothing else failed`,
    abandoned,
  };
}

function positiveInteger(name, value) {
  if (!/^[1-9][0-9]{0,19}$/u.test(value ?? "")) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

async function api(path, token) {
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(`${base}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY is not owner/name");
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const runId = positiveInteger("RUN_ID", process.env.RUN_ID);
  const repo = `/repos/${repository}`;

  const run = await api(`${repo}/actions/runs/${runId}`, token);
  // A manual dry run names only the run; it is judged at its current attempt.
  const attempt = process.env.RUN_ATTEMPT
    ? positiveInteger("RUN_ATTEMPT", process.env.RUN_ATTEMPT)
    : run.run_attempt;
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const body = await api(
      `${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      token,
    );
    jobs.push(...body.jobs);
    if (jobs.length >= body.total_count || body.jobs.length === 0) break;
  }
  let siblings = [];
  if (run.event !== "push" && typeof run.head_branch === "string") {
    const query = new URLSearchParams({
      event: run.event,
      branch: run.head_branch,
      per_page: "20",
    });
    const body = await api(`${repo}/actions/workflows/ci.yml/runs?${query}`, token);
    siblings = body.workflow_runs;
  }

  const decision = decideRerun({ attempt, run, jobs, siblings });
  for (const job of jobs.filter((each) => !GREEN.has(each.conclusion))) {
    console.log(
      `job ${job.id} ${JSON.stringify(job.name)}: conclusion=${JSON.stringify(job.conclusion)} ` +
        `runner_id=${JSON.stringify(job.runner_id)} steps=${job.steps?.length ?? "none"} ` +
        `never-started=${neverStarted(job)}`,
    );
  }
  console.log(`decision: rerun=${decision.rerun} (${decision.reason})`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `rerun=${decision.rerun}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Run ${runId} attempt ${attempt}: ${decision.rerun ? "re-requesting failed jobs" : "no re-request"}` +
        ` (${decision.reason}).\n`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
