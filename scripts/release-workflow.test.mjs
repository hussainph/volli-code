import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse } from "yaml";

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
  const ctx = { event: "workflow_dispatch", dryRun: true, results: { "hostd-assets": "success" } };
  assert.equal(enabled("prepare", ctx), false);
  assert.equal(enabled("release", ctx), false);
  assert.equal(enabled("hostd-ref", ctx), true);
  assert.equal(enabled("dry-run-desktop", ctx), true);
  const sign = workflow.jobs["hostd-assets"].steps.find((step) => step.id === "provenance");
  assert.equal(sign.if, "github.event_name != 'workflow_dispatch' || !inputs.dry_run");
});

test("tag and owner-button releases require both architecture builds and verified pin", () => {
  for (const event of ["push", "workflow_dispatch"]) {
    const ctx = {
      event,
      dryRun: false,
      results: { prepare: event === "push" ? "skipped" : "success", "hostd-assets": "success" },
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
  assert.deepEqual(workflow.jobs.release.needs, ["prepare", "hostd-assets"]);
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
  assert.match(setup.uses, /^voidzero-dev\/setup-vp@[0-9a-f]{40}$/);
  assert.deepEqual(setup.with, { "node-version-file": ".nvmrc", "run-install": false });
  // Every third-party action is pinned to a full commit SHA.
  for (const action of steps.filter((step) => step.uses)) {
    assert.match(action.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  }
  const pnpm = steps[index("Enable pinned pnpm")].run;
  assert.match(pnpm, /corepack" enable --install-directory "\$RUNNER_TEMP\/pnpm-bin" pnpm/);
  assert.match(pnpm, /packageManager/);
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
  assert.ok(index("Enable pinned pnpm") > index("Setup Vite+"));
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
    results: { prepare: "failure", "hostd-assets": "success" },
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
  assert.match(publish.run, /\[ "\$name" != canary-peer\.json \] \|\| continue/);
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
