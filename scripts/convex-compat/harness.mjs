/**
 * The older-app live lane's shared half (VC-1019): which of an older build's
 * own live suites to run, what proves those suites came from that build, how
 * to read vitest's JSON report, and the job-summary blocks.
 *
 * Pure and dependency-free on purpose — the lane's two scripts (prepare and
 * run) are thin shells around this, and its unit test runs before anything is
 * installed.
 */

import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * The suites this lane runs, in the order CI's `Convex (codegen + backend)`
 * lane names them: the cloud board through the real transport, the Session
 * view, a moved project's history and "Waiting for <Mac>". A tag that does
 * not ship one of them runs the rest — and says which it could not run — but a
 * tag that ships NONE of them fails: the lane must never report a green it
 * did not earn.
 */
export const LIVE_SUITES = [
  "apps/desktop/src/renderer/src/stores/cloud-board/convex.live.test.ts",
  "apps/desktop/src/main/cloud-sessions.live.test.ts",
  "apps/desktop/src/main/cloud-move-history.live.test.ts",
  "apps/desktop/src/main/cloud-runner/waiting-for-mac.live.test.ts",
];

/** The older build's own generated Convex API, which its suites import. */
const GENERATED_API = join("convex", "functions", "_generated", "api.js");

/** Where a pnpm workspace links `@volli/convex` from inside the older tree. */
const CONVEX_LINKS = [
  join("apps", "desktop", "node_modules", "@volli", "convex"),
  join("node_modules", "@volli", "convex"),
];

/** The suites of {@link LIVE_SUITES} the tree at `tree` ships, and the ones it does not. */
export function chooseSuites(tree, options = {}) {
  const exists = options.exists ?? existsSync;
  const suites = LIVE_SUITES.filter((suite) => exists(join(tree, suite)));
  const absent = LIVE_SUITES.filter((suite) => !suites.includes(suite));
  return { suites, absent };
}

/**
 * Prove the tree carries its OWN dependencies and generated API — the whole
 * point of the lane is that the suite runs on the older build's code, so a
 * missing install or a link that resolves back into this checkout is a failure
 * rather than something to work around.
 */
export function olderDependencies(tree, options = {}) {
  const exists = options.exists ?? existsSync;
  const real = options.realpath ?? realpathSync;
  const root = real(tree);
  if (!exists(join(root, GENERATED_API))) {
    throw new Error(`${root} has no ${GENERATED_API}: that tag commits no generated Convex API`);
  }
  const link = CONVEX_LINKS.find((candidate) => exists(join(root, candidate)));
  if (link === undefined) {
    throw new Error(
      `${root} has no @volli/convex link (${CONVEX_LINKS.join(" or ")}): ` +
        "the older build's own dependencies are not installed",
    );
  }
  const resolved = real(join(root, link));
  if (resolved !== join(root, "convex")) {
    throw new Error(`@volli/convex resolves to ${resolved}, not to ${join(root, "convex")}`);
  }
  return { convexApi: link, generatedApi: GENERATED_API };
}

/** A report file name as the tree sees it: reports carry absolute paths. */
function relativize(file, tree) {
  const cleaned = String(file ?? "").replaceAll("\\", "/");
  if (tree !== undefined) {
    const root = String(tree).replaceAll("\\", "/").replace(/\/$/, "");
    if (cleaned === root) return "";
    if (cleaned.startsWith(`${root}/`)) return cleaned.slice(root.length + 1);
  }
  return cleaned.replace(/^\.\//, "");
}

/**
 * Read vitest's JSON report as a verdict. Every test in these suites must RUN:
 * a skipped one means the fixture's environment did not reach the older build,
 * which would otherwise look exactly like a pass.
 *
 * Give it `{ tree, suites }` and the report is held to the suites that were
 * selected: a config that excluded one of them, or a file that collected no
 * test at all, fails — the suites that did pass say nothing about the one that
 * never ran.
 */
export function evaluateReport(report, expected = {}) {
  if (report === null || typeof report !== "object" || typeof report.numTotalTests !== "number") {
    return {
      ok: false,
      reason: "vitest wrote no readable JSON report, so nothing proves the suites ran",
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      suites: [],
    };
  }
  const suites = (Array.isArray(report.testResults) ? report.testResults : []).map((result) => {
    const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    const count = (status) => assertions.filter((one) => one.status === status).length;
    return {
      file: relativize(result.name, expected.tree),
      status: String(result.status ?? "unknown"),
      passed: count("passed"),
      failed: count("failed"),
      pending: assertions.length - count("passed") - count("failed"),
    };
  });
  const total = report.numTotalTests;
  const passed = Number(report.numPassedTests ?? 0);
  const failed = Number(report.numFailedTests ?? 0);
  const pending = Number(report.numPendingTests ?? 0) + Number(report.numTodoTests ?? 0);
  const verdict = { total, passed, failed, pending, suites };
  const selected = Array.isArray(expected.suites) ? expected.suites : [];
  if (selected.length > 0) {
    const ran = new Set(suites.map((suite) => suite.file));
    const missing = selected.filter((suite) => !ran.has(suite));
    if (missing.length > 0) {
      return {
        ...verdict,
        ok: false,
        reason: `the report does not include ${missing.length} selected suite(s): ${missing.join(", ")}`,
      };
    }
    const silent = suites.filter(
      (suite) => selected.includes(suite.file) && suite.passed + suite.failed + suite.pending === 0,
    );
    if (silent.length > 0) {
      return {
        ...verdict,
        ok: false,
        reason: `no test ran in ${silent.map((suite) => suite.file).join(", ")}`,
      };
    }
  }
  if (total === 0) {
    return {
      ...verdict,
      ok: false,
      reason: "not one test ran: the older build has the files but no tests",
    };
  }
  if (pending > 0) {
    return {
      ...verdict,
      ok: false,
      reason: `${pending} test(s) were skipped — the fixture's environment did not reach the older build`,
    };
  }
  if (failed > 0 || report.success !== true) {
    return { ...verdict, ok: false, reason: `${failed} test(s) failed` };
  }
  return { ...verdict, ok: true, reason: "every test ran and passed" };
}

/** Markdown for the summary after the older build has been materialized. */
export function renderPrepared(manifest) {
  const lines = [
    "### Older app (live): prepared",
    "",
    "| | |",
    "|---|---|",
    `| Selected build | \`${manifest.tag}\` |`,
    `| Commit | \`${manifest.commit}\` |`,
    `| \`@volli/desktop\` | \`${manifest.appVersion}\` |`,
    `| Live suites that build ships | ${manifest.suites.length} of ${LIVE_SUITES.length} |`,
    "",
    "Run from that build's own tree, dependencies and committed generated API:",
    "",
    ...manifest.suites.map((suite) => `- \`${suite}\``),
  ];
  if (manifest.absent.length > 0) {
    lines.push("", "Not shipped by that tag, so not run:", "");
    for (const suite of manifest.absent) lines.push(`- \`${suite}\``);
  }
  return `${lines.join("\n")}\n`;
}

/** Markdown for the summary after the suites have run against this checkout's backend. */
export function renderResult(manifest, verdict, meta = {}) {
  const result = verdict.ok ? "✅ pass" : `❌ fail — ${verdict.reason}`;
  const lines = [
    "### Older app (live): result",
    "",
    "| | |",
    "|---|---|",
    `| Older build | \`${manifest.tag}\` (\`${manifest.commit.slice(0, 7)}\`) |`,
    `| Backend | ${meta.backend ?? "this checkout's `convex/functions`, deployed to the pinned local backend"} |`,
    `| Tests | ${verdict.passed} passed, ${verdict.failed} failed, ${verdict.pending} skipped |`,
    `| Result | ${result} |`,
    "",
    "| Suite | Passed | Failed | Skipped |",
    "|---|---|---|---|",
  ];
  for (const suite of verdict.suites) {
    lines.push(`| \`${suite.file}\` | ${suite.passed} | ${suite.failed} | ${suite.pending} |`);
  }
  if (meta.legalException) {
    const entry = meta.legalException;
    lines.push(
      "",
      `### ${entry.ticket}: explicit enrollment contract exception`,
      "",
      `${entry.reason}. Applies only to \`${entry.tag}\`; expires automatically after \`${entry.expiresAfterTag}\`.`,
      `The mandatory additional live probe requires a typed \`${entry.refusalCode}\` for \`${entry.fromVersion}\`.`,
      `**SIMULATED current-consent precondition:** the prepared tree's agreement constant is temporarily \`${entry.toVersion}\` so every unchanged data-plane test body still runs.`,
      "This is not evidence that the older app can enroll with text it never showed. No failed or skipped test is excused. The prepared constant is restored after the run.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * How many vitest workers this lane may take: the lane's own cap (two, as the
 * desktop's test config assumes, and what CI's Convex lane gives these same
 * suites), lowered — never raised — by the Session's parallelism budget.
 *
 * The budget arrives as `VOLLI_CONCURRENCY_HINT`, and as `VITEST_MAX_WORKERS`
 * where a toolchain reads that spelling instead (AGENTS.md, "A budget only
 * ever LOWERS a project's own cap, never raises it"). It has to be honoured
 * here rather than left to the config: an explicit `--maxWorkers` flag —
 * which is what this lane passes — outranks the variable vitest re-reads, so
 * the cap has to be applied before the flag is written.
 */
export function resolveWorkers(requested = 2, env = process.env) {
  // Both spellings name one budget; where a machine carries both, the tighter
  // one is the budget, because a budget only ever lowers a cap.
  const budgets = [env["VOLLI_CONCURRENCY_HINT"], env["VITEST_MAX_WORKERS"]]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  const cap = Math.max(1, Math.trunc(requested));
  return Math.min(cap, ...budgets);
}

/**
 * Append a block to the run's job summary. A no-op outside GitHub Actions
 * (`GITHUB_STEP_SUMMARY` unset), so a person running the lane by hand still
 * gets the log without an error.
 */
export function appendStepSummary(markdown, file = process.env["GITHUB_STEP_SUMMARY"]) {
  if (file === undefined || file === "") return false;
  appendFileSync(file, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return true;
}
