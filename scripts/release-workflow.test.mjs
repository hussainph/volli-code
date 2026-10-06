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
function enabled(job, { event, dryRun, results = {}, cancelled = false }) {
  const condition = workflow.jobs[job].if
    .replaceAll("always()", "true")
    .replaceAll("cancelled()", String(cancelled))
    .replaceAll("github.event_name", JSON.stringify(event))
    .replaceAll("inputs.dry_run", String(dryRun))
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
  for (const job of ["hostd-ref", "hostd", "hostd-assets", "dry-run-desktop"]) {
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
  assert.match(steps[verify].run, /hostd-provenance.sigstore.json/);
  assert.match(steps[verify].run, /hostd release asset missing or empty/);
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
