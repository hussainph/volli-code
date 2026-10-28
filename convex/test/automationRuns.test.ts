/**
 * The cloud Automation clock and Runs under convex-test: the minute cron's
 * fires (never early, at most one pending Run, one skip row per gap), the Run
 * commands, the runner's fenced context and the completion hook. Every time is
 * a fixed instant under fake timers; DST rows are explicit, never an accident
 * of the day the suite runs (VC-948).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { AutomationTrigger } from "@volli/shared";
import {
  AGENT_TOKEN_ISSUER,
  RUNNER_TOKEN_ISSUER,
  agentSubject,
  automationRunFailedAttentionId,
  newId,
  parseJobPayload,
  type ClaimedJob,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { Doc } from "../functions/_generated/dataModel.js";
import { automationRunWatchCommandId, onSessionFact } from "../functions/lib/watches";
import {
  boardFixture,
  code,
  createTicket,
  projectEvents,
  seedRunner,
  seedSession,
  setup,
  signIn,
  type Client,
  type Tester,
} from "./board-helpers";
import { writeSession } from "./sessionFixtures";

// Saturday 2026-03-07, the day before New York springs forward.
const NOW = Date.parse("2026-03-07T12:00:00Z");
const MINUTE = 60_000;
const daily = (hour: number, minute: number, timeZone = "America/New_York"): AutomationTrigger => ({
  kind: "schedule",
  schedule: { preset: "daily", hour, minute, timeZone },
});
const command = () => newId("command");
const BOOT = "b0000000-0000-4000-8000-000000000001";
const BOOT2 = "b0000000-0000-4000-8000-000000000002";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function setRunner(t: Tester, runnerId: string, patch: Partial<Doc<"runners">>) {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", runnerId))
      .unique();
    await ctx.db.patch(row!._id, patch);
  });
}

async function capableRunner(t: Tester, userId: string) {
  const runnerId = await seedRunner(t, userId);
  await setRunner(t, runnerId, { capabilities: { tools: ["automation.run"] } });
  return runnerId;
}

async function createAutomation(as: Client, projectId: string, name: string, trigger: unknown) {
  const automationId = newId("automation");
  await as.mutation(api.automations.create, {
    commandId: command(),
    projectId,
    automationId,
    name,
    instructions: `Do ${name}`,
    runtime: null,
    trigger,
  });
  return automationId;
}

async function world(trigger: AutomationTrigger = daily(9, 30)) {
  const t = setup();
  const alice = await boardFixture(t);
  const runnerId = await capableRunner(t, alice.userId);
  const scheduleId = await createAutomation(alice.as, alice.projectId, "Daily", trigger);
  const reviewId = await createAutomation(alice.as, alice.projectId, "Review", {
    kind: "columns",
    columns: ["doing"],
  });
  const ticket = await createTicket(alice.as, alice.projectId);
  return { t, ...alice, runnerId, scheduleId, reviewId, ticketId: ticket.ticketId as string };
}
type World = Awaited<ReturnType<typeof world>>;

async function armSchedule(w: World, automationId = w.scheduleId) {
  return w.as.mutation(api.automations.armSchedule, {
    commandId: command(),
    automationId,
    runnerId: w.runnerId,
  });
}

/** One cron tick at `at`. */
async function tick(w: World, at: number) {
  vi.setSystemTime(at);
  return w.t.mutation(internal.automationSchedules.fireDue, {});
}

async function scheduleRow(w: World, automationId = w.scheduleId) {
  return w.t.run(async (ctx) =>
    ctx.db
      .query("automationSchedules")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .unique(),
  );
}

async function runsOf(w: World, automationId: string | null = w.scheduleId) {
  return w.t.run(async (ctx) =>
    (await ctx.db.query("automationRuns").collect()).filter(
      (row) => automationId === null || row.automationId === automationId,
    ),
  );
}

async function automationJobs(w: World) {
  return w.t.run(async (ctx) =>
    (await ctx.db.query("runnerJobs").collect()).filter((job) => job.kind === "automation.run"),
  );
}

function runnerClient(w: World, runnerId = w.runnerId) {
  return w.t.withIdentity({ subject: `runner:${runnerId}`, issuer: RUNNER_TOKEN_ISSUER });
}

async function claim(w: World, runnerId = w.runnerId, bootId = BOOT): Promise<ClaimedJob[]> {
  return runnerClient(w, runnerId).mutation(api.runnerJobs.claim, { bootId });
}

async function complete(w: World, claimed: ClaimedJob, result: unknown, runnerId = w.runnerId) {
  return runnerClient(w, runnerId).mutation(api.runnerJobs.complete, {
    jobId: claimed.job.id,
    bootId: claimed.lease.bootId,
    attempt: claimed.lease.attempt,
    outcome: { status: "done", result },
  });
}

const started = (sessionId: string) => ({
  kind: "started",
  sessionId,
  model: { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" },
  attendance: "unattended",
});

async function attention(w: World, id: string) {
  return w.t.run(async (ctx) =>
    ctx.db
      .query("attentionItems")
      .withIndex("by_uuid", (q) => q.eq("id", id))
      .unique(),
  );
}

// 09:30 EST on Saturday 7 March is 14:30Z.
const SAT_0930 = Date.parse("2026-03-07T14:30:00Z");
// New York springs forward overnight: 09:30 EDT on Sunday 8 March is 13:30Z.
const SUN_0930 = Date.parse("2026-03-08T13:30:00Z");
const MON_0930 = Date.parse("2026-03-09T13:30:00Z");
const TUE_0930 = Date.parse("2026-03-10T13:30:00Z");

describe("the minute clock", () => {
  test("arming owes nothing; a due schedule fires once, never early, at most a tick late", async () => {
    const w = await world();
    const { nextFireAt } = await armSchedule(w);
    expect(nextFireAt).toBe(SAT_0930);

    await tick(w, SAT_0930 - 1);
    expect(await automationJobs(w)).toEqual([]);

    await tick(w, SAT_0930 + 59_000);
    const [job] = await automationJobs(w);
    expect(job).toMatchObject({ status: "queued", runnerId: w.runnerId, availableAt: SAT_0930 });
    const payload = parseJobPayload("automation.run", job!.payload);
    expect(payload).toMatchObject({
      trigger: "schedule",
      automationId: w.scheduleId,
      ticketId: null,
      armedByUserId: w.userId,
      dueAt: SAT_0930,
      missedCount: 0,
      attendance: "unattended",
    });
    const [run] = await runsOf(w);
    expect(run).toMatchObject({
      id: (payload as { runId: string }).runId,
      status: "queued",
      trigger: "schedule",
      dueAt: SAT_0930,
      jobId: job!.id,
      runnerId: w.runnerId,
    });
    // The DST row: Sunday's 09:30 is an hour earlier in UTC.
    expect(await scheduleRow(w)).toMatchObject({
      nextFireAt: SUN_0930,
      lastFiredAt: SAT_0930,
      pendingJobId: job!.id,
      pendingRunId: run!.id,
      gapRunId: null,
    });

    // Duplicate ticks in the same minute find nothing due.
    await tick(w, SAT_0930 + 59_500);
    await w.t.mutation(internal.automationSchedules.fireDue, { now: SAT_0930 + 59_500 });
    expect(await automationJobs(w)).toHaveLength(1);
    expect(await runsOf(w)).toHaveLength(1);
  });

  test("a continuation never fires ahead of the clock", async () => {
    const w = await world();
    await armSchedule(w);
    vi.setSystemTime(SAT_0930 - MINUTE);
    await w.t.mutation(internal.automationSchedules.fireDue, { now: SAT_0930 + MINUTE });
    expect(await automationJobs(w)).toEqual([]);
  });

  test("a weekend asleep is one skip row and one Run, which starts once on wake", async () => {
    const w = await world();
    await armSchedule(w);
    await setRunner(w.t, w.runnerId, { status: "asleep" });
    for (const at of [SAT_0930, SUN_0930, MON_0930]) await tick(w, at + 30_000);

    const jobs = await automationJobs(w);
    expect(jobs.map((job) => [job.status, job.availableAt])).toEqual([["queued", MON_0930]]);
    const payload = parseJobPayload("automation.run", jobs[0]!.payload) as {
      runId: string;
      missedCount: number;
      dueAt: number;
    };
    expect(payload).toMatchObject({ dueAt: MON_0930, missedCount: 2 });
    const runs = await runsOf(w);
    expect(runs.map((run) => [run.status, run.dueAt, run.missedCount]).toSorted()).toEqual([
      ["queued", MON_0930, null],
      ["skipped", SUN_0930, 2],
    ]);
    const gap = runs.find((run) => run.status === "skipped")!;
    expect(gap.skipReason).toEqual({ kind: "runner-asleep", runnerId: w.runnerId });
    expect((await scheduleRow(w))!.gapRunId).toBe(gap.id);
    const skips = (await projectEvents(w.t, w.projectId)).filter(
      (event) => event.payload.kind === "automation_run_skipped",
    );
    expect(skips).toHaveLength(1);

    // The Mac wakes: exactly one Run starts, and the next occurrence starts afresh.
    await setRunner(w.t, w.runnerId, { status: "online" });
    vi.setSystemTime(MON_0930 + 5 * MINUTE);
    const claimed = await claim(w);
    expect(claimed).toHaveLength(1);
    await complete(
      w,
      claimed[0]!,
      started((claimed[0]!.job.payload as { sessionId: string }).sessionId),
    );
    const after = await runsOf(w);
    expect(after.filter((run) => run.status === "started")).toHaveLength(1);
    expect(await scheduleRow(w)).toMatchObject({ pendingJobId: null, gapRunId: null });
    const startedEvent = (await projectEvents(w.t, w.projectId)).find(
      (event) => event.payload.kind === "automation_run_started",
    )!;
    expect(startedEvent.actor).toMatchObject({
      kind: "automation",
      userId: w.userId,
      automationId: w.scheduleId,
      runId: payload.runId,
    });

    await tick(w, TUE_0930 + 30_000);
    const fresh = (await automationJobs(w)).filter((job) => job.status === "queued");
    expect(fresh).toHaveLength(1);
    expect(parseJobPayload("automation.run", fresh[0]!.payload)).toMatchObject({
      dueAt: TUE_0930,
      missedCount: 0,
    });
    expect((await runsOf(w)).filter((run) => run.status === "skipped")).toHaveLength(1);
  });

  test("one tick after a long sleep covers every missed occurrence in the same skip row", async () => {
    const w = await world();
    await armSchedule(w);
    await tick(w, MON_0930 + 30_000);
    const runs = await runsOf(w);
    expect(runs.map((run) => [run.status, run.dueAt, run.missedCount]).toSorted()).toEqual([
      ["queued", MON_0930, null],
      ["skipped", SUN_0930, 2],
    ]);
    expect(runs.find((run) => run.status === "skipped")!.skipReason).toEqual({
      kind: "superseded",
    });
    // A further supersede folds into that same row.
    await tick(w, TUE_0930 + 30_000);
    const later = await runsOf(w);
    expect(later.map((run) => [run.status, run.dueAt, run.missedCount]).toSorted()).toEqual([
      ["queued", TUE_0930, null],
      ["skipped", MON_0930, 3],
    ]);
    expect(await automationJobs(w)).toHaveLength(1);
  });

  test("a Run its runner already holds is not moved: the next occurrence queues behind it", async () => {
    const w = await world();
    await armSchedule(w);
    await tick(w, SAT_0930 + 30_000);
    vi.setSystemTime(SAT_0930 + MINUTE);
    const [held] = await claim(w);
    await tick(w, SUN_0930 + 30_000);
    const jobs = await automationJobs(w);
    expect(jobs.map((job) => job.status).toSorted()).toEqual(["leased", "queued"]);
    expect((await runsOf(w)).filter((run) => run.status === "skipped")).toEqual([]);

    // The earlier Run's Session is still working: the runner's context says so.
    const sessionId = (held!.job.payload as { sessionId: string }).sessionId;
    await complete(w, held!, started(sessionId));
    const { sessionId: seeded } = await seedSession(
      w.t,
      { projectId: w.projectId, ticketId: null as unknown as string },
      w.userId,
      { turnActive: true },
    );
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", seeded))
        .unique();
      await ctx.db.patch(row!._id, { id: sessionId });
    });
    vi.setSystemTime(SUN_0930 + 2 * MINUTE);
    const [next] = await claim(w);
    const context = await runnerClient(w).query(api.automationRunner.runContext, {
      jobId: next!.job.id,
      bootId: next!.lease.bootId,
      attempt: next!.lease.attempt,
    });
    expect(context).toMatchObject({
      kind: "ready",
      previousRunActive: true,
      scheduleArming: { automationId: w.scheduleId, runnerId: w.runnerId, pausedAt: null },
    });
  });

  test("paused rows, deleted Automations and archived projects fire nothing", async () => {
    const w = await world();
    const second = await createAutomation(w.as, w.projectId, "Second", daily(9, 30));
    await armSchedule(w);
    await armSchedule(w, second);
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("automationSchedules")
        .withIndex("by_automation", (q) => q.eq("automationId", w.scheduleId))
        .unique();
      await ctx.db.patch(row!._id, { pausedAt: NOW, pausedReason: "moved" });
    });
    await tick(w, SAT_0930 + 30_000);
    // Only the unpaused schedule fired; the paused one keeps its cursor.
    expect((await runsOf(w, null)).map((run) => run.automationId)).toEqual([second]);
    expect((await scheduleRow(w))!.nextFireAt).toBe(SAT_0930);

    await w.as.mutation(api.automations.remove, { commandId: command(), automationId: second });
    await w.as.mutation(api.projects.archive, { commandId: command(), projectId: w.projectId });
    await tick(w, MON_0930 + 30_000);
    expect(await automationJobs(w)).toHaveLength(1);
  });

  test("a removed runner pauses the schedule with one skip row and one Needs-you item", async () => {
    const w = await world();
    await armSchedule(w);
    await tick(w, SAT_0930 + 30_000);
    // Revoked out from under the arming, without the transactional pause.
    await setRunner(w.t, w.runnerId, { revokedAt: NOW, status: "revoked" });
    await tick(w, SUN_0930 + 30_000);
    const row = await scheduleRow(w);
    expect(row).toMatchObject({ pausedReason: "runner_removed", pendingJobId: null });
    expect(row!.pausedAt).not.toBeNull();
    const runs = await runsOf(w);
    expect(runs.map((run) => [run.status, run.dueAt, run.missedCount])).toEqual([
      ["skipped", SUN_0930, 2],
    ]);
    expect(runs[0]!.skipReason).toEqual({ kind: "runner-unavailable", code: "runner_removed" });
    expect((await automationJobs(w)).map((job) => job.status)).toEqual(["cancelled"]);
    expect(await attention(w, `a:${w.projectId}:${w.userId}:paused`)).toMatchObject({
      kind: "automation_paused",
      clearedAt: null,
    });
    await tick(w, MON_0930 + 30_000);
    expect(await runsOf(w)).toHaveLength(1);
  });

  test("New York springs forward: a 02:30 schedule fires at 03:30 EDT, not before", async () => {
    const w = await world(daily(2, 30));
    const { nextFireAt } = await armSchedule(w);
    const target = Date.parse("2026-03-08T07:30:00Z");
    expect(nextFireAt).toBe(target);
    await tick(w, Date.parse("2026-03-08T07:00:00Z"));
    await tick(w, target - 1);
    expect(await automationJobs(w)).toEqual([]);
    await tick(w, target + 1);
    expect((await automationJobs(w)).map((job) => job.availableAt)).toEqual([target]);
    expect((await scheduleRow(w))!.nextFireAt).toBe(Date.parse("2026-03-09T06:30:00Z"));
  });

  test("New York falls back: a 01:30 schedule fires once, at the second 01:30", async () => {
    vi.setSystemTime(Date.parse("2026-10-31T12:00:00Z"));
    const w = await world(daily(1, 30));
    const { nextFireAt } = await armSchedule(w);
    const second = Date.parse("2026-11-01T06:30:00Z");
    expect(nextFireAt).toBe(second);
    await tick(w, Date.parse("2026-11-01T05:30:30Z"));
    expect(await automationJobs(w)).toEqual([]);
    await tick(w, second + 30_000);
    await tick(w, second + 90_000);
    expect(await automationJobs(w)).toHaveLength(1);
    expect((await scheduleRow(w))!.nextFireAt).toBe(Date.parse("2026-11-02T06:30:00Z"));
  });

  test("the stored zone wins: a Kolkata weekday schedule skips the weekend", async () => {
    vi.setSystemTime(Date.parse("2026-10-30T06:00:00Z"));
    const w = await world({
      kind: "schedule",
      schedule: { preset: "weekdays", hour: 9, minute: 30, timeZone: "Asia/Kolkata" },
    });
    expect((await armSchedule(w)).nextFireAt).toBe(Date.parse("2026-11-02T04:00:00Z"));
  });
});

describe("Run commands", () => {
  async function personRun(w: World, patch: Record<string, unknown> = {}) {
    return w.as.mutation(api.automations.run, {
      commandId: command(),
      automationId: w.reviewId,
      ticketId: w.ticketId,
      runnerId: w.runnerId,
      ...patch,
    });
  }

  test("a by-hand Run queues on the caller's runner, attended, and replays by command id", async () => {
    const w = await world();
    const commandId = command();
    const reply = await personRun(w, { commandId });
    expect(reply).toMatchObject({
      runner: { id: w.runnerId, status: "online" },
      receipt: { replayed: false },
    });
    expect(await personRun(w, { commandId })).toMatchObject({
      runId: reply.runId,
      receipt: { replayed: true },
    });
    const [job] = await automationJobs(w);
    expect(parseJobPayload("automation.run", job!.payload)).toMatchObject({
      trigger: "manual",
      automationId: w.reviewId,
      ticketId: w.ticketId,
      armedByUserId: null,
      runId: reply.runId,
      sessionId: reply.sessionId,
      attendance: "attended",
      requestedBySessionId: null,
    });
    expect(await runsOf(w, w.reviewId)).toMatchObject([
      { id: reply.runId, status: "queued", trigger: "manual", ticketId: w.ticketId },
    ]);
    // No runner named, or a runner without the executor: refused, nothing queued.
    await expect(personRun(w, { runnerId: null })).rejects.toThrow(code("runner_unavailable"));
    const old = await seedRunner(w.t, w.userId);
    await expect(personRun(w, { runnerId: old })).rejects.toThrow(code("runner_needs_update"));
    const bob = await signIn(w.t, "bob");
    const bobRunner = await capableRunner(w.t, bob.userId);
    await expect(personRun(w, { runnerId: bobRunner })).rejects.toThrow(code("runner_not_yours"));
    expect(await automationJobs(w)).toHaveLength(1);
  });

  test("Unbound Instructions and a project-level Run now", async () => {
    const w = await world();
    const unbound = await personRun(w, { automationId: null, instructions: "Tidy the ticket" });
    await expect(personRun(w, { automationId: null, instructions: "  " })).rejects.toThrow(
      code("invalid_draft"),
    );
    const project = await w.as.mutation(api.automations.runForProject, {
      commandId: command(),
      automationId: w.scheduleId,
      runnerId: w.runnerId,
    });
    const payloads = (await automationJobs(w)).map((job) =>
      parseJobPayload("automation.run", job.payload),
    );
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: unbound.runId,
          automationId: null,
          instructions: "Tidy the ticket",
        }),
        expect.objectContaining({
          runId: project.runId,
          automationId: w.scheduleId,
          ticketId: null,
          trigger: "manual",
        }),
      ]),
    );
    expect((await runsOf(w, null)).find((run) => run.id === unbound.runId)).toMatchObject({
      instructions: "Tidy the ticket",
      automationName: null,
    });
  });

  test("an agent's Run uses its own runner, is unattended, and its watch arms on start", async () => {
    const w = await world();
    const { sessionId: callerId, runnerId: agentRunner } = await seedSession(
      w.t,
      { projectId: w.projectId, ticketId: w.ticketId },
      w.userId,
    );
    await setRunner(w.t, agentRunner, { capabilities: { tools: ["automation.run"] } });
    const other = await createTicket(w.as, w.projectId, { title: "Other" });
    const agent = w.t.withIdentity({
      issuer: AGENT_TOKEN_ISSUER,
      subject: agentSubject(callerId),
      own: w.userId,
      rnr: agentRunner,
      gen: 1,
      tkt: w.ticketId,
    });
    // A ticket Session may name another ticket in its project.
    const reply = await agent.mutation(api.automations.run, {
      commandId: command(),
      automationId: w.reviewId,
      ticketId: other.ticketId,
    });
    expect(reply.runner.id).toBe(agentRunner);
    const [job] = await automationJobs(w);
    expect(parseJobPayload("automation.run", job!.payload)).toMatchObject({
      attendance: "unattended",
      requestedBySessionId: callerId,
    });

    // The completion reaches the backend before the Session's first accept.
    vi.setSystemTime(NOW + MINUTE);
    const [held] = await claim(w, agentRunner);
    await complete(w, held!, started(reply.sessionId), agentRunner);
    const watches = () => w.t.run(async (ctx) => ctx.db.query("watches").collect());
    expect(await watches()).toEqual([]);
    // Its first accept arms the caller's watch, under the frozen id.
    const { events } = await writeSession({
      sessionId: reply.sessionId,
      projectId: w.projectId,
      ticketId: other.ticketId,
    });
    await w.t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        id: reply.sessionId,
        projectId: w.projectId,
        ticketId: other.ticketId,
        role: "ticket",
        parentSessionId: null,
        ownerUserId: w.userId,
        origin: { kind: "automation", automationRunId: reply.runId, automationName: "Review" },
        title: null,
        visibility: "shared",
        visibilityReason: "ticket",
        sharedAt: null,
        status: "open",
        turnActive: false,
        lastTurnOutcome: null,
        signal: null,
        stopped: null,
        needsUser: false,
        attentionCount: 0,
        placeRunnerId: agentRunner,
        model: null,
        usageTotals: {},
        createdAt: NOW,
        lastActivityAt: NOW,
        deletedAt: null,
        purgeAfter: null,
      });
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", reply.sessionId))
        .unique();
      await onSessionFact(ctx, session!, events[0]!);
    });
    const armed = await watches();
    expect(armed).toMatchObject([
      {
        watcherSessionId: callerId,
        target: { kind: "session", id: reply.sessionId },
        origin: "started",
      },
    ]);
    const receipts = await w.t.run(async (ctx) => ctx.db.query("watchReceipts").collect());
    expect(receipts.map((row) => row.commandId)).toEqual([
      automationRunWatchCommandId(reply.runId),
    ]);

    // A ticket in another project reads as absent.
    const elsewhere = await boardFixture(w.t, "carol");
    const foreign = await createTicket(elsewhere.as, elsewhere.projectId);
    await expect(
      agent.mutation(api.automations.run, {
        commandId: command(),
        automationId: w.reviewId,
        ticketId: foreign.ticketId,
      }),
    ).rejects.toThrow();
  });

  test("an agent's watch arms at completion when its Session was accepted first", async () => {
    const w = await world();
    const { sessionId: callerId, runnerId: agentRunner } = await seedSession(
      w.t,
      { projectId: w.projectId, ticketId: w.ticketId },
      w.userId,
    );
    await setRunner(w.t, agentRunner, { capabilities: { tools: ["automation.run"] } });
    const agent = w.t.withIdentity({
      issuer: AGENT_TOKEN_ISSUER,
      subject: agentSubject(callerId),
      own: w.userId,
      rnr: agentRunner,
      gen: 1,
      tkt: w.ticketId,
    });
    const reply = await agent.mutation(api.automations.run, {
      commandId: command(),
      automationId: w.reviewId,
      ticketId: w.ticketId,
    });
    const { sessionId: bornId } = await seedSession(
      w.t,
      { projectId: w.projectId, ticketId: w.ticketId },
      w.userId,
    );
    // Stand the seeded Session in for the Run's own (its id is the minted one).
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", bornId))
        .unique();
      await ctx.db.patch(row!._id, { id: reply.sessionId });
    });
    vi.setSystemTime(NOW + MINUTE);
    const [held] = await claim(w, agentRunner);
    await complete(w, held!, started(reply.sessionId), agentRunner);
    expect(await w.t.run(async (ctx) => ctx.db.query("watches").collect())).toMatchObject([
      { watcherSessionId: callerId, target: { id: reply.sessionId } },
    ]);
  });

  test("cancel withdraws a waiting Run; once a runner holds it, it is starting", async () => {
    const w = await world();
    const first = await personRun(w);
    const [job] = await automationJobs(w);
    // Cancel first: the claim finds nothing.
    await w.as.mutation(api.automations.cancelPendingArrival, {
      commandId: command(),
      jobId: job!.id,
    });
    expect(await claim(w)).toEqual([]);
    expect((await runsOf(w, w.reviewId)).find((run) => run.id === first.runId)).toMatchObject({
      status: "skipped",
      skipReason: { kind: "run-refused", code: "cancelled" },
    });
    // Claim first: the cancel is refused and the Run goes on.
    await personRun(w);
    const [held] = await claim(w);
    await expect(
      w.as.mutation(api.automations.cancelPendingArrival, {
        commandId: command(),
        jobId: held!.job.id,
      }),
    ).rejects.toThrow(code("run_already_started"));
  });
});

describe("arrivals and the completion hook", () => {
  async function armDoing(w: World) {
    await w.as.mutation(api.automations.arm, {
      commandId: command(),
      projectId: w.projectId,
      status: "doing",
      automationId: w.reviewId,
      runnerId: w.runnerId,
    });
  }
  async function arrive(w: World, status: "doing" | "todo" = "doing") {
    await w.as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId: w.projectId,
      ticketIds: [w.ticketId],
      toStatus: status,
    });
  }

  test("an armed arrival carries a Run identity; abandoned it leaves no row, started it writes one", async () => {
    const w = await world();
    await armDoing(w);
    await arrive(w);
    const [job] = await automationJobs(w);
    const payload = parseJobPayload("automation.run", job!.payload) as {
      runId: string;
      sessionId: string;
      attendance: string;
    };
    expect(payload).toMatchObject({ trigger: "arrival", origin: "armed", attendance: "attended" });
    expect(payload.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await runsOf(w, w.reviewId)).toEqual([]);

    vi.setSystemTime(NOW + MINUTE);
    const [held] = await claim(w);
    const context = await runnerClient(w).query(api.automationRunner.runContext, {
      jobId: held!.job.id,
      bootId: held!.lease.bootId,
      attempt: held!.lease.attempt,
    });
    expect(context).toMatchObject({
      kind: "ready",
      projectId: w.projectId,
      automation: { id: w.reviewId, name: "Review" },
      ticket: { id: w.ticketId, status: "doing", archived: false },
      columnArming: { automationId: w.reviewId, runnerId: w.runnerId, pausedAt: null },
      scheduleArming: null,
      previousRunActive: false,
    });
    // Fenced by the CURRENT lease.
    expect(
      await runnerClient(w).query(api.automationRunner.runContext, {
        jobId: held!.job.id,
        bootId: BOOT2,
        attempt: held!.lease.attempt,
      }),
    ).toEqual({ kind: "unavailable", reason: "lease_lost" });
    await complete(w, held!, { kind: "abandoned", reason: "left-column" });
    expect(await runsOf(w, w.reviewId)).toEqual([]);

    await arrive(w, "todo");
    await arrive(w);
    vi.setSystemTime(NOW + 2 * MINUTE);
    const [again] = await claim(w);
    const sessionId = (again!.job.payload as { sessionId: string }).sessionId;
    await complete(w, again!, started(sessionId));
    expect(await runsOf(w, w.reviewId)).toMatchObject([
      {
        status: "started",
        trigger: "arrival",
        sessionId,
        ticketId: w.ticketId,
        armedByUserId: w.userId,
      },
    ]);
  });

  test("a refused arrival fails with attention and a Retry that runs the same Run once", async () => {
    const w = await world();
    await armDoing(w);
    await arrive(w);
    vi.setSystemTime(NOW + MINUTE);
    const [held] = await claim(w);
    const runId = (held!.job.payload as { runId: string }).runId;
    await complete(w, held!, { kind: "refused", code: "model_unavailable", detail: "No key." });
    const [failed] = await runsOf(w, w.reviewId);
    expect(failed).toMatchObject({ id: runId, status: "failed", error: "No key." });
    expect(failed!.retryCommandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await attention(w, automationRunFailedAttentionId(runId))).toMatchObject({
      userId: w.userId,
      kind: "automation_run_failed",
      clearedAt: null,
    });
    expect(
      (await projectEvents(w.t, w.projectId)).filter(
        (event) => event.payload.kind === "automation_run_failed",
      ),
    ).toHaveLength(1);
    const pending = await w.as.query(api.automations.pendingArrivals, { projectId: w.projectId });
    expect(pending).toMatchObject({
      pending: [],
      failures: [{ runId, retryCommandId: failed!.retryCommandId, error: "No key." }],
    });

    const commandId = command();
    const retried = await w.as.mutation(api.automations.retryArrival, { commandId, runId });
    expect(retried.jobId).toBe(failed!.retryCommandId);
    expect(await w.as.mutation(api.automations.retryArrival, { commandId, runId })).toMatchObject({
      receipt: { replayed: true },
    });
    await expect(
      w.as.mutation(api.automations.retryArrival, { commandId: command(), runId }),
    ).rejects.toThrow(code("retry_unavailable"));
    expect((await attention(w, automationRunFailedAttentionId(runId)))!.clearedAt).not.toBeNull();
    expect(
      (await w.as.query(api.automations.pendingArrivals, { projectId: w.projectId })).pending,
    ).toMatchObject([{ jobId: retried.jobId, runId, leased: false }]);

    vi.setSystemTime(NOW + 2 * MINUTE);
    const [retry] = await claim(w);
    expect(retry!.job.id).toBe(failed!.retryCommandId);
    await complete(w, retry!, started((retry!.job.payload as { sessionId: string }).sessionId));
    const runs = await runsOf(w, w.reviewId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, status: "started" });
    expect(runs[0]).not.toHaveProperty("retryCommandId");
  });

  test("a dead-lettered schedule Run fails; an abandoned one is skipped", async () => {
    const w = await world();
    await armSchedule(w);
    await tick(w, SAT_0930 + 30_000);
    let at = SAT_0930 + MINUTE;
    let claimed: ClaimedJob[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      vi.setSystemTime(at);
      claimed = await claim(w, w.runnerId, `b0000000-0000-4000-8000-00000000010${attempt}`);
      expect(claimed).toHaveLength(1);
      await runnerClient(w).mutation(api.runnerJobs.complete, {
        jobId: claimed[0]!.job.id,
        bootId: claimed[0]!.lease.bootId,
        attempt: claimed[0]!.lease.attempt,
        outcome: { status: "failed", code: "boom", detail: "It broke.", retryable: true },
      });
      at += 15 * MINUTE;
    }
    const [failed] = await runsOf(w);
    expect(failed).toMatchObject({ status: "failed", error: "It broke." });
    expect(failed).not.toHaveProperty("retryCommandId");
    expect(await scheduleRow(w)).toMatchObject({ pendingJobId: null });

    await tick(w, SUN_0930 + 30_000);
    vi.setSystemTime(SUN_0930 + MINUTE);
    const [next] = await claim(w, w.runnerId, BOOT2);
    await complete(w, next!, { kind: "abandoned", reason: "schedule-disarmed" });
    const skipped = (await runsOf(w)).find((run) => run.dueAt === SUN_0930)!;
    expect(skipped).toMatchObject({
      status: "skipped",
      skipReason: { kind: "run-refused", code: "schedule-disarmed" },
    });
  });

  test("an unreadable result or a Session under another id is recorded as a failure", async () => {
    const w = await world();
    await w.as.mutation(api.automations.run, {
      commandId: command(),
      automationId: w.reviewId,
      ticketId: w.ticketId,
      runnerId: w.runnerId,
    });
    vi.setSystemTime(NOW + MINUTE);
    const [held] = await claim(w);
    await complete(w, held!, started(newId("session")));
    expect((await runsOf(w, w.reviewId))[0]).toMatchObject({
      status: "failed",
      error: "The runner started this Run under another Session id.",
    });
  });
});
