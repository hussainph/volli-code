/**
 * The two-Mac Automation acceptance's shared half (VC-1004, B3b-6).
 *
 * `cloud-wake-acceptance-smoke.mjs` proves a Session follows its Mac; this
 * journey proves an **Automation** runs on the Mac its armer chose, waits
 * while that Mac is asleep, and starts exactly one Run when it wakes. The
 * pieces here are the ones both journeys need and the ones only this one
 * needs, kept apart from the wake scenario so neither has to know the other:
 *
 * - the generic volli-drive driver (snapshot → one action → fresh snapshot),
 *   cloud launch, dev sign-in and board navigation. These parallel the wake
 *   journey's private driver without changing that established acceptance;
 * - SETUP writes through the backend's own public functions (an Automation, a
 *   ticket), never through a product shortcut;
 * - the guarded test hooks the fixture backend exposes for time
 *   (`testAutomations.coalescePastOccurrences`, `inspectSchedule`),
 *   which the clock test also uses, and the pure arithmetic that makes a
 *   backdated schedule fire exactly one occurrence;
 * - the copy the renderer prints for "waiting" and "skipped", mirrored here so
 *   a driver waits for the product's words rather than a paraphrase, and the
 *   provenance mark's label for a Run-started Session.
 *
 * **Every clock and sleep step is a simulation, and says so.** No OS sleep
 * happens (`runner-power`, main's dual-locked seam) and no scheduled minute
 * passes (`coalescePastOccurrences`); the product code path is the real
 * one in both cases.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { waitUntil } from "../../lib/smoke-kit.mjs";
import { cleanQuitProblems } from "./cloud-acceptance.mjs";
import { createRegistry, instanceLayout, REPO } from "./core.mjs";
import { request } from "./protocol.mjs";
import { hasActionableControl, visibleControls as controls } from "./remote-acceptance.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** SETUP: the person's project, seeded through `projects.create` before the Macs read it. */
export const AUTOMATION_PROJECT = Object.freeze({ name: "Automation demo", prefix: "AUTO" });

/** The ticket B moves; the arrival's target. */
export const ARRIVAL_TICKET = Object.freeze({ title: "Move me into Doing" });

/**
 * The two Automation records. SETUP creates the definitions (a saved record is
 * authored data, not the behaviour under test); the Macs arm them themselves,
 * which is what this journey measures.
 *
 * The fixture default is :17, not a staggered top-of-hour occurrence. The
 * live journey chooses another NONZERO minute far enough in the future that
 * no natural occurrence can race its explicit clock simulation. In UTC,
 * consecutive occurrences remain exactly one hour apart.
 */
export const DOING_AUTOMATION = Object.freeze({
  name: "Doing sweep",
  instructions: "DOING-SWEEP: read the ticket and report one next step.",
  trigger: Object.freeze({ kind: "columns", columns: Object.freeze(["doing"]) }),
});
export const SCHEDULE_AUTOMATION = Object.freeze({
  name: "Hourly sweep",
  instructions: "HOURLY-SWEEP: sweep the project and report one finding.",
  schedule: Object.freeze({ preset: "hourly", minute: 17, timeZone: "UTC" }),
  trigger: Object.freeze({ kind: "schedule" }),
});

/* ----------------------------------------------------------- the driver --- */

/** Board cards are unnamed buttons. Resolve the enclosing button from the
 * title paragraph INSIDE its article, using only refs in this snapshot.
 * See verify-volli's board recipe; never guess a ref or target an unrelated button. */
export function ticketCardButtonRef(tree, title) {
  const ancestors = [];
  const matches = [];
  for (const line of tree.split("\n")) {
    const node = /^(\s*)- '?([a-z]+)(?=[\s:]|$)/u.exec(line);
    if (node === null) continue;
    const indent = node[1].length;
    while (ancestors.length > 0 && ancestors.at(-1).indent >= indent) ancestors.pop();
    const ref = /\[ref=([^\]]+)\]/u.exec(line)?.[1];
    if (node[2] === "paragraph" && ref !== undefined && /\]: (.*)$/u.exec(line)?.[1] === title) {
      const article = ancestors.findLastIndex((parent) => parent.role === "article");
      const button =
        article < 0
          ? undefined
          : ancestors.slice(0, article).findLast((parent) => parent.role === "button");
      if (button?.ref !== undefined) matches.push(button.ref);
    }
    ancestors.push({ indent, role: node[2], ref });
  }
  assert.equal(
    matches.length,
    1,
    `expected one card titled ${JSON.stringify(title)}; found ${matches.length}\n${tree}`,
  );
  return matches[0];
}

/**
 * One instance's drive: every action from a fresh tree; ambiguity is a failure.
 * The same contract `cloud-wake-acceptance-smoke.mjs` uses, so a scenario
 * reads as the person's steps rather than as Playwright.
 */
export function driveInstance(label, socket) {
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
  return {
    label,
    call,
    snap,
    wait,
    gone,
    click: (role, name, options) => action("click", role, name, {}, options),
    press: (role, name, key, options) => action("press", role, name, { key }, options),
    async openTicketCard(title) {
      // Click selects/focuses the card; Enter opens its real keyboard door.
      // Re-resolve after the click because that action creates a new generation.
      for (const [kind, extra] of [
        ["click", {}],
        ["press", { key: "Enter" }],
      ]) {
        const current = await snap();
        const ref = ticketCardButtonRef(current.text, title);
        await call("act", { gen: current.generation, ref, kind, ...extra });
      }
    },
    /** A key to whatever holds focus — how a Popover or sheet is dismissed. */
    async pressKey(key) {
      const current = await snap();
      return (await call("act", { gen: current.generation, kind: "press", key })).snapshot;
    },
    type: (role, name, text, options) => action("type", role, name, { text }, options),
    async has(role, name, options) {
      return controls((await snap()).text, role, name, options).length > 0;
    },
    async text() {
      return (await snap()).text;
    },
    shot: (name) => call("screenshot", { name }),
  };
}

/* ------------------------------------------------- launching and signing --- */

/**
 * One isolated dev instance against the fixture backend (launch, then its
 * socket). `fakeScriptPath` is the instance's ordered fake-provider reply queue
 * (`--fake-script`): read once, before launch, so it can only be written from
 * what is known up front.
 */
export async function launchCloudInstance({
  label,
  subject,
  storageOrigin,
  fakeScriptPath,
  env = process.env,
}) {
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
      ...(fakeScriptPath === undefined ? [] : ["--fake-script", fakeScriptPath]),
      "--json",
    ],
    {
      cwd: REPO,
      timeout: 300_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...env, VOLLI_CLOUD_STORAGE_ORIGIN: storageOrigin },
    },
  );
  const launched = JSON.parse(stdout);
  const entry = await createRegistry().get(launched.id);
  const layout = instanceLayout(entry.scratch, entry.evidence);
  return {
    id: launched.id,
    evidence: launched.evidence,
    layout,
    drive: driveInstance(label, layout.driveSocket),
  };
}

/** Settings → Account → the agreement → Continue with GitHub; the browser double completes it. */
export async function signInCloud(drive) {
  await drive.click("button", "Settings", { first: true });
  await drive.wait("Settings categories");
  await drive.click("button", "Account", { first: true });
  await drive.wait("Accept Preview Agreement");
  await drive.click("checkbox", "Accept Preview Agreement");
  const since = Date.now();
  await drive.click("button", "Continue with GitHub");
  await drive.call("cloud-sign-in-browser", { since });
  await drive.wait("Restart to open Volli Cloud", 60_000);
}

/** This Mac's signed-in person and its runner, once it has registered. */
export async function cloudRunnerState(drive) {
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

/** The cloud project's Home on this Mac (where the checkout folder is chosen). */
export async function openProjectHome(drive, projectName) {
  await drive.wait(projectName, 60_000);
  if (await drive.has("button", projectName)) {
    await drive.click("button", projectName, { first: true });
  }
  if (await drive.has("button", "Home")) await drive.click("button", "Home", { first: true });
}

/** Home → the Board tab: the project's card board, where a column is armed and a card moves. */
export async function openBoard(drive) {
  if (await drive.has("button", "Home")) await drive.click("button", "Home", { first: true });
  await drive.click("tab", "Board");
  await waitUntil(
    `${drive.label}: the board is in front`,
    async () => hasActionableControl(await drive.text(), "button", "New ticket"),
    { timeout: 30_000, interval: 200 },
  );
}

/** A quit for real through the Tray, then the scratch tree removed and nothing left running. */
export async function stopCloudInstance(id) {
  return exec(process.execPath, [cli, "stop", id], { cwd: REPO, timeout: 120_000 });
}

/** A quit that leaves nothing behind: the Tray's Quit Volli, no keychain touch, no process. */
export function cloudCleanupProblems(manifest) {
  if (!manifest) return ["stop left no manifest"];
  const problems = [];
  if (manifest.scratchRemoved !== true) problems.push("scratch not removed");
  if (!Array.isArray(manifest.keychainViolations) || manifest.keychainViolations.length > 0)
    problems.push("keychain violations");
  if (manifest.keychainViolationExit !== false) problems.push("keychain violation exit");
  if (!Array.isArray(manifest.leftovers) || manifest.leftovers.length > 0)
    problems.push(`leftover processes: ${JSON.stringify(manifest.leftovers)}`);
  if (manifest.electron?.trayQuit?.exited !== true) problems.push("Tray Quit Volli did not quit");
  problems.push(...cleanQuitProblems(manifest.electron?.close));
  return problems;
}

/* ------------------------------------------------------- backend access --- */

/** A Convex HTTP client; imported lazily so the pure helpers load without it. */
async function convexClient(url) {
  const [{ ConvexHttpClient }, { makeFunctionReference }] = await Promise.all([
    import("convex/browser"),
    import("convex/server"),
  ]);
  return { client: new ConvexHttpClient(url), ref: makeFunctionReference };
}

/**
 * The fixture backend's guarded Automation hooks, called with the throwaway
 * deployment's admin key exactly as `convex/fixture/testing.ts` does. Each is
 * an `internalMutation` that refuses a deployment without the test issuer, so
 * no cloud deployment can be told what time it is.
 */
export async function scheduleHooks({ convexUrl, adminKey }) {
  if (!adminKey) throw new Error("The Automation clock hooks need the fixture's admin key");
  const { client, ref } = await convexClient(convexUrl);
  client.setAdminAuth(adminKey);
  const call = (name, args) => client.mutation(ref(name), args);
  return {
    /** Two distinct past occurrences through the real clock, isolated from its live cron. */
    coalescePastOccurrences: (automationId, firstDueAt) =>
      call("testAutomations:coalescePastOccurrences", { automationId, firstDueAt }),
    /** The schedule row, its Run rows and their jobs, straight from the backend. */
    inspect: (automationId) => call("testAutomations:inspectSchedule", { automationId }),
  };
}

/** SETUP: one saved Automation definition, through the backend's own public function. */
export async function seedAutomation({ convexUrl, token, projectId, name, instructions, trigger }) {
  const { client, ref } = await convexClient(convexUrl);
  client.setAuth(token);
  const automationId = randomUUID();
  await client.mutation(ref("automations:create"), {
    commandId: randomUUID(),
    projectId,
    automationId,
    name,
    instructions,
    runtime: null,
    trigger,
  });
  return automationId;
}

/**
 * SETUP: one ticket on the project's board, through `board.createTicket`. The
 * id may be chosen by the caller: an agent's `automation_run` names its target,
 * and the reply queue that carries the tool call is written before launch.
 */
export async function seedTicket({
  convexUrl,
  token,
  projectId,
  title,
  status = "todo",
  ticketId = randomUUID(),
}) {
  const { client, ref } = await convexClient(convexUrl);
  client.setAuth(token);
  await client.mutation(ref("board:createTicket"), {
    commandId: randomUUID(),
    projectId,
    ticketId,
    status,
    title,
  });
  return ticketId;
}

/** EVIDENCE: the project's column armings, as the person's window reads them. */
export async function automationArmings({ convexUrl, token, projectId }) {
  const { client, ref } = await convexClient(convexUrl);
  client.setAuth(token);
  return client.query(ref("automations:armings"), { projectId });
}

/** EVIDENCE: the project's armed schedules. */
export async function automationSchedules({ convexUrl, token, projectId }) {
  const { client, ref } = await convexClient(convexUrl);
  client.setAuth(token);
  return client.query(ref("automations:schedules"), { projectId });
}

/** EVIDENCE: the project's Run rows, newest first (a team fact, same as the page's history). */
export async function automationRuns({ convexUrl, token, projectId }) {
  const { client, ref } = await convexClient(convexUrl);
  client.setAuth(token);
  const page = await client.query(ref("automations:runsForProject"), {
    projectId,
    paginationOpts: { numItems: 50, cursor: null },
  });
  return page.page;
}

/* ------------------------------------------------ the agent's own turn --- */

/**
 * The instance's ordered fake-provider reply queue, written where the launcher
 * reads it. The supervisor hands a reply to the next turn that carries tools
 * (`supervisor.mjs:628-638`), so this file is a script of the instance's AGENT
 * turns in order; auto-title and other tool-free refinements never consume an
 * entry. `undefined` past the end falls back to the default echo.
 */
export async function writeFakeScript(directory, replies) {
  const path = join(directory, "fake-script.json");
  await fs.writeFile(path, JSON.stringify(replies, null, 2));
  return path;
}

/** The model-facing tool name an agent uses to run a saved Automation. */
export const AUTOMATION_RUN_TOOL = "automation_run";

/**
 * One scripted `automation_run` turn: no text, only the call, exactly as the
 * tool's schema asks — the Automation by name, the Ticket by its id (the route
 * accepts the display id or a UUID; this journey prechooses the UUID so the
 * script can be written before anything is seeded).
 */
export function automationRunToolCall({ automationName, ticketId }) {
  return {
    toolCalls: [
      {
        name: AUTOMATION_RUN_TOOL,
        arguments: { automation: automationName, ticket: ticketId },
      },
    ],
  };
}

/** The visible WatchNoticeRow, NOT the hidden envelope sent to the model.
 * Match its target handle too, so an unrelated notice cannot pass this check. */
export function noticeTurnFinishedCopy(sessionId) {
  return `${sessionId.slice(0, 8)} finished its turn`;
}

/* ------------------------------------------------------------- the clock --- */

/** An hourly schedule fires at :`minute` past each hour; `MINUTE_MS` keeps that readable. */
const MINUTE_MS = 60_000;

/**
 * SIMULATED CLOCK: the most recent instant the clock read `minute` past the
 * hour. Backdating a schedule's cursor to it makes exactly ONE occurrence
 * due: the next occurrence is a full hour later, so the shared
 * `decideScheduleFire` folds nothing, records `missedCount: 0`, and enqueues
 * one Run whose `dueAt` (its job's `availableAt`) is already due — the Run a
 * waking Mac picks up at once instead of an hour later.
 *
 * `schedule.timeZone` is UTC for this journey, so the wall-clock minute and
 * the `Date` minute are the same reading.
 */
export function hourlyBackdateAt(now, minute) {
  if (!Number.isInteger(minute) || minute < 0 || minute > 59)
    throw new Error(`not a minute past the hour: ${minute}`);
  const slot = new Date(now);
  slot.setUTCSeconds(0, 0);
  slot.setUTCMinutes(minute);
  if (slot.getTime() > now) slot.setUTCHours(slot.getUTCHours() - 1);
  return slot.getTime();
}

/** How many Run rows of each status a schedule (or a project) holds. */
export function runStatusCounts(runs) {
  const counts = { queued: 0, started: 0, skipped: 0, failed: 0 };
  for (const run of runs) if (run.status in counts) counts[run.status] += 1;
  return counts;
}

/**
 * "Wait, coalesced": after two occurrences came due while the armer's Mac was
 * asleep, the schedule owes exactly ONE Run and records ONE skipped row with
 * its count. Reads the guarded hook's own answer (the schedule row, its Runs
 * and their jobs), so a coalesced Run that was quietly re-enqueued — a second
 * job, a second Session — is a failure rather than a pass.
 */
export function coalescingProblems({ runs, jobs }) {
  const problems = [];
  const counts = runStatusCounts(runs);
  if (counts.queued !== 1) problems.push(`${counts.queued} queued Runs, expected 1`);
  if (counts.skipped !== 1) problems.push(`${counts.skipped} skipped Runs, expected 1`);
  if (counts.started !== 0 || counts.failed !== 0)
    problems.push(`${counts.started} started / ${counts.failed} failed before the armer woke`);
  const skipped = runs.find((run) => run.status === "skipped");
  if (skipped !== undefined) {
    if (skipped.missedCount !== 1)
      problems.push(`the skipped row covers ${skipped.missedCount} occurrences, expected 1`);
    const reason = skipped.skipReason?.kind;
    if (reason !== "runner-asleep")
      problems.push(
        `the skipped row's reason is ${JSON.stringify(reason)}, expected runner-asleep`,
      );
    if (skipped.sessionId !== null) problems.push("a skipped occurrence named a Session");
  }
  if (jobs.length !== 1) problems.push(`${jobs.length} jobs, expected 1`);
  for (const job of jobs) {
    if (job.status !== "queued") problems.push(`the waiting job is ${job.status}, expected queued`);
    // A lease ever taken makes a job unpatchable, so coalescing could not have
    // moved it: the Mac was never awake enough to be handed the Run.
    if (job.lease !== null) problems.push("the waiting job was leased before the Mac woke");
    if (job.payload?.missedCount !== 1)
      problems.push(`the waiting job covers ${job.payload?.missedCount} occurrences, expected 1`);
  }
  return problems;
}

/** What the renderer prints for a Run waiting on a sleeping Mac (`waitingForRunner`). */
export function waitingForAsleepCopy(runnerName) {
  return `Waiting for ${runnerName} (asleep)`;
}

/** What the renderer prints for a schedule occurrence a sleeping Mac replaced (`cloudRunLabel`). */
export function skippedAsleepCopy(runnerName) {
  return `Skipped · ${runnerName} was asleep`;
}

/** The accessible sentence a Run-started Session row carries beside its title. */
export function provenanceMarkCopy(automationName) {
  return `Started by the Automation ${automationName}`;
}

/** Runs addressed to a runner (the "never B" half of "it runs on A"). */
export function runsOnRunner(runs, runnerId) {
  return runs.filter((run) => run.runnerId === runnerId);
}

/** Minutes are the unit every offset above is written in; exported for the tests. */
export const MINUTES = MINUTE_MS;
