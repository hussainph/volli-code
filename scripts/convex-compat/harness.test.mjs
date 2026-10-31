import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LIVE_SUITES,
  appendStepSummary,
  chooseSuites,
  evaluateReport,
  olderDependencies,
  renderPrepared,
  renderResult,
  resolveWorkers,
} from "./harness.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** A throwaway directory inside the checkout, like the canary recorder's tests. */
function scratch() {
  const dir = mkdtempSync(join(ROOT, ".convex-compat-test-"));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A tree carrying only the files a prepared older build would have. */
function treeWith(files) {
  const { dir, close } = scratch();
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  return { dir, close };
}

/** Link the tree's own `convex/` package where pnpm links `@volli/convex`. */
function linkConvex(dir, target = "../../../../convex") {
  const parent = join(dir, "apps/desktop/node_modules/@volli");
  mkdirSync(parent, { recursive: true });
  symlinkSync(target, join(parent, "convex"));
}

test("chooses the suites the older build ships, and names the ones it does not", () => {
  const { dir, close } = treeWith([LIVE_SUITES[0], LIVE_SUITES[2]]);
  try {
    const { suites, absent } = chooseSuites(dir);
    // Order is the lane's, never the filesystem's.
    assert.deepEqual(suites, [LIVE_SUITES[0], LIVE_SUITES[2]]);
    assert.deepEqual(absent, [LIVE_SUITES[1], LIVE_SUITES[3]]);
    assert.deepEqual(chooseSuites(dir, { exists: () => true }).suites, LIVE_SUITES);
    assert.deepEqual(chooseSuites(dir, { exists: () => false }), {
      suites: [],
      absent: LIVE_SUITES,
    });
  } finally {
    close();
  }
});

test("requires the older build's own generated API and its own installed dependencies", () => {
  const { dir, close } = treeWith([
    "convex/functions/_generated/api.js",
    "convex/package.json",
    "apps/desktop/package.json",
  ]);
  try {
    assert.throws(() => olderDependencies(dir), /no @volli\/convex link/);

    linkConvex(dir);
    assert.deepEqual(olderDependencies(dir), {
      convexApi: "apps/desktop/node_modules/@volli/convex",
      generatedApi: "convex/functions/_generated/api.js",
    });

    // A link that reaches OUT of the tree would run this checkout's package.
    rmSync(join(dir, "apps/desktop/node_modules/@volli/convex"));
    mkdirSync(join(dir, "elsewhere"), { recursive: true });
    linkConvex(dir, join(dir, "elsewhere"));
    assert.throws(() => olderDependencies(dir), /resolves to .*elsewhere, not to/);

    // And the tag must commit the generated API its suites import, at all.
    rmSync(join(dir, "convex/functions/_generated/api.js"));
    assert.throws(() => olderDependencies(dir), /commits no generated Convex API/);
  } finally {
    close();
  }
});

const reportWith = (counts, results = []) => ({ success: true, ...counts, testResults: results });

test("reads vitest's report as a verdict, refusing every kind of empty green", () => {
  assert.equal(evaluateReport(null).ok, false);
  assert.match(evaluateReport(undefined).reason, /no readable JSON report/);
  assert.match(evaluateReport({}).reason, /no readable JSON report/);

  // Files found but nothing ran.
  assert.match(evaluateReport(reportWith({ numTotalTests: 0 })).reason, /not one test ran/);

  // The fixture never reached the older build: `describe.skipIf` skipped it all.
  const skipped = evaluateReport(
    reportWith({ numTotalTests: 3, numPassedTests: 0, numPendingTests: 3 }),
  );
  assert.equal(skipped.ok, false);
  assert.match(skipped.reason, /3 test\(s\) were skipped/);

  // A failed test, and a run that failed without one (a collection error).
  assert.match(
    evaluateReport(reportWith({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1 })).reason,
    /1 test\(s\) failed/,
  );
  assert.equal(
    evaluateReport({ ...reportWith({ numTotalTests: 1, numPassedTests: 1 }), success: false }).ok,
    false,
  );

  const clean = evaluateReport(
    reportWith({ numTotalTests: 4, numPassedTests: 4 }, [
      {
        name: "/tree/apps/desktop/src/main/a.live.test.ts",
        status: "passed",
        assertionResults: [{ status: "passed" }, { status: "passed" }],
      },
      {
        name: "/tree/apps/desktop/src/main/b.live.test.ts",
        status: "passed",
        assertionResults: [{ status: "passed" }, { status: "passed" }],
      },
    ]),
  );
  assert.deepEqual(clean, {
    ok: true,
    reason: "every test ran and passed",
    total: 4,
    passed: 4,
    failed: 0,
    pending: 0,
    suites: [
      {
        file: "/tree/apps/desktop/src/main/a.live.test.ts",
        status: "passed",
        passed: 2,
        failed: 0,
        pending: 0,
      },
      {
        file: "/tree/apps/desktop/src/main/b.live.test.ts",
        status: "passed",
        passed: 2,
        failed: 0,
        pending: 0,
      },
    ],
  });
});

const manifest = {
  tag: "v0.3.0-canary.1",
  commit: "b410095c7aea19f1f452de7c276ffbb44876d4f6",
  appVersion: "0.3.0-canary.1",
  tree: "/scratch/older-app/b410095c7aea19f1f452de7c276ffbb44876d4f6",
  suites: [LIVE_SUITES[0], LIVE_SUITES[1]],
  absent: [LIVE_SUITES[2]],
};

test("the prepared summary names the build, its commit and the suites it ships", () => {
  const markdown = renderPrepared(manifest);
  assert.match(markdown, /`v0\.3\.0-canary\.1`/);
  assert.match(markdown, /b410095c7aea19f1f452de7c276ffbb44876d4f6/);
  assert.match(markdown, /`0\.3\.0-canary\.1`/);
  assert.match(markdown, /2 of 4/);
  // Tree-relative, so the log reads like the repository.
  assert.ok(markdown.includes(`\`${LIVE_SUITES[0]}\``), markdown);
  assert.ok(markdown.includes(`\`${LIVE_SUITES[2]}\``), "the absent suite is named, not hidden");
  assert.equal(renderPrepared({ ...manifest, absent: [] }).includes("not run"), false);
});

test("the result summary carries the counts, the suites and the reason it failed", () => {
  const verdict = evaluateReport(
    reportWith({ numTotalTests: 7, numPassedTests: 7 }, [
      {
        name: `${manifest.tree}/${LIVE_SUITES[0]}`,
        status: "passed",
        assertionResults: Array.from({ length: 7 }, () => ({ status: "passed" })),
      },
    ]),
    { tree: manifest.tree, suites: [LIVE_SUITES[0]] },
  );
  const passing = renderResult(manifest, verdict, { backend: "backend `http://127.0.0.1:1`" });
  assert.match(passing, /7 passed, 0 failed, 0 skipped/);
  assert.match(passing, /✅ pass/);
  assert.match(passing, /backend `http:\/\/127\.0\.0\.1:1`/);
  assert.ok(passing.includes(`| \`${LIVE_SUITES[0]}\` | 7 | 0 | 0 |`), passing);

  const failing = renderResult(
    manifest,
    evaluateReport(reportWith({ numTotalTests: 2, numFailedTests: 1, numPassedTests: 1 })),
  );
  assert.match(failing, /❌ fail — 1 test\(s\) failed/);
});

test("holds the report to the selected suites: none missing, none silent", () => {
  const tree = manifest.tree;
  const selected = [LIVE_SUITES[0], LIVE_SUITES[1]];
  const suite = (name, statuses) => ({
    name: `${tree}/${name}`,
    status: "passed",
    assertionResults: statuses.map((status) => ({ status })),
  });

  // Every selected suite ran at least one test. Report names are absolute; the
  // verdict normalizes them to the tree, which is how the summary lists them.
  const complete = evaluateReport(
    reportWith({ numTotalTests: 2, numPassedTests: 2 }, [
      suite(LIVE_SUITES[0], ["passed"]),
      suite(LIVE_SUITES[1], ["passed"]),
    ]),
    { tree, suites: selected },
  );
  assert.equal(complete.ok, true);
  assert.deepEqual(
    complete.suites.map((one) => one.file),
    selected,
  );

  // A config that excluded the second suite: the first one passing proves
  // nothing about it, and the lane must not call that compatible.
  const missing = evaluateReport(
    reportWith({ numTotalTests: 1, numPassedTests: 1 }, [suite(LIVE_SUITES[0], ["passed"])]),
    { tree, suites: selected },
  );
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /does not include 1 selected suite\(s\)/);
  assert.ok(missing.reason.includes(LIVE_SUITES[1]), missing.reason);

  // A file that collected no test at all is the same hole, one level down.
  const silent = evaluateReport(
    reportWith({ numTotalTests: 1, numPassedTests: 1 }, [
      suite(LIVE_SUITES[0], ["passed"]),
      suite(LIVE_SUITES[1], []),
    ]),
    { tree, suites: selected },
  );
  assert.equal(silent.ok, false);
  assert.match(silent.reason, /no test ran in/);
  assert.ok(silent.reason.includes(LIVE_SUITES[1]), silent.reason);
});

test("caps workers at the Session's parallelism budget, never above the lane's own cap", () => {
  // CI carries no budget: the lane's two workers, as the desktop config assumes.
  assert.equal(resolveWorkers(2, {}), 2);
  // Either spelling of the same budget lowers it.
  assert.equal(resolveWorkers(2, { VOLLI_CONCURRENCY_HINT: "1" }), 1);
  assert.equal(resolveWorkers(2, { VITEST_MAX_WORKERS: "1" }), 1);
  // A budget never raises the cap, and the tighter spelling wins where both exist.
  assert.equal(resolveWorkers(2, { VOLLI_CONCURRENCY_HINT: "8" }), 2);
  assert.equal(resolveWorkers(8, { VOLLI_CONCURRENCY_HINT: "8", VITEST_MAX_WORKERS: "3" }), 3);
  // An explicit request is the cap where there is no budget, and is capped where there is.
  assert.equal(resolveWorkers(4, {}), 4);
  assert.equal(resolveWorkers(4, { VOLLI_CONCURRENCY_HINT: "3" }), 3);
  // Anything that is not a positive integer is not a budget, and never a zero-worker run.
  for (const invalid of ["", "0", "-2", "two", "1.5", undefined]) {
    assert.equal(resolveWorkers(2, { VOLLI_CONCURRENCY_HINT: invalid }), 2, `${invalid}`);
  }
  assert.equal(resolveWorkers(0, {}), 1);
});

test("a legal exception requires the added probe and never excuses a failed or skipped test", () => {
  const probe = "apps/desktop/src/main/legal-consent.exception.live.test.ts";
  const selected = [...manifest.suites, probe];
  const result = (file, status = "passed") => ({
    name: `${manifest.tree}/${file}`,
    status,
    assertionResults: [{ status }],
  });
  const report = reportWith(
    { numTotalTests: 3, numPassedTests: 3 },
    selected.map((file) => result(file)),
  );
  const expected = { tree: manifest.tree, suites: selected };
  const verdict = evaluateReport(report, expected);
  assert.equal(verdict.ok, true);
  assert.equal(
    evaluateReport({ ...report, testResults: report.testResults.slice(0, -1) }, expected).ok,
    false,
  );
  for (const file of selected) {
    assert.equal(
      evaluateReport(
        {
          ...report,
          success: false,
          numFailedTests: 1,
          numPassedTests: 2,
          testResults: selected.map((one) => result(one, one === file ? "failed" : "passed")),
        },
        expected,
      ).ok,
      false,
    );
  }
  assert.equal(evaluateReport({ ...report, numPendingTests: 1 }, expected).ok, false);
  const entry = JSON.parse(
    readFileSync(new URL("./live-exceptions.json", import.meta.url), "utf8"),
  )[0];
  const markdown = renderResult(manifest, verdict, { legalException: entry });
  for (const value of [
    entry.ticket,
    entry.reason,
    entry.expiresAfterTag,
    entry.fromVersion,
    entry.toVersion,
    entry.refusalCode,
  ]) {
    assert.ok(markdown.includes(value), value);
  }
  assert.match(markdown, /SIMULATED current-consent/);
  assert.match(markdown, /not evidence that the older app can enroll/);
});

test("a step summary is written where Actions points, and nowhere else", () => {
  const { dir, close } = scratch();
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  try {
    const path = join(dir, "summary.md");
    writeFileSync(path, "first\n");
    assert.equal(appendStepSummary("### Older app (live): result", path), true);
    assert.equal(appendStepSummary("second\n", path), true);
    assert.equal(
      readFileSync(path, "utf8"),
      "first\n### Older app (live): result\nsecond\n",
      "each block ends with exactly one newline",
    );
    // Model both environments explicitly: CI itself already sets this name.
    delete process.env.GITHUB_STEP_SUMMARY;
    assert.equal(appendStepSummary("ignored", ""), false);
    assert.equal(appendStepSummary("ignored", undefined), false);
    process.env.GITHUB_STEP_SUMMARY = path;
    assert.equal(appendStepSummary("from environment"), true);
    assert.equal(
      readFileSync(path, "utf8"),
      "first\n### Older app (live): result\nsecond\nfrom environment\n",
    );
  } finally {
    if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previousSummary;
    close();
  }
});
