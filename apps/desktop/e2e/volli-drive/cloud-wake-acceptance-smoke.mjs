#!/usr/bin/env node
/**
 * The 0.3-C demo, live (VC-895 N2-3): "Waiting for <Mac>", and back.
 *
 * Two isolated volli-drive dev instances, "Mac A" and "Mac B", signed in as
 * ONE person against ONE throwaway pinned local backend, driven through
 * their real windows (snapshot → one action → fresh snapshot):
 *
 *   1. Both sign in (Settings → Account, the dev sign-in).
 *   2. Both restart into Volli Cloud and become that person's runners.
 *   3. Mac A chooses the folder for the cloud project, starts a Session and
 *      gets the streamed reply.
 *   4. Mac B shows that Session live: its transcript, "Running on <Mac A>".
 *   5. Mac A sleeps (SIMULATED: see below). Mac B reads "Waiting for
 *      <Mac A> — asleep since …".
 *   6. Mac B sends a message; it waits ("Sent — waiting for <Mac A>"), and
 *      no reply comes while Mac A sleeps.
 *   7. Mac A wakes: it is running the Session again, claims the message,
 *      runs the turn, and Mac B catches up with the reply.
 *
 * **Sleep is a simulation, and is labelled so everywhere.** Main's
 * dual-locked smoke seam (`src/main/cloud-runner/smoke-power.ts`, unpackaged
 * AND `VOLLI_SMOKE_CLOUD_RUNNER_POWER=1`) emits the real `suspend`, waits
 * for the runner's `asleep` report to land, and holds the runner's transport
 * down until the real `resume`. No process is frozen and no OS sleep
 * happens. The real lid test is the owner's, on hardware.
 *
 * SETUP and doubles, never the behaviour under test (each is in the
 * transcript): preview enrollment for the dev profile (admin key, throwaway
 * backend), the person's project (the board's public `projects.create`), the
 * "browser" that follows the dev issuer's recorded loopback URL, the native
 * folder picker (it returns a scratch-only repo), the fake model provider,
 * and a supervised restart in place of `app.relaunch()` (which under the
 * harness would start an Electron nobody drives). Reads for evidence: the
 * person's runners list and each Mac's non-secret runner record.
 *
 * Run it under the fixture, on a Mac, against a build with the loopback CSP:
 *
 *   VOLLI_CLOUD_LOOPBACK=1 pnpm -C apps/desktop run build
 *   node convex/fixture/with-backend.ts --deploy -- \
 *     node apps/desktop/e2e/volli-drive/cloud-wake-acceptance-smoke.mjs
 *
 * CI runs it in `ci-extended.yml`'s `Smoke (cloud wake acceptance)`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { waitUntil } from "../lib/smoke-kit.mjs";
import {
  CLOUD_PROJECT,
  cloudFixtureFromEnv,
  devAccessToken,
  cleanQuitProblems,
  grantPreview,
  personRunners,
  projectSessions,
  seedCloudProject,
} from "./lib/cloud-acceptance.mjs";
import { createRegistry, instanceLayout, REPO } from "./lib/core.mjs";
import { request } from "./lib/protocol.mjs";
import { hasActionableControl, visibleControls as controls } from "./lib/remote-acceptance.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));

const FIRST = "Wake demo first message";
const WHILE_ASLEEP = "Wake demo sent while asleep";
const reply = (text) => `fake-agent: ${text}`;
const STEPS = [
  [1, "Sign in on Mac A and Mac B (Settings → Account, dev sign-in)"],
  [2, "Restart both into Volli Cloud; both are the person's runners, online"],
  [3, "Mac A: Choose the folder…, New chat, send; streamed reply"],
  [4, "Mac B: Mac A's Session live, its reply, Running on <Mac A>"],
  [5, "SIMULATED sleep on Mac A: Mac B reads Waiting for <Mac A> — asleep since"],
  [6, "Mac B sends while Mac A sleeps: Sent — waiting for <Mac A>, no reply"],
  [7, "Mac A wakes: Running on <Mac A> again, the message runs, Mac B catches up"],
];

const results = [];
const instances = {};

function record(number, status, assertion, detail = "") {
  results.push({ step: number, status, assertion, detail });
  console.log(`${status} ${number}: ${assertion}${detail ? ` — ${detail}` : ""}`);
}

/** One instance's drive: every action from a fresh tree; ambiguity is a failure. */
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
    assert.ok(
      hit,
      `${label}: expected ${role} "${name}" once; found ${hits.length}\n${current.text}`,
    );
    assert.ok(!hit.includes("[disabled]"), `${label}: ${name} is disabled`);
    const ref = hit.match(/\[ref=([^\]]+)\]/u)[1];
    return (await call("act", { gen: current.generation, ref, kind, ...extra })).snapshot;
  }
  const click = (role, name, options) => action("click", role, name, {}, options);
  const type = (name, text) => action("type", "textbox", name, { text });
  return {
    label,
    call,
    snap,
    wait,
    gone,
    click,
    async send(text) {
      await waitUntil(
        `${label}: the Message box is ready`,
        async () => hasActionableControl((await snap()).text, "textbox", "Message"),
        { timeout: 30_000, interval: 200 },
      );
      await type("Message", text);
      await action("press", "textbox", "Message", { key: "Enter" });
    },
    async has(role, name, options) {
      return controls((await snap()).text, role, name, options).length > 0;
    },
    async text() {
      return (await snap()).text;
    },
    shot: (name) => call("screenshot", { name }),
  };
}

async function launch(label, subject) {
  const { stdout } = await exec(
    process.execPath,
    [
      cli,
      "launch",
      "--fixture",
      "empty",
      "--cloud",
      "--cloud-subject",
      subject,
      "--no-build",
      "--json",
    ],
    { cwd: REPO, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const launched = JSON.parse(stdout);
  const entry = await createRegistry().get(launched.id);
  const socket = instanceLayout(entry.scratch, entry.evidence).driveSocket;
  instances[label] = { id: launched.id, evidence: launched.evidence, drive: driver(label, socket) };
  return instances[label].drive;
}

async function step(number, body) {
  const assertion = STEPS.find(([n]) => n === number)[1];
  try {
    const result = await body();
    for (const { drive } of Object.values(instances))
      await drive.shot(`step-${number}`).catch(() => {});
    record(number, "PASS", assertion, result?.detail ?? "");
    return result;
  } catch (error) {
    record(number, "FAIL", assertion, error.message.split("\n")[0]);
    for (const { drive } of Object.values(instances))
      await drive.shot(`step-${number}-failed`).catch(() => {});
    throw error;
  }
}

/** Settings → Account → the agreement → Continue with GitHub; the browser double completes it. */
async function signIn(drive) {
  await drive.click("button", "Settings", { first: true });
  await drive.wait("Settings categories");
  await drive.click("button", "Account", { first: true });
  await drive.wait("Accept Preview Agreement");
  await drive.click("checkbox", "Accept Preview Agreement");
  const since = Date.now();
  await drive.click("button", "Continue with GitHub");
  await drive.call("cloud-sign-in-browser", { since });
  // A completed sign-in in a local launch offers the restart into Volli Cloud:
  // the app wrote its launch marker for this person.
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

/** The cloud project's Home on this Mac. */
async function openProject(drive) {
  await drive.wait(CLOUD_PROJECT.name, 60_000);
  if (await drive.has("button", CLOUD_PROJECT.name)) {
    await drive.click("button", CLOUD_PROJECT.name, { first: true });
  }
  if (await drive.has("button", "Home")) await drive.click("button", "Home", { first: true });
}

async function runnerStatus(fixture, token, runnerId) {
  const runners = await personRunners({ convexUrl: fixture.convexUrl, token });
  return runners.find((runner) => runner.id === runnerId) ?? null;
}

async function journey(fixture) {
  const subject = `wake-${randomBytes(4).toString("hex")}`;
  const token = () => devAccessToken({ privateKeyPem: fixture.privateKeyPem, subject });
  // SETUP: preview enrollment for the dev profile, on the throwaway backend.
  await grantPreview({ convexUrl: fixture.convexUrl, adminKey: fixture.adminKey });
  const macA = await launch("A", subject);
  const macB = await launch("B", subject);

  await step(1, async () => {
    await signIn(macA);
    await signIn(macB);
  });

  // SETUP: the person's project, through the board's own public function.
  const project = await seedCloudProject({
    convexUrl: fixture.convexUrl,
    token: token(),
    name: CLOUD_PROJECT.name,
    prefix: CLOUD_PROJECT.prefix,
  });

  const { a } = await step(2, async () => {
    await macA.call("restart", { reason: "Restart to open Volli Cloud (supervised)" });
    await macB.call("restart", { reason: "Restart to open Volli Cloud (supervised)" });
    const stateA = await cloudState(macA);
    const stateB = await cloudState(macB);
    assert.equal(stateA.userId, stateB.userId, "both Macs are the same person");
    assert.notEqual(stateA.runnerId, stateB.runnerId, "each Mac is its own runner");
    let runnerA = null;
    await waitUntil(
      "both runners online in the person's list",
      async () => {
        runnerA = await runnerStatus(fixture, token(), stateA.runnerId);
        const runnerB = await runnerStatus(fixture, token(), stateB.runnerId);
        return runnerA?.status === "online" && runnerB?.status === "online";
      },
      { timeout: 60_000, interval: 500 },
    );
    return { a: { ...stateA, name: runnerA.name }, detail: `Mac A is ${runnerA.name}` };
  });
  const nameA = a.name;

  await step(3, async () => {
    // A double at the OS boundary: the folder picker answers with a scratch repo.
    await macA.call("cloud-checkout-folder");
    await openProject(macA);
    const choose = `Choose the folder for ${CLOUD_PROJECT.name} on this Mac`;
    await macA.wait(choose, 60_000);
    await macA.click("button", choose);
    await macA.gone(choose, 30_000);
    await macA.click("button", "New chat", { first: true });
    await macA.send(FIRST);
    await macA.wait(reply(FIRST), 60_000);
  });

  await step(4, async () => {
    // Which row to open comes from the backend's own listing (a read, not a
    // guess at the auto-title): Mac A's one Session in the project, by id.
    let session = null;
    await waitUntil(
      "Mac A's Session accepted by the backend",
      async () => {
        const sessions = await projectSessions({
          convexUrl: fixture.convexUrl,
          token: token(),
          projectId: project.projectId,
        });
        session = sessions.length === 1 ? sessions[0] : null;
        return session !== null && session.placeRunnerId === a.runnerId;
      },
      { timeout: 60_000, interval: 500 },
    );
    // The listing names a Session by its title, "Chat" until it has one.
    const title = session.title ?? "Chat";
    await openProject(macB);
    await waitUntil(
      `Mac A's Session listed on Mac B as "${title}"`,
      async () => controls(await macB.text(), "button", title, { contains: true }).length > 0,
      { timeout: 60_000, interval: 500 },
    );
    await macB.click("button", title, { contains: true, first: true });
    await macB.wait(reply(FIRST), 60_000);
    await macB.wait(`Running on ${nameA}`, 30_000);
    return { detail: `Session ${session.id.slice(0, 8)} "${title}"` };
  });

  await step(5, async () => {
    const asleep = await macA.call("runner-power", { action: "suspend" });
    assert.equal(asleep.simulated, true);
    await macB.wait(`Waiting for ${nameA} — asleep since`, 45_000);
    const runner = await runnerStatus(fixture, token(), a.runnerId);
    assert.equal(runner?.status, "asleep", "the backend reads Mac A asleep");
    return { detail: "SIMULATED: real suspend event, asleep acked, runner transport held down" };
  });

  await step(6, async () => {
    await macB.send(WHILE_ASLEEP);
    await macB.wait(`Sent — waiting for ${nameA}`, 30_000);
    // It waits: nothing runs it while Mac A sleeps.
    await new Promise((done) => setTimeout(done, 5_000));
    assert.ok(!(await macB.text()).includes(reply(WHILE_ASLEEP)), "no reply while Mac A sleeps");
    const runner = await runnerStatus(fixture, token(), a.runnerId);
    assert.equal(runner?.status, "asleep", "Mac A is still asleep");
  });

  await step(7, async () => {
    await macA.call("runner-power", { action: "resume" });
    await macB.wait(`Running on ${nameA}`, 60_000);
    await macB.wait(reply(WHILE_ASLEEP), 90_000);
    await macB.gone(`Sent — waiting for ${nameA}`, 30_000);
    await macA.wait(reply(WHILE_ASLEEP), 30_000);
    const runner = await runnerStatus(fixture, token(), a.runnerId);
    assert.equal(runner?.status, "online", "the backend reads Mac A online");
  });

  for (const { drive } of Object.values(instances)) {
    const doctor = await drive.call("doctor");
    assert.ok(doctor.ok, `${drive.label}: ${JSON.stringify(doctor.problems)}`);
  }
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

if (process.platform !== "darwin") throw new Error("The cloud wake acceptance drives macOS apps");
const fixture = cloudFixtureFromEnv(process.env);
const reportDir =
  process.env.VOLLI_SMOKE_REPORT_DIR ?? join(REPO, ".scratch", "cloud-wake-acceptance");
await fs.mkdir(reportDir, { recursive: true });
let failed = false;
const cleanup = {};
try {
  await journey(fixture);
} catch (error) {
  failed = true;
  console.error(error.stack);
  for (const [number, assertion] of STEPS) {
    if (!results.some((row) => row.step === number))
      record(number, "BLOCKED", assertion, "An earlier step or its setup failed");
  }
} finally {
  for (const [label, instance] of Object.entries(instances)) {
    const stopped = await exec(process.execPath, [cli, "stop", instance.id], {
      cwd: REPO,
      timeout: 120_000,
    }).catch((error) => ({ error }));
    const manifest = await fs
      .readFile(join(instance.evidence, "manifest.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    const problems = stopped.error ? [stopped.error.message] : cleanupProblems(manifest);
    cleanup[label] = {
      id: instance.id,
      evidence: instance.evidence,
      close: manifest?.electron?.close?.kind ?? null,
      problems,
    };
    if (problems.length > 0) failed = true;
  }
  const complete =
    !failed &&
    results.length === STEPS.length &&
    results.every((row) => row.status === "PASS") &&
    Object.keys(cleanup).length === 2;
  await fs.writeFile(
    join(reportDir, "acceptance.json"),
    JSON.stringify(
      {
        commit: (await exec("git", ["rev-parse", "HEAD"], { cwd: REPO })).stdout.trim(),
        simulation:
          "Sleep is SIMULATED: real power events through main's dual-locked smoke seam, runner transport held down. No OS sleep.",
        complete,
        failed,
        results,
        cleanup,
      },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Cloud wake acceptance (two Macs; sleep SIMULATED)\n\n${results
        .map(
          (row) =>
            `- **${row.status} ${row.step}** ${row.assertion}${row.detail ? ` — ${row.detail}` : ""}`,
        )
        .join("\n")}\n\nCleanup: ${Object.entries(cleanup)
        .map(
          ([label, c]) =>
            `Mac ${label} ${c.problems.length === 0 ? "PASS" : `FAIL (${c.problems.join("; ")})`}`,
        )
        .join(", ")}. complete:${complete} in acceptance.json.\n`,
    );
}
process.exitCode = failed ? 1 : 0;
