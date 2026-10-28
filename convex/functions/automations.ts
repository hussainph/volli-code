/**
 * Project Automation records. Any active board Member may edit, replace or
 * disarm an arming; a new arm always uses the caller's own capable live runner.
 * Cloud arming IS enablement. No machine-local switch and no clock here.
 *
 * Runs: `run` (a ticket; people and agents), `runForProject` (a project-level
 * "Run now"), `pendingArrivals`, `cancelPendingArrival` and `retryArrival`.
 * The minute clock that fires armed schedules is `automationSchedules.ts`;
 * what a runner reads before it starts a Run is `automationRunner.ts`; the Run
 * row's outcome is written from the runner inbox (`lib/automationRuns.ts`).
 *
 * Receiving-task wiring: the cloud UI subscribes to these reads and sends
 * caller-minted receipt ids and this Mac's runner; the cloud agent route calls
 * `run` under the Session's Agent token for `automation_run`.
 */
import { paginationOptsValidator, type OrderedQuery, type PaginationOptions } from "convex/server";
import { v } from "convex/values";
import {
  REASONING_LEVELS,
  nextScheduleOccurrence,
  type AutomationRunAttendance,
  type ModelSelection,
} from "@volli/shared";
import {
  AUTOMATION_INSTRUCTIONS_MAX_CHARS,
  TICKET_STATUSES,
  automationRunFailedAttentionId,
  decideArming,
  decideAutomationChange,
  decideAutomationRunRouting,
  decideScheduleArming,
  newId,
  parseId,
  type AutomationRunJobPayload,
} from "@volli/shared/cloud";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { DataModel, Doc } from "./_generated/dataModel.js";
import { PERSON_OR_AGENT, requireActor, type Caller } from "./lib/actorAuth";
import { clearAttention } from "./lib/attention";
import { authError, requireProject } from "./lib/auth";
import {
  executablePayload,
  findRun,
  newRunId,
  queuedRunRow,
  settleAutomationRunJob,
} from "./lib/automationRuns";
import { cancelJob, tryEnqueueJob } from "./lib/jobs";
import { publicRow, recordBoardEvents, requireTicket, requireWritableProject } from "./lib/board";
import { withBoardReceipt } from "./lib/boardReceipts";
import { literals, nullable } from "./lib/validators";
import {
  armingNames,
  automationError,
  automationFacts,
  automationRunner,
  cancelAutomationJobs,
  clearPauseAttention,
  findAutomation,
  projectAutomations,
  publicArming,
  reconcileColumns,
  removeScheduleArming,
  requireAutomation,
  writableAutomation,
} from "./lib/automations";

const projectArgs = { projectId: v.string() };
const draftArgs = {
  name: v.string(),
  instructions: v.string(),
  runtime: v.any(),
  trigger: v.any(),
};
const runStatus = literals(["queued", "started", "skipped", "failed"]);

/** Live, project-scoped definitions, ordered by name. Agents may read, not edit. */
export const list = query({
  args: projectArgs,
  handler: async (ctx, { projectId }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    await requireProject(ctx, projectId, viewer);
    return (await projectAutomations(ctx, projectId))
      .filter((row) => row.deletedAt === null)
      .map((row) => Object.assign(publicRow(row), automationFacts(row)));
  },
});

export const create = mutation({
  args: { commandId: v.string(), ...projectArgs, automationId: v.string(), ...draftArgs },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.create", intent },
      async ({ viewer, actor }) => {
        const { project } = await requireProject(ctx, intent.projectId, viewer);
        requireWritableProject(project);
        const automationId = parseId("automation", intent.automationId);
        const rows = await projectAutomations(ctx, project.id);
        const taken = await findAutomation(ctx, automationId);
        if (taken !== null && !rows.some((row) => row.id === taken.id)) rows.push(taken);
        const decision = decideAutomationChange({
          change: "create",
          automationId,
          projectId: parseId("project", project.id),
          existing: rows.map(automationFacts),
          draft: intent,
        });
        if (decision.kind !== "save")
          throw automationError(decision.kind === "refused" ? decision.code : "invalid_draft");
        const now = Date.now();
        await ctx.db.insert("automations", {
          id: automationId,
          projectId: project.id,
          name: decision.draft.name,
          instructions: decision.draft.instructions,
          runtime: decision.draft.runtime,
          triggerSpec: decision.draft.trigger,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
        await recordBoardEvents(ctx, project.id, actor, now, [
          {
            ticketId: null,
            payload: { kind: "automation_changed", automationId, change: "created" },
          },
        ]);
        return { projectId: project.id, reply: { automationId } };
      },
    ),
});

/** An edit updates the schedule's stored zone/cursor, but never reactivates a paused arm. */
export const update = mutation({
  args: { commandId: v.string(), automationId: v.string(), ...draftArgs },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.update", intent },
      async ({ viewer, actor }) => {
        const { automation, project } = await writableAutomation(ctx, intent.automationId, viewer);
        const decision = decideAutomationChange({
          change: "update",
          automationId: parseId("automation", automation.id),
          projectId: parseId("project", project.id),
          existing: (await projectAutomations(ctx, project.id)).map(automationFacts),
          draft: intent,
        });
        if (decision.kind !== "save")
          throw automationError(decision.kind === "refused" ? decision.code : "invalid_draft");
        const now = Date.now();
        const patch = {
          name: decision.draft.name,
          instructions: decision.draft.instructions,
          runtime: decision.draft.runtime,
          triggerSpec: decision.draft.trigger,
          updatedAt: now,
        };
        await ctx.db.patch(automation._id, patch);
        await recordBoardEvents(ctx, project.id, actor, now, [
          {
            ticketId: null,
            payload: {
              kind: "automation_changed",
              automationId: parseId("automation", automation.id),
              change: "updated",
            },
          },
        ]);
        await reconcileColumns(ctx, { ...automation, ...patch }, now, actor);
        const schedule = await ctx.db
          .query("automationSchedules")
          .withIndex("by_automation", (q) => q.eq("automationId", automation.id))
          .unique();
        if (
          schedule !== null &&
          JSON.stringify(automationFacts(automation).trigger) !==
            JSON.stringify(decision.draft.trigger)
        ) {
          if (decision.draft.trigger.kind === "schedule") {
            await cancelAutomationJobs(
              ctx,
              project.id,
              (_job, payload) =>
                payload.automationId === automation.id && payload.trigger === "schedule",
              now,
              actor,
              "schedule-disarmed",
            );
            const spec = decision.draft.trigger.schedule;
            await ctx.db.patch(schedule._id, {
              spec,
              timezone: spec.timeZone,
              nextFireAt: nextScheduleOccurrence({
                schedule: spec,
                staggerKey: automation.id,
                after: now,
              }),
              pendingJobId: null,
              pendingRunId: null,
              gapRunId: null,
            });
          } else {
            await removeScheduleArming(ctx, {
              schedule,
              projectId: project.id,
              actor,
              now,
              withdrawal: "schedule-disarmed",
            });
          }
        }
        return { projectId: project.id, reply: { automationId: automation.id } };
      },
    ),
});

export const remove = mutation({
  args: { commandId: v.string(), automationId: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.remove", intent },
      async ({ viewer, actor }) => {
        const { automation, project } = await writableAutomation(ctx, intent.automationId, viewer);
        const decision = decideAutomationChange({
          change: "delete",
          automationId: parseId("automation", automation.id),
          projectId: parseId("project", project.id),
          existing: [automationFacts(automation)],
        });
        if (decision.kind === "refused") throw automationError(decision.code);
        const now = Date.now();
        await ctx.db.patch(automation._id, { deletedAt: now, updatedAt: now });
        await recordBoardEvents(ctx, project.id, actor, now, [
          {
            ticketId: null,
            payload: {
              kind: "automation_changed",
              automationId: parseId("automation", automation.id),
              change: "deleted",
            },
          },
        ]);
        const orders = await ctx.db
          .query("automationColumnOrder")
          .withIndex("by_project_status", (q) => q.eq("projectId", project.id))
          .collect();
        for (const order of orders) {
          if (order.rankedIds.includes(automation.id))
            await ctx.db.patch(order._id, {
              rankedIds: order.rankedIds.filter((id) => id !== automation.id),
              orderedAt: now,
            });
        }
        await reconcileColumns(ctx, { ...automation, deletedAt: now }, now, actor);
        const schedule = await ctx.db
          .query("automationSchedules")
          .withIndex("by_automation", (q) => q.eq("automationId", automation.id))
          .unique();
        if (schedule !== null)
          await removeScheduleArming(ctx, {
            schedule,
            projectId: project.id,
            actor,
            now,
            withdrawal: "gone",
          });
        await cancelAutomationJobs(
          ctx,
          project.id,
          (_job, payload) => payload.automationId === automation.id,
          now,
          actor,
          "gone",
        );
        return { projectId: project.id, reply: { automationId: automation.id } };
      },
    ),
});

export const armings = query({
  args: projectArgs,
  handler: async (ctx, { projectId }) => {
    await requireProject(ctx, projectId);
    const rows = await ctx.db
      .query("automationArmings")
      .withIndex("by_project_status", (q) => q.eq("projectId", projectId))
      .collect();
    return Promise.all(
      rows.map(async (row) => Object.assign(publicArming(row), await armingNames(ctx, row))),
    );
  },
});

export const arm = mutation({
  args: {
    commandId: v.string(),
    ...projectArgs,
    status: literals(TICKET_STATUSES),
    automationId: nullable(v.string()),
    runnerId: v.optional(nullable(v.string())),
  },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.arm", intent },
      async ({ viewer, actor }) => {
        const { project } = await requireProject(ctx, intent.projectId, viewer);
        requireWritableProject(project);
        const automation =
          intent.automationId === null
            ? null
            : await findAutomation(ctx, parseId("automation", intent.automationId));
        const decision = decideArming({
          projectId: parseId("project", project.id),
          callerUserId: viewer.userId,
          canEdit: true,
          automation: automation === null ? null : automationFacts(automation),
          runner:
            intent.automationId === null ? null : await automationRunner(ctx, intent.runnerId),
          status: intent.status,
          disarm: intent.automationId === null,
        });
        if (decision.kind === "refused") throw automationError(decision.code);
        const previous = await ctx.db
          .query("automationArmings")
          .withIndex("by_project_status", (q) =>
            q.eq("projectId", project.id).eq("status", intent.status),
          )
          .unique();
        const now = Date.now();
        // A replaced arm's countdown is withdrawn, not silently handed to the new armer.
        await cancelAutomationJobs(
          ctx,
          project.id,
          (_job, payload) =>
            payload.trigger === "arrival" &&
            payload.origin === "armed" &&
            payload.status === intent.status,
          now,
          actor,
          "disarmed",
        );
        if (decision.kind === "disarm") {
          if (previous !== null) await ctx.db.delete(previous._id);
        } else {
          const row = {
            projectId: project.id,
            status: intent.status,
            automationId: decision.automationId,
            runnerId: decision.runnerId,
            armedByUserId: decision.armedByUserId,
            armedAt: now,
            pausedAt: null,
            pausedReason: null,
          };
          if (previous === null) await ctx.db.insert("automationArmings", row);
          else await ctx.db.replace(previous._id, row);
        }
        if (previous !== null)
          await clearPauseAttention(ctx, project.id, previous.armedByUserId, now);
        if (decision.kind === "arm" || previous !== null)
          await recordBoardEvents(ctx, project.id, actor, now, [
            {
              ticketId: null,
              payload: {
                kind: "automation_armed",
                status: intent.status,
                automationId: decision.kind === "arm" ? decision.automationId : null,
                runnerId: decision.kind === "arm" ? decision.runnerId : null,
              },
            },
          ]);
        return {
          projectId: project.id,
          reply: {
            projectId: project.id,
            status: intent.status,
            automationId: intent.automationId,
          },
        };
      },
    ),
});

export const columnOrders = query({
  args: projectArgs,
  handler: async (ctx, { projectId }) => {
    await requireProject(ctx, projectId);
    return (
      await ctx.db
        .query("automationColumnOrder")
        .withIndex("by_project_status", (q) => q.eq("projectId", projectId))
        .collect()
    ).map(publicRow);
  },
});

/** Shared team ranking; like a ticket reorder, this emits no board event. */
export const setColumnOrder = mutation({
  args: {
    commandId: v.string(),
    ...projectArgs,
    status: literals(TICKET_STATUSES),
    rankedIds: v.array(v.string()),
  },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.setColumnOrder", intent },
      async ({ viewer }) => {
        const { project } = await requireProject(ctx, intent.projectId, viewer);
        requireWritableProject(project);
        if (intent.rankedIds.length > 1_000) throw automationError("order_too_large");
        const rankedIds = [...new Set(intent.rankedIds.map((id) => parseId("automation", id)))];
        const live = new Set(
          (await projectAutomations(ctx, project.id))
            .filter((row) => row.deletedAt === null)
            .map((row) => row.id),
        );
        if (rankedIds.some((id) => !live.has(id)))
          throw automationError("automation_not_in_project");
        const previous = await ctx.db
          .query("automationColumnOrder")
          .withIndex("by_project_status", (q) =>
            q.eq("projectId", project.id).eq("status", intent.status),
          )
          .unique();
        const row = {
          projectId: project.id,
          status: intent.status,
          rankedIds,
          orderedAt: Date.now(),
        };
        if (previous === null) await ctx.db.insert("automationColumnOrder", row);
        else await ctx.db.replace(previous._id, row);
        return {
          projectId: project.id,
          reply: { projectId: project.id, status: intent.status, rankedIds },
        };
      },
    ),
});

export const schedules = query({
  args: projectArgs,
  handler: async (ctx, { projectId }) => {
    await requireProject(ctx, projectId);
    const result = [];
    for (const automation of await projectAutomations(ctx, projectId)) {
      if (automation.deletedAt !== null) continue;
      const row = await ctx.db
        .query("automationSchedules")
        .withIndex("by_automation", (q) => q.eq("automationId", automation.id))
        .unique();
      if (row !== null) result.push({ ...publicArming(row), ...(await armingNames(ctx, row)) });
    }
    return result;
  },
});

export const armSchedule = mutation({
  args: {
    commandId: v.string(),
    automationId: v.string(),
    runnerId: v.optional(nullable(v.string())),
  },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.armSchedule", intent },
      async ({ viewer, actor }) => {
        const { automation, project } = await writableAutomation(ctx, intent.automationId, viewer);
        const now = Date.now();
        const facts = automationFacts(automation);
        const decision = decideScheduleArming({
          projectId: parseId("project", project.id),
          callerUserId: viewer.userId,
          canEdit: true,
          automation: facts,
          runner: await automationRunner(ctx, intent.runnerId),
          disarm: false,
          now,
        });
        if (decision.kind !== "arm")
          throw automationError(decision.kind === "refused" ? decision.code : "wrong_trigger");
        const previous = await ctx.db
          .query("automationSchedules")
          .withIndex("by_automation", (q) => q.eq("automationId", automation.id))
          .unique();
        await cancelAutomationJobs(
          ctx,
          project.id,
          (_job, payload) =>
            payload.automationId === automation.id && payload.trigger === "schedule",
          now,
          actor,
          "schedule-disarmed",
        );
        if (facts.trigger.kind !== "schedule") throw automationError("wrong_trigger");
        const row = {
          automationId: automation.id,
          armedByUserId: decision.armedByUserId,
          runnerId: decision.runnerId,
          spec: facts.trigger.schedule,
          timezone: decision.timezone,
          nextFireAt: decision.nextFireAt,
          lastFiredAt: previous?.lastFiredAt ?? null,
          armedAt: now,
          pausedAt: null,
          pausedReason: null,
          pendingJobId: null,
          pendingRunId: null,
          gapRunId: null,
        };
        if (previous === null) await ctx.db.insert("automationSchedules", row);
        else await ctx.db.replace(previous._id, row);
        if (previous !== null)
          await clearPauseAttention(ctx, project.id, previous.armedByUserId, now);
        await recordBoardEvents(ctx, project.id, actor, now, [
          {
            ticketId: null,
            payload: {
              kind: "automation_schedule_armed",
              automationId: parseId("automation", automation.id),
              runnerId: decision.runnerId,
            },
          },
        ]);
        return {
          projectId: project.id,
          reply: { automationId: automation.id, nextFireAt: decision.nextFireAt },
        };
      },
    ),
});

export const disarmSchedule = mutation({
  args: { commandId: v.string(), automationId: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.disarmSchedule", intent },
      async ({ viewer, actor }) => {
        const { automation, project } = await writableAutomation(ctx, intent.automationId, viewer);
        const decision = decideScheduleArming({
          projectId: parseId("project", project.id),
          callerUserId: viewer.userId,
          canEdit: true,
          automation: automationFacts(automation),
          runner: null,
          disarm: true,
          now: Date.now(),
        });
        if (decision.kind === "refused") throw automationError(decision.code);
        const previous = await ctx.db
          .query("automationSchedules")
          .withIndex("by_automation", (q) => q.eq("automationId", automation.id))
          .unique();
        const now = Date.now();
        if (previous !== null) {
          await removeScheduleArming(ctx, {
            schedule: previous,
            projectId: project.id,
            actor,
            now,
            withdrawal: "schedule-disarmed",
          });
        }
        return { projectId: project.id, reply: { automationId: automation.id } };
      },
    ),
});

const historyArgs = { paginationOpts: paginationOptsValidator, status: v.optional(runStatus) };

async function runPage(
  rows: OrderedQuery<DataModel["automationRuns"]>,
  args: { paginationOpts: PaginationOptions; status?: Doc<"automationRuns">["status"] },
) {
  const filtered =
    args.status === undefined ? rows : rows.filter((q) => q.eq(q.field("status"), args.status!));
  const page = await filtered.paginate(args.paginationOpts);
  return { ...page, page: page.page.map(publicRow) };
}

/** Run rows are team facts; a private Session id still resolves as not_found to teammates. */
export const runsForProject = query({
  args: { ...projectArgs, ...historyArgs },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    return runPage(
      ctx.db
        .query("automationRuns")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .order("desc"),
      args,
    );
  },
});

export const runsForTicket = query({
  args: { ticketId: v.string(), ...historyArgs },
  handler: async (ctx, args) => {
    const caller = await requireActor(ctx);
    await requireTicket(ctx, args.ticketId, caller.viewer);
    return runPage(
      ctx.db
        .query("automationRuns")
        .withIndex("by_ticket", (q) => q.eq("ticketId", args.ticketId))
        .order("desc"),
      args,
    );
  },
});

export const runsForAutomation = query({
  args: { automationId: v.string(), ...historyArgs },
  handler: async (ctx, args) => {
    // Keep history readable after the definition is soft-deleted.
    const caller = await requireActor(ctx);
    const automation = await findAutomation(ctx, args.automationId);
    if (automation === null) throw automationError("automation_not_found");
    await requireProject(ctx, automation.projectId, caller.viewer);
    return runPage(
      ctx.db
        .query("automationRuns")
        .withIndex("by_automation", (q) => q.eq("automationId", args.automationId))
        .order("desc"),
      args,
    );
  },
});

// ── Runs: by hand, by an agent, and pending arrivals ────────────────────────

const modelOverrideArg = v.optional(
  nullable(
    v.object({
      providerId: v.string(),
      modelId: v.string(),
      reasoningLevel: literals(REASONING_LEVELS),
    }),
  ),
);

/** Who a queued Run waits for: the reply a by-hand or agent Run answers. */
async function runnerReply(ctx: QueryCtx | MutationCtx, runnerId: string) {
  const row = await ctx.db
    .query("runners")
    .withIndex("by_uuid", (q) => q.eq("id", runnerId))
    .unique();
  return {
    id: runnerId,
    name: row?.name ?? "Removed runner",
    status: row === null || row.revokedAt !== null ? ("revoked" as const) : row.status,
  };
}

/**
 * Queues one by-hand or agent Run: a `queued` Run row and its `automation.run`
 * job, in one transaction, for the runner `decideAutomationRunRouting` picks
 * (the ticket's Place when it is the caller's own runner, else the caller's).
 * Nothing runs on a teammate's machine or credentials. Waiting for an asleep
 * runner is normal: the reply names the runner so the caller can say so.
 */
async function queueManualRun(
  ctx: MutationCtx,
  input: {
    caller: Caller;
    project: Doc<"projects">;
    ticket: Doc<"tickets"> | null;
    automation: Doc<"automations"> | null;
    instructions: string | null;
    modelOverride: ModelSelection | null;
    /** A person's current Mac; an agent's runner comes from its token. */
    runnerId: string | null | undefined;
    attendance: AutomationRunAttendance;
  },
) {
  const { caller, project, ticket, automation } = input;
  const decision = decideAutomationRunRouting({
    callerUserId: caller.viewer.userId,
    callerRunner: await automationRunner(
      ctx,
      caller.kind === "agent" ? caller.agent.runnerId : input.runnerId,
    ),
    ticketPlace: ticket === null ? null : await automationRunner(ctx, ticket.placeRunnerId),
  });
  if (decision.kind === "refused") throw automationError(decision.code);
  const now = Date.now();
  const runId = newRunId();
  const common = {
    trigger: "manual" as const,
    runId,
    sessionId: newId("session"),
    dueAt: now,
    missedCount: 0,
    attendance: input.attendance,
    modelOverride: input.modelOverride,
    requestedBySessionId: caller.kind === "agent" ? caller.agent.sessionId : null,
    armedByUserId: null,
  };
  const payload: AutomationRunJobPayload =
    automation !== null
      ? {
          ...common,
          automationId: parseId("automation", automation.id),
          ticketId: ticket === null ? null : parseId("ticket", ticket.id),
        }
      : {
          ...common,
          automationId: null,
          ticketId: parseId("ticket", ticket!.id),
          instructions: input.instructions!,
        };
  const outcome = await tryEnqueueJob(ctx, {
    runnerId: decision.runnerId,
    kind: "automation.run",
    projectId: project.id,
    ticketId: ticket?.id ?? null,
    payload,
    availableAt: now,
    createdBy: caller.actor,
    onBehalfOf: decision.onBehalfOf,
  });
  if ("refused" in outcome) throw automationError(outcome.refused);
  await ctx.db.insert(
    "automationRuns",
    queuedRunRow({
      payload,
      jobId: outcome.jobId,
      projectId: project.id,
      runnerId: decision.runnerId,
      automationName: automation?.name ?? null,
      now,
    }),
  );
  return {
    runId,
    sessionId: payload.sessionId,
    jobId: outcome.jobId,
    runner: await runnerReply(ctx, decision.runnerId),
  };
}

/**
 * A by-hand or agent Run on a ticket: a saved Automation, or Unbound
 * Instructions. Agents call it for `automation_run` (a ticket Session may name
 * any ticket in its own project); their Run is unattended, and the completion
 * arms the calling Session's watch on the Run's Session. The agent's runner is
 * its token's; a person passes this Mac's `runnerId`.
 */
export const run = mutation({
  args: {
    commandId: v.string(),
    automationId: v.optional(nullable(v.string())),
    instructions: v.optional(nullable(v.string())),
    ticketId: v.string(),
    modelOverride: modelOverrideArg,
    runnerId: v.optional(nullable(v.string())),
  },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.run", intent, allow: PERSON_OR_AGENT },
      async (caller) => {
        const { project, ticket } = await requireTicket(ctx, intent.ticketId, caller.viewer);
        requireWritableProject(project);
        if (caller.kind === "agent" && caller.agent.session.projectId !== project.id)
          throw authError("not_found", "That ticket does not exist.");
        if (ticket.archivedAt !== null) throw automationError("ticket_archived");
        const automationId = intent.automationId ?? null;
        let automation: Doc<"automations"> | null = null;
        let instructions: string | null = null;
        if (automationId !== null) {
          automation = (await requireAutomation(ctx, automationId, caller.viewer)).automation;
          if (automation.projectId !== project.id)
            throw automationError("automation_not_in_project");
        } else {
          instructions = intent.instructions ?? "";
          if (instructions.trim().length === 0) throw automationError("invalid_draft");
          if (instructions.length > AUTOMATION_INSTRUCTIONS_MAX_CHARS)
            throw automationError("draft_too_large");
        }
        const queued = await queueManualRun(ctx, {
          caller,
          project,
          ticket,
          automation,
          instructions,
          modelOverride: (intent.modelOverride ?? null) as ModelSelection | null,
          runnerId: intent.runnerId,
          attendance: caller.kind === "agent" ? "unattended" : "attended",
        });
        return { projectId: project.id, reply: queued };
      },
    ),
});

/** "Run now" for a project-level Automation (a schedule's target): a Board Session, by hand. */
export const runForProject = mutation({
  args: {
    commandId: v.string(),
    automationId: v.string(),
    runnerId: v.optional(nullable(v.string())),
  },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.runForProject", intent },
      async (caller) => {
        const { automation, project } = await writableAutomation(
          ctx,
          intent.automationId,
          caller.viewer,
        );
        const queued = await queueManualRun(ctx, {
          caller,
          project,
          ticket: null,
          automation,
          instructions: null,
          modelOverride: null,
          runnerId: intent.runnerId,
          attendance: "attended",
        });
        return { projectId: project.id, reply: queued };
      },
    ),
});

/**
 * The project's armed-column countdowns and waiting arrivals (queued, or
 * leased while their runner starts them), each with the runner it waits for,
 * and the failed arrivals a person may Retry.
 */
export const pendingArrivals = query({
  args: projectArgs,
  handler: async (ctx, { projectId }) => {
    await requireProject(ctx, projectId);
    const pending = [];
    for (const status of ["queued", "leased"] as const) {
      const jobs = await ctx.db
        .query("runnerJobs")
        .withIndex("by_project_kind_status", (q) =>
          q.eq("projectId", projectId).eq("kind", "automation.run").eq("status", status),
        )
        .take(200);
      for (const job of jobs) {
        const payload = executablePayload(job);
        if (payload === null || payload.trigger !== "arrival") continue;
        pending.push({
          jobId: job.id,
          runId: payload.runId,
          ticketId: payload.ticketId,
          automationId: payload.automationId,
          status: payload.status,
          origin: payload.origin,
          availableAt: job.availableAt,
          leased: job.lease !== null && status === "leased",
          runner: await runnerReply(ctx, job.runnerId),
        });
      }
    }
    const failures = (
      await ctx.db
        .query("automationRuns")
        .withIndex("by_project_status", (q) => q.eq("projectId", projectId).eq("status", "failed"))
        .order("desc")
        .take(200)
    )
      .filter((row) => row.trigger === "arrival" && row.retryCommandId !== undefined)
      .slice(0, 50)
      .map((row) => ({
        runId: row.id,
        ticketId: row.ticketId,
        automationId: row.automationId,
        automationName: row.automationName,
        error: row.error ?? null,
        retryCommandId: row.retryCommandId!,
        createdAt: row.createdAt,
      }));
    return { pending: pending.toSorted((a, b) => a.availableAt - b.availableAt), failures };
  },
});

/**
 * Withdraws a waiting Automation Run that no runner has picked up yet (an
 * armed countdown, or a Run waiting for an asleep runner). Once a runner holds
 * it, it is starting and the answer is `run_already_started`.
 */
export const cancelPendingArrival = mutation({
  args: { commandId: v.string(), jobId: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.cancelPendingArrival", intent },
      async ({ viewer }) => {
        const job = await ctx.db
          .query("runnerJobs")
          .withIndex("by_uuid", (q) => q.eq("id", intent.jobId))
          .unique();
        if (job === null || job.kind !== "automation.run")
          throw authError("not_found", "That Run does not exist.");
        const { project } = await requireProject(ctx, job.projectId, viewer);
        requireWritableProject(project);
        if (job.status === "cancelled") return { projectId: project.id, reply: { jobId: job.id } };
        if (job.status !== "queued" || job.lease !== null)
          throw automationError(
            job.status === "leased" || job.status === "queued"
              ? "run_already_started"
              : "run_already_finished",
          );
        const now = Date.now();
        await cancelJob(ctx, job, now, { code: "cancelled", detail: "Cancelled by a person." });
        await settleAutomationRunJob(
          ctx,
          job,
          {
            kind: "withdrawn",
            code: "cancelled",
            reason: {
              kind: "run-refused",
              code: "cancelled",
              error: "Cancelled before it started.",
            },
          },
          now,
        );
        return { projectId: project.id, reply: { jobId: job.id } };
      },
    ),
});

/**
 * Retries a failed arrival under the command id its failure retained, so a
 * second press finds the same Run. The Run keeps its id: with its original job
 * still at hand it goes again to the same runner as the same work (the runner
 * re-checks the ticket and the column); otherwise (a moved Run, or one older
 * than the inbox keeps) it runs as the caller's by-hand Run on that ticket.
 */
export const retryArrival = mutation({
  args: { commandId: v.string(), runId: v.string(), runnerId: v.optional(nullable(v.string())) },
  handler: async (ctx, { commandId, ...intent }) =>
    withBoardReceipt(
      ctx,
      { commandId, operation: "automations.retryArrival", intent },
      async (caller) => {
        const failed = await findRun(ctx, intent.runId);
        if (failed === null) throw authError("not_found", "That Run does not exist.");
        const { project } = await requireProject(ctx, failed.projectId, caller.viewer);
        requireWritableProject(project);
        if (
          failed.status !== "failed" ||
          failed.trigger !== "arrival" ||
          failed.retryCommandId === undefined ||
          failed.ticketId === null ||
          failed.automationId === null
        )
          throw automationError("retry_unavailable");
        const retryJobId = parseId("job", failed.retryCommandId);
        const automation = await findAutomation(ctx, failed.automationId);
        if (automation === null || automation.deletedAt !== null)
          throw automationError("automation_not_found");
        const { ticket } = await requireTicket(ctx, failed.ticketId, caller.viewer);
        const original =
          failed.jobId == null
            ? null
            : await ctx.db
                .query("runnerJobs")
                .withIndex("by_uuid", (q) => q.eq("id", failed.jobId!))
                .unique();
        const originalPayload = original === null ? null : executablePayload(original);
        const now = Date.now();
        let payload: AutomationRunJobPayload;
        let runnerId: string;
        let onBehalfOf: string;
        if (original !== null && originalPayload !== null) {
          payload = originalPayload;
          runnerId = original.runnerId;
          const runner = await automationRunner(ctx, runnerId);
          if (runner === null || runner.status === "revoked")
            throw automationError("runner_unavailable");
          onBehalfOf = runner.ownerUserId;
        } else {
          const decision = decideAutomationRunRouting({
            callerUserId: caller.viewer.userId,
            callerRunner: await automationRunner(ctx, intent.runnerId),
            ticketPlace: await automationRunner(ctx, ticket.placeRunnerId),
          });
          if (decision.kind === "refused") throw automationError(decision.code);
          runnerId = decision.runnerId;
          onBehalfOf = decision.onBehalfOf;
          payload = {
            trigger: "manual",
            automationId: parseId("automation", automation.id),
            ticketId: parseId("ticket", ticket.id),
            armedByUserId: null,
            runId: failed.id,
            sessionId: newId("session"),
            dueAt: now,
            missedCount: 0,
            attendance: "attended",
            modelOverride: null,
            requestedBySessionId: null,
          };
        }
        const outcome = await tryEnqueueJob(ctx, {
          id: retryJobId,
          runnerId,
          kind: "automation.run",
          projectId: project.id,
          ticketId: ticket.id,
          payload,
          availableAt: now,
          createdBy: caller.actor,
          onBehalfOf,
        });
        if ("refused" in outcome) throw automationError(outcome.refused);
        await ctx.db.patch(failed._id, {
          status: "queued",
          jobId: outcome.jobId,
          runnerId,
          error: undefined,
          retryCommandId: undefined,
        });
        await clearAttention(ctx, automationRunFailedAttentionId(failed.id), "resolved", now);
        return {
          projectId: project.id,
          reply: { runId: failed.id, jobId: outcome.jobId },
        };
      },
    ),
});
