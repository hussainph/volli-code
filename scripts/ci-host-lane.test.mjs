// Exercise the actual workflow's shell, not a second implementation of it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const jobs = workflow.jobs;
const gate = jobs.gate.steps.find((step) => step.id === "require-lanes");
const filter = jobs.changes.steps.find((step) => step.id === "filter");
const required = [
  "changes",
  "check",
  "test-desktop",
  "coverage-desktop",
  "test-packages",
  "n1-compat",
];
const conditional = ["host-container", "smoke-boot", "smoke-rest", "smoke-cloud"];

function results(event = "pull_request", desktop = "true", host = "true", cloud = "true") {
  return {
    EVENT: event,
    DESKTOP: desktop,
    HOST_CONTAINER_REQUIRED: host,
    CLOUD_SMOKE_REQUIRED: cloud,
    SMOKE_CLOUD: cloud === "true" ? "success" : "skipped",
    SCOPE: "success",
    CHECK: "success",
    TEST_DESKTOP: "success",
    COVERAGE_DESKTOP: "success",
    TEST_PACKAGES: "success",
    N1_COMPAT: "success",
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
  assert.equal(jobs["smoke-cloud"].if, "needs.changes.outputs.cloud-smoke == 'true'");
  assert.equal(
    jobs["smoke-rest"].if,
    "needs.changes.outputs.desktop == 'true' && github.event_name == 'pull_request'",
  );
});

test("gate accepts only success or the precise conditional skip", () => {
  for (const event of ["pull_request", "push", "workflow_dispatch", "schedule"]) {
    for (const desktop of ["true", "false"]) {
      for (const host of ["true", "false"]) {
        for (const cloud of ["true", "false"]) {
          const env = results(event, desktop, host, cloud);
          const green = runGate(env);
          assert.equal(green.status, 0, green.stdout + green.stderr);
          for (const job of jobs.gate.needs) {
            const variable = resultVariable(job);
            for (const state of ["success", "failure", "cancelled", "skipped", "", "unknown"]) {
              const outcome = runGate({ ...env, [variable]: state });
              assert.equal(
                outcome.status === 0,
                state === env[variable],
                `${event}/${desktop}/${host}/${cloud}: ${job}=${state}\n${outcome.stdout}${outcome.stderr}`,
              );
            }
          }
        }
      }
    }
  }
});

test("empty or malformed Scope outputs cannot authorize skips", () => {
  for (const variable of ["DESKTOP", "HOST_CONTAINER_REQUIRED", "CLOUD_SMOKE_REQUIRED"]) {
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
      ["docs/plans/volli-cloud.md", "false", "false", "false"],
      ["apps/website/src/index.ts", "false", "false", "false"],
      ["apps/desktop/src/main/index.ts", "true", "false", "false"],
      ["packages/host-core/src/index.ts", "true", "true", "true"],
      ["packages/host-protocol/src/index.ts", "true", "true", "true"],
      ["packages/host-install/src/artifact.ts", "true", "true", "true"],
      ["packages/host-future/src/index.ts", "true", "true", "true"],
      ["packages/session-rpc/src/index.ts", "true", "true", "true"],
      ["apps/hostd/src/index.ts", "true", "true", "true"],
      ["apps/desktop/src/main/remote-hosts.ts", "true", "false", "true"],
      ["apps/desktop/src/main/remote-hosts.test.ts", "true", "false", "true"],
      ["apps/desktop/src/main/host-sign-ins/nested/link.ts", "true", "false", "true"],
      ["apps/desktop/src/renderer/src/components/hosts/AddHost.tsx", "true", "false", "true"],
      ["apps/desktop/src/renderer/src/stores/remote-hosts-store.ts", "true", "false", "true"],
      ["apps/desktop/src/renderer/src/stores/host-store.ts", "true", "false", "true"],
      ["apps/desktop/src/renderer/src/stores/session-store.ts", "true", "false", "false"],
      ["apps/desktop/src/renderer/src/lib/board-protocol.ts", "true", "false", "true"],
      ["apps/desktop/src/renderer/src/lib/board-protocol.test.ts", "true", "false", "false"],
      ["apps/desktop/e2e/volli-drive/remote-acceptance-smoke.mjs", "true", "false", "true"],
      ["apps/desktop/e2e/volli-drive/lib/core.mjs", "true", "false", "true"],
      ["apps/desktop/e2e/lib/smoke-kit.mjs", "true", "false", "true"],
      ["apps/desktop/src/main/harness/containment.ts", "true", "false", "true"],
      ["apps/desktop/package.json", "true", "false", "true"],
      ["packages/session-engine/src/index.ts", "true", "true", "false"],
      ["packages/shared/src/index.ts\ndocs/DESIGN.md", "true", "true", "false"],
      ["docs/DESIGN.md\npackages/session-rpc/src/index.ts", "true", "true", "true"],
      [".devcontainer/host/Dockerfile", "true", "true", "false"],
      [".devcontainer/host/devcontainer.json", "true", "true", "false"],
      [".github/workflows/ci.yml", "true", "true", "true"],
      ["scripts/ci-host-lane.test.mjs", "true", "true", "true"],
      ["scripts/check-host-electron-imports.mjs", "true", "true", "false"],
      [".nvmrc", "true", "true", "true"],
      ["package.json", "true", "true", "true"],
      ["pnpm-lock.yaml", "true", "true", "true"],
      ["pnpm-workspace.yaml", "true", "true", "true"],
      ["", "true", "true", "true"],
    ];
    for (const event of ["pull_request", "push", "workflow_dispatch", "schedule"]) {
      for (const [changed, desktop, host, cloud] of cases) {
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
          `desktop=${event === "pull_request" ? desktop : "true"}\nhost-container=${event === "pull_request" ? host : "true"}\ncloud-smoke=${event === "pull_request" ? cloud : "true"}\n`,
          `${event}: ${changed}`,
        );
        rmSync(output);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("cloud acceptance is nightly, macOS-only and separate from flag-off core e2e", () => {
  assert.deepEqual(workflow.on.schedule, [{ cron: "30 7 * * *" }]);
  const job = jobs["smoke-cloud"];
  assert.equal(job["runs-on"], "macos-15");
  assert.equal(job.needs, "changes");
  assert.equal(
    job.steps.find((step) => step.name === "Checkout").with.ref,
    "${{ github.event.pull_request.head.sha || github.sha }}",
  );
  const smoke = job.steps.find((step) => step.name === "Run flag-on remote acceptance");
  assert.equal(smoke.run, "node apps/desktop/e2e/volli-drive/remote-acceptance-smoke.mjs");
  assert.equal(smoke.env.VOLLI_EXPERIMENTAL, "cloud");
  assert.equal(smoke.env.VOLLI_DRIVE_EVIDENCE, "${{ runner.temp }}/cloud-acceptance");
  const upload = job.steps.at(-1);
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, smoke.env.VOLLI_DRIVE_EVIDENCE);
  assert.equal(upload.with["retention-days"], 30);
  // Cloud env must not leak through a workflow/global env to existing smokes.
  assert.equal(workflow.env?.VOLLI_EXPERIMENTAL, undefined);
  for (const name of ["smoke-boot", "smoke-rest"]) {
    assert.equal(jobs[name].env?.VOLLI_EXPERIMENTAL, undefined);
    for (const step of jobs[name].steps) {
      assert.equal(step.env?.VOLLI_EXPERIMENTAL, undefined);
      assert.doesNotMatch(step.run ?? "", /VOLLI_EXPERIMENTAL/);
    }
  }
});

test("cloud hostd is pinned and packaged before the Electron desktop install", () => {
  const steps = jobs["smoke-cloud"].steps;
  const setup = steps.find((step) => step.name === "Setup Vite+");
  assert.equal(setup.with["node-version-file"], ".nvmrc");
  assert.equal(setup.with["run-install"], false);
  const hostInstall = steps.findIndex((step) => step.name === "Host-only install");
  const packaging = steps.findIndex((step) => step.name.startsWith("Package hostd"));
  const desktopInstall = steps.findIndex((step) => step.name === "Install desktop dependencies");
  const build = steps.findIndex((step) => step.name === "Build and fetch Electron");
  const smoke = steps.findIndex((step) => step.name === "Run flag-on remote acceptance");
  assert.ok(hostInstall < packaging && packaging < desktopInstall);
  assert.ok(desktopInstall < build && build < smoke);
  assert.equal(
    steps[hostInstall].run,
    "pnpm --filter volli-code --filter './packages/*' --filter './apps/hostd' install --frozen-lockfile",
  );
  assert.equal(steps[desktopInstall].run, "pnpm install --frozen-lockfile");
  const pnpm = steps.find((step) => step.name === "Enable pinned pnpm").run;
  assert.match(pnpm, /corepack.*enable.*pnpm/);
  assert.match(pnpm, /packageManager/);
  const guard = steps.find((step) => step.name === "Check hostd target and desktop version").run;
  assert.match(guard, /process\.versions\.node.*cat \.nvmrc/);
  assert.match(guard, /process\.arch.*arm64/);
  assert.match(guard, /package\.json.*version.*apps\/desktop\/package\.json.*version/);
});

test("cloud artifact export uses the desktop version and requires archive plus checksum", () => {
  const packaging = jobs["smoke-cloud"].steps.find((step) => step.name.startsWith("Package hostd"));
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const temporary = mkdtempSync(join(root, ".tmp/ci-cloud-artifact-"));
  // Stub only the expensive packager and version read; execute the real export shell.
  const stub = `node() {
    if [[ "$1" == "apps/hostd/scripts/package.mjs" ]]; then
      mkdir -p "$3"
      if [[ "$OMIT" != archive ]]; then touch "$3/volli-hostd-9.8.7-darwin-arm64.tar.gz"; fi
      if [[ "$OMIT" != checksum ]]; then touch "$3/volli-hostd-9.8.7-darwin-arm64.tar.gz.sha256"; fi
    elif [[ "$1" == -p && "$2" == *apps/desktop/package.json* ]]; then
      printf '9.8.7\\n'
    else
      return 99
    fi
  }\n`;
  try {
    for (const omit of ["neither", "archive", "checksum"]) {
      const output = join(temporary, "env");
      writeFileSync(output, "");
      const run = spawnSync("bash", ["-c", stub + packaging.run], {
        cwd: root,
        env: { ...process.env, RUNNER_TEMP: temporary, GITHUB_ENV: output, OMIT: omit },
        encoding: "utf8",
      });
      assert.equal(run.status === 0, omit === "neither", run.stdout + run.stderr);
      assert.equal(
        readFileSync(output, "utf8"),
        omit === "neither"
          ? `VOLLI_HOSTD_DEV_TARBALLS=${temporary}/hostd/volli-hostd-9.8.7-darwin-arm64.tar.gz\n`
          : "",
      );
      rmSync(join(temporary, "hostd"), { recursive: true, force: true });
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

function hostPackageDirectories(workspaceRoot) {
  const workspace = parse(readFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8"));
  return globSync(
    workspace.packages.map((pattern) => `${pattern}/package.json`),
    { cwd: workspaceRoot },
  )
    .map((manifest) => dirname(manifest))
    .filter((directory) => directory.startsWith("packages/") || directory === "apps/hostd")
    .toSorted();
}

function assertHostCoverage(workspaceRoot) {
  for (const directory of hostPackageDirectories(workspaceRoot)) {
    const manifest = join(workspaceRoot, directory, "package.json");
    assert.equal(
      typeof JSON.parse(readFileSync(manifest, "utf8")).scripts?.["test:coverage"],
      "string",
      `${directory} must join Test (packages)`,
    );
  }
}

test("existing and future host packages cannot silently omit the coverage script", () => {
  assertHostCoverage(root);
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

test("workspace globs discover a newly added host package and require its coverage script", () => {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const temporary = mkdtempSync(join(root, ".tmp/ci-host-packages-"));
  function writeManifest(directory, scripts = {}) {
    mkdirSync(join(temporary, directory), { recursive: true });
    writeFileSync(join(temporary, directory, "package.json"), JSON.stringify({ scripts }));
  }
  try {
    writeFileSync(
      join(temporary, "pnpm-workspace.yaml"),
      readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
    );
    writeManifest("packages/existing", { "test:coverage": "vitest run --coverage" });
    writeManifest("apps/hostd", { "test:coverage": "vitest run --coverage" });
    writeManifest("apps/desktop");
    mkdirSync(join(temporary, "packages/not-a-package"), { recursive: true });
    assert.deepEqual(hostPackageDirectories(temporary), ["apps/hostd", "packages/existing"]);
    assertHostCoverage(temporary);

    writeManifest("packages/new-host-package");
    assert.deepEqual(hostPackageDirectories(temporary), [
      "apps/hostd",
      "packages/existing",
      "packages/new-host-package",
    ]);
    assert.throws(() => assertHostCoverage(temporary), /packages\/new-host-package must join/);
    writeManifest("packages/new-host-package", { "test:coverage": "vitest run --coverage" });
    assertHostCoverage(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("N-1 compatibility runs the release, the latest canary and the base, from full history", () => {
  const job = jobs["n1-compat"];
  assert.deepEqual(job.strategy.matrix.lane, ["release", "latest-canary", "base"]);
  const prepare = job.steps.find((step) => step.id === "prepare").run;
  assert.match(prepare, /"\$LANE" == "release" \]\]; then\s+args=\(--release\)/);
  assert.match(prepare, /"\$LANE" == "latest-canary" \]\]; then\s+args=\(--canary\)/);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.steps.find((step) => step.name === "Checkout").with["fetch-depth"], 0);
  const run = job.steps.at(-1).run;
  assert.ok(run.includes("src/db/n1-compatibility.test.ts"));
  assert.equal(job.steps.at(-1).env.VOLLI_N1_MANIFEST, "${{ steps.prepare.outputs.manifest }}");
});
