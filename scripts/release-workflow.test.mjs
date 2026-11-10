import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse } from "yaml";

// ci.yml invokes this release-contract entrypoint; keep the installer/manifest checks here
// without adding a runner to the desktop or Vitest test surfaces.
import "./runner-install.test.mjs";
import "./runner-release-manifest.test.mjs";
import "./runner-native-build.test.mjs";
import "./release-publication.test.mjs";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
);

// Evaluate only the small condition vocabulary used by this workflow. Unknown
// atoms fail syntax checking rather than being silently treated as truthy.
function enabled(job, { event, dryRun, results = {}, outputs = {}, cancelled = false }) {
  const condition = workflow.jobs[job].if
    .replaceAll("always()", "true")
    .replaceAll("cancelled()", String(cancelled))
    .replaceAll("github.event_name", JSON.stringify(event))
    .replaceAll("inputs.dry_run", String(dryRun))
    .replace(/needs\.([\w-]+)\.outputs\.([\w-]+)/g, (_, name, key) =>
      JSON.stringify(outputs[name]?.[key] ?? ""),
    )
    .replace(/needs\.([\w-]+)\.result/g, (_, name) => JSON.stringify(results[name] ?? "skipped"));
  assert.match(condition, /^[\w\s'"=!&|().-]+$/);
  return Function(`"use strict"; return (${condition});`)();
}

test("dispatch defaults to dry run and can never enter tagging or desktop signing/publishing", () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  const ctx = {
    event: "workflow_dispatch",
    dryRun: true,
    results: { "hostd-assets": "success", "runner-assets": "success" },
  };
  assert.equal(enabled("prepare", ctx), false);
  assert.equal(enabled("release", ctx), false);
  assert.equal(enabled("hostd-ref", ctx), true);
  assert.equal(enabled("dry-run-desktop", ctx), true);
  const sign = workflow.jobs["hostd-assets"].steps.find((step) => step.id === "provenance");
  assert.equal(sign.if, "github.event_name != 'workflow_dispatch' || !inputs.dry_run");
});

test("tag and manually dispatched releases require both architecture builds and verified pin", () => {
  for (const event of ["push", "workflow_dispatch"]) {
    const ctx = {
      event,
      dryRun: false,
      results: {
        prepare: event === "push" ? "skipped" : "success",
        "hostd-assets": "success",
        "runner-assets": "success",
      },
    };
    assert.equal(enabled("hostd-ref", ctx), true);
    assert.equal(enabled("release", ctx), true);
    assert.equal(enabled("dry-run-desktop", ctx), false);
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.equal(
        enabled("release", { ...ctx, results: { ...ctx.results, "hostd-assets": result } }),
        false,
      );
    }
    assert.equal(enabled("release", { ...ctx, cancelled: true }), false);
  }
  assert.deepEqual(workflow.jobs.release.needs, ["prepare", "hostd-assets", "runner-assets"]);
  assert.deepEqual(workflow.jobs.hostd.strategy.matrix.include, [
    { arch: "x64", runner: "ubuntu-24.04" },
    { arch: "arm64", runner: "ubuntu-24.04-arm" },
  ]);
  assert.deepEqual(workflow.jobs["hostd-darwin"].strategy.matrix.include, [
    { arch: "arm64", runner: "macos-15" },
    { arch: "x64", runner: "macos-15-intel" },
  ]);
});

test("hostd-darwin runs exactly when the Linux build does", () => {
  const darwin = workflow.jobs["hostd-darwin"];
  const linux = workflow.jobs.hostd;
  assert.deepEqual(darwin.needs, linux.needs);
  assert.equal(darwin.if, linux.if);
  assert.equal(darwin.strategy["fail-fast"], false);
  assert.equal(darwin["runs-on"], "${{ matrix.runner }}");
  for (const result of ["success", "failure", "skipped", "cancelled"]) {
    for (const event of ["push", "workflow_dispatch"]) {
      const ctx = { event, dryRun: true, results: { "hostd-ref": result } };
      assert.equal(enabled("hostd-darwin", ctx), enabled("hostd", ctx));
    }
  }
});

test("hostd-darwin pins Node to .nvmrc, packages natively, probes and uploads", () => {
  const steps = workflow.jobs["hostd-darwin"].steps;
  const index = (name) => {
    const at = steps.findIndex((step) => step.name === name);
    assert.ok(at >= 0, `missing step: ${name}`);
    return at;
  };
  const checkout = steps[0];
  assert.equal(checkout.with.ref, "${{ needs.hostd-ref.outputs.ref }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const setup = steps[index("Setup Vite+")];
  assert.equal(setup.uses, "./.github/actions/setup-toolchain");
  assert.deepEqual(setup.with, { "run-install": false });
  // Local actions are checked separately; third-party actions stay SHA-pinned.
  for (const action of steps.filter((step) => step.uses && !step.uses.startsWith("./"))) {
    assert.match(action.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  }
  const arch = steps[index("Check runner architecture")];
  assert.equal(arch.env.ARCH, "${{ matrix.arch }}");
  assert.match(arch.run, /test "\$\(node -p process.arch\)" = "\$ARCH"/);
  assert.match(arch.run, /test "\$\(node -p process.platform\)" = darwin/);
  assert.match(arch.run, /process.versions.node.*\.nvmrc/);
  // The same host-only install and integration test the Linux image runs.
  const linuxBuild = readFileSync(
    new URL("../apps/hostd/scripts/ci-build-artifact.sh", import.meta.url),
    "utf8",
  );
  const install = steps[index("Host-only install")].run;
  assert.equal(
    install,
    "pnpm --filter volli-code --filter './packages/*' --filter './apps/hostd' install --frozen-lockfile",
  );
  assert.ok(linuxBuild.replace(/ \\\n\s+/g, " ").includes(install));
  const integration = steps[index("Hostd integration test")].run;
  assert.match(integration, /src\/session-runtime\.integration\.test\.ts/);
  assert.match(linuxBuild, /src\/session-runtime\.integration\.test\.ts/);
  const pack = steps[index("Package and probe hostd")].run;
  assert.match(pack, /node apps\/hostd\/scripts\/package\.mjs --out "\$RUNNER_TEMP\/hostd"/);
  assert.match(pack, /bash apps\/hostd\/scripts\/ci-boot-artifact\.sh "\$RUNNER_TEMP\/hostd"/);
  assert.ok(index("Setup Vite+") < index("Check runner architecture"));
  assert.ok(index("Check runner architecture") < index("Host-only install"));
  assert.ok(index("Host-only install") < index("Hostd integration test"));
  assert.ok(index("Hostd integration test") < index("Package and probe hostd"));
  const upload = steps[index("Upload architecture assets")];
  assert.ok(index("Package and probe hostd") < index("Upload architecture assets"));
  assert.equal(upload.with.name, "hostd-darwin-${{ matrix.arch }}");
  assert.equal(
    upload.with.path,
    "${{ runner.temp }}/hostd/*.tar.gz\n${{ runner.temp }}/hostd/*.tar.gz.sha256\n",
  );
  assert.equal(upload.with["if-no-files-found"], "error");
  const guardStep = steps[index("Guard release version")];
  const linuxGuard = workflow.jobs.hostd.steps.find(
    (step) => step.name === "Guard release version",
  );
  assert.deepEqual(guardStep, linuxGuard);
});

test("hostd-assets needs both platforms' builds and downloads exactly their artifacts", () => {
  const assets = workflow.jobs["hostd-assets"];
  assert.deepEqual(assets.needs, ["hostd-ref", "hostd", "hostd-darwin"]);
  const both = { "hostd-ref": "success", hostd: "success", "hostd-darwin": "success" };
  for (const event of ["push", "workflow_dispatch"]) {
    for (const dryRun of [true, false]) {
      assert.equal(enabled("hostd-assets", { event, dryRun, results: both }), true);
      for (const job of ["hostd", "hostd-darwin"]) {
        for (const result of ["failure", "cancelled", "skipped"]) {
          const results = { ...both, [job]: result };
          assert.equal(enabled("hostd-assets", { event, dryRun, results }), false);
        }
      }
      assert.equal(
        enabled("hostd-assets", { event, dryRun, results: both, cancelled: true }),
        false,
      );
    }
  }
  const downloads = assets.steps.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.deepEqual(
    downloads.map((step) => step.with),
    ["hostd-linux-*", "hostd-darwin-*"].map((pattern) => ({
      pattern,
      "merge-multiple": true,
      path: "${{ runner.temp }}/hostd-assets",
    })),
  );
  const generate = assets.steps.findIndex(
    (step) => step.name === "Generate verified manifest and SHA256SUMS",
  );
  assert.ok(downloads.every((step) => assets.steps.indexOf(step) < generate));
  const sign = assets.steps.find((step) => step.id === "provenance");
  assert.match(sign.with["subject-path"], /hostd-assets\/\*\.tar\.gz$/m);
});

test("failed preparation blocks hostd/release; dry builds have read-only contents", () => {
  const ctx = {
    event: "workflow_dispatch",
    dryRun: false,
    results: { prepare: "failure", "hostd-assets": "success", "runner-assets": "success" },
  };
  assert.equal(enabled("hostd-ref", ctx), false);
  assert.equal(enabled("release", ctx), false);
  assert.equal(enabled("hostd", { ...ctx, results: { "hostd-ref": "failure" } }), false);
  assert.equal(enabled("hostd-darwin", { ...ctx, results: { "hostd-ref": "failure" } }), false);
  for (const job of ["hostd-ref", "hostd", "hostd-darwin", "hostd-assets", "dry-run-desktop"]) {
    assert.equal(workflow.jobs[job].permissions.contents, "read");
    const commands = workflow.jobs[job].steps.map((step) => step.run ?? "").join("\n");
    assert.doesNotMatch(commands, /\bsecurity\b|\bgit (?:tag|push)\b|gh release (?:create|upload)/);
  }
});

test("desktop release and dry run compile only the public pinned account target", () => {
  for (const job of ["release", "dry-run-desktop"]) {
    const build = workflow.jobs[job].steps.find((step) => step.env?.VOLLI_HOSTD_MANIFEST);
    for (const name of [
      "VOLLI_BUILD_WORKOS_CLIENT_ID",
      "VOLLI_BUILD_CONVEX_URL",
      "VOLLI_BUILD_CONVEX_SITE_URL",
      "VOLLI_BUILD_STORAGE_ORIGIN",
    ]) {
      assert.equal(build.env[name], `\u0024{{ vars.${name} }}`);
    }
    assert.doesNotMatch(
      Object.keys(build.env).join(" "),
      /DEPLOY_KEY|SIGNING_KEY|S3_SECRET|ROOT_KEYS/,
    );
  }
});

test("desktop gets the same generated pin; release cleanup keeps hostd assets and signature", () => {
  for (const job of ["release", "dry-run-desktop"]) {
    const steps = workflow.jobs[job].steps;
    const build = steps.find((step) => step.env?.VOLLI_HOSTD_MANIFEST);
    assert.equal(
      build.env.VOLLI_HOSTD_MANIFEST,
      "${{ runner.temp }}/hostd-assets/hostd-release-manifest.json",
    );
    assert.match(
      build.run,
      /cmp "\$VOLLI_HOSTD_MANIFEST" apps\/desktop\/dist-electron\/hostd-release-manifest.json/,
    );
    const download = steps.findIndex((step) => step.with?.name === "hostd-release-assets");
    assert.ok(download >= 0 && download < steps.indexOf(build));
  }
  const publish = workflow.jobs.release.steps.find(
    (step) => step.name === "Publish artifacts to the release",
  ).run;
  assert.match(publish, /files\+=\("\$\{hostdFiles\[@\]\}"\)/);
  assert.match(publish, /hostd-provenance.sigstore.json/);
  const steps = workflow.jobs.release.steps;
  const download = steps.findIndex(
    (step) => step.name === "Download verified hostd release assets",
  );
  const verify = steps.findIndex((step) => step.name === "Verify hostd release asset set");
  const precreate = steps.findIndex((step) => step.name === "Pre-create GitHub release");
  assert.ok(download >= 0 && download < verify && verify < precreate);
  assert.match(steps[verify].run, /shasum -a 256 -c SHA256SUMS/);
  // 4 tarballs + 4 sidecars + SHA256SUMS + manifest + provenance.
  assert.match(steps[verify].run, /\[ "\$\{#hostdFiles\[@\]\}" -eq 11 \]/);
  assert.match(steps[verify].run, /hostd-provenance.sigstore.json/);
  assert.match(steps[verify].run, /hostd release asset missing or empty/);
});

test("peer capture is advisory, resolves the release commit, and exercises dry runs", () => {
  const capture = workflow.jobs["canary-peer"];
  const attach = workflow.jobs["canary-peer-asset"];
  assert.equal(capture["continue-on-error"], true);
  assert.equal(attach["continue-on-error"], true);
  assert.deepEqual(capture.needs, ["prepare", "hostd-ref"]);
  assert.deepEqual(attach.needs, ["canary-peer", "release"]);
  // No critical-path job may depend on either advisory job.
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === "canary-peer-asset") continue;
    assert.ok(!(job.needs ?? []).includes("canary-peer"), name);
    assert.ok(!(job.needs ?? []).includes("canary-peer-asset"), name);
  }
  assert.equal(capture.permissions.contents, "read");
  assert.equal(capture.steps[0].with.ref, "${{ needs.hostd-ref.outputs.ref }}");
  assert.equal(capture.steps[0].with["persist-credentials"], false);
  const command = capture.steps.find((step) => step.id === "capture");
  assert.match(
    command.run,
    /node scripts\/record-canary-peer\.mjs --tag "\$PEER_TAG" --commit "\$\(git rev-parse HEAD\)" --out/,
  );
  assert.equal(command.env.VOLLI_CONCURRENCY_HINT, "2");
  const upload = capture.steps.find((step) => step.id === "upload");
  const download = attach.steps.find((step) => step.with?.name);
  assert.equal(upload.with.name, "canary-peer-${{ github.run_attempt }}");
  assert.equal(download.with.name, upload.with.name);
  assert.match(capture.outputs.captured, /steps\.upload\.outputs\.artifact-id/);
  const attachment = attach.steps.find(
    (step) => step.name === "Attach without changing the release",
  );
  assert.match(attachment.run, /gh release view/);
  assert.match(attachment.run, /if \[ -n "\$existing" \]; then[\s\S]*exit 0/);
  assert.doesNotMatch(attachment.run, /^\s*gh release upload.*--clobber/m);
  const scope = capture.steps.find((step) => step.id === "scope");
  assert.match(scope.run, /dry-run-\$\(git rev-parse HEAD\)/);
  assert.match(scope.run, /\[\[ "\$RELEASE_TAG" == v\*-\* \]\]/);
  const ctx = {
    event: "workflow_dispatch",
    dryRun: true,
    results: { "hostd-ref": "success", release: "success" },
    outputs: { "canary-peer": { captured: "true" } },
  };
  assert.equal(enabled("canary-peer", ctx), true);
  // Even with fabricated successful release/capture outputs, dry runs cannot publish.
  assert.equal(enabled("canary-peer-asset", ctx), false);
  assert.equal(enabled("canary-peer-asset", { ...ctx, dryRun: false }), true);
  assert.equal(enabled("canary-peer-asset", { ...ctx, event: "push" }), true);
  assert.equal(enabled("canary-peer-asset", { ...ctx, event: "push", outputs: {} }), false);
  const publish = workflow.jobs.release.steps.find(
    (step) => step.name === "Publish artifacts to the release",
  );
  assert.match(publish.run, /release-publication\.mjs upload/);
});

test("dry-run provenance resolution never uses a distributable tag", (t) => {
  const root = versionFixture(t);
  const output = join(root, "outputs");
  const scope = workflow.jobs["canary-peer"].steps.find((step) => step.id === "scope").run;
  for (const [dryRun, tag, expected] of [
    ["true", "v0.3.0-canary.1", "dry-run-"],
    ["false", "v0.3.0-canary.1", "tag=v0.3.0-canary.1"],
    ["false", "v0.3.0", ""],
  ]) {
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", scope], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output, DRY_RUN: dryRun, RELEASE_TAG: tag },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const resolved = readFileSync(output, "utf8");
    if (dryRun === "true") assert.match(resolved, /^tag=dry-run-[0-9a-f]{40}\n$/);
    assert.ok(resolved.includes(expected));
    if (!expected) assert.equal(resolved, "");
  }
});

test("packaging exclusion also runs on the existing unsigned CI artifact before core smoke", () => {
  const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const steps = ci.jobs["smoke-boot"].steps;
  const pack = steps.findIndex((step) => step.name === "Verify unsigned desktop packaging");
  const gate = steps.findIndex((step) => step.name === "Gate: no e2e files in packaged app");
  const smoke = steps.findIndex(
    (step) => step.name === "Run core e2e and verify quiet native windows",
  );
  assert.ok(pack >= 0 && pack < gate && gate < smoke);
  const releaseGate = workflow.jobs.release.steps.find(
    (step) => step.name === "Gate: no e2e files in packaged app",
  );
  assert.equal(steps[gate].run, releaseGate.run);
  assert.equal(steps[gate]["working-directory"], undefined);
  assert.equal(steps[gate].if, undefined);
  assert.notEqual(steps[gate]["continue-on-error"], true);
});

test("packaging exclusion is a failing release gate before publishing", () => {
  const steps = workflow.jobs.release.steps;
  const gate = steps.findIndex((step) => step.name === "Gate: no e2e files in packaged app");
  const packageIndex = steps.findIndex((step) => step.name === "Package, sign, notarize, staple");
  const publish = steps.findIndex((step) => step.name === "Publish artifacts to the release");
  assert.ok(packageIndex < gate && gate < publish);
  assert.match(
    steps[gate].run,
    /check-packaged-e2e\.mjs --app "apps\/desktop\/release\/mac-arm64\/Volli Code\.app"/,
  );
  assert.notEqual(steps[gate]["continue-on-error"], true);
});

function versionFixture(t, version = "1.2.3") {
  const scratch = fileURLToPath(new URL("../.tmp/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "release-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "apps/desktop"), { recursive: true });
  for (const file of ["package.json", "apps/desktop/package.json"]) {
    writeFileSync(join(root, file), JSON.stringify({ version }));
  }
  return root;
}

const guard = workflow.jobs.hostd.steps.find((step) => step.name === "Guard release version").run;

test("button bump updates root and desktop together, including a canary", (t) => {
  const root = versionFixture(t);
  const bump = workflow.jobs.prepare.steps
    .find((step) => step.name === "Bump versions, commit, tag, push")
    .run.split("git diff --stat")[0];
  // Execute only the manifest rewrite, never the commit/tag/push portion.
  assert.doesNotMatch(bump, /\bgit\b/);
  const result = spawnSync("bash", ["-c", bump], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, VERSION: "1.2.4-canary.1" },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const file of ["package.json", "apps/desktop/package.json"]) {
    assert.equal(JSON.parse(readFileSync(join(root, file), "utf8")).version, "1.2.4-canary.1");
  }
  const matched = spawnSync("bash", ["-c", guard], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, RELEASE_REF: "v1.2.4-canary.1", DRY_RUN: "false" },
  });
  assert.equal(matched.status, 0, matched.stdout + matched.stderr);
});

test("hostd version guard explains tag mismatch and root/desktop drift", (t) => {
  const root = versionFixture(t);
  const runGuard = () =>
    spawnSync("bash", ["-c", guard], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RELEASE_REF: "v9.9.9", DRY_RUN: "false" },
    });
  const mismatch = runGuard();
  assert.notEqual(mismatch.status, 0);
  assert.match(
    mismatch.stdout,
    /::error::Tag v9.9.9 does not match apps\/desktop\/package.json version 1.2.3/,
  );
  writeFileSync(join(root, "apps/desktop/package.json"), JSON.stringify({ version: "1.2.4" }));
  const drift = runGuard();
  assert.notEqual(drift.status, 0);
  assert.match(
    drift.stdout,
    /::error::root package.json is 1.2.3 but apps\/desktop\/package.json is 1.2.4 — bump both together/,
  );
});

test("manifest version validation is build-only, not pnpm dev or CI test lanes", () => {
  const config = readFileSync(new URL("../apps/desktop/vite.config.ts", import.meta.url), "utf8");
  const devTask = config.slice(config.indexOf("      dev: {"), config.indexOf("      build: {"));
  assert.doesNotMatch(devTask, /copy-hostd-manifest|releaseVersion/);
  const devScript = readFileSync(
    new URL("../apps/desktop/scripts/dev.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(devScript, /copy-hostd-manifest|releaseVersion/);
  const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const testJobs = Object.values(ci.jobs).filter((job) => (job.name ?? "").startsWith("Test ("));
  assert.ok(testJobs.length > 0);
  for (const job of testJobs) {
    const commands = job.steps.map((step) => step.run ?? "").join("\n");
    assert.doesNotMatch(commands, /copy-hostd-manifest|hostd-release-manifest|releaseVersion/);
  }
});

test("release guard requires a green ci.yml AND ci-extended.yml run on the exact commit", () => {
  const greenGuard = workflow.jobs.prepare.steps.find(
    (step) => step.name === "Guard: CI is green on this commit",
  );
  assert.equal(greenGuard.if, "inputs.require_green");
  // Stub git and gh; the conclusions per workflow come from the environment.
  const stub = `git() { echo abc123; }
  gh() {
    case "$2" in
      */workflows/ci.yml/runs?head_sha=abc123*) printf '%b' "$CI" ;;
      */workflows/ci-extended.yml/runs?head_sha=abc123*) printf '%b' "$EXTENDED" ;;
      *) return 99 ;;
    esac
  }\n`;
  const cases = [
    ["success", "success", true],
    ["cancelled\\nsuccess", "success", true],
    ["success", "", false],
    ["", "success", false],
    ["success", "cancelled", false],
    ["failure", "success", false],
    ["success", "failure\\ncancelled", false],
  ];
  for (const [ci, extended, green] of cases) {
    const run = spawnSync("bash", ["-c", stub + greenGuard.run], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "owner/repo", CI: ci, EXTENDED: extended },
    });
    assert.equal(run.status === 0, green, `ci=${ci} extended=${extended}\n${run.stdout}`);
  }
});

test("release guard accepts extended green on an ancestor only across inert changes", () => {
  const greenGuard = workflow.jobs.prepare.steps.find(
    (step) => step.name === "Guard: CI is green on this commit",
  );
  // HEAD (head1) has ci.yml green but no extended run; base0 has extended green.
  const stub = `git() {
    case "$1" in
      rev-parse) echo head1 ;;
      rev-list) printf 'head1\\nmid2\\nbase0\\n' ;;
      diff) printf '%b' "$CHANGED" ;;
    esac
  }
  gh() {
    case "$2" in
      */workflows/ci.yml/runs?head_sha=head1*) echo success ;;
      */workflows/ci-extended.yml/runs?head_sha=base0*) echo success ;;
      */workflows/ci-extended.yml/runs?head_sha=mid2*) echo failure ;;
      *) return 0 ;;
    esac
  }\n`;
  const cases = [
    ["README.md\\napps/docs/src/content/x.md\\napps/website/src/pages/index.astro", true],
    ["docs/development/ci.md", true],
    ["README.md\\napps/desktop/src/main/index.ts", false],
    ["apps/desktop/e2e/volli-drive/supervisor.mjs", false],
    [".github/workflows/ci.yml", false],
    ["packages/shared/src/index.ts", false],
    ["convex/functions/board.ts", false],
    ["apps/docs/package.json\\npnpm-lock.yaml", false],
  ];
  for (const [changed, green] of cases) {
    const run = spawnSync("bash", ["-c", stub + greenGuard.run], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "owner/repo", CHANGED: changed },
    });
    assert.equal(run.status === 0, green, `changed=${changed}\n${run.stdout}${run.stderr}`);
  }
});

test("runner builds both native architectures at the bullseye ABI baseline", () => {
  const runner = workflow.jobs.runner;
  assert.deepEqual(runner.strategy.matrix.include, workflow.jobs.hostd.strategy.matrix.include);
  assert.equal(runner.if, workflow.jobs.hostd.if);
  assert.deepEqual(runner.needs, ["prepare", "hostd-ref"]);
  assert.equal(runner.permissions.contents, "read");
  const commands = runner.steps.map((step) => step.run ?? "").join("\n");
  assert.match(commands, /runner-build\/Dockerfile/);
  assert.match(commands, /ci-build-artifact\.sh/);
  assert.match(commands, /ci-boot-artifact\.sh/);
  assert.match(commands, /EXPECTED_ARCH/);
  assert.match(commands, /-e ALLOW_SKELETON="\$ALLOW_SKELETON"/);
  const build = runner.steps.find((step) => step.name === "Package and boot runner");
  assert.equal(
    build.env.ALLOW_SKELETON,
    "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}",
  );
  for (const name of ["VOLLI_BUILD_CONVEX_URL", "VOLLI_BUILD_CONVEX_SITE_URL"]) {
    assert.equal(build.env[name], `\u0024{{ vars.${name} }}`);
    assert.ok(build.run.includes(`-e ${name}`));
  }
  const dockerfile = readFileSync(
    new URL("../.devcontainer/runner-build/Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(dockerfile, /FROM debian:bullseye-slim/);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /archive\.debian\.org\/debian bullseye main/);
  assert.match(dockerfile, /archive\.debian\.org\/debian-security bullseye-security main/);
  assert.doesNotMatch(dockerfile, /trusted=yes|allow-unauthenticated|AllowInsecureRepositories/);
  assert.match(dockerfile, /amd64\) arch=x64; sha=[0-9a-f]{64}/);
  assert.match(dockerfile, /arm64\) arch=arm64; sha=[0-9a-f]{64}/);
  const packager = readFileSync(
    new URL("../apps/runner/scripts/package.mjs", import.meta.url),
    "utf8",
  );
  assert.match(packager, /probe-glibc.cjs/);
  assert.match(packager, /probe-natives.cjs/);
  assert.match(packager, /probe-codemode.mjs/);
});

test("runner assets are verified and attested, and gate every publishing path", () => {
  const assets = workflow.jobs["runner-assets"];
  assert.deepEqual(assets.needs, ["hostd-ref", "runner"]);
  const nodeSetup = assets.steps.find((step) => step.name === "Setup pinned Node");
  assert.equal(nodeSetup.uses, "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1");
  assert.deepEqual(nodeSetup.with, {
    "node-version-file": ".nvmrc",
    "package-manager-cache": false,
  });
  const download = assets.steps.findIndex((step) => step.with?.pattern === "runner-linux-*");
  const generate = assets.steps.findIndex(
    (step) => step.name === "Generate runner manifest and stamped installer",
  );
  const sign = assets.steps.findIndex((step) => step.id === "provenance");
  assert.ok(download < generate && generate < sign);
  assert.match(assets.steps[generate].run, /sha256sum -c volli-runner-SHA256SUMS/);
  assert.equal(
    assets.steps[sign].if,
    "github.event_name != 'workflow_dispatch' || !inputs.dry_run",
  );
  for (const file of [
    "*.tar.gz",
    "volli-runner-manifest.json",
    "volli-runner-install.sh",
    "volli-runner-SHA256SUMS",
  ]) {
    assert.ok(assets.steps[sign].with["subject-path"].includes(file));
  }
  assert.match(
    assets.steps.find((step) => step.name === "Collect runner signature bundle").run,
    /volli-runner-provenance.sigstore.json/,
  );
  for (const job of ["release", "dry-run-desktop"]) {
    assert.ok(workflow.jobs[job].needs.includes("runner-assets"));
    assert.equal(
      enabled(job, {
        event: "workflow_dispatch",
        dryRun: job !== "release",
        results: { prepare: "success", "hostd-assets": "success", "runner-assets": "failure" },
      }),
      false,
    );
  }
  const steps = workflow.jobs.release.steps;
  const verify = steps.findIndex((step) => step.name === "Verify runner release asset set");
  assert.ok(verify < steps.findIndex((step) => step.name === "Pre-create GitHub release"));
  assert.match(steps[verify].run, /shasum -a 256 -c volli-runner-SHA256SUMS/);
  assert.match(
    steps.find((step) => step.name === "Publish artifacts to the release").run,
    /files\+=\("\$\{runnerFiles\[@\]\}"\)/,
  );
  for (const job of ["runner", "runner-assets"]) {
    for (const action of workflow.jobs[job].steps.filter((step) => step.uses))
      assert.match(action.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  }
});

test("artifact gate accepts only the declared run stub; implemented run must boot", (t) => {
  const script = readFileSync(
    new URL("../apps/runner/scripts/ci-boot-artifact.sh", import.meta.url),
    "utf8",
  );
  const start = script.indexOf('if [[ "${ALLOW_SKELETON:-false}" != true ]]; then');
  assert.ok(start > 0);
  const skeletonGuard = script.slice(start);
  const root = versionFixture(t);
  mkdirSync(join(root, "bin"));
  // Simulated wiring: this process double tests the real shell guard. Like the
  // actual registry, help always succeeds even while a command remains a stub.
  // The release container runs the shipped binary, not this double.
  writeFileSync(
    join(root, "bin/volli-runner"),
    `#!/bin/sh
if [ "\${2:-}" = --help ]; then echo Usage; exit 0; fi
if [ "$1" = version ]; then
  if [ "$TEST_INSTALL_BEHAVIOR" = wrong-version ]; then echo 0.0.0; else echo "$TEST_EXPECTED_VERSION"; fi
  exit 0
fi
if [ "$1" = install ]; then
  printf '%s\\n' "$@" "HOME=$HOME" "XDG_DATA_HOME=$XDG_DATA_HOME" "XDG_STATE_HOME=$XDG_STATE_HOME" "XDG_CONFIG_HOME=$XDG_CONFIG_HOME" > "$TEST_INSTALL_RECORD"
  [ "$#" -eq 6 ] && [ "$2" = --user ] && [ "$3" = --from ] && [ "$4" = "$root" ] && [ "$5" = --no-start ] && [ "$6" = --no-link ] || exit 97
  [ "$TEST_INSTALL_CODE" = 0 ] || exit "$TEST_INSTALL_CODE"
  [ "$TEST_INSTALL_BEHAVIOR" != noop ] || exit 0
  release="$HOME/.local/share/volli-runner/releases/$TEST_EXPECTED_VERSION"
  mkdir -p "$release/bin" "$HOME/.local/bin"
  cp "$0" "$release/bin/volli-runner"
  ln -s "$release" "$HOME/.local/share/volli-runner/current"
  ln -s "$HOME/.local/share/volli-runner/current/bin/volli-runner" "$HOME/.local/bin/volli-runner"
  exit 0
fi
[ "$1" = run ] && [ "$2" = --data-dir ] || exit 98
if [ "$TEST_CODE" = live ]; then
  trap 'exit 0' TERM
  while :; do sleep 0.02; done
fi
printf '%s\\n' "$TEST_MESSAGE" >&2
exit "$TEST_CODE"
`,
    { mode: 0o755 },
  );
  const cleanup = `trap 'if [[ -n "\${pid:-}" ]]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true; fi' EXIT\n`;
  const installHome = join(root, "install-home");
  const installRecord = join(root, "install-record");
  const runData = join(root, "run-data");
  mkdirSync(runData);
  for (const [
    code,
    message,
    allowSkeleton,
    installCode,
    skeleton,
    success,
    installBehavior = "copy",
  ] of [
    ["69", "volli-runner: `run` is not available in this build yet.", "true", "69", true, true],
    ["69", "volli-runner: `run` is not available in this build yet.", "false", "0", false, false],
    [
      "69",
      "crash: volli-runner: `run` is not available in this build yet.",
      "true",
      "0",
      false,
      false,
    ],
    ["69", "arbitrary unavailable/crash", "true", "0", false, false],
    ["1", "runtime failure", "true", "0", false, false],
    ["0", "premature successful exit", "true", "0", false, false],
    ["live", "", "false", "69", false, false],
    ["live", "", "false", "0", false, true],
    ["live", "", "false", "0", false, false, "noop"],
    ["live", "", "false", "0", false, false, "wrong-version"],
  ]) {
    rmSync(installHome, { recursive: true, force: true });
    rmSync(installRecord, { force: true });
    mkdirSync(installHome);
    const result = spawnSync("bash", ["-eu", "-c", `${cleanup}${skeletonGuard}`], {
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        root,
        data: runData,
        install_home: installHome,
        expected_version: "1.2.3",
        log: join(root, "run.log"),
        TEST_EXPECTED_VERSION: "1.2.3",
        TEST_INSTALL_RECORD: installRecord,
        TEST_INSTALL_BEHAVIOR: installBehavior,
        TEST_CODE: code,
        TEST_MESSAGE: message,
        TEST_INSTALL_CODE: installCode,
        ALLOW_SKELETON: allowSkeleton,
      },
    });
    assert.equal(result.status === 0, success, result.stdout + result.stderr);
    if (allowSkeleton === "false") {
      assert.deepEqual(readFileSync(installRecord, "utf8").trim().split("\n"), [
        "install",
        "--user",
        "--from",
        root,
        "--no-start",
        "--no-link",
        `HOME=${installHome}`,
        `XDG_DATA_HOME=${installHome}/.local/share`,
        `XDG_STATE_HOME=${installHome}/.local/state`,
        `XDG_CONFIG_HOME=${installHome}/.config`,
      ]);
    }
    assert.equal(result.stdout.includes("skeleton artifact"), skeleton);
    assert.equal(result.stdout.includes("unlinked boot and SIGTERM passed"), success && !skeleton);
  }
});

const prepareStep = (name) => workflow.jobs.prepare.steps.find((step) => step.name === name);
const pushStep = prepareStep("Bump versions, commit, tag, push");

// A PATH whose git refuses to run, so a step that escapes the shell stub can
// never touch this worktree or its remote.
function guardedEnv(root, extra) {
  const bin = join(root, "no-git-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), "#!/bin/sh\necho 'real git reached' >&2\nexit 97\n", {
    mode: 0o755,
  });
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CEILING_DIRECTORIES: root,
    ...extra,
  };
}

test("button bump goes to main over SSH with the deploy key; the tag stays on GITHUB_TOKEN", (t) => {
  const prepare = workflow.jobs.prepare;
  // Only main may deploy the environment that holds the key.
  assert.equal(prepare.environment, "release");
  // The key guard runs first, before checkout and every other guard.
  assert.equal(prepare.steps[0].name, "Guard: release deploy key present");
  assert.deepEqual(prepare.steps[0].env, {
    RELEASE_DEPLOY_KEY: "${{ secrets.RELEASE_DEPLOY_KEY }}",
  });
  for (const [key, status] of [
    ["", 1],
    ["-----BEGIN OPENSSH PRIVATE KEY-----", 0],
  ]) {
    const run = spawnSync("bash", ["-c", prepare.steps[0].run], {
      encoding: "utf8",
      env: { ...process.env, RELEASE_DEPLOY_KEY: key },
    });
    assert.equal(run.status, status, run.stdout + run.stderr);
    if (status) assert.match(run.stdout, /::error::Missing secret RELEASE_DEPLOY_KEY/);
  }
  // Only prepare (never a dry-run or tag-path job) reads the key.
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== "prepare") assert.doesNotMatch(JSON.stringify(job), /RELEASE_DEPLOY_KEY/, name);
  }

  // Run the real step with git stubbed: record each push in full, its SSH
  // command and the key file as git would see it.
  const root = versionFixture(t);
  const temp = join(root, "runner-temp");
  mkdirSync(temp);
  const log = join(root, "git.log");
  const stub = `git() {
    if [ "$1" = push ]; then
      { echo "push \${*:2}"; echo "ssh \${GIT_SSH_COMMAND:-none}"
        echo "key $(cat "$RUNNER_TEMP/release_deploy_key" 2>/dev/null || echo absent) $(stat -c %a "$RUNNER_TEMP/release_deploy_key" 2>/dev/null || stat -f %Lp "$RUNNER_TEMP/release_deploy_key" 2>/dev/null)"
      } >> "$GIT_LOG"
    fi
  }\n`;
  assert.equal(pushStep.env.RELEASE_DEPLOY_KEY, "${{ secrets.RELEASE_DEPLOY_KEY }}");
  const run = spawnSync("bash", ["-c", stub + pushStep.run], {
    cwd: root,
    encoding: "utf8",
    env: guardedEnv(root, {
      VERSION: "1.2.4",
      TAG: "v1.2.4",
      RELEASE_DEPLOY_KEY: "test-key",
      RUNNER_TEMP: temp,
      GITHUB_REPOSITORY: "owner/repo",
      GIT_LOG: log,
    }),
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  const sshCommand =
    `ssh -i '${temp}/release_deploy_key' -o IdentitiesOnly=yes -o BatchMode=yes ` +
    `-o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null ` +
    `-o UserKnownHostsFile='${temp}/github_known_hosts'`;
  assert.deepEqual(lines, [
    // Branch first and unforced, so a moved main fails before any tag exists.
    "push git@github.com:owner/repo.git HEAD:refs/heads/main",
    `ssh ${sshCommand}`,
    "key test-key 600",
    // The key is gone before the GITHUB_TOKEN tag push.
    "push origin refs/tags/v1.2.4",
    "ssh none",
    "key absent",
  ]);
  // GitHub's published ed25519 host key (api.github.com/meta), nothing else.
  assert.equal(
    readFileSync(join(temp, "github_known_hosts"), "utf8"),
    "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
  );
});

function realGit(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

test("button push over real git: lands bump and tag, or tags nothing when main moved", (t) => {
  for (const moved of [false, true]) {
    const scratch = versionFixture(t);
    const remote = join(scratch, "remote.git");
    const seed = join(scratch, "seed");
    const work = join(scratch, "work");
    const temp = join(scratch, "runner-temp");
    mkdirSync(temp);
    realGit(scratch, "init", "-q", "--bare", "-b", "main", remote);
    realGit(scratch, "init", "-q", "-b", "main", seed);
    mkdirSync(join(seed, "apps/desktop"), { recursive: true });
    for (const file of ["package.json", "apps/desktop/package.json"]) {
      writeFileSync(join(seed, file), JSON.stringify({ version: "1.2.3" }, null, 2) + "\n");
    }
    realGit(seed, "add", "-A");
    realGit(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    realGit(seed, "push", "-q", remote, "main");
    realGit(scratch, "clone", "-q", remote, work);
    if (moved) {
      writeFileSync(join(seed, "other"), "x");
      realGit(seed, "add", "-A");
      realGit(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "moved");
      realGit(seed, "push", "-q", remote, "main");
    }
    const before = realGit(remote, "rev-parse", "main");
    // The SSH URL is rewritten to the local bare remote; origin is the same.
    const run = spawnSync("bash", ["-c", pushStep.run], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CEILING_DIRECTORIES: scratch,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`,
        GIT_CONFIG_VALUE_0: "git@github.com:owner/repo.git",
        VERSION: "1.2.4",
        TAG: "v1.2.4",
        RELEASE_DEPLOY_KEY: "test-key",
        RUNNER_TEMP: temp,
        GITHUB_REPOSITORY: "owner/repo",
      },
    });
    const tags = realGit(remote, "tag", "--list");
    assert.equal(spawnSync("test", ["-e", join(temp, "release_deploy_key")]).status, 1);
    if (moved) {
      assert.notEqual(run.status, 0, "a moved main must fail the push");
      assert.equal(realGit(remote, "rev-parse", "main"), before);
      assert.equal(tags, "");
    } else {
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(realGit(remote, "log", "-1", "--format=%s", "main"), "chore(release): 1.2.4");
      assert.equal(tags, "v1.2.4");
      assert.equal(
        realGit(remote, "rev-parse", "v1.2.4^{commit}"),
        realGit(remote, "rev-parse", "main"),
      );
    }
  }
});
