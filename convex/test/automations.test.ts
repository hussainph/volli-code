import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  nextScheduleOccurrence,
  type AutomationDraft,
  type AutomationTrigger,
} from "@volli/shared";
import {
  AGENT_TOKEN_ISSUER,
  RUNNER_TOKEN_ISSUER,
  agentSubject,
  automationAbandonSkipReason,
  newId,
  parseId,
  parseJobPayload,
  runnerSubject,
  type Actor,
} from "@volli/shared/cloud";
import { api, internal } from "../functions/_generated/api";
import { enqueueJob } from "../functions/lib/jobs";
import { pauseArmingsFor } from "../functions/lib/automations";
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

const NOW = Date.parse("2026-03-07T12:00:00Z");
const spec = { preset: "daily" as const, hour: 9, minute: 30, timeZone: "America/New_York" };
const columns: AutomationTrigger = { kind: "columns", columns: ["doing", "needs_review"] };
const scheduled: AutomationTrigger = { kind: "schedule", schedule: spec };
const draft: AutomationDraft = {
  name: "Review",
  instructions: "Review the work",
  runtime: null,
  trigger: columns,
};
const command = () => newId("command");
const pageOpts = { numItems: 2, cursor: null };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function create(as: Client, projectId: string, patch: Partial<typeof draft> = {}) {
  const automationId = newId("automation");
  await as.mutation(api.automations.create, {
    commandId: command(),
    projectId,
    automationId,
    ...draft,
    ...patch,
  });
  return automationId;
}

async function capableRunner(t: Tester, userId: string) {
  const runnerId = await seedRunner(t, userId);
  await t.run(async (ctx) => {
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", runnerId))
      .unique();
    await ctx.db.patch(runner!._id, { capabilities: { tools: ["automation.run"] } });
  });
  return runnerId;
}

async function addMember(
  t: Tester,
  workspaceId: string,
  userId: string,
  status: "active" | "suspended" | "left" = "active",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("workspaceMembers", {
      id: newId("member"),
      workspaceId,
      userId,
      role: "member",
      status,
      billingTier: "free",
      joinedAt: NOW,
      suspendedAt: null,
      leftAt: null,
      invitedByUserId: null,
    });
  });
}

async function world() {
  const t = setup();
  const alice = await boardFixture(t);
  const bob = await signIn(t, "bob");
  await addMember(t, alice.workspaceId, bob.userId);
  const runnerId = await capableRunner(t, alice.userId);
  const bobRunnerId = await capableRunner(t, bob.userId);
  const automationId = await create(alice.as, alice.projectId);
  const scheduleId = await create(alice.as, alice.projectId, { name: "Daily", trigger: scheduled });
  const ticket = await createTicket(alice.as, alice.projectId);
  return {
    t,
    ...alice,
    bob,
    runnerId,
    bobRunnerId,
    automationId,
    scheduleId,
    ticketId: ticket.ticketId,
  };
}

type World = Awaited<ReturnType<typeof world>>;
async function armBoth(w: World) {
  await w.as.mutation(api.automations.arm, {
    commandId: command(),
    projectId: w.projectId,
    status: "doing",
    automationId: w.automationId,
    runnerId: w.runnerId,
  });
  await w.as.mutation(api.automations.armSchedule, {
    commandId: command(),
    automationId: w.scheduleId,
    runnerId: w.runnerId,
  });
}

async function waiting(
  w: World,
  trigger: "arrival" | "schedule" | "manual",
  options: {
    leased?: boolean;
    runnerId?: string;
    userId?: string;
    projectId?: string;
    automationId?: string;
  } = {},
) {
  const runnerId = options.runnerId ?? w.runnerId;
  const userId = options.userId ?? w.userId;
  const projectId = options.projectId ?? w.projectId;
  const automationId =
    options.automationId ?? (trigger === "schedule" ? w.scheduleId : w.automationId);
  const runId = newId("job");
  const sessionId = newId("session");
  const actor: Actor = { kind: "person", userId: parseId("user", userId) };
  return w.t.run(async (ctx) => {
    const common = {
      runId,
      sessionId,
      dueAt: NOW,
      missedCount: 0,
      attendance: "unattended" as const,
      modelOverride: null,
      requestedBySessionId: null,
      automationId,
      armedByUserId: userId,
    };
    const payload =
      trigger === "arrival"
        ? {
            ...common,
            trigger,
            ticketId: w.ticketId,
            from: "todo",
            status: "doing",
            origin: "armed",
          }
        : trigger === "schedule"
          ? { ...common, trigger, ticketId: null }
          : { ...common, trigger, ticketId: w.ticketId, armedByUserId: null };
    const { jobId } = await enqueueJob(ctx, {
      runnerId,
      projectId,
      ticketId: trigger === "schedule" ? null : w.ticketId,
      kind: "automation.run",
      createdBy: actor,
      onBehalfOf: userId,
      payload: parseJobPayload("automation.run", payload),
    });
    if (trigger !== "arrival")
      await ctx.db.insert("automationRuns", {
        id: runId,
        automationId,
        automationName: "Review",
        projectId,
        ticketId: trigger === "schedule" ? null : w.ticketId,
        sessionId,
        trigger,
        status: "queued",
        skipReason: null,
        missedCount: 0,
        dueAt: NOW,
        model: null,
        attendance: "unattended",
        armedByUserId: userId,
        runnerId,
        createdAt: NOW,
        jobId,
      });
    if (options.leased) {
      const job = await ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", jobId))
        .unique();
      await ctx.db.patch(job!._id, {
        status: "leased",
        lease: { bootId: "boot", attempt: 1, expiresAt: NOW + 60_000 },
      });
    }
    return { jobId, runId };
  });
}

async function jobStatus(w: World, jobId: string) {
  return w.t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("runnerJobs")
          .withIndex("by_uuid", (q) => q.eq("id", jobId))
          .unique()
      )?.status,
  );
}

const reads = (w: World, as: Client) => [
  () => as.query(api.automations.list, { projectId: w.projectId }),
  () => as.query(api.automations.armings, { projectId: w.projectId }),
  () => as.query(api.automations.columnOrders, { projectId: w.projectId }),
  () => as.query(api.automations.schedules, { projectId: w.projectId }),
  () =>
    as.query(api.automations.runsForProject, { projectId: w.projectId, paginationOpts: pageOpts }),
  () => as.query(api.automations.runsForTicket, { ticketId: w.ticketId, paginationOpts: pageOpts }),
  () =>
    as.query(api.automations.runsForAutomation, {
      automationId: w.automationId,
      paginationOpts: pageOpts,
    }),
];
const writes = (w: World, as: Client) => [
  () =>
    as.mutation(api.automations.create, {
      commandId: command(),
      projectId: w.projectId,
      automationId: newId("automation"),
      ...draft,
      name: "New",
    }),
  () =>
    as.mutation(api.automations.update, {
      commandId: command(),
      automationId: w.automationId,
      ...draft,
    }),
  () => as.mutation(api.automations.remove, { commandId: command(), automationId: w.automationId }),
  () =>
    as.mutation(api.automations.arm, {
      commandId: command(),
      projectId: w.projectId,
      status: "doing",
      automationId: w.automationId,
      runnerId: w.runnerId,
    }),
  () =>
    as.mutation(api.automations.setColumnOrder, {
      commandId: command(),
      projectId: w.projectId,
      status: "doing",
      rankedIds: [w.automationId],
    }),
  () =>
    as.mutation(api.automations.armSchedule, {
      commandId: command(),
      automationId: w.scheduleId,
      runnerId: w.runnerId,
    }),
  () =>
    as.mutation(api.automations.disarmSchedule, {
      commandId: command(),
      automationId: w.scheduleId,
    }),
];

describe("Automation records", () => {
  test("CRUD uses shared validation, project-local unique names, canonical rows and board events", async () => {
    const t = setup();
    const { as, projectId, userId } = await boardFixture(t);
    const automationId = await create(as, projectId, { name: "  Review  " });
    const z = await create(as, projectId, { name: "Zebra" });
    expect((await as.query(api.automations.list, { projectId })).map((row) => row.name)).toEqual([
      "Review",
      "Zebra",
    ]);
    const definition = (await as.query(api.automations.list, { projectId }))[0]!;
    expect(definition).toMatchObject({
      id: automationId,
      runtime: null,
      trigger: columns,
      createdBy: { kind: "person", userId },
    });
    expect(definition).not.toHaveProperty("_id");
    for (const [patch, refusal] of [
      [{ name: " review " }, "name_taken"],
      [{ instructions: "" }, "invalid_draft"],
      [{ instructions: "x".repeat(32_001) }, "draft_too_large"],
      [{ runtime: { bad: true } }, "invalid_runtime"],
      [{ trigger: { kind: "alien" } }, "invalid_trigger"],
    ] as const) {
      await expect(
        as.mutation(api.automations.create, {
          commandId: command(),
          projectId,
          automationId: newId("automation"),
          ...draft,
          name: "Other",
          ...patch,
        }),
      ).rejects.toThrow(code(refusal));
    }
    await as.mutation(api.automations.update, {
      commandId: command(),
      automationId,
      ...draft,
      name: "Changed",
    });
    await as.mutation(api.automations.remove, { commandId: command(), automationId: z });
    expect((await as.query(api.automations.list, { projectId })).map((row) => row.name)).toEqual([
      "Changed",
    ]);
    expect((await projectEvents(t, projectId)).slice(1).map((event) => event.payload)).toEqual([
      { kind: "automation_changed", automationId, change: "created" },
      { kind: "automation_changed", automationId: z, change: "created" },
      { kind: "automation_changed", automationId, change: "updated" },
      { kind: "automation_changed", automationId: z, change: "deleted" },
    ]);
    await expect(
      as.mutation(api.automations.create, {
        commandId: command(),
        projectId,
        automationId: z,
        ...draft,
        name: "Again",
      }),
    ).rejects.toThrow(code("automation_exists"));
    const other = await boardFixture(t, "other");
    await create(other.as, other.projectId, { name: "Changed" });
    await expect(
      other.as.mutation(api.automations.create, {
        commandId: command(),
        projectId: other.projectId,
        automationId,
        ...draft,
      }),
    ).rejects.toThrow(code("automation_not_in_project"));
  });

  test("all writes have receipts, replay causes no new events, and changed intents/callers conflict", async () => {
    const w = await world();
    const id = newId("automation");
    const operations = [
      {
        ref: api.automations.create,
        args: { projectId: w.projectId, automationId: id, ...draft, name: "Receipt" },
      },
      {
        ref: api.automations.update,
        args: { automationId: id, ...draft, name: "Receipt changed" },
      },
      {
        ref: api.automations.arm,
        args: { projectId: w.projectId, status: "doing", automationId: id, runnerId: w.runnerId },
      },
      {
        ref: api.automations.setColumnOrder,
        args: { projectId: w.projectId, status: "doing", rankedIds: [id] },
      },
      {
        ref: api.automations.armSchedule,
        args: { automationId: w.scheduleId, runnerId: w.runnerId },
      },
      { ref: api.automations.disarmSchedule, args: { automationId: w.scheduleId } },
      { ref: api.automations.remove, args: { automationId: id } },
    ];
    for (const operation of operations) {
      const args = { commandId: command(), ...operation.args };
      // The runtime path is the real generated function reference/validator for each shape.
      const first = await w.as.mutation(operation.ref, args as never);
      const before = (await projectEvents(w.t, w.projectId)).length;
      expect(await w.as.mutation(operation.ref, args as never)).toEqual({
        ...first,
        receipt: { ...first.receipt, replayed: true },
      });
      expect((await projectEvents(w.t, w.projectId)).length).toBe(before);
      await expect(w.bob.as.mutation(operation.ref, args as never)).rejects.toThrow(
        code("command_conflict"),
      );
      await expect(
        w.as.mutation(api.automations.setColumnOrder, {
          commandId: args.commandId,
          projectId: w.projectId,
          status: "todo",
          rankedIds: [],
        }),
      ).rejects.toThrow(code("command_conflict"));
    }
  });

  test("any board Member can replace/disarm a teammate's arm; column order is shared", async () => {
    const w = await world();
    await armBoth(w);
    await w.bob.as.mutation(api.automations.arm, {
      commandId: command(),
      projectId: w.projectId,
      status: "doing",
      automationId: w.automationId,
      runnerId: w.bobRunnerId,
    });
    const armed = await w.as.query(api.automations.armings, { projectId: w.projectId });
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({
      armedByUserId: w.bob.userId,
      runnerId: w.bobRunnerId,
      pausedAt: null,
      runnerStatus: "online",
      armedByDisplayName: expect.any(String),
      runnerName: expect.any(String),
    });
    expect(armed[0]).not.toHaveProperty("_id");
    await w.bob.as.mutation(api.automations.armSchedule, {
      commandId: command(),
      automationId: w.scheduleId,
      runnerId: w.bobRunnerId,
    });
    expect(
      (await w.as.query(api.automations.schedules, { projectId: w.projectId }))[0],
    ).toMatchObject({ armedByUserId: w.bob.userId, runnerId: w.bobRunnerId });
    const before = (await projectEvents(w.t, w.projectId)).length;
    await w.bob.as.mutation(api.automations.setColumnOrder, {
      commandId: command(),
      projectId: w.projectId,
      status: "doing",
      rankedIds: [w.automationId, w.automationId],
    });
    expect(await w.as.query(api.automations.columnOrders, { projectId: w.projectId })).toEqual([
      {
        projectId: w.projectId,
        status: "doing",
        rankedIds: [w.automationId],
        orderedAt: expect.any(Number),
      },
    ]);
    expect((await projectEvents(w.t, w.projectId)).length).toBe(before);
    await expect(
      w.as.mutation(api.automations.setColumnOrder, {
        commandId: command(),
        projectId: w.projectId,
        status: "doing",
        rankedIds: [newId("automation")],
      }),
    ).rejects.toThrow(code("automation_not_in_project"));
    await w.as.mutation(api.automations.arm, {
      commandId: command(),
      projectId: w.projectId,
      status: "doing",
      automationId: null,
    });
    await w.as.mutation(api.automations.disarmSchedule, {
      commandId: command(),
      automationId: w.scheduleId,
    });
    expect(await w.as.query(api.automations.armings, { projectId: w.projectId })).toEqual([]);
    expect(await w.as.query(api.automations.schedules, { projectId: w.projectId })).toEqual([]);
    const events = await projectEvents(w.t, w.projectId);
    expect(
      events.slice(-2).map((event) => ({ ticketId: event.ticketId, payload: event.payload })),
    ).toEqual([
      {
        ticketId: null,
        payload: { kind: "automation_armed", status: "doing", automationId: null, runnerId: null },
      },
      {
        ticketId: null,
        payload: { kind: "automation_schedule_armed", automationId: w.scheduleId, runnerId: null },
      },
    ]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, i) => i + 1));
  });

  test("arm refuses foreign/missing/incapable/offline/revoked runners and mismatched triggers", async () => {
    const w = await world();
    const args = {
      commandId: command(),
      projectId: w.projectId,
      status: "doing" as const,
      automationId: w.automationId,
      runnerId: w.runnerId,
    };
    await expect(
      w.as.mutation(api.automations.arm, { ...args, runnerId: w.bobRunnerId }),
    ).rejects.toThrow(code("runner_not_yours"));
    await expect(
      w.as.mutation(api.automations.arm, { ...args, runnerId: undefined }),
    ).rejects.toThrow(code("runner_unavailable"));
    await expect(
      w.as.mutation(api.automations.arm, { ...args, automationId: w.scheduleId }),
    ).rejects.toThrow(code("wrong_trigger"));
    await expect(
      w.as.mutation(api.automations.armSchedule, {
        commandId: command(),
        automationId: w.automationId,
        runnerId: w.runnerId,
      }),
    ).rejects.toThrow(code("wrong_trigger"));
    for (const [patch, refusal] of [
      [{ capabilities: {} }, "runner_needs_update"],
      [{ capabilities: { tools: ["automation.run"] }, status: "asleep" }, "runner_not_live"],
      [{ status: "offline" }, "runner_not_live"],
      [{ status: "online", revokedAt: NOW }, "runner_unavailable"],
    ] as const) {
      await w.t.run(async (ctx) => {
        const row = await ctx.db
          .query("runners")
          .withIndex("by_uuid", (q) => q.eq("id", w.runnerId))
          .unique();
        await ctx.db.patch(row!._id, patch);
      });
      await expect(w.as.mutation(api.automations.arm, args)).rejects.toThrow(code(refusal));
      await expect(
        w.as.mutation(api.automations.armSchedule, {
          commandId: command(),
          automationId: w.scheduleId,
          runnerId: w.runnerId,
        }),
      ).rejects.toThrow(code(refusal));
    }
    const other = await boardFixture(w.t, "other");
    const foreign = await create(other.as, other.projectId);
    await expect(
      w.as.mutation(api.automations.arm, { ...args, automationId: foreign }),
    ).rejects.toThrow(code("automation_not_in_project"));
  });

  test("schedule arms strictly after server time in stored zone; edit recomputes without rearming pause", async () => {
    const w = await world();
    await armBoth(w);
    const expected = nextScheduleOccurrence({
      schedule: spec,
      staggerKey: w.scheduleId,
      after: NOW,
    });
    expect(expected).toBeGreaterThan(NOW);
    expect(
      (await w.as.query(api.automations.schedules, { projectId: w.projectId }))[0],
    ).toMatchObject({
      timezone: spec.timeZone,
      nextFireAt: expected,
      armedAt: expect.any(Number),
      pausedAt: null,
    });
    await w.t.run((ctx) => pauseArmingsFor(ctx, { runnerId: w.runnerId }, NOW));
    const changed = { ...spec, timeZone: "Pacific/Chatham", hour: 10 };
    await w.bob.as.mutation(api.automations.update, {
      commandId: command(),
      automationId: w.scheduleId,
      ...draft,
      name: "Daily",
      trigger: { kind: "schedule", schedule: changed },
    });
    expect(
      (await w.as.query(api.automations.schedules, { projectId: w.projectId }))[0],
    ).toMatchObject({
      spec: changed,
      timezone: changed.timeZone,
      nextFireAt: nextScheduleOccurrence({
        schedule: changed,
        staggerKey: w.scheduleId,
        after: NOW,
      }),
      pausedAt: NOW,
      pausedReason: "runner_removed",
      armedByUserId: w.userId,
    });
    // Editing Instructions alone does not reset the authoritative cursor.
    vi.setSystemTime(NOW + 60_000);
    await w.as.mutation(api.automations.update, {
      commandId: command(),
      automationId: w.scheduleId,
      ...draft,
      name: "Daily",
      trigger: { kind: "schedule", schedule: changed },
    });
    expect(
      (await w.as.query(api.automations.schedules, { projectId: w.projectId }))[0]!.nextFireAt,
    ).toBe(nextScheduleOccurrence({ schedule: changed, staggerKey: w.scheduleId, after: NOW }));
    await w.as.mutation(api.automations.update, {
      commandId: command(),
      automationId: w.scheduleId,
      ...draft,
      name: "Daily",
      trigger: { kind: "none" },
    });
    expect(await w.as.query(api.automations.schedules, { projectId: w.projectId })).toEqual([]);
  });

  test("trigger edits disarm invalid columns; deletion cancels only never-leased jobs and keeps history", async () => {
    const w = await world();
    await armBoth(w);
    const arrival = await waiting(w, "arrival");
    const manual = await waiting(w, "manual");
    const leased = await waiting(w, "manual", { leased: true });
    await w.as.mutation(api.automations.setColumnOrder, {
      commandId: command(),
      projectId: w.projectId,
      status: "doing",
      rankedIds: [w.automationId, w.scheduleId],
    });
    const beforeEdit = (await projectEvents(w.t, w.projectId)).length;
    await w.as.mutation(api.automations.update, {
      commandId: command(),
      automationId: w.automationId,
      ...draft,
      trigger: { kind: "columns", columns: ["done"] },
    });
    expect(await w.as.query(api.automations.armings, { projectId: w.projectId })).toEqual([]);
    expect(await jobStatus(w, arrival.jobId)).toBe("cancelled");
    expect(await jobStatus(w, manual.jobId)).toBe("queued");
    expect(
      (await projectEvents(w.t, w.projectId)).slice(beforeEdit).map((event) => event.kind),
    ).toEqual(["automation_changed", "automation_armed"]);
    await w.bob.as.mutation(api.automations.remove, {
      commandId: command(),
      automationId: w.automationId,
    });
    expect(await jobStatus(w, manual.jobId)).toBe("cancelled");
    expect(await jobStatus(w, leased.jobId)).toBe("leased");
    const history = await w.as.query(api.automations.runsForAutomation, {
      automationId: w.automationId,
      paginationOpts: pageOpts,
    });
    expect(history.page).toHaveLength(2);
    expect(history.page.find((row) => row.id === manual.runId)).toMatchObject({
      status: "skipped",
      skipReason: automationAbandonSkipReason("gone"),
    });
    expect(
      (await w.as.query(api.automations.columnOrders, { projectId: w.projectId }))[0]!.rankedIds,
    ).toEqual([w.scheduleId]);
    const schedule = await waiting(w, "schedule");
    await w.as.mutation(api.automations.remove, {
      commandId: command(),
      automationId: w.scheduleId,
    });
    expect(await jobStatus(w, schedule.jobId)).toBe("cancelled");
    expect(await w.as.query(api.automations.schedules, { projectId: w.projectId })).toEqual([]);
    expect(
      (await w.as.query(api.automations.columnOrders, { projectId: w.projectId }))[0]!.rankedIds,
    ).toEqual([]);
  });

  test.each(["disarm", "rearm", "edit"] as const)(
    "schedule %s withdraws waiting Runs with the shared disarm reason",
    async (change) => {
      const w = await world();
      await armBoth(w);
      await waiting(w, "schedule");
      if (change === "disarm")
        await w.bob.as.mutation(api.automations.disarmSchedule, {
          commandId: command(),
          automationId: w.scheduleId,
        });
      else if (change === "rearm")
        await w.bob.as.mutation(api.automations.armSchedule, {
          commandId: command(),
          automationId: w.scheduleId,
          runnerId: w.bobRunnerId,
        });
      else
        await w.bob.as.mutation(api.automations.update, {
          commandId: command(),
          automationId: w.scheduleId,
          ...draft,
          name: "Daily",
          trigger: { kind: "schedule", schedule: { ...spec, hour: 10 } },
        });
      const runs = await w.as.query(api.automations.runsForAutomation, {
        automationId: w.scheduleId,
        paginationOpts: pageOpts,
      });
      expect(runs.page[0]).toMatchObject({
        status: "skipped",
        skipReason: automationAbandonSkipReason("schedule-disarmed"),
      });
    },
  );

  test("Run history is paginated, scoped and status-filtered; private Session resolution stays private", async () => {
    const w = await world();
    const runs: Awaited<ReturnType<typeof waiting>>[] = [];
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(NOW + i);
      runs.push(await waiting(w, "manual"));
    }
    await w.t.run(async (ctx) => {
      const run = await ctx.db
        .query("automationRuns")
        .withIndex("by_uuid", (q) => q.eq("id", runs[1]!.runId))
        .unique();
      await ctx.db.patch(run!._id, { status: "skipped" });
    });
    const privateSession = await seedSession(
      w.t,
      { projectId: w.projectId, ticketId: w.ticketId },
      w.userId,
    );
    await w.t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", privateSession.sessionId))
        .unique();
      await ctx.db.patch(session!._id, {
        ticketId: null,
        role: "project",
        visibility: "private",
        visibilityReason: "adhoc",
      });
      const run = await ctx.db
        .query("automationRuns")
        .withIndex("by_uuid", (q) => q.eq("id", runs[0]!.runId))
        .unique();
      await ctx.db.patch(run!._id, { sessionId: privateSession.sessionId });
    });
    const first = await w.bob.as.query(api.automations.runsForProject, {
      projectId: w.projectId,
      paginationOpts: pageOpts,
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    expect(first.page[0]).not.toHaveProperty("_id");
    const last = await w.bob.as.query(api.automations.runsForProject, {
      projectId: w.projectId,
      paginationOpts: { ...pageOpts, cursor: first.continueCursor },
    });
    expect(last.page).toHaveLength(1);
    expect(new Set([...first.page, ...last.page].map((row) => row.id)).size).toBe(3);
    const skipped = await w.bob.as.query(api.automations.runsForTicket, {
      ticketId: w.ticketId,
      status: "skipped",
      paginationOpts: pageOpts,
    });
    expect(skipped.page.map((row) => row.id)).toEqual([runs[1]!.runId]);
    const queued = await w.bob.as.query(api.automations.runsForAutomation, {
      automationId: w.automationId,
      status: "queued",
      paginationOpts: pageOpts,
    });
    expect(queued.page).toHaveLength(2);
    expect([...first.page, ...last.page].find((row) => row.id === runs[0]!.runId)!.sessionId).toBe(
      privateSession.sessionId,
    );
    await expect(
      w.bob.as.query(api.sessionVisibility.get, { sessionId: privateSession.sessionId }),
    ).rejects.toThrow(code("not_found"));
    await expect(
      w.as.query(api.sessionVisibility.get, { sessionId: privateSession.sessionId }),
    ).resolves.toBeDefined();
  });
});

describe("Automation authorization", () => {
  test.each(["outsider", "suspended", "left"] as const)(
    "%s cannot read or write any records",
    async (position) => {
      const w = await world();
      const outsider = await signIn(w.t, position);
      if (position !== "outsider") await addMember(w.t, w.workspaceId, outsider.userId, position);
      for (const call of [...reads(w, outsider.as), ...writes(w, outsider.as)])
        await expect(call()).rejects.toThrow(code("not_a_member"));
    },
  );

  test("agents may list under a fenced claim, all other record doors and runner tokens are refused", async () => {
    const w = await world();
    const { sessionId, runnerId } = await seedSession(
      w.t,
      { projectId: w.projectId, ticketId: w.ticketId },
      w.userId,
    );
    const agent = w.t.withIdentity({
      issuer: AGENT_TOKEN_ISSUER,
      subject: agentSubject(sessionId),
      own: w.userId,
      rnr: runnerId,
      gen: 1,
      tkt: w.ticketId,
    });
    expect(await agent.query(api.automations.list, { projectId: w.projectId })).toHaveLength(2);
    for (const call of [...reads(w, agent).slice(1), ...writes(w, agent)])
      await expect(call()).rejects.toThrow(code("not_a_person"));
    const runner = w.t.withIdentity({
      issuer: RUNNER_TOKEN_ISSUER,
      subject: runnerSubject(parseId("runner", runnerId)),
    });
    for (const call of [...reads(w, runner), ...writes(w, runner)])
      await expect(call()).rejects.toThrow(code("not_a_person"));
    await w.t.run(async (ctx) => {
      const intake = await ctx.db
        .query("sessionIntake")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique();
      await ctx.db.patch(intake!._id, { claim: { runnerId, generation: 2 } });
    });
    await expect(agent.query(api.automations.list, { projectId: w.projectId })).rejects.toThrow(
      code("fenced"),
    );
  });

  test("preview revocation cuts off every record door even with active membership", async () => {
    const w = await world();
    await w.t.mutation(internal.previewAccess.set, {
      kind: "user",
      value: w.userId,
      enabled: false,
    });
    for (const call of [...reads(w, w.as), ...writes(w, w.as)])
      await expect(call()).rejects.toThrow(code("preview_waitlisted"));
  });

  test("archived projects stay readable but every mutation is refused; receipts require current access", async () => {
    const w = await world();
    const args = {
      commandId: command(),
      projectId: w.projectId,
      status: "doing" as const,
      automationId: w.automationId,
      runnerId: w.runnerId,
    };
    await w.as.mutation(api.automations.arm, args);
    await w.as.mutation(api.projects.archive, { commandId: command(), projectId: w.projectId });
    for (const call of reads(w, w.as)) await expect(call()).resolves.toBeDefined();
    for (const call of writes(w, w.as))
      await expect(call()).rejects.toThrow(code("project_archived"));
    await w.t.run(async (ctx) => {
      const member = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", w.workspaceId).eq("userId", w.userId),
        )
        .unique();
      await ctx.db.patch(member!._id, { status: "left" });
    });
    await expect(w.as.mutation(api.automations.arm, args)).rejects.toThrow(code("not_a_member"));
  });
});

describe("Automation access-loss lifecycle", () => {
  test.each(["leave", "suspend", "remove"] as const)(
    "%s pauses just that Member's Workspace arms; rejoining does not auto-arm",
    async (kind) => {
      const w = await world();
      await armBoth(w);
      const arrival = await waiting(w, "arrival");
      const schedule = await waiting(w, "schedule");
      const manual = await waiting(w, "manual");
      const leased = await waiting(w, "manual", { leased: true });
      const other = await boardFixture(w.t, "elsewhere");
      await addMember(w.t, other.workspaceId, w.userId);
      const otherAuto = await create(w.as, other.projectId);
      await w.as.mutation(api.automations.arm, {
        commandId: command(),
        projectId: other.projectId,
        status: "doing",
        automationId: otherAuto,
        runnerId: w.runnerId,
      });
      // Bob is an owner only for the Member-management operation, not for arming.
      await w.t.run(async (ctx) => {
        const row = await ctx.db
          .query("workspaceMembers")
          .withIndex("by_workspace_user", (q) =>
            q.eq("workspaceId", w.workspaceId).eq("userId", w.bob.userId),
          )
          .unique();
        await ctx.db.patch(row!._id, { role: "owner" });
      });
      if (kind === "leave") await w.as.mutation(api.members.leave, { workspaceId: w.workspaceId });
      else
        await w.bob.as.mutation(kind === "suspend" ? api.members.suspend : api.members.remove, {
          workspaceId: w.workspaceId,
          userId: w.userId,
        });
      expect(
        (await w.bob.as.query(api.automations.armings, { projectId: w.projectId }))[0],
      ).toMatchObject({ pausedAt: expect.any(Number), pausedReason: "armer_left" });
      expect(
        (await w.bob.as.query(api.automations.schedules, { projectId: w.projectId }))[0],
      ).toMatchObject({
        pausedAt: expect.any(Number),
        pausedReason: "armer_left",
        pendingJobId: null,
        pendingRunId: null,
      });
      expect(
        (await w.as.query(api.automations.armings, { projectId: other.projectId }))[0]!.pausedAt,
      ).toBeNull();
      for (const item of [arrival, schedule, manual])
        expect(await jobStatus(w, item.jobId)).toBe("cancelled");
      expect(await jobStatus(w, leased.jobId)).toBe("leased");
      const pausedRuns = await w.bob.as.query(api.automations.runsForProject, {
        projectId: w.projectId,
        status: "skipped",
        paginationOpts: pageOpts,
      });
      expect(pausedRuns.page.map((run) => run.skipReason)).toEqual([
        { kind: "runner-unavailable", code: "armer_left" },
        { kind: "runner-unavailable", code: "armer_left" },
      ]);
      const alerts = await w.t.run((ctx) => ctx.db.query("attentionItems").collect());
      expect(alerts.filter((row) => row.kind === "automation_paused")).toEqual([]);
      await w.t.finishAllScheduledFunctions(vi.runAllTimers);
      await w.t.run(async (ctx) => {
        const row = await ctx.db
          .query("workspaceMembers")
          .withIndex("by_workspace_user", (q) =>
            q.eq("workspaceId", w.workspaceId).eq("userId", w.userId),
          )
          .unique();
        await ctx.db.patch(row!._id, { status: "active" });
      });
      expect(
        (await w.as.query(api.automations.armings, { projectId: w.projectId }))[0]!.pausedAt,
      ).toBeGreaterThanOrEqual(NOW);
      await w.bob.as.mutation(api.automations.arm, {
        commandId: command(),
        projectId: w.projectId,
        status: "doing",
        automationId: w.automationId,
        runnerId: w.bobRunnerId,
      });
      expect(
        (await w.as.query(api.automations.armings, { projectId: w.projectId }))[0],
      ).toMatchObject({ armedByUserId: w.bob.userId, pausedAt: null, pausedReason: null });
    },
  );

  test("runner removal pauses columns/schedule, cancels its waiting jobs, and raises one clearable alert", async () => {
    const w = await world();
    await armBoth(w);
    const schedule = await waiting(w, "schedule");
    const manual = await waiting(w, "manual");
    const teammate = await waiting(w, "manual", { runnerId: w.bobRunnerId, userId: w.bob.userId });
    await w.as.mutation(api.runners.remove, { runnerId: w.runnerId });
    const pausedColumns = await w.bob.as.query(api.automations.armings, { projectId: w.projectId });
    expect(pausedColumns[0]).toMatchObject({
      pausedAt: expect.any(Number),
      pausedReason: "runner_removed",
      runnerStatus: "revoked",
    });
    expect(
      (await w.bob.as.query(api.automations.schedules, { projectId: w.projectId }))[0],
    ).toMatchObject({ pausedAt: expect.any(Number), pausedReason: "runner_removed" });
    expect(await jobStatus(w, schedule.jobId)).toBe("cancelled");
    expect(await jobStatus(w, manual.jobId)).toBe("cancelled");
    expect(await jobStatus(w, teammate.jobId)).toBe("queued");
    const before = (await projectEvents(w.t, w.projectId)).length;
    await w.t.run((ctx) => pauseArmingsFor(ctx, { runnerId: w.runnerId }, NOW + 1));
    expect((await projectEvents(w.t, w.projectId)).length).toBe(before);
    const alerts = await w.t.run((ctx) => ctx.db.query("attentionItems").collect());
    expect(alerts.filter((row) => row.kind === "automation_paused")).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      userId: w.userId,
      projectId: w.projectId,
      clearedAt: null,
      source: "runner_alert",
      sourceId: w.runnerId,
    });
    const pausedRuns = await w.as.query(api.automations.runsForProject, {
      projectId: w.projectId,
      status: "skipped",
      paginationOpts: pageOpts,
    });
    expect(pausedRuns.page.map((run) => run.skipReason)).toEqual([
      { kind: "runner-unavailable", code: "runner_removed" },
      { kind: "runner-unavailable", code: "runner_removed" },
    ]);
    // A paused column is inert even if the old runner regains a capability.
    await w.bob.as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId: w.projectId,
      ticketIds: [w.ticketId],
      toStatus: "doing",
    });
    expect(
      (await w.t.run((ctx) => ctx.db.query("runnerJobs").collect())).filter(
        (job) => job.kind === "automation.run" && job.status === "queued",
      ),
    ).toHaveLength(1);
    await w.bob.as.mutation(api.automations.arm, {
      commandId: command(),
      projectId: w.projectId,
      status: "doing",
      automationId: w.automationId,
      runnerId: w.bobRunnerId,
    });
    expect(
      (await w.t.run((ctx) => ctx.db.query("attentionItems").collect()))[0]!.clearedAt,
    ).toBeNull();
    await w.bob.as.mutation(api.automations.armSchedule, {
      commandId: command(),
      automationId: w.scheduleId,
      runnerId: w.bobRunnerId,
    });
    expect(
      (await w.t.run((ctx) => ctx.db.query("attentionItems").collect()))[0]!.clearedReason,
    ).toBe("resolved");
    const paused = (await projectEvents(w.t, w.projectId)).filter(
      (event) =>
        event.actor.kind === "volli" &&
        ["automation_armed", "automation_schedule_armed"].includes(event.kind),
    );
    expect(paused.map((event) => event.payload)).toEqual([
      { kind: "automation_armed", automationId: w.automationId, status: "doing", runnerId: null },
      { kind: "automation_schedule_armed", automationId: w.scheduleId, runnerId: null },
    ]);
  });

  test.each(["credential_reuse", "replaced"] as const)(
    "runner revocation (%s) also pauses, and never transfers an arm to its successor",
    async (reason) => {
      const w = await world();
      await armBoth(w);
      const pending = await waiting(w, "schedule");
      if (reason === "credential_reuse") {
        await w.t.run(async (ctx) => {
          await ctx.db.insert("runnerCredentials", {
            runnerId: w.runnerId,
            currentHash: "current",
            previousHash: "previous",
            currentFirstUsedAt: NOW,
            generation: 2,
            rotatedAt: NOW,
            lastUsedAt: NOW,
            lastUsedIp: null,
          });
        });
        expect(
          await w.t.mutation(internal.runners.rotateCredential, {
            runnerId: w.runnerId,
            presentedHash: "previous",
            nextHash: "next",
            ip: null,
          }),
        ).toEqual({ ok: false, code: "revoked" });
      } else {
        await w.as.mutation(internal.runners.linkFromDesktop, {
          credentialHash: "new-credential-hash",
          host: {
            hostname: "Mac.local",
            platform: { os: "darwin", distro: null, kernel: null, arch: "arm64", glibc: null },
            installMode: "app",
          },
          name: null,
          replacesRunnerId: w.runnerId,
        });
      }
      expect(
        (await w.as.query(api.automations.armings, { projectId: w.projectId }))[0],
      ).toMatchObject({ runnerId: w.runnerId, pausedReason: "runner_removed" });
      expect(
        (await w.as.query(api.automations.schedules, { projectId: w.projectId }))[0],
      ).toMatchObject({ runnerId: w.runnerId, pausedReason: "runner_removed" });
      expect(await jobStatus(w, pending.jobId)).toBe("cancelled");
    },
  );

  test("moved/paused rows are inert even on a capable live runner; an explicit re-arm restores arrivals", async () => {
    const w = await world();
    await armBoth(w);
    await w.t.run(async (ctx) => {
      const arming = await ctx.db
        .query("automationArmings")
        .withIndex("by_project_status", (q) => q.eq("projectId", w.projectId).eq("status", "doing"))
        .unique();
      const schedule = await ctx.db
        .query("automationSchedules")
        .withIndex("by_automation", (q) => q.eq("automationId", w.scheduleId))
        .unique();
      await ctx.db.patch(arming!._id, { pausedAt: NOW, pausedReason: "moved" });
      await ctx.db.patch(schedule!._id, { pausedAt: NOW, pausedReason: "moved" });
    });
    await w.as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId: w.projectId,
      ticketIds: [w.ticketId],
      toStatus: "doing",
    });
    expect(await w.t.run((ctx) => ctx.db.query("runnerJobs").collect())).toEqual([]);
    await armBoth(w);
    await w.as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId: w.projectId,
      ticketIds: [w.ticketId],
      toStatus: "todo",
    });
    await w.as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId: w.projectId,
      ticketIds: [w.ticketId],
      toStatus: "doing",
    });
    expect(
      (await w.t.run((ctx) => ctx.db.query("runnerJobs").collect())).filter(
        (job) => job.kind === "automation.run",
      ),
    ).toHaveLength(1);
    expect(
      (await w.as.query(api.automations.schedules, { projectId: w.projectId }))[0],
    ).toMatchObject({ pausedAt: null, pausedReason: null });
  });

  test("old rows without optional pause fields stay readable and explicitly re-armable", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("automationArmings", {
        projectId: w.projectId,
        status: "doing",
        automationId: w.automationId,
        runnerId: w.runnerId,
        armedByUserId: w.userId,
        armedAt: 0,
      });
      await ctx.db.insert("automationSchedules", {
        automationId: w.scheduleId,
        runnerId: w.runnerId,
        armedByUserId: w.userId,
        spec,
        timezone: spec.timeZone,
        nextFireAt: NOW + 1,
        lastFiredAt: null,
      });
    });
    expect(
      (await w.as.query(api.automations.armings, { projectId: w.projectId }))[0]!.pausedAt,
    ).toBeNull();
    expect(
      (await w.as.query(api.automations.schedules, { projectId: w.projectId }))[0]!.pausedAt,
    ).toBeNull();
    await armBoth(w);
    expect(
      (await w.as.query(api.automations.schedules, { projectId: w.projectId }))[0]!.nextFireAt,
    ).toBeGreaterThan(NOW);
  });
});
