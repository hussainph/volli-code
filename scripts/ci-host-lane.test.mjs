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
const extended = parse(readFileSync(join(root, ".github/workflows/ci-extended.yml"), "utf8"));
const n1All = '["release","latest-canary","base","v0.2.1","v0.2.2-canary.1"]';
const gate = jobs.gate.steps.find((step) => step.id === "require-lanes");
const filter = jobs.changes.steps.find((step) => step.id === "filter");
const required = [
  "changes",
  "check",
  "test-desktop",
  "coverage-desktop",
  "test-packages",
  "convex",
  "n1-compat",
];
const conditional = ["host-container", "smoke-boot"];

function results(desktop = "true", host = "true", n1 = '["base"]', event = "pull_request") {
  return {
    EVENT: event,
    DESKTOP: desktop,
    HOST_CONTAINER_REQUIRED: host,
    N1_LANES: n1,
    SCOPE: "success",
    CHECK: "success",
    TEST_DESKTOP: "success",
    COVERAGE_DESKTOP: "success",
    TEST_PACKAGES: "success",
    CONVEX: "success",
    N1_COMPAT: "success",
    HOST_CONTAINER: host === "true" ? "success" : "skipped",
    SMOKE_BOOT: desktop === "true" ? "success" : "skipped",
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
  assert.equal(jobs["n1-compat"].needs, "changes");
  assert.equal(jobs["n1-compat"].if, undefined);
});

test("a PR runs exactly one macOS job; the extended lanes left ci.yml", () => {
  const macos = Object.entries(jobs)
    .filter(([, job]) => String(job["runs-on"]).startsWith("macos"))
    .map(([name]) => name);
  assert.deepEqual(macos, ["smoke-boot"]);
  assert.equal(jobs["smoke-rest"], undefined);
  assert.equal(jobs["smoke-cloud"], undefined);
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
});

test("gate accepts only success or the precise conditional skip", () => {
  const shapes = [];
  for (const desktop of ["true", "false"]) {
    for (const host of ["true", "false"]) {
      for (const n1 of ['["base"]', n1All]) shapes.push([desktop, host, n1, "pull_request"]);
    }
  }
  // Off a PR, Scope runs everything, so that is the only accepted shape.
  for (const event of ["push", "workflow_dispatch", "schedule"])
    shapes.push(["true", "true", n1All, event]);
  for (const [desktop, host, n1, event] of shapes) {
    const env = results(desktop, host, n1, event);
    const green = runGate(env);
    assert.equal(green.status, 0, green.stdout + green.stderr);
    for (const job of jobs.gate.needs) {
      const variable = resultVariable(job);
      for (const state of ["success", "failure", "cancelled", "skipped", "", "unknown"]) {
        const outcome = runGate({ ...env, [variable]: state });
        assert.equal(
          outcome.status === 0,
          state === env[variable],
          `${event}/${desktop}/${host}/${n1}: ${job}=${state}\n${outcome.stdout}${outcome.stderr}`,
        );
      }
    }
  }
});

test("empty or malformed Scope outputs cannot authorize skips", () => {
  for (const variable of ["DESKTOP", "HOST_CONTAINER_REQUIRED"]) {
    for (const flag of ["", "unknown", "FALSE", "0"]) {
      assert.notEqual(runGate({ ...results("false", "false"), [variable]: flag }).status, 0);
    }
  }
  for (const lanes of ["", "[]", '["release"]', "base", "unknown"]) {
    assert.notEqual(runGate({ ...results("false", "false"), N1_LANES: lanes }).status, 0, lanes);
  }
  // A non-PR run that was scoped down (any flag or lane missing) is refused,
  // even when every lane result matches the narrowed scope.
  for (const event of ["push", "workflow_dispatch", "schedule"]) {
    for (const [desktop, host, n1] of [
      ["false", "true", n1All],
      ["true", "false", n1All],
      ["true", "true", '["base"]'],
    ]) {
      const outcome = runGate(results(desktop, host, n1, event));
      assert.notEqual(outcome.status, 0, `${event}/${desktop}/${host}/${n1}`);
    }
  }
});

test("actual path classifier selects lanes and fails safe", () => {
  // Stub just git diff; all classification and output code comes from ci.yml.
  // Renames must list both paths, so a move out of the app is an app change.
  assert.match(filter.run, /git diff --name-only --no-renames "\$BASE_SHA" "\$HEAD_SHA"/);
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const temporary = mkdtempSync(join(root, ".tmp/ci-host-test-"));
  // A long diff whose one app-affecting file is last: the classifier must read
  // all of it, not stop (or SIGPIPE) at the first inert match.
  const docs = Array.from({ length: 6000 }, (_, i) => `docs/generated/page-${i}.md`);
  const longDiff = [...docs, "apps/desktop/src/main/index.ts"].join("\n");
  // ...and one whose host/N-1 match comes FIRST, so `grep -q` would exit while
  // a producer was still writing past the pipe buffer (the SIGPIPE skip).
  const longDiffMatchFirst = ["packages/host-core/src/db/migrations.ts", ...docs].join("\n");
  assert.ok(longDiffMatchFirst.length > 128 * 1024);
  try {
    // [changed, desktop (core e2e), host container, N-1 lanes on a PR]
    const cases = [
      ["docs/guide.md", "false", "false", "base"],
      ["apps/website/src/index.ts", "false", "false", "base"],
      ["apps/desktop/src/main/index.ts", "true", "false", "base"],
      ["packages/host-core/src/index.ts", "true", "true", "base"],
      ["packages/host-protocol/src/index.ts", "true", "true", "base"],
      ["packages/host-install/src/artifact.ts", "true", "true", "base"],
      ["packages/host-future/src/index.ts", "true", "true", "base"],
      ["packages/session-rpc/src/index.ts", "true", "true", "base"],
      ["apps/hostd/src/index.ts", "true", "true", "base"],
      ["apps/desktop/src/main/remote-hosts.ts", "true", "false", "base"],
      ["apps/desktop/e2e/lib/smoke-kit.mjs", "true", "false", "base"],
      ["apps/desktop/package.json", "true", "false", "base"],
      ["packages/session-engine/src/index.ts", "true", "true", "base"],
      // convex/ and packages/shared sources: unit suites own them on a PR.
      ["convex/functions/accounts.ts", "false", "false", "base"],
      ["convex/functions/accounts.ts\ndocs/DESIGN.md", "false", "false", "base"],
      ["packages/shared/src/index.ts", "false", "true", "base"],
      ["packages/shared/src/index.ts\ndocs/DESIGN.md", "false", "true", "base"],
      ["packages/shared/src/index.ts\nconvex/functions/accounts.ts", "false", "true", "base"],
      ["packages/shared/src/index.ts\napps/desktop/src/main/index.ts", "true", "true", "base"],
      // ...but never a manifest: a dependency change always runs core e2e.
      ["packages/shared/package.json", "true", "true", "base"],
      ["packages/shared/tsconfig.json", "true", "true", "base"],
      ["convex/package.json", "true", "false", "base"],
      ["apps/gateway/src/gateway.ts", "false", "false", "base"],
      ["apps/gateway/package.json", "true", "false", "base"],
      ["docs/DESIGN.md\npackages/session-rpc/src/index.ts", "true", "true", "base"],
      [longDiff, "true", "false", "base"],
      [longDiffMatchFirst, "true", "true", "all"],
      // Migration and N-1 harness inputs run every N-1 lane on the PR.
      ["packages/host-core/src/db/migrations.ts", "true", "true", "all"],
      ["packages/host-core/src/db/migrations.lock.json", "true", "true", "all"],
      ["packages/host-core/scripts/n1/prepare.mjs", "true", "true", "all"],
      ["packages/host-core/src/backup/bundle.ts", "true", "true", "all"],
      ["packages/host-core/src/session-control/sqlite-ledger.ts", "true", "true", "all"],
      ["packages/host-core/src/session-runtime/transcript-artifacts.ts", "true", "true", "all"],
      ["packages/host-core/src/blob-store.ts", "true", "true", "all"],
      ["packages/host-core/src/ticket-commands.ts", "true", "true", "all"],
      // web/n1-compatibility.test.ts is a unit test in Test (packages).
      ["packages/host-core/src/web/test-support/n1-child.ts", "true", "true", "base"],
      ["packages/host-core/src/web/server.ts", "true", "true", "base"],
      [".devcontainer/host/Dockerfile", "true", "true", "base"],
      [".devcontainer/host/devcontainer.json", "true", "true", "base"],
      [".github/workflows/ci.yml", "true", "true", "all"],
      [".github/actions/setup-toolchain/action.yml", "true", "true", "all"],
      [".github/workflows/ci-extended.yml", "true", "false", "base"],
      ["scripts/ci-host-lane.test.mjs", "true", "true", "all"],
      ["scripts/check-host-electron-imports.mjs", "true", "true", "base"],
      [".nvmrc", "true", "true", "base"],
      ["package.json", "true", "true", "base"],
      ["pnpm-lock.yaml", "true", "true", "base"],
      ["pnpm-workspace.yaml", "true", "true", "base"],
      ["", "true", "true", "all"],
    ];
    for (const event of ["pull_request", "push", "workflow_dispatch", "schedule"]) {
      for (const [changed, desktop, host, n1] of cases) {
        const output = join(temporary, "output");
        // Through a file, not the environment: Linux caps one env string at
        // 128 KB (MAX_ARG_STRLEN), and the long diffs are past that.
        const diff = join(temporary, "diff");
        writeFileSync(diff, `${changed}\n`);
        const run = spawnSync("bash", ["-c", 'git() { cat "$CHANGED_FILE"; }\n' + filter.run], {
          cwd: root,
          env: {
            ...process.env,
            EVENT: event,
            CHANGED_FILE: diff,
            BASE_SHA: "base",
            HEAD_SHA: "head",
            GITHUB_OUTPUT: output,
          },
          encoding: "utf8",
        });
        assert.equal(run.status, 0, `${run.error ?? ""}${run.stdout}${run.stderr}`);
        const pr = event === "pull_request";
        const lanes = !pr || n1 === "all" ? n1All : '["base"]';
        assert.equal(
          readFileSync(output, "utf8"),
          `desktop=${pr ? desktop : "true"}\nhost-container=${pr ? host : "true"}\nn1-lanes=${lanes}\n`,
          `${event}: ${changed.slice(0, 200)}`,
        );
        rmSync(output);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("extended lanes run after merge, nightly and on demand — never as a PR gate", () => {
  assert.deepEqual(workflow.on.schedule, [{ cron: "30 7 * * *" }]);
  assert.deepEqual(extended.on.push, { branches: ["main"] });
  assert.equal(extended.on.schedule.length, 1);
  assert.ok("workflow_dispatch" in extended.on);
  // PRs run it only to prove an edit to the lane's own definition.
  assert.deepEqual(extended.on.pull_request, {
    paths: [
      ".github/workflows/ci-extended.yml",
      "apps/desktop/scripts/run-smokes.mjs",
      "apps/desktop/scripts/smoke-quiet-check.mjs",
      // The older-app live lane's harness (VC-1019).
      "scripts/convex-compat/**",
    ],
  });
  // A main run is never cancelled by the next merge; a PR's newer push may.
  assert.equal(
    extended.concurrency["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
  );
  // The summary waits on every lane and accepts only success.
  const summary = extended.jobs.summary;
  assert.equal(summary.if, "always()");
  assert.deepEqual(
    summary.needs.toSorted(),
    Object.keys(extended.jobs)
      .filter((job) => job !== "summary")
      .toSorted(),
  );
  const report = summary.steps.find((step) => step.id === "report");
  for (const job of summary.needs) {
    const variable = Object.entries(report.env).find(
      ([, value]) => value === `\${{ needs.${job}.result }}`,
    )?.[0];
    assert.ok(variable, `${job} is not reported`);
    const green = Object.fromEntries(Object.keys(report.env).map((name) => [name, "success"]));
    for (const state of ["success", "failure", "cancelled", "skipped", ""]) {
      const outcome = spawnSync("bash", ["-c", report.run], {
        cwd: root,
        env: { ...process.env, ...green, [variable]: state, GITHUB_STEP_SUMMARY: "" },
        encoding: "utf8",
      });
      assert.equal(outcome.status === 0, state === "success", `${job}=${state}`);
    }
  }
});

test("cloud acceptance is macOS-only and separate from flag-off core e2e", () => {
  const job = extended.jobs["smoke-cloud"];
  assert.equal(job["runs-on"], "macos-15");
  // One macOS slot at a time, and a red rest tier still runs it.
  assert.equal(job.needs, "smoke-rest");
  assert.equal(job.if, "${{ !cancelled() }}");
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
  assert.equal(extended.env?.VOLLI_EXPERIMENTAL, undefined);
  for (const lane of [jobs["smoke-boot"], extended.jobs["smoke-rest"]]) {
    assert.equal(lane.env?.VOLLI_EXPERIMENTAL, undefined);
    for (const step of lane.steps) {
      assert.equal(step.env?.VOLLI_EXPERIMENTAL, undefined);
      assert.doesNotMatch(step.run ?? "", /VOLLI_EXPERIMENTAL/);
    }
  }
});

test("cloud hostd is pinned and packaged before the Electron desktop install", () => {
  const steps = extended.jobs["smoke-cloud"].steps;
  const setup = steps.find((step) => step.name === "Setup Vite+");
  assert.equal(setup.uses, "./.github/actions/setup-toolchain");
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
  const guard = steps.find((step) => step.name === "Check hostd target and desktop version").run;
  assert.match(guard, /process\.versions\.node.*cat \.nvmrc/);
  assert.match(guard, /process\.arch.*arm64/);
  assert.match(guard, /package\.json.*version.*apps\/desktop\/package\.json.*version/);
});

test("package lane rebuilds node-pty with pinned pnpm for the host Node", () => {
  const rebuild = jobs["test-packages"].steps.find(
    (step) => step.name === "Build node-pty for Node",
  );
  assert.equal(rebuild["working-directory"], "packages/host-core");
  assert.match(rebuild.run, /npm_config_runtime=node/);
  assert.match(rebuild.run, /npm_config_target="\$\(node -p 'process\.versions\.node'\)"/);
  assert.match(rebuild.run, /pnpm rebuild node-pty/);
  assert.doesNotMatch(rebuild.run, /vp rebuild/);
  assert.match(rebuild.run, /node scripts\/probe-node-pty\.mjs/);
});

test("cloud artifact export uses the desktop version and requires archive plus checksum", () => {
  const packaging = extended.jobs["smoke-cloud"].steps.find((step) =>
    step.name.startsWith("Package hostd"),
  );
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
    .filter(
      (directory) =>
        directory.startsWith("packages/") ||
        directory === "apps/hostd" ||
        directory === "apps/runner",
    )
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
    jobs["test-packages"].steps.find((step) => step.name === "Setup Vite+").uses,
    "./.github/actions/setup-toolchain",
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

test("N-1 compatibility runs rolling and fixed downgrade promises from full history", () => {
  const job = jobs["n1-compat"];
  // The lanes come from Scope: every one off-PR, `base` alone on most PRs.
  assert.equal(job.strategy.matrix.lane, "${{ fromJSON(needs.changes.outputs.n1-lanes) }}");
  assert.deepEqual(JSON.parse(n1All), [
    "release",
    "latest-canary",
    "base",
    "v0.2.1",
    "v0.2.2-canary.1",
  ]);
  assert.ok(filter.run.includes(`n1_all='${n1All}'`));
  const prepare = job.steps.find((step) => step.id === "prepare").run;
  assert.match(prepare, /"\$LANE" == "release" \]\]; then\s+args=\(--release\)/);
  assert.match(prepare, /"\$LANE" == "latest-canary" \]\]; then\s+args=\(--canary\)/);
  assert.match(
    prepare,
    /"\$LANE" == "v0\.2\.1" \|\| "\$LANE" == "v0\.2\.2-canary\.1" \]\]; then\s+args=\(--ref "\$LANE"\)/,
  );
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.steps.find((step) => step.name === "Checkout").with["fetch-depth"], 0);
  const run = job.steps.at(-1).run;
  assert.ok(run.includes("src/db/n1-compatibility.test.ts"));
  assert.equal(job.steps.at(-1).env.VOLLI_N1_MANIFEST, "${{ steps.prepare.outputs.manifest }}");
});

test("the older-app live lane runs the newest shipped build against THIS commit's backend", () => {
  const job = extended.jobs["older-app-live"];
  // Linux and a short leash: these suites are plain Node, and a lane that
  // cannot finish inside fifteen minutes is a broken lane, not a slow one.
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 15);
  assert.equal(job.if, "${{ !cancelled() }}");
  assert.equal(job.needs, undefined, "runs beside the smoke chain, not behind it");

  // The checkout is the commit under test, with the tags the build is chosen
  // from — never the tag itself: an older tree checked out over this one would
  // make the backend older too, and prove nothing.
  const checkout = job.steps.find((step) => step.name === "Checkout").with;
  assert.equal(checkout["fetch-depth"], 0);
  assert.equal(checkout.ref, undefined);
  assert.equal(checkout["persist-credentials"], false);

  // The build comes out of the tag; the backend and the deployed functions out
  // of this checkout.
  const prepare = job.steps.find((step) => step.id === "prepare");
  assert.equal(prepare.name, "Materialize the newest shipped build");
  assert.ok(prepare.run.includes("scripts/convex-compat/prepare-older-app.mjs --latest"));
  assert.match(prepare.run, /tail -n 1 .*older-app-prepare\.log/);
  const live = job.steps.find((step) => step.name.startsWith("Run that build's"));
  assert.equal(live["working-directory"], "convex");
  assert.ok(live.run.includes("fixture/with-backend.ts --deploy"));
  assert.ok(live.run.includes("scripts/convex-compat/older-app-live.mjs"));
  assert.ok(live.run.includes('--manifest "${{ steps.prepare.outputs.manifest }}"'));
  // Required, so a missing fixture fails these suites instead of skipping them.
  assert.equal(live.env.VOLLI_CLOUD_BOARD_LIVE_REQUIRED, "1");
  assert.equal(live.env.VOLLI_CLOUD_SESSION_LIVE_REQUIRED, "1");

  // The harness's own unit tests run before it, and its evidence is kept even
  // when the run is red.
  assert.equal(
    job.steps.find((step) => step.name === "Harness unit tests").run,
    "node --test scripts/convex-compat/*.test.mjs",
  );
  const upload = job.steps.at(-1);
  assert.equal(upload.if, "always()");
  assert.equal(upload.with["retention-days"], 30);
  assert.ok(upload.with.path.includes("live-report.json"));

  // And the one check that sums the lanes gates on it like every other.
  assert.ok(extended.jobs.summary.needs.includes("older-app-live"));
  assert.equal(
    extended.jobs.summary.steps.find((step) => step.id === "report").env.OLDER_APP_LIVE,
    "${{ needs.older-app-live.result }}",
  );
});

/** A BYO lane's "is that ticket's work on this tree" step, and the steps it gates. */
const presence = (job) => job.steps.find((step) => step.id === "present");
const gated = (job) =>
  job.steps.filter((step) => step.if === "steps.present.outputs.present == 'true'");
const before = (job, step) => job.steps.indexOf(presence(job)) < job.steps.indexOf(step);

test("the BYO lanes gate on merged work: pending is a notice, present-but-broken is red", () => {
  // Built per architecture on native runners, as release.yml builds it, and
  // never with a baked deployment: a test artifact links only via --server.
  const artifact = extended.jobs["byo-runner-artifact"];
  assert.equal(artifact.if, "${{ !cancelled() }}");
  assert.deepEqual(
    artifact.strategy.matrix.include.map((entry) => [entry.arch, entry.runner]),
    [
      ["x64", "ubuntu-24.04"],
      ["arm64", "ubuntu-24.04-arm"],
    ],
  );
  const build = artifact.steps.find((step) => step.name === "Build, package and boot the runner");
  assert.ok(gated(artifact).includes(build) && before(artifact, build));
  assert.ok(
    build.run.includes("ci-build-artifact.sh") && build.run.includes("ci-boot-artifact.sh"),
  );
  assert.doesNotMatch(JSON.stringify(artifact), /VOLLI_BUILD_CONVEX/u);
  const upload = artifact.steps.find((step) => step.name === "Upload the runner artifact");
  assert.equal(upload.with["if-no-files-found"], "error");

  // The matrix takes both artifacts; bootstrap-only only while install is absent.
  const matrix = extended.jobs["byo-install-matrix"];
  assert.equal(matrix.needs, "byo-runner-artifact");
  assert.equal(matrix.if, "${{ !cancelled() }}");
  assert.match(presence(matrix).run, /ci-install-matrix\.sh/u);
  assert.match(presence(matrix).run, /ci-build-artifact\.sh/u);
  assert.match(presence(matrix).run, /mode=--bootstrap-only/u);
  assert.match(presence(matrix).run, /-d apps\/runner\/src\/install/u);
  const run = matrix.steps.find((step) => step.name === "Run the install.sh matrix");
  assert.ok(gated(matrix).includes(run) && before(matrix, run));
  assert.equal(run.env.MODE, "${{ steps.present.outputs.mode }}");

  // The acceptance itself: after the artifact, never hiding a missing one.
  const byo = extended.jobs["byo-runner"];
  assert.equal(byo.needs, "byo-runner-artifact");
  assert.equal(byo.if, "${{ !cancelled() }}");
  assert.ok(byo.steps.every((step) => step["continue-on-error"] === undefined));
  const download = byo.steps.find((step) => step.name === "Download both runner artifacts");
  assert.ok(gated(byo).includes(download) && before(byo, download));
  const acceptance = byo.steps.find((step) => step.name === "Run the BYO runner acceptance");
  assert.equal(acceptance["working-directory"], "convex");
  assert.ok(acceptance.run.includes("fixture/with-backend.ts --deploy"));
  assert.ok(acceptance.run.includes("../apps/runner/e2e/acceptance.mjs"));
  assert.equal(
    byo.steps.find((step) => step.name.startsWith("Harness self-tests")).run,
    "node --test scripts/fake-github/*.test.mjs apps/runner/e2e/lib/*.test.mjs",
  );
  assert.equal(byo.steps.at(-1).if, "always()");

  // BYO-6's sheet rides the cloud-wake build; only its scrubbed report is kept.
  const wake = extended.jobs["smoke-cloud-wake"];
  const setup = wake.steps.find((step) => step.name.startsWith("Run the runner-setup acceptance"));
  assert.deepEqual(Object.keys(setup.env), ["VOLLI_SMOKE_REPORT_DIR"]);
  assert.match(setup.run, /if \[\[ ! -f "\$smoke" \]\]; then[\s\S]*exit 0/u);
  assert.ok(wake.steps.at(-1).with.path.includes(setup.env.VOLLI_SMOKE_REPORT_DIR));

  for (const job of ["byo-runner-artifact", "byo-install-matrix", "byo-runner"]) {
    assert.ok(extended.jobs.summary.needs.includes(job), job);
  }
});
