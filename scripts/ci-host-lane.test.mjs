// Exercise the actual workflow's shell, not a second implementation of it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const jobs = workflow.jobs;
const gate = jobs.gate.steps.find((step) => step.id === "require-lanes");
const filter = jobs.changes.steps.find((step) => step.id === "filter");
const required = ["changes", "check", "test-desktop", "coverage-desktop", "test-packages"];
const conditional = ["host-container", "smoke-boot", "smoke-rest"];

function results(event = "pull_request", desktop = "true", host = "true") {
  return {
    EVENT: event,
    DESKTOP: desktop,
    HOST_CONTAINER_REQUIRED: host,
    SCOPE: "success",
    CHECK: "success",
    TEST_DESKTOP: "success",
    COVERAGE_DESKTOP: "success",
    TEST_PACKAGES: "success",
    HOST_CONTAINER: host === "true" ? "success" : "skipped",
    SMOKE_BOOT: desktop === "true" ? "success" : "skipped",
    SMOKE_REST: desktop === "true" && event === "pull_request" ? "success" : "skipped",
  };
}

function runGate(env) {
  return spawnSync("bash", ["-c", gate.run], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function resultVariable(job) {
  const match = Object.entries(gate.env).find(
    ([, value]) => value === `\${{ needs.${job}.result }}`,
  );
  assert.ok(match, `${job} has no gate result assertion`);
  return match[0];
}

test("gate names every job and always runs, even on failure/cancellation", () => {
  assert.equal(jobs.gate.if, "always()");
  assert.deepEqual(
    jobs.gate.needs.toSorted(),
    Object.keys(jobs)
      .filter((job) => job !== "gate")
      .toSorted(),
  );
  assert.deepEqual(jobs.gate.needs.toSorted(), [...required, ...conditional].toSorted());
  for (const job of jobs.gate.needs) resultVariable(job);
  assert.equal(jobs["host-container"].if, "needs.changes.outputs.host-container == 'true'");
  assert.equal(jobs["smoke-boot"].if, "needs.changes.outputs.desktop == 'true'");
  assert.equal(
    jobs["smoke-rest"].if,
    "needs.changes.outputs.desktop == 'true' && github.event_name == 'pull_request'",
  );
});

test("gate accepts only success or the precise conditional skip", () => {
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    for (const desktop of ["true", "false"]) {
      for (const host of ["true", "false"]) {
        const env = results(event, desktop, host);
        const green = runGate(env);
        assert.equal(green.status, 0, green.stdout + green.stderr);
        for (const job of jobs.gate.needs) {
          const variable = resultVariable(job);
          for (const state of ["success", "failure", "cancelled", "skipped", "", "unknown"]) {
            const outcome = runGate({ ...env, [variable]: state });
            assert.equal(
              outcome.status === 0,
              state === env[variable],
              `${event}/${desktop}/${host}: ${job}=${state}\n${outcome.stdout}${outcome.stderr}`,
            );
          }
        }
      }
    }
  }
});

test("empty or malformed Scope outputs cannot authorize skips", () => {
  for (const variable of ["DESKTOP", "HOST_CONTAINER_REQUIRED"]) {
    for (const flag of ["", "unknown", "FALSE", "0"]) {
      assert.notEqual(
        runGate({ ...results("pull_request", "false", "false"), [variable]: flag }).status,
        0,
      );
    }
  }
});

test("actual path classifier selects host/container inputs and fails safe", () => {
  // Stub just git diff; all classification and output code comes from ci.yml.
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const temporary = mkdtempSync(join(root, ".tmp/ci-host-test-"));
  try {
    const cases = [
      ["docs/plans/volli-cloud.md", "false", "false"],
      ["apps/website/src/index.ts", "false", "false"],
      ["apps/desktop/src/main/index.ts", "true", "false"],
      ["packages/host-core/src/index.ts", "true", "true"],
      ["packages/host-protocol/src/index.ts", "true", "true"],
      ["apps/hostd/src/index.ts", "true", "true"],
      ["packages/session-engine/src/index.ts", "true", "true"],
      ["packages/shared/src/index.ts\ndocs/DESIGN.md", "true", "true"],
      [".devcontainer/host/Dockerfile", "true", "true"],
      [".devcontainer/host/devcontainer.json", "true", "true"],
      [".github/workflows/ci.yml", "true", "true"],
      ["scripts/ci-host-lane.test.mjs", "true", "true"],
      ["scripts/check-host-electron-imports.mjs", "true", "true"],
      [".nvmrc", "true", "true"],
      ["package.json", "true", "true"],
      ["pnpm-lock.yaml", "true", "true"],
      ["pnpm-workspace.yaml", "true", "true"],
      ["", "true", "true"],
    ];
    for (const event of ["pull_request", "push", "workflow_dispatch"]) {
      for (const [changed, desktop, host] of cases) {
        const output = join(temporary, "output");
        const run = spawnSync(
          "bash",
          ["-c", 'git() { printf "%s\\n" "$CHANGED"; }\n' + filter.run],
          {
            cwd: root,
            env: {
              ...process.env,
              EVENT: event,
              CHANGED: changed,
              BASE_SHA: "base",
              HEAD_SHA: "head",
              GITHUB_OUTPUT: output,
            },
            encoding: "utf8",
          },
        );
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal(
          readFileSync(output, "utf8"),
          `desktop=${event === "pull_request" ? desktop : "true"}\nhost-container=${event === "pull_request" ? host : "true"}\n`,
          `${event}: ${changed}`,
        );
        rmSync(output);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("devcontainer installs host tooling/packages without the desktop postinstall", () => {
  const config = JSON.parse(
    readFileSync(join(root, ".devcontainer/host/devcontainer.json"), "utf8"),
  );
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(config.postCreateCommand, [
    "pnpm",
    "--filter",
    manifest.name,
    "--filter",
    "./packages/*",
    "--filter",
    "./apps/hostd",
    "install",
    "--frozen-lockfile",
  ]);
});

test("existing and future host packages cannot silently omit the coverage script", () => {
  for (const directory of [
    "packages/session-engine",
    "packages/session-rpc",
    "packages/agent-runtime",
    "packages/shared",
    "packages/host-protocol",
    "packages/host-core",
    "apps/hostd",
  ]) {
    const manifest = join(root, directory, "package.json");
    if (
      !existsSync(manifest) &&
      ["packages/host-protocol", "packages/host-core", "apps/hostd"].includes(directory)
    )
      continue;
    assert.equal(
      typeof JSON.parse(readFileSync(manifest, "utf8")).scripts?.["test:coverage"],
      "string",
      `${directory} must join Test (packages)`,
    );
  }
  assert.equal(
    jobs["test-packages"].steps.find((step) => step.name === "Setup Vite+").with[
      "node-version-file"
    ],
    ".nvmrc",
  );
  const command = jobs["test-packages"].steps.at(-1).run;
  assert.ok(
    command.includes("--filter './packages/*' --filter './apps/*' --filter '!@volli/desktop'"),
  );
  assert.ok(command.includes("test:coverage"));
});
