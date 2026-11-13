// The never-started re-request (VC-1221): its predicate against GitHub's own
// recorded job payloads, the script's wiring through a real HTTP API double,
// the workflow's shape and permissions, and the rerun step's actual shell.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { GATE_JOB_NAME, WORKFLOW_PATH, decideRerun, neverStarted } from "./ci-rerun-abandoned.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/ci-rerun-abandoned.mjs");
const workflowFile = ".github/workflows/ci-rerun-abandoned.yml";
const workflow = parse(readFileSync(join(root, workflowFile), "utf8"));
const ci = parse(readFileSync(join(root, WORKFLOW_PATH), "utf8"));

// Recorded with `gh api` from this repository's history, trimmed to the
// fields the predicate reads (see each file's `recorded`).
function fixture(name) {
  return JSON.parse(
    readFileSync(join(root, "scripts/fixtures/ci-rerun-abandoned", `${name}.json`), "utf8"),
  );
}
// A copy of `jobs` with `change` applied to the jobs `which` selects.
function withJobs(jobs, which, change) {
  const copy = structuredClone(jobs);
  for (const job of copy) if (which(job)) Object.assign(job, change);
  return copy;
}
const SMOKE = 131984718584;
// The run as it stood when attempt 1 completed, for a run later re-run.
function asFirstAttempt(recorded, conclusion = "failure") {
  return { ...recorded.run, run_attempt: 1, conclusion };
}

test("the 2026-11-13 never-started core e2e lane is re-requested (run 43454391718)", () => {
  const { attempt, run, jobs } = fixture("never-started");
  const smoke = jobs.find((job) => job.id === 131984718584);
  assert.equal(smoke.name, "Smoke (core e2e)");
  assert.equal(neverStarted(smoke), true);
  assert.deepEqual(decideRerun({ attempt, run, jobs }), {
    rerun: true,
    reason: "1 job(s) never started and nothing else failed",
    abandoned: [131984718584],
  });
});

test("a real test failure stays red (run 43417035934, Test (desktop 4/4))", () => {
  const { attempt, run, jobs } = fixture("real-failure");
  const failed = jobs.filter((job) => job.conclusion === "failure");
  assert.deepEqual(failed.map((job) => job.name).toSorted(), [GATE_JOB_NAME, "Test (desktop 4/4)"]);
  const decision = decideRerun({ attempt, run, jobs });
  assert.equal(decision.rerun, false);
  assert.match(decision.reason, /ran and concluded failure/u);
});

test("a never-started lane beside a real failure stays red (run 42635926330, attempt 1)", () => {
  const recorded = fixture("mixed");
  const { jobs } = recorded;
  assert.ok(jobs.some((job) => job.name === "Smoke (core e2e)" && neverStarted(job)));
  assert.ok(jobs.some((job) => job.name === "Test (packages)" && job.conclusion === "failure"));
  const decision = decideRerun({ attempt: 1, run: asFirstAttempt(recorded), jobs });
  assert.equal(decision.rerun, false);
  assert.match(decision.reason, /a real result stays red/u);
});

test("a second attempt is never re-requested, even when it also never started (run 41853107014)", () => {
  const { attempt, run, jobs } = fixture("second-attempt");
  assert.equal(attempt, 2);
  assert.ok(jobs.some(neverStarted), "attempt 2's core e2e was not acquired either");
  assert.equal(decideRerun({ attempt, run, jobs }).rerun, false);
  // Attempt 1's completion event arriving after a person already re-ran it.
  const first = withJobs(jobs, () => true, { run_attempt: 1 });
  assert.equal(decideRerun({ attempt: 1, run, jobs: first }).rerun, false);
  assert.match(decideRerun({ attempt: 1, run, jobs: first }).reason, /already on attempt 2/u);
});

test("a run cancelled by a newer push is left alone though its jobs never started (run 42616473309)", () => {
  const { attempt, run, jobs } = fixture("superseded");
  assert.equal(run.conclusion, "cancelled");
  assert.ok(jobs.filter(neverStarted).length > 5);
  const decision = decideRerun({ attempt, run, jobs });
  assert.equal(decision.rerun, false);
  assert.match(decision.reason, /concluded cancelled/u);
});

test("a PR run superseded by a newer run of the same branch is left alone", () => {
  const { attempt, run, jobs } = fixture("never-started");
  const pr = { ...run, event: "pull_request", head_branch: "feature" };
  const newer = { ...pr, id: run.id + 1, run_number: run.run_number + 1 };
  assert.equal(decideRerun({ attempt, run: pr, jobs, siblings: [pr] }).rerun, true);
  assert.match(
    decideRerun({ attempt, run: pr, jobs, siblings: [pr, newer] }).reason,
    /supersedes/u,
  );
  // Other branches, other events, older runs and forks' same-named branches do not count.
  for (const other of [
    { ...newer, head_branch: "other" },
    { ...newer, event: "push" },
    { ...newer, run_number: run.run_number - 1 },
    { ...newer, head_repository: { id: 1, full_name: "someone/fork" } },
  ]) {
    assert.equal(decideRerun({ attempt, run: pr, jobs, siblings: [other] }).rerun, true);
  }
  // Push runs are grouped per commit and never cancelled.
  const push = { ...run, event: "push" };
  assert.equal(
    decideRerun({ attempt, run: push, jobs, siblings: [{ ...push, id: 1, run_number: 1e9 }] })
      .rerun,
    true,
  );
});

test("never-started means no runner, no step and cancelled — each alone is not enough", () => {
  const { jobs } = fixture("never-started");
  const base = jobs.find((job) => job.id === 131984718584);
  assert.equal(neverStarted({ ...base, runner_id: null, runner_name: null }), true);
  for (const change of [
    { steps: [{ number: 1, conclusion: "success" }] },
    { steps: undefined },
    { runner_id: 1000045877 },
    { runner_name: "GitHub Actions 1000045877" },
    { conclusion: "failure" },
    { conclusion: "timed_out" },
    { status: "in_progress" },
  ]) {
    assert.equal(neverStarted({ ...base, ...change }), false, JSON.stringify(change));
  }
});

test("any other non-green job that ran keeps the run red, whatever its conclusion", () => {
  const { attempt, run, jobs } = fixture("never-started");
  const lane = jobs.find((job) => job.name === "Test (packages)");
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", null]) {
    const changed = withJobs(jobs, (job) => job.id === lane.id, { conclusion });
    assert.equal(decideRerun({ attempt, run, jobs: changed }).rerun, false, String(conclusion));
  }
  // The gate is exempt only because it ran: a gate that failed without a
  // runner or a step is not the summarising job doing its work.
  const gate = jobs.find((job) => job.name === GATE_JOB_NAME);
  const stepless = withJobs(jobs, (job) => job.id === gate.id, { steps: [] });
  assert.equal(decideRerun({ attempt, run, jobs: stepless }).rerun, false);
  // A gate GitHub never started either is just another never-started job.
  const gateNeverRan = withJobs(jobs, (job) => job.id === gate.id, {
    conclusion: "cancelled",
    runner_id: 0,
    runner_name: "",
    steps: [],
  });
  assert.deepEqual(decideRerun({ attempt, run, jobs: gateNeverRan }).abandoned.length, 2);
});

test("only a completed, failed first attempt of ci.yml qualifies", () => {
  const { run, jobs } = fixture("never-started");
  const no = (input) => assert.equal(decideRerun({ attempt: 1, run, jobs, ...input }).rerun, false);
  no({ attempt: 2 });
  no({ attempt: "1" });
  no({ run: { ...run, run_attempt: 2 } });
  no({ run: { ...run, path: ".github/workflows/evil.yml" } });
  no({ run: { ...run, status: "in_progress" } });
  for (const conclusion of ["success", "cancelled", "action_required", "timed_out", null]) {
    no({ run: { ...run, conclusion } });
  }
  no({ jobs: [] });
  no({ jobs: withJobs(jobs, () => true, { run_attempt: 2 }) });
  no({
    jobs: withJobs(jobs, (job) => job.id === SMOKE, { conclusion: "success" }),
  });
});

// The script's IO, through a real HTTP server standing in for the API.
async function runScript({ recorded, siblings = [], env = {} }) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, auth: request.headers.authorization });
    const url = new URL(request.url, "http://x");
    let body;
    if (url.pathname === `/repos/o/r/actions/runs/${recorded.run.id}`) body = recorded.run;
    else if (url.pathname.endsWith("/jobs")) {
      const page = Number(url.searchParams.get("page"));
      const jobs = recorded.jobs.slice((page - 1) * 10, page * 10);
      body = { total_count: recorded.jobs.length, jobs };
    } else if (url.pathname === "/repos/o/r/actions/workflows/ci.yml/runs") {
      body = { workflow_runs: siblings };
    }
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? {}));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const dir = mkdtempSync(join(tmpdir(), "ci-rerun-"));
  const output = join(dir, "output");
  writeFileSync(output, "");
  try {
    const child = spawn(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_TOKEN: "test-token",
        GITHUB_OUTPUT: output,
        RUN_ID: String(recorded.run.id),
        RUN_ATTEMPT: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((done) => child.once("exit", done));
    return { code, stdout, stderr, output: readFileSync(output, "utf8"), requests };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the script pages through the attempt's jobs and writes only rerun=true|false", async () => {
  const recorded = fixture("never-started");
  const result = await runScript({ recorded });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output, "rerun=true\n");
  assert.ok(recorded.jobs.length > 10, "the fixture spans more than one page here");
  assert.ok(
    result.requests.some((request) => request.url.includes("/attempts/1/jobs?per_page=100&page=2")),
  );
  assert.ok(result.requests.every((request) => request.auth === "Bearer test-token"));
  // A scheduled run looks for a newer scheduled run of its branch.
  assert.ok(
    result.requests.some((request) =>
      request.url.endsWith("/workflows/ci.yml/runs?event=schedule&branch=main&per_page=20"),
    ),
  );

  // A push run is grouped per commit, so it needs no sibling lookup.
  const failed = await runScript({ recorded: fixture("real-failure") });
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(failed.output, "rerun=false\n");
  assert.ok(!failed.requests.some((request) => request.url.includes("/workflows/")));
});

test("hostile names from the API cannot start a workflow command or reach a URL raw", async () => {
  const recorded = fixture("never-started");
  const hostile = "x\n::error::forged\n::set-output name=rerun::true";
  const run = { ...recorded.run, event: "pull_request", head_branch: "a&event=push#" };
  const jobs = withJobs(recorded.jobs, (job) => job.id === SMOKE, { name: hostile });
  const result = await runScript({ recorded: { run, jobs } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output, "rerun=true\n");
  for (const line of result.stdout.split("\n")) assert.doesNotMatch(line, /^\s*::/u);
  const sibling = result.requests.find((request) => request.url.includes("/workflows/ci.yml/runs"));
  assert.match(sibling.url, /branch=a%26event%3Dpush%23/u);
  assert.match(sibling.url, /event=pull_request/u);
});

test("the script refuses a run id or attempt that is not a number", async () => {
  const recorded = fixture("never-started");
  for (const env of [{ RUN_ID: "1; rm -rf /" }, { RUN_ID: "" }, { RUN_ATTEMPT: "1 2" }]) {
    const result = await runScript({ recorded, env });
    assert.notEqual(result.code, 0, JSON.stringify(env));
    assert.equal(result.output, "", JSON.stringify(env));
  }
});

test("the workflow listens to CI's completion, from the default branch, with split least privilege", () => {
  assert.equal(ci.name, "CI");
  assert.deepEqual(Object.keys(workflow.on).toSorted(), ["workflow_dispatch", "workflow_run"]);
  assert.deepEqual(workflow.on.workflow_run, { workflows: ["CI"], types: ["completed"] });
  assert.notEqual(workflow.name, "CI");
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency["cancel-in-progress"], false);

  const { decide, rerun } = workflow.jobs;
  assert.deepEqual(Object.keys(workflow.jobs).toSorted(), ["decide", "rerun"]);
  assert.deepEqual(decide.permissions, { actions: "read", contents: "read" });
  assert.deepEqual(rerun.permissions, { actions: "write" });
  assert.equal(rerun.needs, "decide");
  assert.equal(
    rerun.if,
    "github.event_name == 'workflow_run' && needs.decide.outputs.rerun == 'true'",
  );

  // Decide checks out only the predicate, at the workflow's own commit (the
  // default branch for workflow_run), and keeps no credentials.
  const [checkout, judge] = decide.steps;
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/u);
  assert.deepEqual(checkout.with, {
    "persist-credentials": false,
    "sparse-checkout": "scripts/ci-rerun-abandoned.mjs",
    "sparse-checkout-cone-mode": false,
  });
  assert.equal(judge.run, "node scripts/ci-rerun-abandoned.mjs");
  assert.equal(decide.steps.length, 2);

  // Rerun runs no action and no repository code.
  assert.ok(rerun.steps.every((step) => !step.uses));
});

test("event data reaches no shell directly and only the run id, attempt and conclusion are read", () => {
  const text = readFileSync(join(root, workflowFile), "utf8");
  const fields = new Set(text.match(/github\.event\.[A-Za-z0-9_.]+/gu));
  assert.deepEqual([...fields].toSorted(), [
    "github.event.workflow_run.conclusion",
    "github.event.workflow_run.id",
    "github.event.workflow_run.run_attempt",
  ]);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      assert.doesNotMatch(step.run ?? "", /\$\{\{/u, `${step.name} interpolates an expression`);
    }
  }
  assert.doesNotMatch(text, /download-artifact|github\.event\.workflow_run\.head_/u);
});

// The rerun step's own shell, with `gh` replaced by a recorder.
function runRerunStep({ runId, attempt }) {
  const dir = mkdtempSync(join(tmpdir(), "ci-rerun-gh-"));
  try {
    const log = join(dir, "gh.log");
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n` +
        `if [[ "$1" == api && "$2" != --method ]]; then echo "${attempt}"; fi\n`,
    );
    chmodSync(gh, 0o755);
    writeFileSync(log, "");
    const step = workflow.jobs.rerun.steps[0];
    const result = spawnSync("bash", ["-c", step.run], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: "t",
        RUN_ID: runId,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_STEP_SUMMARY: join(dir, "summary"),
      },
      encoding: "utf8",
    });
    return { ...result, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the rerun step posts once for attempt 1 and stands down if a person re-ran it", () => {
  const posted = runRerunStep({ runId: "43454391718", attempt: 1 });
  assert.equal(posted.status, 0, posted.stderr);
  assert.deepEqual(posted.calls, [
    "api repos/o/r/actions/runs/43454391718 --jq .run_attempt",
    "api --method POST repos/o/r/actions/runs/43454391718/rerun-failed-jobs",
  ]);

  const already = runRerunStep({ runId: "43454391718", attempt: 2 });
  assert.equal(already.status, 0, already.stderr);
  assert.equal(already.calls.length, 1);

  const forged = runRerunStep({ runId: "1$(touch /tmp/x)", attempt: 1 });
  assert.notEqual(forged.status, 0);
  assert.deepEqual(forged.calls, []);
});
