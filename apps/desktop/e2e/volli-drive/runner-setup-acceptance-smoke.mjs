#!/usr/bin/env node
/**
 * The BYO-6 runner-setup sheet, live (VC-1039): Settings → Runners →
 * "Add a runner" mints a one-time install token, a fake Linux box spends it
 * over the real `/runner/*` wire, and the open sheet turns into
 * "<name> is online. Pick it in the composer." The steps below print as they
 * run; each one is a fresh snapshot, one action, a fresh snapshot again.
 *
 * ONE isolated volli-drive dev instance, signed in as one person against ONE
 * throwaway pinned local backend (`convex/fixture/with-backend.ts --deploy`):
 *
 *   1. Settings → Account: the dev sign-in.
 *   2. Restart into Volli Cloud; this Mac is one of the person's runners.
 *   3. Settings → Runners → Add a runner: the sheet's own command, minted by
 *      the backend's `runners.createInstallToken`.
 *   4. The token is read out of the command the sheet renders — in memory —
 *      and handed to the box through its environment. The box POSTs
 *      `/runner/link` (`linkWithInstallToken`); the sheet reads "<name> is
 *      linked. Waiting for it to come online…".
 *   5. The box exchanges the refresh credential at `/runner/token` for a
 *      runner JWT, keeping the rotated credential in memory.
 *   6. That token's real `runners.reportCapabilities` and `runners.heartbeat`
 *      make the box online, and the sheet reads "<name> is online. Pick it in
 *      the composer."
 *
 * SIMULATION, labelled so everywhere: the box (`lib/runner-box.mjs`) is not a
 * Volli build and not the `volli-runner` installer. It is a separate Node
 * process speaking the real wire; nothing is injected into the app. SETUP and
 * doubles, never the behaviour under test: preview enrollment for the dev
 * profile, the "browser" that follows the dev issuer's recorded loopback URL
 * (the app's own dev seam), and a supervised restart in place of
 * `app.relaunch()`. Evidence is read from the person's own `runners.list`.
 *
 * The one-time token is never logged, never in a screenshot, and never in this
 * run's report. The driver's snapshot files are scrubbed after stop, even if
 * linking failed. The rotated refresh credential and runner JWT stay in the box.
 * Screenshots are therefore taken only after the token is spent.
 *
 * CI ONLY, on a disposable macOS GitHub runner with the loopback CSP
 * (`VOLLI_CLOUD_LOOPBACK=1`) built and Electron fetched:
 *
 *   node convex/fixture/with-backend.ts --deploy -- \
 *     node apps/desktop/e2e/volli-drive/runner-setup-acceptance-smoke.mjs
 *
 * The `ci-extended.yml` step is BYO-14's. No other registration is needed: the
 * rest tier globs `e2e/*-smoke.mjs`, and this journey starts its own Chromium.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { waitUntil } from "../lib/smoke-kit.mjs";
import {
  cleanQuitProblems,
  cloudFixtureFromEnv,
  devAccessToken,
  grantPreview,
  personRunners,
} from "./lib/cloud-acceptance.mjs";
import { createRegistry, instanceLayout, REPO } from "./lib/core.mjs";
import { request } from "./lib/protocol.mjs";
import {
  installCommandFromSnapshot,
  redactInstallTokens,
  scrubRunnerSetupEvidence,
} from "./lib/runner-setup-evidence.mjs";
import { hasActionableControl, visibleControls as controls } from "./lib/remote-acceptance.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const boxPath = fileURLToPath(new URL("./lib/runner-box.mjs", import.meta.url));

/** What the person types in the sheet; the backend slugs it to the runner's name. */
const NAME = "byo6-box";
/** The sentence the open sheet must turn into once the box is really online. */
const ONLINE = `${NAME} is online. Pick it in the composer.`;
const STEPS = [
  [1, "Sign in (Settings → Account, dev sign-in)"],
  [2, "Restart into Volli Cloud: this Mac is one of the person's runners, online"],
  [3, "Settings → Runners → Add a runner: the sheet mints its one-line install command"],
  [4, "SIMULATED box spends the sheet's token: POST /runner/link creates a Linux runner"],
  [5, "The box exchanges the refresh credential at POST /runner/token, rotating it"],
  [6, "Real report and heartbeat make the box online: the sheet says so"],
];

const results = [];
const instances = {};
const box = { child: null, events: [], lines: [], error: null, exit: null };
/** Set once the install token has been spent: only then may a screenshot exist. */
let spent = false;

function record(number, status, assertion, detail = "") {
  const safeDetail = redactInstallTokens(detail);
  results.push({ step: number, status, assertion, detail: safeDetail });
  console.log(`${status} ${number}: ${assertion}${safeDetail ? ` — ${safeDetail}` : ""}`);
}

/** One instance's drive: every action from a fresh tree, and no tree or secret in any error. */
function driver(label, socket) {
  const call = (cmd, args = {}) => request(socket, cmd, args, { timeoutMs: 150_000 });
  const snap = () => call("snapshot");
  const wait = async (text, timeout = 45_000) => (await call("wait", { text, timeout })).snapshot;
  const gone = async (text, timeout = 45_000) =>
    (await call("wait", { text, timeout, gone: true })).snapshot;
  async function action(kind, role, name, extra = {}, options = {}) {
    const current = await snap();
    const hits = controls(current.text, role, name, options);
    const hit = options.first ? hits[0] : hits.length === 1 ? hits[0] : null;
    assert.ok(hit, `${label}: expected ${role} "${name}" once; found ${hits.length}`);
    assert.ok(!hit.includes("[disabled]"), `${label}: "${name}" is disabled`);
    const ref = hit.match(/\[ref=([^\]]+)\]/u)[1];
    return (await call("act", { gen: current.generation, ref, kind, ...extra })).snapshot;
  }
  return {
    label,
    call,
    snap,
    wait,
    gone,
    click: (role, name, options) => action("click", role, name, {}, options),
    type: (role, name, text) => action("type", role, name, { text }),
    async text() {
      return (await snap()).text;
    },
    /** A screenshot only once no secret can be on screen (see the header). */
    shot: async (name) =>
      spent ? call("screenshot", { name }) : { skipped: "a token was on screen" },
  };
}

async function launch(label, subject) {
  const args = [cli, "launch", "--fixture", "empty", "--cloud", "--cloud-subject", subject];
  const { stdout } = await exec(process.execPath, [...args, "--no-build", "--json"], {
    cwd: REPO,
    timeout: 300_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const launched = JSON.parse(stdout);
  const entry = await createRegistry().get(launched.id);
  const layout = instanceLayout(entry.scratch, entry.evidence);
  instances[label] = {
    id: launched.id,
    evidence: launched.evidence,
    layout,
    drive: driver(label, layout.driveSocket),
  };
  return instances[label].drive;
}

async function step(number, body) {
  const assertion = STEPS.find(([n]) => n === number)[1];
  const drive = instances.Mac.drive;
  try {
    const result = await body();
    await drive.shot(`step-${number}`).catch(() => {});
    record(number, "PASS", assertion, result?.detail ?? "");
    return result;
  } catch (error) {
    record(number, "FAIL", assertion, error.message.split("\n")[0]);
    await drive.shot(`step-${number}-failed`).catch(() => {});
    throw error;
  }
}

/** Settings → Account → the agreement → Continue with GitHub; the browser double completes it. */
async function signIn(drive) {
  await drive.wait("Settings", 60_000);
  await drive.click("button", "Settings", { first: true });
  await drive.wait("Settings categories");
  await drive.click("button", "Account", { first: true });
  await drive.wait("Accept Preview Agreement");
  await drive.click("checkbox", "Accept Preview Agreement");
  const since = Date.now();
  await drive.click("button", "Continue with GitHub");
  await drive.call("cloud-sign-in-browser", { since });
  // A completed sign-in in a local launch offers the restart into Volli Cloud.
  await drive.wait("Restart to open Volli Cloud", 60_000);
}

/** This Mac's signed-in person and its runner, once it has registered. */
async function cloudState(drive) {
  let state = null;
  await waitUntil(
    `${drive.label}: registered as a runner`,
    async () => {
      state = await drive.call("cloud-state");
      return state.userId !== null && state.runnerId !== null;
    },
    { timeout: 60_000, interval: 500 },
  );
  return state;
}

/** The box's stdout is NDJSON events; its stderr is "stage: code" lines, nothing else. */
function readLines(stream, receive, { json = false } = {}) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === "") continue;
      if (!json) {
        receive(line);
        continue;
      }
      try {
        receive(JSON.parse(line));
      } catch {
        box.error = "the box printed a line that is not one of its events";
      }
    }
  });
}

/** The box: a separate Node process, its token in the environment, never in argv. */
function startBox({ installToken, siteUrl, convexUrl, version }) {
  const child = spawn(process.execPath, [boxPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      VOLLI_RUNNER_TOKEN: installToken,
      VOLLI_BOX_SITE_URL: siteUrl,
      VOLLI_BOX_CONVEX_URL: convexUrl,
      VOLLI_BOX_VERSION: version,
    },
  });
  box.child = child;
  readLines(child.stdout, (event) => box.events.push(event), { json: true });
  readLines(child.stderr, (line) => box.lines.push(line));
  child.on("error", (error) => {
    box.error = error.message;
  });
  child.on("exit", (code, signal) => {
    box.exit = { code, signal };
  });
}

async function awaitBox(event, timeout = 60_000) {
  const found = box.events.find((row) => row.event === event);
  if (found !== undefined) return found;
  return waitUntil(
    `the fake box to report "${event}"`,
    () => {
      const seen = box.events.find((row) => row.event === event);
      if (seen !== undefined) return seen;
      if (box.error !== null) throw new Error(box.error);
      if (box.exit !== null)
        throw new Error(
          `the box exited (${box.exit.code ?? box.exit.signal}) before "${event}"${box.lines.length > 0 ? `: ${box.lines.at(-1)}` : ""}`,
        );
      return null;
    },
    { timeout, interval: 100 },
  );
}

/** The phase boundary: the harness has read `linked`, so the box may connect. */
function releaseBox() {
  box.child.stdin.write("go\n");
}

/** SIGTERM, then prove it stopped itself; a box that has to be killed is a problem. */
async function stopBox() {
  const child = box.child;
  if (child === null) return [];
  if (box.exit === null) {
    child.kill("SIGTERM");
    child.stdin.end();
    const stopped = await waitUntil("the fake box to stop", () => box.exit !== null, {
      timeout: 15_000,
      interval: 50,
    }).catch(() => false);
    if (!stopped) {
      child.kill("SIGKILL");
      return ["the fake box ignored SIGTERM"];
    }
  }
  const problems = [];
  if (box.exit?.code !== 0 || box.exit?.signal !== null)
    problems.push(`the fake box exited ${JSON.stringify(box.exit)}`);
  if (!box.events.some((row) => row.event === "stopped"))
    problems.push("the fake box did not record its own stop");
  return problems;
}

async function journey(fixture) {
  const subject = `byo6-${randomBytes(4).toString("hex")}`;
  const token = () => devAccessToken({ privateKeyPem: fixture.privateKeyPem, subject });
  const runnerRow = async (runnerId) =>
    (await personRunners({ convexUrl: fixture.convexUrl, token: token() })).find(
      (runner) => runner.id === runnerId,
    ) ?? null;
  // SETUP: preview enrollment for the dev profile, on the throwaway backend.
  await grantPreview({ convexUrl: fixture.convexUrl, adminKey: fixture.adminKey });
  const mac = await launch("Mac", subject);

  await step(1, async () => signIn(mac));

  await step(2, async () => {
    await mac.call("restart", { reason: "Restart to open Volli Cloud (supervised)" });
    const state = await cloudState(mac);
    let thisMac = null;
    await waitUntil(
      "this Mac online in the person's runners",
      async () => {
        thisMac = await runnerRow(state.runnerId);
        return thisMac?.status === "online";
      },
      { timeout: 60_000, interval: 500 },
    );
    return { detail: `this Mac is ${thisMac.name}, online; person ${state.userId.slice(0, 8)}` };
  });

  await step(3, async () => {
    await mac.click("button", "Settings", { first: true });
    await mac.wait("Settings categories", 30_000);
    await mac.click("button", "Runners", { first: true });
    // The sheet is only offered when this cloud launch names its own backend
    // and the app knows its version: wait for the button, and name what it
    // says if it never becomes usable (a quiet setup fault, not the journey).
    let seen = "(no Add a runner button)";
    await waitUntil(
      "the Add a runner sheet to be available",
      async () => {
        const tree = await mac.text();
        seen = controls(tree, "button", "Add a runner")[0] ?? "(no Add a runner button)";
        return hasActionableControl(tree, "button", "Add a runner");
      },
      { timeout: 30_000, interval: 250 },
    ).catch((error) => {
      throw new Error(`${error.message}; it reads ${seen.replace(/u?\[ref=[^\]]+\] /u, "")}`);
    });
    await mac.click("button", "Add a runner");
    await mac.wait("Create install command", 30_000);
    await mac.type("textbox", "Runner name", NAME);
    await mac.click("button", "Create install command");
    return { detail: `${NAME} typed in the sheet, command requested` };
  });

  let linked;
  await step(4, async () => {
    let command = "";
    await waitUntil(
      "the sheet to show the one-line install command",
      async () => {
        command = await mac.text();
        return /vrt_[A-Za-z0-9_-]{20,}/u.test(command);
      },
      { timeout: 60_000, interval: 250 },
    );
    const { installToken, version } = installCommandFromSnapshot(command);
    // Drop the token-bearing snapshot text as soon as the token is read out.
    command = "";
    startBox({ installToken, siteUrl: fixture.siteUrl, convexUrl: fixture.convexUrl, version });
    linked = await awaitBox("linked");
    spent = true;
    assert.equal(linked.name, NAME, "the sheet's own name named the runner");
    await mac.wait(`${NAME} is linked. Waiting for it to come online`, 45_000);
    const runner = await runnerRow(linked.runnerId);
    assert.ok(runner, "the person's runners list has the box");
    assert.equal(runner.kind, "linux");
    assert.equal(runner.linkedVia, "install_token");
    assert.equal(runner.status, "offline", "linked is not yet connected");
    return {
      detail: `box ${linked.runnerId.slice(0, 8)} linked via POST /runner/link (installer v${version}); sheet: linked, waiting`,
    };
  });

  await step(5, async () => {
    releaseBox();
    const exchanged = await awaitBox("token");
    assert.equal(exchanged.rotated, true, "the refresh credential rotated");
    assert.ok(exchanged.expiresAt > exchanged.serverTime, "the token expires in the future");
    return {
      detail: `credential generation ${exchanged.generation}, token good for ${Math.round(exchanged.ttlMs / 60_000)} min`,
    };
  });

  await step(6, async () => {
    const reported = await awaitBox("reported");
    assert.equal(reported.changed, true, "the backend took the host report");
    const online = await awaitBox("online", 90_000);
    assert.equal(online.status, "online");
    const runner = await runnerRow(linked.runnerId);
    assert.equal(runner?.status, "online", "the backend reads the box online");
    assert.equal(runner?.version, reported.version);
    await mac.wait(ONLINE, 60_000);
    // The command, and with it the token, is off screen; the sheet says online.
    await mac.gone("Waiting for the box", 15_000);
    await mac.gone("--token", 15_000);
    return { detail: `sheet reads "${ONLINE}"` };
  });

  const doctor = await mac.call("doctor");
  assert.ok(doctor.ok, `${mac.label}: ${JSON.stringify(doctor.problems)}`);
  return { subject };
}

/** Stop quits for real, removes the scratch tree, and leaves no process and no keychain touch behind. */
function cleanupProblems(manifest) {
  if (!manifest) return ["stop left no manifest"];
  const problems = [];
  if (manifest.scratchRemoved !== true) problems.push("scratch not removed");
  if (!Array.isArray(manifest.keychainViolations) || manifest.keychainViolations.length > 0)
    problems.push("keychain violations");
  if (manifest.keychainViolationExit !== false) problems.push("keychain violation exit");
  if (!Array.isArray(manifest.leftovers) || manifest.leftovers.length > 0)
    problems.push(`leftover processes: ${JSON.stringify(manifest.leftovers)}`);
  // Quit for real (the Tray's Quit Volli in a cloud launch), not terminated.
  if (manifest.electron?.trayQuit?.exited !== true) problems.push("Tray Quit Volli did not quit");
  problems.push(...cleanQuitProblems(manifest.electron?.close));
  return problems;
}

/** One results line (stdout's shape) for the report and the job summary. */
const resultsLine = (row) =>
  `- **${row.status} ${row.step}** ${row.assertion}${row.detail ? ` — ${row.detail}` : ""}`;
const verdict = (problems) => (problems.length === 0 ? "PASS" : `FAIL (${problems.join("; ")})`);

// Check before launching Electron or changing the fixture: never run this on
// a local developer Mac, even when fixture environment variables are present.
if (
  process.platform !== "darwin" ||
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_OS !== "macOS"
)
  throw new Error("Runner setup acceptance runs only on disposable macOS GitHub CI runners");
// This journey follows the sheet's token, not an object store: never consume
// an ambient bucket origin (`cli launch --cloud` inherits this environment).
delete process.env.VOLLI_CLOUD_STORAGE_ORIGIN;
const fixture = cloudFixtureFromEnv();
const reportDir =
  process.env.VOLLI_SMOKE_REPORT_DIR ?? join(REPO, ".scratch", "runner-setup-acceptance");
await fs.mkdir(reportDir, { recursive: true });
let failed = false;
const cleanup = {};
const boxProblems = [];
let boxEvidence = null;
// What this drive home held before the journey: a launch that failed after it
// reserved is stopped in the sweep below, because it never reached `instances`.
const known = new Set((await createRegistry().list()).map((entry) => entry.id));
try {
  assert.ok(fixture.adminKey, "the throwaway backend's admin key is required");
  await journey(fixture);
} catch (error) {
  failed = true;
  console.error(redactInstallTokens(error.stack ?? "Runner setup acceptance failed"));
  for (const [number, assertion] of STEPS) {
    if (!results.some((row) => row.step === number))
      record(number, "BLOCKED", assertion, "An earlier step or its setup failed");
  }
} finally {
  boxProblems.push(...(await stopBox().catch((error) => [error.message])));
  // The box's evidence is its events only: runner id, name, status, timings.
  boxEvidence = { events: box.events, stderr: box.lines, exit: box.exit };
  for (const [label, instance] of Object.entries(instances)) {
    const stopped = await exec(process.execPath, [cli, "stop", instance.id], {
      cwd: REPO,
      timeout: 120_000,
    }).catch((error) => ({ error }));
    const manifest = await fs
      .readFile(join(instance.evidence, "manifest.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    const problems = stopped.error
      ? [redactInstallTokens(stopped.error.message)]
      : cleanupProblems(manifest);
    await scrubRunnerSetupEvidence(instance.evidence).catch(() => {
      problems.push("Could not scrub install-token snapshots");
    });
    cleanup[label] = {
      id: instance.id,
      evidence: instance.evidence,
      close: manifest?.electron?.close?.kind ?? null,
      problems,
    };
    if (problems.length > 0) failed = true;
  }
  // A launch that failed before reporting its id still reserved an instance:
  // stop anything this drive home gained that the journey never recorded.
  const recorded = new Set(Object.values(instances).map((instance) => instance.id));
  for (const entry of await createRegistry().list()) {
    if (!entry.live || recorded.has(entry.id) || known.has(entry.id)) continue;
    const stopped = await exec(process.execPath, [cli, "stop", entry.id], {
      cwd: REPO,
      timeout: 120_000,
    }).catch((error) => ({ error }));
    await scrubRunnerSetupEvidence(entry.evidence).catch(() => {
      failed = true;
    });
    cleanup[`unrecorded:${entry.id}`] = {
      id: entry.id,
      evidence: entry.evidence,
      close: null,
      problems: stopped.error ? [`stop failed: ${stopped.error.message}`] : [],
    };
    if (stopped.error) failed = true;
  }
  if (boxProblems.length > 0) failed = true;
  const complete =
    !failed &&
    results.length === STEPS.length &&
    results.every((row) => row.status === "PASS") &&
    boxProblems.length === 0 &&
    Object.values(cleanup).every((entry) => entry.problems.length === 0);
  await fs.writeFile(
    join(reportDir, "acceptance.json"),
    JSON.stringify(
      {
        commit: (await exec("git", ["rev-parse", "HEAD"], { cwd: REPO })).stdout.trim(),
        simulation:
          "The Linux box is SIMULATED: a separate Node process speaking the real /runner/link → /runner/token wire and real report/heartbeat mutations. No Volli runner build, nothing injected into the app.",
        complete,
        failed,
        results,
        box: boxEvidence,
        cleanup,
      },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    const cleanupText =
      Object.entries(cleanup)
        .map(([label, entry]) => `${label} ${verdict(entry.problems)}`)
        .join(", ") || "no instance launched";
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Runner setup acceptance (one Mac; the Linux box is SIMULATED)\n\n${results
        .map(resultsLine)
        .join(
          "\n",
        )}\n\nCleanup: ${cleanupText}. Fake box: ${verdict(boxProblems)}. complete:${complete} in acceptance.json.\n`,
    );
  }
}
process.exitCode = failed ? 1 : 0;
