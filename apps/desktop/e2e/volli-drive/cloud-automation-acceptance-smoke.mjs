#!/usr/bin/env node
/**
 * The two-Mac Automation acceptance (VC-1004, B3b-6): a Run follows the Mac
 * its armer chose, waits while that Mac sleeps, and starts exactly one Run
 * when it wakes.
 *
 * Two isolated volli-drive dev instances, "Mac A" and "Mac B", signed in as
 * ONE person against ONE throwaway pinned local backend, driven through their
 * real windows (snapshot → one action → fresh snapshot):
 *
 *   1. Both sign in (Settings → Account, the dev sign-in).
 *   2. Both restart into Volli Cloud and become that person's runners, online
 *      and advertising the Automation executor (`capabilities.tools`).
 *   3. Mac A arms the Doing column and an hourly schedule — both on this Mac,
 *      through the app's own bolt and Armed switch.
 *   4. Mac B moves one ticket into Doing. The armed arrival's Run starts on
 *      Mac A (never on B, the Mac that only moved the card), and its Session —
 *      ticket work is shared — appears on Mac B.
 *   5. Mac A sleeps (SIMULATED: see below) and the schedule's first occurrence
 *      comes due (SIMULATED clock): Mac B reads "Waiting for <Mac A> (asleep)".
 *   6. A second occurrence comes due while Mac A is still asleep: the waiting
 *      Run is superseded — ONE skipped occurrence (missed 1) and the same ONE
 *      waiting Run, never two.
 *   7. Mac A wakes: exactly one schedule Run starts, and Mac B's waiting row
 *      is gone.
 *
 * **Sleep is a simulation**: main's dual-locked smoke seam
 * (`src/main/cloud-runner/smoke-power.ts`, unpackaged AND
 * `VOLLI_SMOKE_CLOUD_RUNNER_POWER=1`) emits the real `suspend`, waits for the
 * runner's `asleep` report, and holds the runner's transport down until the
 * real `resume`. No process is frozen and no OS sleep happens. The real lid
 * test is the owner's, on hardware.
 *
 * **The clock is simulated**: no scheduled minute passes. The fixture
 * backend's guarded hooks (`convex/functions/testAutomations.ts`: internal, so
 * admin-key only, and each refuses a deployment that does not trust the test
 * issuer) move one armed schedule's cursor and run one clock page as if it
 * were now — the same `fireDuePage` the one-minute cron runs. The backend's
 * own coalescing rules then decide the outcome; nothing is injected.
 *
 * SETUP and doubles, never the behaviour under test (each is in the
 * transcript): preview enrollment for the dev profile, the person's project,
 * two saved Automation definitions and one ticket through the backend's own
 * public functions, the "browser" that follows the dev issuer's recorded
 * loopback URL, the native folder picker (it returns a scratch-only repo), the
 * fake model provider, a local S3-compatible HTTP fake for transcript packs,
 * and a supervised restart in place of `app.relaunch()`. Reads for evidence:
 * the person's runners, the project's armings, schedules and Run rows, its
 * Session listing, and the guarded clock hook's own answer.
 *
 * **The agent's `automation_run` is covered, and its turn is scripted.** Mac A's
 * instance launches with an ordered fake-provider reply queue
 * (`fake-script.json`, written before launch and kept as evidence). The queue
 * feeds the next turn that carries tools (`supervisor.mjs:628-638`; auto-title
 * and other tool-free refinements never consume an entry), so it is a script of
 * this instance's AGENT TURNS in order: the arrival Run's turn, the schedule
 * Run's turn, then — on Mac A's explicit New-chat kickoff — one turn whose only
 * output is an `automation_run` tool call naming the Automation and the
 * prechosen Ticket id. The replies after it are plain text, because the Run's
 * own first turn and the caller's continuation may land in either order. The
 * Run it queues is the real one (`automations:run` under the calling Session's
 * Agent token), and the notice the Run arms is the real one too: its watch
 * fires when the Run's Session finishes its first turn, the backend queues
 * `session.notice`, and the runner's outbox delivers the composed text.
 * Nothing here injects a token, a watch, or a notice.
 *
 * Every authoring/arming step stays the app's; the backend is read, and told
 * what time it is, through its own public functions and the guarded
 * `testAutomations` hooks only.
 *
 * CI ONLY, on a disposable macOS GitHub runner, with the loopback CSP:
 *
 *   VOLLI_CLOUD_LOOPBACK=1 pnpm -C apps/desktop run build
 *   node convex/fixture/with-backend.ts --deploy -- \
 *     node apps/desktop/e2e/volli-drive/cloud-automation-acceptance-smoke.mjs
 *
 * CI runs it in `ci-extended.yml`, in the two-Mac cloud acceptance job's slot
 * after the wake journey (its build is reused).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { waitUntil } from "../lib/smoke-kit.mjs";
import {
  AUTOMATION_PROJECT,
  ARRIVAL_TICKET,
  DOING_AUTOMATION,
  SCHEDULE_AUTOMATION,
  automationArmings,
  automationRuns,
  automationSchedules,
  cloudCleanupProblems,
  cloudRunnerState,
  coalescingProblems,
  hourlyBackdateAt,
  launchCloudInstance,
  openBoard,
  openProjectHome,
  provenanceMarkCopy,
  runStatusCounts,
  runsOnRunner,
  scheduleHooks,
  seedAutomation,
  seedTicket,
  AUTOMATION_RUN_TOOL,
  automationRunToolCall,
  noticeDeliveredCopy,
  noticeTurnFinishedCopy,
  writeFakeScript,
  signInCloud,
  skippedAsleepCopy,
  stopCloudInstance,
  waitingForAsleepCopy,
} from "./lib/cloud-automation-acceptance.mjs";
import {
  cloudFixtureFromEnv,
  devAccessToken,
  grantPreview,
  personRunners,
  projectSessions,
  seedCloudProject,
} from "./lib/cloud-acceptance.mjs";
import { hasActionableControl } from "./lib/remote-acceptance.mjs";
import { startTranscriptStore } from "./lib/cloud-transcript-acceptance.mjs";
import { REPO } from "./lib/core.mjs";

const exec = promisify(execFile);

const STEPS = [
  [1, "Sign in on Mac A and Mac B (Settings → Account, dev sign-in)"],
  [
    2,
    "Restart both into Volli Cloud; both are the person's runners, online, advertising the Automation executor",
  ],
  [3, "Mac A arms the Doing column and an hourly schedule, both on this Mac"],
  [
    4,
    "Mac B moves a ticket into Doing: the Run starts on Mac A (never B) and its shared Session appears on B",
  ],
  [
    5,
    "SIMULATED sleep on Mac A; the first schedule occurrence comes due (SIMULATED clock): B reads Waiting for <Mac A> (asleep)",
  ],
  [
    6,
    "SIMULATED clock: a second occurrence comes due while Mac A sleeps — one skipped occurrence (missed 1) and the same one waiting Run",
  ],
  [7, "Mac A wakes: exactly one schedule Run starts; B's waiting row is gone"],
  [
    8,
    "Mac A asks its agent for the Run (scripted automation_run): a real Run starts, and the started notice reaches the caller's Session",
  ],
];

/** The caller's own turn: Mac A opens a chat and asks for the Run by name. */
const AGENT_KICKOFF = "Kick off the Doing sweep through automation_run";
const followUpMarker = (marker) => `SCRIPTED ${marker}`;
const AGENT_FOLLOW_UP = followUpMarker("caller follow-up after the queued Run");
/** Plain replies for turns whose order the journey does not control. */
const RUN_TURN_MARKER = followUpMarker("a Run's own turn");
const NOTICE_TURN_MARKER = followUpMarker("caller turn after the notice");

const results = [];
const instances = {};
const evidence = {};

function record(number, status, assertion, detail = "") {
  results.push({ step: number, status, assertion, detail });
  console.log(`${status} ${number}: ${assertion}${detail ? ` — ${detail}` : ""}`);
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

async function runnerStatus(fixture, token, runnerId) {
  const runners = await personRunners({ convexUrl: fixture.convexUrl, token });
  return runners.find((runner) => runner.id === runnerId) ?? null;
}

/** The project's Run rows for one Automation, newest first. */
async function runsFor(fixture, token, projectId, automationId) {
  const runs = await automationRuns({ convexUrl: fixture.convexUrl, token, projectId });
  return runs.filter((run) => run.automationId === automationId);
}

async function journey(fixture, store, evidenceDir) {
  const subject = `automation-${randomBytes(4).toString("hex")}`;
  const token = () => devAccessToken({ privateKeyPem: fixture.privateKeyPem, subject });
  // SETUP: the one ticket both the arrival and the agent's Run name. Its id is
  // chosen here because Mac A's reply queue — which carries the scripted
  // `automation_run` call — is written into the launch, before anything is
  // seeded. The route reads a Ticket UUID as readily as a display id
  // (`cloud-agent/session-verbs.ts`), so the script does not wait on a number.
  const ticketId = randomUUID();
  // SETUP: preview enrollment for the dev profile, on the throwaway backend.
  await grantPreview({ convexUrl: fixture.convexUrl, adminKey: fixture.adminKey });
  // SETUP: Mac A's ordered agent turns. Two Runs come first (the arrival, then
  // the schedule), then the caller's own kickoff carries the tool call.
  const fakeScriptPath = await writeFakeScript(evidenceDir, [
    { text: RUN_TURN_MARKER },
    { text: RUN_TURN_MARKER },
    automationRunToolCall({ automationName: DOING_AUTOMATION.name, ticketId }),
    { text: AGENT_FOLLOW_UP },
    { text: RUN_TURN_MARKER },
    { text: NOTICE_TURN_MARKER },
  ]);
  const macA = await launchCloudInstance({
    label: "A",
    subject,
    storageOrigin: store.endpoint,
    fakeScriptPath,
  });
  const macB = await launchCloudInstance({ label: "B", subject, storageOrigin: store.endpoint });
  instances.A = { id: macA.id, evidence: macA.evidence, layout: macA.layout, drive: macA.drive };
  instances.B = { id: macB.id, evidence: macB.evidence, layout: macB.layout, drive: macB.drive };

  await step(1, async () => {
    await signInCloud(macA.drive);
    await signInCloud(macB.drive);
  });

  // SETUP: the person's project, through the board's own public function.
  const project = await seedCloudProject({
    convexUrl: fixture.convexUrl,
    token: token(),
    name: AUTOMATION_PROJECT.name,
    prefix: AUTOMATION_PROJECT.prefix,
  });

  const { a, b } = await step(2, async () => {
    await macA.drive.call("restart", { reason: "Restart to open Volli Cloud (supervised)" });
    await macB.drive.call("restart", { reason: "Restart to open Volli Cloud (supervised)" });
    const stateA = await cloudRunnerState(macA.drive);
    const stateB = await cloudRunnerState(macB.drive);
    assert.equal(stateA.userId, stateB.userId, "both Macs are the same person");
    assert.notEqual(stateA.runnerId, stateB.runnerId, "each Mac is its own runner");
    let runners = [];
    await waitUntil(
      "both runners online in the person's list",
      async () => {
        runners = await personRunners({ convexUrl: fixture.convexUrl, token: token() });
        const seen = (id) => runners.find((runner) => runner.id === id) ?? null;
        return (
          seen(stateA.runnerId)?.status === "online" && seen(stateB.runnerId)?.status === "online"
        );
      },
      { timeout: 60_000, interval: 500 },
    );
    // The executor is what the picker offers and what the arrival routes to:
    // a runner that does not name it is never handed an Automation Run.
    for (const [label, state] of [
      ["A", stateA],
      ["B", stateB],
    ]) {
      const runner = runners.find((row) => row.id === state.runnerId);
      assert.ok(
        Array.isArray(runner?.capabilities?.tools) &&
          runner.capabilities.tools.includes("automation.run"),
        `Mac ${label} does not advertise the Automation executor: ${JSON.stringify(runner?.capabilities ?? null)}`,
      );
    }
    const nameA = runners.find((row) => row.id === stateA.runnerId).name;
    return {
      a: { ...stateA, name: nameA },
      b: stateB,
      detail: `Mac A is ${nameA}; both advertise automation.run`,
    };
  });
  const nameA = a.name;

  // SETUP: two saved Automation definitions and one ticket, through the
  // backend's own public functions. Arming them — the behaviour under test —
  // is Mac A's, below.
  const doingAutomationId = await seedAutomation({
    convexUrl: fixture.convexUrl,
    token: token(),
    projectId: project.projectId,
    name: DOING_AUTOMATION.name,
    instructions: DOING_AUTOMATION.instructions,
    trigger: DOING_AUTOMATION.trigger,
  });
  const scheduleAutomationId = await seedAutomation({
    convexUrl: fixture.convexUrl,
    token: token(),
    projectId: project.projectId,
    name: SCHEDULE_AUTOMATION.name,
    instructions: SCHEDULE_AUTOMATION.instructions,
    trigger: { kind: "schedule", schedule: SCHEDULE_AUTOMATION.schedule },
  });
  await seedTicket({
    convexUrl: fixture.convexUrl,
    token: token(),
    projectId: project.projectId,
    title: ARRIVAL_TICKET.title,
    ticketId,
  });
  const hooks = await scheduleHooks({ convexUrl: fixture.convexUrl, adminKey: fixture.adminKey });

  await step(3, async () => {
    // A double at the OS boundary: the folder picker answers with a scratch
    // repo. Both Runs below are born on Mac A, so its checkout is SETUP.
    await macA.drive.call("cloud-checkout-folder");
    await openProjectHome(macA.drive, AUTOMATION_PROJECT.name);
    const choose = `Choose the folder for ${AUTOMATION_PROJECT.name} on this Mac`;
    await macA.drive.wait(choose, 60_000);
    await macA.drive.click("button", choose);
    await macA.drive.gone(choose, 30_000);
    await openBoard(macA.drive);
    // The column's own bolt: the person arms Doing, on this Mac (the picker's
    // default), with the one Automation offered there.
    await macA.drive.click("button", "Arm Doing");
    await macA.drive.wait("Arrives in Doing", 30_000);
    await macA.drive.click("button", DOING_AUTOMATION.name);
    await macA.drive.pressKey("Escape");
    await macA.drive.wait(`Doing runs ${DOING_AUTOMATION.name} on ${nameA}`, 30_000);
    // The schedule's own Armed switch, on the Automations page.
    await macA.drive.click("button", "Automations");
    await macA.drive.click("button", SCHEDULE_AUTOMATION.name, { contains: true });
    await macA.drive.wait(`Armed: ${SCHEDULE_AUTOMATION.name}`, 30_000);
    await macA.drive.click("switch", `Armed: ${SCHEDULE_AUTOMATION.name}`);
    // Armed and not paused: the editor's own next-occurrence line, from the
    // backend's cursor rather than from a client computation.
    await macA.drive.wait("Next:", 30_000);
    const armings = await automationArmings({
      convexUrl: fixture.convexUrl,
      token: token(),
      projectId: project.projectId,
    });
    const arming = armings.find((row) => row.status === "doing");
    assert.ok(arming, `the Doing column is not armed: ${JSON.stringify(armings)}`);
    assert.equal(arming.automationId, doingAutomationId, "Doing is armed with another Automation");
    assert.equal(arming.runnerId, a.runnerId, "Doing is armed on another Mac");
    assert.equal(arming.pausedAt, null, "the Doing arming is paused");
    let schedule = null;
    await waitUntil(
      "the schedule is armed on Mac A",
      async () => {
        const schedules = await automationSchedules({
          convexUrl: fixture.convexUrl,
          token: token(),
          projectId: project.projectId,
        });
        schedule = schedules.find((row) => row.automationId === scheduleAutomationId) ?? null;
        return schedule !== null && schedule.runnerId === a.runnerId;
      },
      { timeout: 30_000, interval: 500 },
    );
    assert.equal(schedule.pausedAt, null, "the schedule is paused");
    assert.ok(schedule.nextFireAt > Date.now(), "the schedule has no next occurrence");
    return {
      detail: `Doing and ${SCHEDULE_AUTOMATION.name} both armed on ${nameA} (id ${a.runnerId.slice(0, 8)})`,
    };
  });

  let arrivalRun = null;
  await step(4, async () => {
    await openProjectHome(macB.drive, AUTOMATION_PROJECT.name);
    await openBoard(macB.drive);
    // The card's keyboard door is its Enter key (a double-click is not a drive
    // gesture): focus the card, then open the ticket's full page.
    await macB.drive.press("button", ARRIVAL_TICKET.title, "Enter", { contains: true });
    await macB.drive.wait("Properties", 30_000);
    await macB.drive.click("button", "Status: Todo");
    await macB.drive.click("menuitemradio", "Doing");
    await macB.drive.wait("Status: Doing", 30_000);
    // The arrival is a 3.5 s countdown, then Mac A's runner claims it.
    await waitUntil(
      "the arrival Run starts on Mac A",
      async () => {
        const runs = await runsFor(fixture, token(), project.projectId, doingAutomationId);
        arrivalRun = runs.find((run) => run.status === "started") ?? null;
        return arrivalRun !== null && arrivalRun.sessionId !== null;
      },
      { timeout: 180_000, interval: 1_000 },
    );
    assert.equal(arrivalRun.runnerId, a.runnerId, "the arrival Run was addressed to another Mac");
    assert.equal(
      runsOnRunner(
        await automationRuns({
          convexUrl: fixture.convexUrl,
          token: token(),
          projectId: project.projectId,
        }),
        b.runnerId,
      ).length,
      0,
      "a Run was addressed to Mac B, the Mac that only moved the card",
    );
    let session = null;
    await waitUntil(
      "the Run's Session reaches the backend",
      async () => {
        const sessions = await projectSessions({
          convexUrl: fixture.convexUrl,
          token: token(),
          projectId: project.projectId,
        });
        session = sessions.find((row) => row.id === arrivalRun.sessionId) ?? null;
        return session !== null;
      },
      { timeout: 60_000, interval: 500 },
    );
    assert.equal(session.placeRunnerId, a.runnerId, "the Run's Session runs on another Mac");
    assert.equal(session.ownerUserId, a.userId, "the Run's Session belongs to another person");
    assert.equal(session.ticketId, ticketId, "the Run's Session is on another ticket");
    // Ticket work is shared, so a Member — here the same person's other Mac —
    // lists it and reads a Run-started row's mark.
    assert.equal(session.visibility, "shared", "a ticket Run's Session is not shared");
    evidence.arrival = {
      runId: arrivalRun.id,
      sessionId: arrivalRun.sessionId,
      runnerId: a.runnerId,
      place: session.placeRunnerId,
      visibility: session.visibility,
    };
    await openProjectHome(macB.drive, AUTOMATION_PROJECT.name);
    await macB.drive.wait(provenanceMarkCopy(DOING_AUTOMATION.name), 60_000);
    return {
      detail: `Run ${arrivalRun.id.slice(0, 8)} started on ${nameA}; shared Session ${arrivalRun.sessionId.slice(
        0,
        8,
      )} listed on B with its Automation mark`,
    };
  });

  /** SIMULATED CLOCK: one occurrence comes due, through the guarded hooks. */
  async function occurrenceDue() {
    const before = (await hooks.inspect(scheduleAutomationId)).runs.length;
    await hooks.backdate(
      scheduleAutomationId,
      hourlyBackdateAt(Date.now(), SCHEDULE_AUTOMATION.schedule.minute),
    );
    await hooks.fireDueAt(Date.now());
    await waitUntil(
      "the schedule's cursor to advance",
      async () => (await hooks.inspect(scheduleAutomationId)).runs.length > before,
      { timeout: 30_000, interval: 500 },
    );
    return hooks.inspect(scheduleAutomationId);
  }

  await step(5, async () => {
    const asleep = await macA.drive.call("runner-power", { action: "suspend" });
    assert.equal(asleep.simulated, true);
    await waitUntil(
      "the backend reads Mac A asleep",
      async () => (await runnerStatus(fixture, token(), a.runnerId))?.status === "asleep",
      { timeout: 30_000, interval: 500 },
    );
    // SIMULATED CLOCK: the first occurrence. No minute passed.
    const after = await occurrenceDue();
    const counts = runStatusCounts(after.runs);
    assert.deepEqual(counts, { queued: 1, started: 0, skipped: 0, failed: 0 });
    // The first occurrence covers itself alone: the job's own count, which is
    // what the coalescing rule adds to. A queued Run row covers nothing yet.
    assert.equal(after.jobs.length, 1, `${after.jobs.length} jobs after the first occurrence`);
    assert.equal(after.jobs[0].payload.missedCount, 0, "the first occurrence folded earlier ones");
    assert.equal(after.runs[0].missedCount, null, "a waiting Run already claims a missed count");
    // Mac B reads the waiting Run in the project's own Run history.
    await macB.drive.click("button", "Automations");
    await macB.drive.click("button", "Project activity");
    await macB.drive.wait(waitingForAsleepCopy(nameA), 60_000);
    evidence.firstOccurrence = {
      runId: after.runs[0].id,
      jobMissedCount: after.jobs[0].payload.missedCount,
      dueAt: after.runs[0].dueAt,
      nextFireAt: after.schedule.nextFireAt,
    };
    return {
      detail: `SIMULATED sleep (real suspend event, transport held down) and SIMULATED clock (one clock page at now); B reads "${waitingForAsleepCopy(
        nameA,
      )}"`,
    };
  });

  await step(6, async () => {
    const before = evidence.firstOccurrence.runId;
    // SIMULATED CLOCK: the second occurrence, while the first Run still waits.
    const after = await occurrenceDue();
    const problems = coalescingProblems({ runs: after.runs, jobs: after.jobs });
    assert.equal(problems.length, 0, problems.join("; "));
    const waiting = after.runs.find((run) => run.status === "queued");
    assert.equal(waiting.id, before, "the waiting Run was replaced instead of moved");
    assert.equal(after.schedule.pendingRunId, before, "the schedule points at another Run");
    // B sees the one skipped occurrence beside the one Run still waiting.
    await macB.drive.wait(skippedAsleepCopy(nameA), 60_000);
    evidence.coalescing = {
      ...runStatusCounts(after.runs),
      skipped: {
        missedCount: after.runs.find((run) => run.status === "skipped").missedCount,
        skipReason: after.runs.find((run) => run.status === "skipped").skipReason,
      },
      waitingRunId: before,
      jobs: after.jobs.map((job) => ({ id: job.id, status: job.status, lease: job.lease })),
      problems,
    };
    return {
      detail: `one skipped occurrence (missed ${evidence.coalescing.skipped.missedCount}) and the same waiting Run ${before.slice(0, 8)}; the job was never leased; B reads "${skippedAsleepCopy(nameA)}"`,
    };
  });

  await step(7, async () => {
    const resumed = await macA.drive.call("runner-power", { action: "resume" });
    assert.equal(resumed.simulated, true);
    let after = null;
    await waitUntil(
      "the one waiting Run starts on the waking Mac",
      async () => {
        after = await hooks.inspect(scheduleAutomationId);
        const counts = runStatusCounts(after.runs);
        return counts.started === 1 && counts.skipped === 1 && counts.queued === 0;
      },
      { timeout: 180_000, interval: 1_000 },
    );
    const started = after.runs.find((run) => run.status === "started");
    assert.equal(started.runnerId, a.runnerId, "the schedule Run started on another Mac");
    assert.equal(
      after.jobs[0]?.payload.missedCount,
      1,
      "the started Run lost its coalesced occurrence",
    );
    for (const job of after.jobs)
      assert.notEqual(job.status, "queued", "a schedule job is still waiting after the wake");
    // Exactly one schedule Run starts: one started row, one skip, one job.
    assert.equal(
      after.runs.length,
      2,
      `the schedule recorded ${after.runs.length} Runs, expected 2`,
    );
    assert.equal(
      after.jobs.length,
      1,
      `the schedule recorded ${after.jobs.length} jobs, expected 1`,
    );
    let session = null;
    await waitUntil(
      "the schedule Run's Session reaches the backend",
      async () => {
        const sessions = await projectSessions({
          convexUrl: fixture.convexUrl,
          token: token(),
          projectId: project.projectId,
        });
        session = sessions.find((row) => row.id === started.sessionId) ?? null;
        return session !== null;
      },
      { timeout: 60_000, interval: 500 },
    );
    assert.equal(session.placeRunnerId, a.runnerId, "the schedule Session runs on another Mac");
    const sessions = await projectSessions({
      convexUrl: fixture.convexUrl,
      token: token(),
      projectId: project.projectId,
    });
    assert.equal(sessions.length, 2, `${sessions.length} Sessions exist, expected one per Run`);
    await macB.drive.gone(waitingForAsleepCopy(nameA), 60_000);
    evidence.started = {
      runId: started.id,
      sessionId: started.sessionId,
      placeRunnerId: session.placeRunnerId,
      sessions: sessions.length,
      runs: after.runs.map((run) => ({
        id: run.id,
        status: run.status,
        missedCount: run.missedCount,
      })),
    };
    return {
      detail: `one schedule Run ${started.id.slice(0, 8)} started on ${nameA}; B's waiting row is gone (${sessions.length} Sessions, one per Run)`,
    };
  });

  await step(8, async () => {
    // The caller's own kickoff on Mac A: this is the instance's third agent
    // turn, so the reply queue's `automation_run` call lands here and nowhere
    // else. The tool turn carries no text; its continuation does.
    await openProjectHome(macA.drive, AUTOMATION_PROJECT.name);
    await macA.drive.click("button", "New chat", { first: true });
    await waitUntil(
      "Mac A: the Message box is ready",
      async () => hasActionableControl(await macA.drive.text(), "textbox", "Message"),
      { timeout: 30_000, interval: 200 },
    );
    await macA.drive.type("textbox", "Message", AGENT_KICKOFF);
    await macA.drive.press("textbox", "Message", "Enter");
    await macA.drive.wait(AGENT_FOLLOW_UP, 180_000);
    // The Run the agent asked for: a real one, unattended, recorded against the
    // calling Session, starting on Mac A (`automations.run` under its own
    // Agent token — nothing here mints one).
    let agentRun = null;
    await waitUntil(
      "the agent's Run starts on Mac A",
      async () => {
        const runs = await runsFor(fixture, token(), project.projectId, doingAutomationId);
        agentRun = runs.find((run) => run.trigger === "manual") ?? null;
        return agentRun !== null && agentRun.status === "started" && agentRun.sessionId !== null;
      },
      { timeout: 180_000, interval: 1_000 },
    );
    assert.equal(agentRun.runnerId, a.runnerId, "the agent's Run was addressed to another Mac");
    assert.equal(agentRun.attendance, "unattended", "an agent's Run is not attended");
    assert.ok(
      typeof agentRun.requestedBySessionId === "string" && agentRun.requestedBySessionId.length > 0,
      "the agent's Run does not name the Session that asked for it",
    );
    // The started notice, composed by the backend and delivered by the
    // runner's own outbox when that Run's Session finished its first turn:
    // its opening sentence, and the line naming the turn that ended.
    await macA.drive.wait(noticeDeliveredCopy(), 240_000);
    await macA.drive.wait(noticeTurnFinishedCopy(), 240_000);
    evidence.agentRun = {
      runId: agentRun.id,
      sessionId: agentRun.sessionId,
      requestedBySessionId: agentRun.requestedBySessionId,
      attendance: agentRun.attendance,
      trigger: agentRun.trigger,
      noticed: noticeDeliveredCopy(),
    };
    return {
      detail: `scripted ${AUTOMATION_RUN_TOOL} queued Run ${agentRun.id.slice(0, 8)} from the caller's Session; it started on ${nameA} and its finished-turn notice reached that Session`,
    };
  });

  for (const { drive } of Object.values(instances)) {
    const doctor = await drive.call("doctor");
    assert.ok(doctor.ok, `${drive.label}: ${JSON.stringify(doctor.problems)}`);
  }
  return { subject };
}

// Check before launching Electron or changing the fixture: never run this on
// a local developer Mac, even when fixture environment variables are present.
if (
  process.platform !== "darwin" ||
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_OS !== "macOS"
)
  throw new Error("The Automation acceptance runs only on disposable macOS GitHub CI runners");
// This journey starts its own store; never consume an ambient bucket origin.
const fixture = cloudFixtureFromEnv({ ...process.env, VOLLI_CLOUD_STORAGE_ORIGIN: undefined });
const reportDir =
  process.env.VOLLI_SMOKE_REPORT_DIR ?? join(REPO, ".scratch", "cloud-automation-acceptance");
await fs.mkdir(reportDir, { recursive: true });
let failed = false;
const cleanup = {};
let store;
let objectStoreCleanup = null;
try {
  assert.ok(fixture.adminKey, "the throwaway backend's admin key is required");
  store = await startTranscriptStore(fixture, reportDir);
  await journey(fixture, store, reportDir);
} catch (error) {
  failed = true;
  console.error(error.stack);
  for (const [number, assertion] of STEPS) {
    if (!results.some((row) => row.step === number))
      record(number, "BLOCKED", assertion, "An earlier step or its setup failed");
  }
} finally {
  for (const [label, instance] of Object.entries(instances)) {
    const stopped = await stopCloudInstance(instance.id).catch((error) => ({ error }));
    const manifest = await fs
      .readFile(join(instance.evidence, "manifest.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    const problems = stopped.error ? [stopped.error.message] : cloudCleanupProblems(manifest);
    cleanup[label] = {
      id: instance.id,
      evidence: instance.evidence,
      close: manifest?.electron?.close?.kind ?? null,
      problems,
    };
    if (problems.length > 0) failed = true;
  }
  if (store) {
    objectStoreCleanup = await store
      .close()
      .catch((error) => ({ closed: false, problems: [error.message] }));
    // The transcript packs this journey uploads are the wake journey's
    // subject; here the store is SETUP, so only its own shutdown is ours.
    if (objectStoreCleanup.closed !== true) failed = true;
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
          "Sleep is SIMULATED (real power events through main's dual-locked smoke seam, runner transport held down; no OS sleep). The clock is SIMULATED (testAutomations.backdateSchedule + fireDueAt, which run the cron's own fireDuePage; no minute passed).",
        agentTurnScript:
          "Mac A launches with an ordered fake-provider reply queue (fake-script.json, kept here). It feeds the next turn that carries tools, so it scripts this instance's agent turns in order: the arrival Run's turn, the schedule Run's turn, the caller's scripted automation_run kickoff, then plain replies (the Run's own turn and the caller's continuation may race). No token, watch or notice is injected: the Run goes through automations:run under the caller Session's Agent token, and the notice is the backend's session.notice composed by the runner's outbox.",
        complete,
        failed,
        results,
        evidence,
        objectStore: {
          closed: objectStoreCleanup?.closed ?? null,
          problems: objectStoreCleanup?.problems ?? [],
        },
        cleanup,
      },
      null,
      2,
    ),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Cloud Automation acceptance (two Macs; sleep and clock SIMULATED)\n\n${results
        .map(
          (row) =>
            `- **${row.status} ${row.step}** ${row.assertion}${row.detail ? ` — ${row.detail}` : ""}`,
        )
        .join("\n")}\n\nCleanup: ${Object.entries(cleanup)
        .map(
          ([label, c]) =>
            `Mac ${label} ${c.problems.length === 0 ? "PASS" : `FAIL (${c.problems.join("; ")})`}`,
        )
        .join(
          ", ",
        )}. Mac A's agent turns are SCRIPTED by fake-script.json (kept in the evidence); the Run and the notice it arms are the product's own. complete:${complete} in acceptance.json.\n`,
    );
}
process.exitCode = failed ? 1 : 0;
