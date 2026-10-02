import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { parseArgs, selectSmokes } from "../scripts/run-smokes.mjs";

const workflow = parse(
  readFileSync(new URL("../../../.github/workflows/smoke-quarantine.yml", import.meta.url), "utf8"),
);
const observation = workflow.jobs.quarantine.steps.find((step) =>
  step.name.startsWith("Observe restored picker"),
);

test("picker return is gating; manual concurrent observations remain opt-in and non-gating", () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.observe_picker.type, "boolean");
  assert.equal(workflow.on.workflow_dispatch.inputs.observe_picker.default, false);
  assert.equal(observation.if, "${{ inputs.observe_picker }}");
  assert.equal(observation["continue-on-error"], true);
  assert.ok(selectSmokes(parseArgs(["--tier", "rest"])).includes("automations-picker-smoke.mjs"));
  assert.ok(
    !selectSmokes(parseArgs(["--tier", "quarantine"])).includes("automations-picker-smoke.mjs"),
  );
  for (const probe of ["arming", "schedule", "provenance", "page", "notification"]) {
    assert.ok(selectSmokes(parseArgs([])).includes(`automations-${probe}-smoke.mjs`));
  }
});

async function observe(statuses) {
  // Execute the workflow's actual JS with fake runners, never launch Electron.
  const source = observation.run
    .split("<<'NODE'\n")[1]
    .split("\nNODE")[0]
    .replace(/^import .+;\n/gm, "");
  const execute = new Function(
    "join",
    "runOne",
    "createSmokeReporter",
    "runWithRetry",
    "process",
    "console",
    `return (async () => { ${source} })();`,
  );
  const reports = [];
  const finished = [];
  let started = 0;
  let concurrent = 0;
  const fakeProcess = { env: { VOLLI_SMOKE_REPORT_DIR: "/evidence", GITHUB_SHA: "test-sha" } };
  await execute(
    join,
    async (name, number, { reporter }) => {
      started += 1;
      concurrent = Math.max(concurrent, started - finished.length);
      await Promise.resolve();
      return { name, number, status: statuses[reporter.index] };
    },
    (options) => {
      const index = reports.length;
      reports.push(options);
      return {
        index,
        recordResult() {},
        finish() {
          finished.push(index);
        },
      };
    },
    async (name, run) => run(name, 1),
    fakeProcess,
    { log() {} },
  );
  return { reports, finished, concurrent, exitCode: fakeProcess.exitCode };
}

test("workflow observes four simultaneous profiles with distinct durable reports", async () => {
  const result = await observe(["PASS", "PASS", "PASS", "PASS"]);
  assert.equal(result.concurrent, 4);
  assert.equal(result.finished.length, 4);
  assert.deepEqual(
    result.reports.map((report) => report.reportDir),
    ["/evidence/1", "/evidence/2", "/evidence/3", "/evidence/4"],
  );
  assert.ok(result.reports.every((report) => report.metadata.sha === "test-sha"));
  assert.equal(result.exitCode, undefined);
});

for (const status of ["FLAKY", "FAIL"]) {
  test(`workflow does not count ${status} as successful return proof`, async () => {
    const result = await observe(["PASS", status, "PASS", "PASS"]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.finished.length, 4);
  });
}
