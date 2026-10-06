import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(publish, /shasum -a 256 -c SHA256SUMS/);
});
