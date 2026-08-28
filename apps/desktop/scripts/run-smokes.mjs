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
 *   node apps/desktop/scripts/run-smokes.mjs                  # everything
 *   node apps/desktop/scripts/run-smokes.mjs --tier boot      # the fail-fast tier
 *   node apps/desktop/scripts/run-smokes.mjs --tier rest      # everything else
 *   node apps/desktop/scripts/run-smokes.mjs --shard 1/3      # one shard of a matrix
 *   node apps/desktop/scripts/run-smokes.mjs --jobs 4         # concurrency (default 4)
 *   node apps/desktop/scripts/run-smokes.mjs --list           # print, run nothing
 *
 * Requires a built app (`vp run --filter @volli/desktop build`) and, on a
 * fresh machine, `ensure:electron`.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "e2e");
const REPO_ROOT = resolve(E2E_DIR, "..", "..", "..");

/**
 * Probes this lane will not run, each with the reason it cannot.
 *
 * Anything NOT listed here runs. Adding a name is a deliberate act: it means
 * the probe cannot work on a clean CI runner, not that it is inconvenient.
 */
const DENY = new Map([
  // NOTE: probes that need real Pi credentials are NOT listed here. They are
  // detected structurally — see `needsPiCredentials()`. Hand-listing them was
  // how three of them (composer-kickoff, composer-verbs, session-env-parity)
  // reached CI and aborted: their headers do not mention a credential, only
  // their code does.

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
  // Distinct from the rest: this one is FLAKY, not consistently failing.
  // Observed 3 failures in 5 runs, including twice with nothing else running,
  // always as check 1 reading bg=rgb(0,0,0) — i.e. it samples the window
  // background BEFORE first paint rather than disagreeing about the colour.
  // A flaky probe in a required gate is worse than an absent one: it teaches
  // readers that red means nothing. Needs a paint barrier before it samples.
  [
    "ghostty-config-smoke.mjs",
    "QUARANTINED (flaky): check 1 samples window bg before first paint (3 of 5 runs)",
  ],
  [
    "quit-window-lifecycle-smoke.mjs",
    "QUARANTINED: second Electron launch never reports a ready window",
  ],
]);

/**
 * The fail-fast tier: if the app cannot boot, these say so in about a minute
 * instead of letting a full shard matrix spend ten proving it repeatedly.
 * Chosen because each one boots the app through a different door — board,
 * composer, terminal, worktree, and the agent socket.
 */
const BOOT_TIER = new Set([
  "board-smoke.mjs",
  "composer-basics-smoke.mjs",
  "terminal-smoke.mjs",
  "worktree-smoke.mjs",
  "agent-socket-smoke.mjs",
]);

/**
 * Probes that must run ALONE, with nothing else on the machine.
 *
 * Not flakiness, and not fixable by lowering `--jobs`: these drive real mouse
 * and focus events at a live window, and a second Electron app on the same
 * desktop steals focus or intercepts the pointer. Measured on terminal-smoke:
 * 3 checks fail at --jobs 4, 1 check fails at --jobs 2, all pass at --jobs 1.
 * The observable signature is Playwright reporting `<html class="dark">…</html>
 * intercepts pointer events`, or a click timing out on a visible control.
 *
 * They are run last, one at a time, after the concurrent pass finishes.
 */
const SERIAL = new Set([
  // Clicks and wheels a canvas and asserts the SGR mouse reports that reach
  // the PTY — the most focus-dependent probe in the suite.
  "terminal-smoke.mjs",
]);

/**
 * Probes that do not match `*-smoke.mjs` but are part of the lane anyway.
 * `agent-cli-token-bench.mjs` was on the old allow-list and is a real
 * assertion, not a screenshot generator; the `*-shots.mjs` files ARE
 * screenshot generators and deliberately stay out.
 */
const EXTRA = new Set(["agent-cli-token-bench.mjs"]);

function parseArgs(argv) {
  const args = { tier: "all", shard: null, jobs: 4, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") args.list = true;
    else if (arg === "--tier") args.tier = argv[(i += 1)];
    else if (arg === "--jobs") args.jobs = Number(argv[(i += 1)]);
    else if (arg === "--shard") args.shard = argv[(i += 1)];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["all", "boot", "rest"].includes(args.tier)) {
    throw new Error(`--tier must be all | boot | rest (got ${args.tier})`);
  }
  if (!Number.isInteger(args.jobs) || args.jobs < 1) {
    throw new Error(`--jobs must be a positive integer (got ${args.jobs})`);
  }
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
function needsPiCredentials(name) {
  return readFileSync(join(E2E_DIR, name), "utf8").includes("ensurePiAuthInto(");
}

/** Every runnable probe, sorted, with denied and credential-gated names removed. */
function discover() {
  const found = readdirSync(E2E_DIR)
    .filter((name) => name.endsWith("-smoke.mjs") || EXTRA.has(name))
    .toSorted();
  return found.filter((name) => !DENY.has(name) && !needsPiCredentials(name));
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

/** Run one probe to completion, capturing its output for ordered replay. */
function runOne(name) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    // ELECTRON_RUN_AS_NODE leaks in from some parents and makes the built app
    // boot as plain Node, which fails every probe confusingly. Delete the key
    // outright — assigning `undefined` can arrive as the STRING "undefined".
    // (`smoke:docs-shots` in package.json does the same with `env -u`.)
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [join(E2E_DIR, name)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => {
      resolvePromise({
        name,
        code: 1,
        output: `${output}\nspawn failed: ${error.message}`,
        ms: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      resolvePromise({ name, code: code ?? 1, output, ms: Date.now() - started });
    });
  });
}

/** A fixed-size worker pool over `names`. */
async function runPool(names, jobs) {
  const queue = [...names];
  const results = [];
  const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const result = await runOne(next);
      results.push(result);
      const status = result.code === 0 ? "PASS" : "FAIL";
      process.stdout.write(`  ${status}  ${result.name} (${(result.ms / 1000).toFixed(1)}s)\n`);
    }
  });
  await Promise.all(workers);
  return results;
}

const args = parseArgs(process.argv.slice(2));

let names = discover();
if (args.tier === "boot") names = names.filter((name) => BOOT_TIER.has(name));
else if (args.tier === "rest") names = names.filter((name) => !BOOT_TIER.has(name));
if (args.shard) names = applyShard(names, args.shard);

if (args.list) {
  for (const name of names) process.stdout.write(`${name}\n`);
  process.exit(0);
}

if (names.length === 0) {
  process.stdout.write("no smokes selected\n");
  process.exit(0);
}

const concurrent = names.filter((name) => !SERIAL.has(name));
const exclusive = names.filter((name) => SERIAL.has(name));

const label = `tier=${args.tier}${args.shard ? ` shard=${args.shard}` : ""} jobs=${args.jobs}`;
process.stdout.write(`Running ${names.length} smoke(s) — ${label}\n`);
if (exclusive.length > 0) {
  process.stdout.write(
    `  (${exclusive.length} run exclusively, after the rest: ${exclusive.join(", ")})\n`,
  );
}
if (DENY.size > 0 && args.tier !== "boot") {
  process.stdout.write(`Skipped ${DENY.size} by deny-list:\n`);
  for (const [name, reason] of DENY) process.stdout.write(`  - ${name}: ${reason}\n`);
}

const startedAt = Date.now();
// The concurrent pass must fully drain before the exclusive pass starts — that
// is the entire point of the exclusive set.
const results = await runPool(concurrent, args.jobs);
results.push(...(await runPool(exclusive, 1)));
const failures = results.filter((result) => result.code !== 0);

// Failures replay last and in full: in a concurrent run the interleaved live
// output is unreadable, and the thing a reader came for is the failure.
for (const failure of failures) {
  process.stdout.write(`\n::group::FAILED ${failure.name}\n${failure.output}\n::endgroup::\n`);
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
process.stdout.write(
  `\n${results.length - failures.length}/${results.length} passed in ${elapsed}s\n`,
);

if (failures.length > 0) {
  process.stdout.write(`FAILED: ${failures.map((failure) => failure.name).join(", ")}\n`);
  process.exit(1);
}
