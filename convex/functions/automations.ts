/**
 * Project Automation records. Any active board Member may edit, replace or
 * disarm an arming; a new arm always uses the caller's own capable live runner.
 * Cloud arming IS enablement. No machine-local switch and no clock here.
 *
 * Receiving-task wiring: the cloud UI subscribes to these reads and sends
 * caller-minted receipt ids; the clock/Run task owns enqueue, pending arrivals,
 * runner context and completion. Merely storing a schedule does not fire it.
 */
import { paginationOptsValidator, type OrderedQuery, type PaginationOptions } from "convex/server";
import { v } from "convex/values";
import { nextScheduleOccurrence } from "@volli/shared";
import {
  TICKET_STATUSES,
  decideArming,
  decideAutomationChange,
  decideScheduleArming,
  parseId,
} from "@volli/shared/cloud";
import { mutation, query } from "./_generated/server";
import type { DataModel, Doc } from "./_generated/dataModel.js";
import { PERSON_OR_AGENT, requireActor } from "./lib/actorAuth";
import { requireProject } from "./lib/auth";
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
