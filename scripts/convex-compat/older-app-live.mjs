#!/usr/bin/env node
/**
 * Runs the newest shipped build's OWN live cloud suites against THIS
 * checkout's backend (VC-1019).
 *
 *   node convex/fixture/with-backend.ts --deploy -- \
 *     node scripts/convex-compat/older-app-live.mjs --manifest <tree>/older-app.json
 *
 * `with-backend --deploy` starts the pinned local backend, pushes this
 * checkout's `convex/functions`, and hands the child the backend's URLs and a
 * test issuer key. This script then runs `vp test run` inside the older tree's
 * `apps/desktop`, so the suites, every module they import, the dependency tree
 * and the committed `convex/functions/_generated` API are that build's — only
 * the backend is this checkout's. The one documented VC-937 exception in
 * live-exceptions.json adapts only a consent fixture constant, requires an
 * additional typed-refusal probe, and expires as soon as a newer tag ships.
 * Frozen data-plane test bodies, SDKs and generated APIs remain unchanged.
 *
 * That is the half a schema/function-API diff cannot prove: the build people
 * are actually running still signs in, still paints its board, still streams a
 * Session, still reads "Waiting for <Mac>". A function renamed, an argument
 * made required, a validator made stricter — each fails here.
 *
 * The lane requires its own evidence rather than trusting an exit code: every
 * suite must RUN (a skipped one means the fixture's environment never reached
 * the older build, which would otherwise look exactly like a pass), the JSON
 * report must show at least one test, and the suite list must be the one the
 * manifest recorded. The verdict goes to the job summary and, with `--report`,
 * to a JSON file an artifact can carry.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  appendStepSummary,
  chooseSuites,
  evaluateReport,
  olderDependencies,
  renderResult,
  resolveWorkers,
} from "./harness.mjs";
import { latestTag } from "./tags.mjs";
import { installLegalFixture, selectLegalException } from "./legal-fixture.mjs";
import { PREVIEW_AGREEMENT_VERSION } from "../../packages/shared/src/preview-legal.ts";

/** What the fixture must have handed us; any one missing means the run proves nothing. */
const FIXTURE_ENV = [
  "VOLLI_CONVEX_URL",
  "VOLLI_CONVEX_SITE_URL",
  "VOLLI_CONVEX_TEST_PRIVATE_KEY",
  "VOLLI_CONVEX_ADMIN_KEY",
];

/** Hard stop well inside the job's timeout, so a hung suite is a red lane, not a killed job. */
const TIMEOUT_MS = 12 * 60_000;

function fail(lines) {
  const list = Array.isArray(lines) ? lines : [lines];
  for (const line of list) console.error(line);
  // A lane that failed before running anything still says so on the run page.
  appendStepSummary(`### Older app (live): result\n\n❌ fail — ${list[0]}\n`);
  process.exit(1);
}

/** HEAD of this checkout: the backend the older build is being held to. */
function headSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return process.env["GITHUB_SHA"] ?? null;
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      report: { type: "string" },
      "max-workers": { type: "string" },
    },
  });
  if (!values.manifest)
    throw new Error("usage: older-app-live.mjs --manifest <path> [--report <path>]");

  const missing = FIXTURE_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    fail([
      `older-app-live needs the backend fixture: missing ${missing.join(", ")}.`,
      "Run it under `node convex/fixture/with-backend.ts --deploy -- node scripts/convex-compat/older-app-live.mjs …`.",
    ]);
  }

  const manifestPath = resolve(values.manifest);
  if (!existsSync(manifestPath))
    fail(`${manifestPath} does not exist: prepare the older build first`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const reportPath = resolve(values.report ?? join(manifest.tree, "live-report.json"));
  const requested = Number(values["max-workers"] ?? 2);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error("--max-workers must be a positive integer");
  }
  // The lane's own cap, lowered by this Session's parallelism budget when the
  // machine carries one (CI does not).
  const workers = resolveWorkers(requested);
  if (workers !== requested) {
    console.log(`Budget lowered --max-workers ${requested} to ${workers}`);
  }

  // Re-derive the suite list from the tree and demand it is the one that was
  // prepared: a tree re-extracted under a stale manifest must not silently run
  // a different set of suites than the summary claims.
  const { suites, absent } = chooseSuites(manifest.tree);
  if (suites.length === 0) {
    fail(`${manifest.tag} ships none of the lane's live suites: ${absent.join(", ")}`);
  }
  if (suites.join("\n") !== manifest.suites.join("\n")) {
    fail([
      `${manifest.tree} no longer matches its manifest.`,
      `  prepared: ${manifest.suites.join(", ") || "(none)"}`,
      `  found:    ${suites.join(", ")}`,
    ]);
  }
  try {
    olderDependencies(manifest.tree);
  } catch (error) {
    fail(`the older build's own dependencies are not usable: ${error.message}`);
  }

  const exception = selectLegalException(
    JSON.parse(readFileSync(new URL("./live-exceptions.json", import.meta.url), "utf8")),
    {
      tag: manifest.tag,
      commit: manifest.commit,
      latestTag: latestTag(
        execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split("\n"),
      ),
      currentVersion: PREVIEW_AGREEMENT_VERSION,
    },
  );
  const fixture = exception
    ? installLegalFixture(manifest.tree, exception, process.env["VOLLI_CONVEX_URL"])
    : null;
  const selectedSuites = fixture === null ? suites : [...suites, fixture.suite];
  const vp = join(manifest.tree, "node_modules", ".bin", "vp");
  let run;
  try {
    if (exception) {
      console.log(
        `${exception.ticket}: ${exception.reason}; SIMULATED current-consent fixture only. ` +
          `The additional live probe must refuse ${exception.fromVersion} with ${exception.refusalCode}. ` +
          `Exception expires after ${exception.expiresAfterTag}.`,
      );
    }
    const filters = selectedSuites.map((suite) => {
      const prefix = "apps/desktop/";
      if (!suite.startsWith(prefix)) throw new Error(`${suite} is not under ${prefix}`);
      return suite.slice(prefix.length);
    });
    const args = [
      "test",
      "run",
      ...filters,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${reportPath}`,
      `--maxWorkers=${workers}`,
    ];
    console.log(
      `Older app ${manifest.tag}: vp ${args.join(" ")} (in ${manifest.tree}/apps/desktop)`,
    );
    // A reused prepared tree must not reuse an earlier successful report if
    // this invocation fails before the reporter writes its own evidence.
    rmSync(reportPath, { force: true });
    // PATH now contains the backend checkout's locked vp, which can run its own
    // bundled Vitest even with cwd inside the tag. Invoke the tag's binary so
    // the test toolchain, not just the suite sources, comes from its lockfile.
    run = spawnSync(vp, args, {
      cwd: join(manifest.tree, "apps", "desktop"),
      stdio: "inherit",
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        // The lane's own guarantee, not the workflow's: these suites skip
        // themselves when the fixture's environment is missing, and this is the
        // lane that must never accept that as a pass.
        VOLLI_CLOUD_BOARD_LIVE_REQUIRED: "1",
        VOLLI_CLOUD_SESSION_LIVE_REQUIRED: "1",
        // The desktop's main-project setup file imports `electron` after every
        // test (through `broadcast.ts`), and the older tree was installed with
        // lifecycle scripts off, so electron has no binary. Pointing its
        // override somewhere empty keeps `require('electron')` a string instead
        // of a ~100 MB download inside a test worker. These suites never launch
        // Electron — no suite in this lane does.
        ELECTRON_OVERRIDE_DIST_PATH: join(manifest.tree, ".no-electron-binary"),
      },
    });
  } finally {
    fixture?.restore();
  }
  if (run.error?.code === "ENOENT") fail(`the older build's own Vite+ binary is missing: ${vp}`);
  if (run.error) fail(`vp failed to start: ${run.error.message}`);
  if (run.status === null) {
    fail(`vp was killed (${run.signal ?? "timeout"}) after ${TIMEOUT_MS / 60_000} minutes`);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`could not read ${reportPath}: ${error.message}`);
  }
  let verdict = evaluateReport(parsed, { tree: manifest.tree, suites: selectedSuites });
  if (verdict.ok && run.status !== 0) {
    // The report can look clean while vitest exited non-zero (an unhandled
    // error after the last test, a rejected teardown): trust neither alone.
    verdict = { ...verdict, ok: false, reason: `vitest exited ${run.status}` };
  }
  const report = {
    tag: manifest.tag,
    commit: manifest.commit,
    appVersion: manifest.appVersion,
    tree: manifest.tree,
    backend: process.env["VOLLI_CONVEX_URL"],
    head: headSha(),
    suites: selectedSuites,
    absent,
    legalException: exception,
    exit: run.status,
    verdict,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const backend =
    `this checkout at \`${(report.head ?? "unknown").slice(0, 7)}\`, ` +
    "deployed to the pinned local backend";
  appendStepSummary(renderResult(manifest, verdict, { backend, legalException: exception }));
  console.log(
    `Older app ${manifest.tag} (${manifest.commit}): ${verdict.passed} passed, ` +
      `${verdict.failed} failed, ${verdict.pending} skipped — ${verdict.ok ? "PASS" : "FAIL"}`,
  );
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
