#!/usr/bin/env node
/**
 * The desktop smoke runner — one entry point for CI and for the dev Mac.
 *
 * WHY THIS EXISTS. CI used to carry a hand-written allow-list of smoke
 * filenames inside ci.yml. An allow-list is a manual registration step, and it
 * failed exactly the way manual registration always does: it named 35 files
 * while 53 existed, so 18 probes reported nothing. Two of them were failing
 * against `main` the whole time (see QUARANTINE below). This script inverts
 * that — it GLOBS the directory and subtracts an explicit, commented
 * deny-list, so a new smoke runs by default and every exclusion is a decision
 * someone wrote down.
 *
 * Smokes are WAIT-bound, not CPU-bound: each boots the built Electron app and
 * then spends most of its life waiting on it (measured: 12–44% of one core).
 * So they are run concurrently. That is safe because `lib/smoke-kit.mjs`
 * mkdtemp's a fresh scratch dir, SQLite database, and `--user-data-dir` per
 * run, and the agent socket resolves under that same user-data dir — no fixed
 * port, no shared path, nothing to collide.
 *
 * Usage:
 *   node apps/desktop/scripts/run-smokes.mjs                  # every gating probe
 *   node apps/desktop/scripts/run-smokes.mjs --tier core      # core e2e (boot is an alias)
 *   node apps/desktop/scripts/run-smokes.mjs --tier rest      # extended gating journeys
 *   node apps/desktop/scripts/run-smokes.mjs --tier quarantine # nightly observations
 *   node apps/desktop/scripts/run-smokes.mjs --shard 1/3      # one shard of a matrix
 *   node apps/desktop/scripts/run-smokes.mjs --jobs 4         # concurrency (default 4)
 *   node apps/desktop/scripts/run-smokes.mjs --list           # print, run nothing
 *
 * Requires a built app (`vp run --filter @volli/desktop build`) and, on a
 * fresh machine, `ensure:electron`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSmokeReporter, runWithRetry, smokeAttemptEnvironment } from "./smoke-results.mjs";

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "e2e");
const REPO_ROOT = resolve(E2E_DIR, "..", "..", "..");

/**
 * Probes this lane will not run, each with the reason it cannot.
 *
 * Anything NOT listed here, credential-gated or in SMOKE_QUARANTINE gates by
 * default. This legacy deny-list is distinct from the measured nightly lane.
 * Adding a name is deliberate, not a way to hide an inconvenient red.
 */
const DENY = new Map([
  // NOTE: probes that need real Pi credentials are NOT listed here. They are
  // detected structurally — see `needsPiCredentials()`. Hand-listing them was
  // how three of them (composer-kickoff, composer-verbs, session-env-parity)
  // reached CI and aborted: their headers do not mention a credential, only
  // their code does.

  // ---- needs a third-party binary the runner does not ship ---------------
  // Boots N real `claude` TUIs in raw PTYs and drives /usr/bin/memory_pressure
  // to measure warm-parking (issue #51). A GitHub runner has no Claude Code
  // install, so every session produces no output and the probe reports
  // "booted 0/8". Not a bug and not a race — a missing dependency it cannot
  // create. It stays a local research probe.
  ["sigstop-smoke.mjs", "needs the `claude` CLI + memory_pressure; runner ships neither"],

  // ---- research probes: hour-long, macOS-only, and they take the machine --
  //
  // VC-291's terminal reflow/accessibility investigation. These match the
  // lane's `*-smoke.mjs` glob but are not acceptance probes: they exist to
  // produce evidence for one ticket, and running them here would be actively
  // harmful rather than merely slow.
  //
  //  - Each drives the ticket's whole matrix — 3 runs × up to 20 action
  //    boundaries, every one screenshotted and OCRed. A full sweep is the
  //    better part of an hour per case.
  //  - Markers are read by OCRing canvas screenshots through the macOS Vision
  //    framework (`lib/ocr.js`, JXA). There is no such bridge on Linux.
  //  - The a11y probe TOGGLES VOICEOVER and OWNS THE SYSTEM CLIPBOARD, which
  //    no shared runner should have done to it, and reads the macOS AX tree
  //    through System Events (an unattended runner grants no such permission).
  //  - They deliberately force the WebGL2 fallback and open 17+ live GPU
  //    contexts, which is a hostile neighbour for concurrent smokes.
  //
  // Run them by hand with `apps/desktop/e2e/run-vc291-matrix.sh`.
  ["reflow-matrix-smoke.mjs", "VC-291 research probe: ~1h, macOS Vision OCR, 17+ GPU contexts"],
  [
    "reflow-a11y-smoke.mjs",
    "VC-291 research probe: toggles VoiceOver, owns the clipboard, macOS AX",
  ],

  // ---- pass locally, do not hold on a GitHub runner ----------------------
  //
  // A category of their own, and the distinction matters to whoever reads this
  // next: everything here is GREEN on a dev Mac and red only on CI. The probes
  // are not wrong and the app is not broken — the runner differs, in ways the
  // probe cannot wait its way out of. Each was chased to its actual cause
  // first, and the cheap causes were FIXED rather than listed (the project
  // import race, the dnd-kit settle, the stty read, the PATH-position claim).
  // What is left is second-launch and filesystem-watch behaviour.
  //
  // Re-check these whenever the runner image changes; drop a line the moment
  // its probe passes twice on CI.
  [
    "monaco-reconciliation-smoke.mjs",
    "CI: external write never adopted (fsevents in the runner temp dir); waiting longer does not help",
  ],
  [
    "home-taxonomy-smoke.mjs",
    "CI: check 6 — the run's SECOND cold Electron boot does not mount Home within 30s",
  ],
  [
    "settings-fill-smoke.mjs",
    "CI: check 5 — Models pane mounts neither its table nor its empty state (no Pi catalog)",
  ],
  [
    "global-artifacts-smoke.mjs",
    "CI: checks 4/6 — create-artifact completion and post-relaunch tab restore",
  ],
  [
    "menu-scroll-smoke.mjs",
    "CI: the New-ticket composer does not close, so it intercepts the board dblclick",
  ],

  // ---- QUARANTINE: already failing against main -------------------------
  //
  // These are NOT runner limitations and NOT regressions from this change.
  // Each was verified failing on a clean checkout of origin/main (0438e480)
  // with a fresh build, run serially, on an isolated scratch profile.
  //
  // Five of the six were ON THE OLD CI ALLOW-LIST. The manual macOS lane was
  // therefore already red — it had simply never been fired, which is the whole
  // argument for this change. They are quarantined rather than fixed here so
  // that turning the lane on is not blocked behind six unrelated bug fixes.
  //
  // This list is NOT a silent skip: the runner prints every entry and its
  // reason on each run. Fix a bug, delete its line — never delete the probe.
  [
    "live-preview-smoke.mjs",
    "QUARANTINED: check 5 — deep heading not styled after wheel-scroll (Document Mode)",
  ],
  [
    "agent-cli-token-bench.mjs",
    "QUARANTINED: check 2 — `volli help ticket create` is 334 est tokens, ceiling 225",
  ],
  [
    "harness-wrapper-smoke.mjs",
    "QUARANTINED: checks 2/7/9 — wrapper mints no session id (sessionId=null)",
  ],
  [
    "editor-theme-smoke.mjs",
    "QUARANTINED: checks 2/3/4 — Settings Mode control never becomes clickable",
  ],
  ["park-smoke.mjs", "QUARANTINED: tab strip shows no parked badge (count=0)"],
  // The flake this was quarantined for is FIXED: check 1 used to screenshot the
  // terminal and average the pixels, which read the window background before
  // first paint in 3 of 5 runs. VC-107's DOM renderer puts the theme colours on
  // the elements themselves, so the check now reads them and cannot be early.
  //
  // What keeps the entry is check 2, the live-reload half: it edits a config
  // inside an isolated $HOME and waits for main's `fs.watch` to notice. That is
  // the same directory-watch behaviour `monaco-reconciliation-smoke` is denied
  // for, and it does not fire under a temp-dir $HOME on every machine — the
  // check cannot wait its way out of a notification that never arrives. Checks
  // 1 and 3 pass locally.
  [
    "ghostty-config-smoke.mjs",
    "check 2 needs main's fs.watch to fire under an isolated $HOME (see monaco-reconciliation)",
  ],
  [
    "quit-window-lifecycle-smoke.mjs",
    "QUARANTINED: second Electron launch never reports a ready window",
  ],
]);

/**
 * Clearly named core e2e: gates every desktop PR AND runs after each main merge.
 * Boot/board, session/composer, terminal/worktree, CLI round-trip, DB recovery
 * and theming. Extended journeys stay gating in the rest shards.
 * `boot` remains a CLI alias for `core`, not a smaller hidden selection.
 */
export const CORE_E2E = new Set([
  "board-smoke.mjs",
  "composer-basics-smoke.mjs",
  "terminal-smoke.mjs",
  "worktree-smoke.mjs",
  "agent-socket-smoke.mjs",
  "session-rpc-transport-smoke.mjs",
  "agent-cli-roundtrip-smoke.mjs",
  "database-recovery-smoke.mjs",
  "canvas-theming-smoke.mjs",
]);

/**
 * Measured repeat flakers, NOT silent exclusions. Run nightly with artifacts;
 * each has a Backlog owner and a measured return condition. Selection/threshold
 * evidence: docs/research/smoke-flakes-2026-10.md. Never quarantine sole core
 * coverage, deterministic related failures, or credential-dependent probes.
 */
export const SMOKE_QUARANTINE = new Map([
  [
    "browser-recovery-smoke.mjs",
    "VC-523: 59/225 confirmed recoveries; lost click result / preview recovery",
  ],
  [
    "automations-picker-smoke.mjs",
    "VC-524: 15/227 confirmed recoveries; picker/drag readiness hypothesis",
  ],
  ["bare-path-env-smoke.mjs", "VC-525: 16/227 confirmed recoveries; harness readiness marker"],
]);

/**
 * Probes that must not overlap another smoke process.
 *
 * VC-219 removed the native-window cause: every smoke now receives synthetic
 * Playwright input through Chromium's event pipeline while its click-through,
 * non-key renderer runs with background throttling disabled. Re-tested after
 * that change, concurrently pairing terminal-smoke with split-view-smoke five
 * times: split-view passed 5/5 (including the tab drag), so it returned to the
 * ordinary pool; terminal passed only 2/5. In every terminal failure check 1's
 * first shell probe stayed null, and dependent checks inherited that missing
 * shell state; one run also failed to acquire its GPU backend. A dropped first
 * command cannot be waited back.
 *
 * The retained probe runs last after the concurrent pass finishes.
 */
const SERIAL = new Set([
  // Clicks and wheels a live terminal and asserts the SGR mouse reports that
  // reach its PTY; its first terminal command was not reliable under concurrent
  // startup (2/5 paired runs after throttling was disabled).
  //
  // That measurement predates VC-107 and its stated cause — WebGPU backend
  // acquisition racing PTY startup — no longer exists: the renderer is xterm's
  // DOM renderer and asks the GPU for nothing. The entry stays because nobody
  // has re-run the experiment, not because the old reason still holds. To
  // retire it, pair this probe with split-view-smoke five times
  // (`--jobs 2`) and drop the line if it passes 5/5.
  "terminal-smoke.mjs",
]);

/**
 * Probes that do not match `*-smoke.mjs` but are part of the lane anyway.
 * `agent-cli-token-bench.mjs` was on the old allow-list and is a real
 * assertion, not a screenshot generator; the `*-shots.mjs` files ARE
 * screenshot generators and deliberately stay out.
 */
const EXTRA = new Set(["agent-cli-token-bench.mjs"]);

export function parseArgs(argv, concurrencyHint = process.env.VOLLI_CONCURRENCY_HINT) {
  const args = { tier: "all", shard: null, jobs: 4, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") args.list = true;
    else if (arg === "--tier") args.tier = argv[(i += 1)];
    else if (arg === "--jobs") args.jobs = Number(argv[(i += 1)]);
    else if (arg === "--shard") args.shard = argv[(i += 1)];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["all", "core", "boot", "rest", "quarantine"].includes(args.tier)) {
    throw new Error(`--tier must be all | core | boot | rest | quarantine (got ${args.tier})`);
  }
  if (!Number.isInteger(args.jobs) || args.jobs < 1) {
    throw new Error(`--jobs must be a positive integer (got ${args.jobs})`);
  }
  const budget = Number(concurrencyHint);
  if (Number.isInteger(budget) && budget > 0) args.jobs = Math.min(args.jobs, budget);
  if (args.tier === "boot") args.tier = "core";
  return args;
}

/**
 * Whether a probe copies the developer's real `~/.pi/agent/auth.json` into its
 * scratch HOME — i.e. whether it drives a LIVE model turn.
 *
 * Detected from the source rather than from a hand-kept list, because a list is
 * what failed: `ensurePiAuthInto()` throws when the file is absent, so such a
 * probe can only ever abort on a runner, and three of them were only
 * discovered by watching CI abort. The call is the requirement, so the call is
 * what this reads. Run them locally with `pnpm smoke:pi`.
 */
function needsPiCredentials(name, e2eDir) {
  return readFileSync(join(e2eDir, name), "utf8").includes("ensurePiAuthInto(");
}

/** New probes join the gate by default; quarantine is an explicit separate lane. */
export function selectSmokes(args, e2eDir = E2E_DIR) {
  let names = readdirSync(e2eDir)
    .filter((name) => name.endsWith("-smoke.mjs") || EXTRA.has(name))
    .toSorted()
    .filter((name) => !DENY.has(name) && !needsPiCredentials(name, e2eDir));
  if (args.tier === "quarantine") {
    for (const name of SMOKE_QUARANTINE.keys()) {
      if (!names.includes(name))
        throw new Error(`quarantined smoke missing or unrunnable: ${name}`);
    }
    names = names.filter((name) => SMOKE_QUARANTINE.has(name));
  } else {
    names = names.filter((name) => !SMOKE_QUARANTINE.has(name));
    if (args.tier === "core" || args.tier === "boot") {
      for (const name of CORE_E2E) {
        if (!names.includes(name)) throw new Error(`core e2e smoke missing or unrunnable: ${name}`);
      }
      names = names.filter((name) => CORE_E2E.has(name));
    } else if (args.tier === "rest") names = names.filter((name) => !CORE_E2E.has(name));
  }
  return args.shard ? applyShard(names, args.shard) : names;
}

/**
 * `--shard i/n` → a deterministic, size-balanced slice.
 *
 * Round-robin by index rather than contiguous slicing: the heavy probes
 * (board, ticket-detail, canvas-theming, monaco-reconciliation) are spread
 * across shards instead of landing in whichever contiguous block happens to
 * hold them, so the shards finish at roughly the same time.
 */
function applyShard(names, spec) {
  const match = /^(\d+)\/(\d+)$/.exec(spec ?? "");
  if (!match) throw new Error(`--shard must look like 1/3 (got ${spec})`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index < 1 || index > total) throw new Error(`--shard ${spec} is out of range`);
  return names.filter((_, i) => i % total === index - 1);
}

/** A fresh probe process per attempt; logs persist as bytes arrive, even on cancellation. */
export function runOne(
  name,
  number,
  {
    reporter,
    children = new Set(),
    e2eDir = E2E_DIR,
    repoRoot = REPO_ROOT,
    environment = process.env,
  } = {},
) {
  const evidence = reporter?.startAttempt(name, number);
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(e2eDir, name)], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: smokeAttemptEnvironment(environment),
    });
    children.add(child);
    let output = "";
    let settled = false;
    const collect = (chunk) => {
      output += chunk;
      evidence?.output(chunk);
    };
    const finish = (code, signal = null) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      const result = { name, number, code, signal, output, ms: Date.now() - started };
      evidence?.finish(result);
      resolvePromise(result);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      collect(`\nspawn failed: ${error.message}\n`);
      finish(1);
    });
    child.once("close", (code, signal) => finish(code ?? 1, signal));
  });
}

/** A fixed-size worker pool over `names`; never schedule retries after interruption. */
async function runPool(names, jobs, { reporter, children, isInterrupted }) {
  const queue = [...names];
  const results = [];
  const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined && !isInterrupted(); next = queue.shift()) {
      const result = await runWithRetry(
        next,
        (name, number) => runOne(name, number, { reporter, children }),
        isInterrupted,
      );
      results.push(result);
      reporter.recordResult(result);
      process.stdout.write(
        `  ${result.status}  ${result.name} (${(result.ms / 1000).toFixed(1)}s)\n`,
      );
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const names = selectSmokes(args);
  if (args.list) {
    for (const name of names) process.stdout.write(`${name}\n`);
    return;
  }
  if (names.length === 0) throw new Error("no smokes selected (refusing an empty green lane)");

  const scratchRoot = join(REPO_ROOT, ".tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const reportDir =
    process.env.VOLLI_SMOKE_REPORT_DIR ?? mkdtempSync(join(scratchRoot, "smoke-results-"));
  const reporter = createSmokeReporter({
    reportDir,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
    names,
    metadata: {
      ...args,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      sha: process.env.GITHUB_SHA ?? null,
      event: process.env.GITHUB_EVENT_NAME ?? null,
    },
  });
  const children = new Set();
  let interruptedBy = null;
  const interrupt = (signal) => {
    interruptedBy = signal;
    for (const child of children) child.kill(signal);
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const execution = { reporter, children, isInterrupted: () => interruptedBy !== null };
  const startedAt = Date.now();
  try {
    const concurrent = names.filter((name) => !SERIAL.has(name));
    const exclusive = names.filter((name) => SERIAL.has(name));
    const label = `tier=${args.tier}${args.shard ? ` shard=${args.shard}` : ""} jobs=${args.jobs}`;
    process.stdout.write(`Running ${names.length} smoke(s) — ${label}\nEvidence: ${reportDir}\n`);
    if (exclusive.length > 0)
      process.stdout.write(`  (exclusive, after the rest: ${exclusive.join(", ")})\n`);
    if (args.tier !== "quarantine") {
      process.stdout.write("Quarantined to nightly Smoke quarantine (not deleted):\n");
      for (const [name, reason] of SMOKE_QUARANTINE)
        process.stdout.write(`  - ${name}: ${reason}\n`);
    }
    if (args.tier !== "core") {
      process.stdout.write(`Skipped ${DENY.size} by legacy deny-list:\n`);
      for (const [name, reason] of DENY) process.stdout.write(`  - ${name}: ${reason}\n`);
    }
    // Fully drain concurrent probes before terminal's exclusive pass.
    const results = await runPool(concurrent, args.jobs, execution);
    results.push(...(await runPool(exclusive, 1, execution)));
    const failures = results.filter((result) => result.code !== 0);
    const flaky = results.filter((result) => result.flaky);
    for (const result of results.filter((candidate) => candidate.code !== 0 || candidate.flaky)) {
      for (const attempt of result.attempts) {
        process.stdout.write(
          `\n::group::${result.status === "FAIL" ? "FAILED" : "FLAKY"} ${result.name} attempt ${attempt.number} (exit ${attempt.code}${attempt.signal ? `, ${attempt.signal}` : ""})\n${attempt.output}\n::endgroup::\n`,
        );
      }
    }
    process.stdout.write(
      `\n${results.length - failures.length}/${names.length} passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
    );
    if (flaky.length)
      process.stdout.write(
        `FLAKY (passed on retry): ${flaky.map((result) => result.name).join(", ")}\n`,
      );
    if (failures.length)
      process.stdout.write(`FAILED: ${failures.map((result) => result.name).join(", ")}\n`);
    if (failures.length || interruptedBy || results.length !== names.length) process.exitCode = 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    reporter.finish(interruptedBy);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(`smoke runner failed: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
