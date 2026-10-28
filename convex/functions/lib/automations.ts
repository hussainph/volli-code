/** Storage adapters and lifecycle writes shared by Automation records and access-loss hooks. */
import { ConvexError } from "convex/values";
import {
  automationTriggersColumn,
  parseAutomationRuntime,
  parseAutomationTrigger,
} from "@volli/shared";
import {
  actorUserId,
  automationAbandonSkipReason,
  automationPauseAttentionId,
  parseId,
  parseJobPayload,
  type Actor,
  type AutomationRunner,
  type AutomationRunAbandonReason,
  type AutomationPauseReason,
  type BoardEventDraft,
  type CloudAutomationDefinition,
  type RunnerId,
  type UserId,
} from "@volli/shared/cloud";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { clearAttention, raiseAttention } from "./attention";
import { authError, requireProject, type Viewer } from "./auth";
import { publicRow, recordBoardEvents, requireWritableProject } from "./board";
import { cancelJob, ownerMayWorkOn } from "./jobs";

type Reader = Pick<QueryCtx, "db">;

export function automationError(code: string) {
  return new ConvexError({ code, message: `Automation change refused: ${code}.` });
}

export function automationFacts(row: Doc<"automations">): CloudAutomationDefinition {
  return {
    id: parseId("automation", row.id),
    projectId: parseId("project", row.projectId),
    name: row.name,
    instructions: row.instructions,
    runtime: parseAutomationRuntime(row.runtime),
    trigger: parseAutomationTrigger(row.triggerSpec),
    deletedAt: row.deletedAt,
  };
}

export function findAutomation(ctx: Reader, automationId: string) {
  return ctx.db
    .query("automations")
    .withIndex("by_uuid", (q) => q.eq("id", automationId))
    .unique();
}

export function projectAutomations(ctx: Reader, projectId: string) {
  return ctx.db
    .query("automations")
    .withIndex("by_project_name", (q) => q.eq("projectId", projectId))
    .collect();
}

export async function requireAutomation(
  ctx: QueryCtx | MutationCtx,
  automationId: string,
  viewer?: Viewer,
) {
  const automation = await findAutomation(ctx, automationId);
  if (automation === null || automation.deletedAt !== null)
    throw authError("not_found", "That Automation does not exist.");
  const access = await requireProject(ctx, automation.projectId, viewer);
  return { ...access, automation };
}

export async function writableAutomation(ctx: MutationCtx, automationId: string, viewer: Viewer) {
  const access = await requireAutomation(ctx, automationId, viewer);
  requireWritableProject(access.project);
  return access;
}

export async function automationRunner(
  ctx: Reader,
  runnerId: string | null | undefined,
): Promise<AutomationRunner | null> {
  // A person token does not identify a Mac. The desktop passes this Mac's runner;
  // never guess among the person's machines (or borrow another person's runner).
  if (runnerId == null) return null;
  parseId("runner", runnerId);
  const row = await ctx.db
    .query("runners")
    .withIndex("by_uuid", (q) => q.eq("id", runnerId))
    .unique();
  if (row === null) return null;
  const tools: unknown = row.capabilities?.tools;
  return {
    id: row.id as RunnerId,
    ownerUserId: row.ownerUserId as UserId,
    status: row.revokedAt === null ? row.status : "revoked",
    tools: Array.isArray(tools)
      ? tools.filter((tool): tool is string => typeof tool === "string")
      : [],
  };
}

export async function armingNames(ctx: Reader, row: { armedByUserId: string; runnerId: string }) {
  const [user, runner] = await Promise.all([
    ctx.db
      .query("users")
      .withIndex("by_uuid", (q) => q.eq("id", row.armedByUserId))
      .unique(),
    ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", row.runnerId))
      .unique(),
  ]);
  return {
    armedByDisplayName: user?.displayName ?? "Deleted user",
    runnerName: runner?.name ?? "Removed runner",
    runnerStatus: runner?.status ?? "revoked",
  };
}

/** One waiting Run must not keep saying Waiting after its never-leased job was withdrawn. */
export async function cancelAutomationJobs(
  ctx: MutationCtx,
  projectId: string,
  matches: (job: Doc<"runnerJobs">, payload: ReturnType<typeof automationPayload>) => boolean,
  now: number,
  actor: Actor,
  withdrawal:
    | AutomationRunAbandonReason
    | { kind: "runner-unavailable"; code: Exclude<AutomationPauseReason, "moved"> },
): Promise<void> {
  const code = typeof withdrawal === "string" ? withdrawal : withdrawal.code;
  const skipReason =
    typeof withdrawal === "string" ? automationAbandonSkipReason(withdrawal) : withdrawal;
  const detail =
    skipReason.kind === "run-refused"
      ? skipReason.error
      : "The runner or armer is no longer available.";
  const jobs = await ctx.db
    .query("runnerJobs")
    .withIndex("by_project_kind_status", (q) =>
      q.eq("projectId", projectId).eq("kind", "automation.run").eq("status", "queued"),
    )
    .collect();
  const events: BoardEventDraft[] = [];
  for (const job of jobs) {
    const payload = automationPayload(job);
    if (job.lease !== null || !matches(job, payload)) continue;
    await cancelJob(ctx, job, now, { code, detail });
    const runId = "runId" in payload ? payload.runId : null;
    const run =
      runId === null
        ? null
        : await ctx.db
            .query("automationRuns")
            .withIndex("by_uuid", (q) => q.eq("id", runId))
            .unique();
    if (run?.status === "queued") {
      await ctx.db.patch(run._id, {
        status: "skipped",
        skipReason,
      });
      if (run.automationId !== null)
        events.push({
          ticketId: run.ticketId as BoardEventDraft["ticketId"],
          payload: {
            kind: "automation_run_skipped",
            automationId: parseId("automation", run.automationId),
            runId: run.id,
            reason: code,
          },
        });
    }
  }
  await recordBoardEvents(ctx, projectId, actor, now, events);
}

export async function removeScheduleArming(
  ctx: MutationCtx,
  input: {
    schedule: Doc<"automationSchedules">;
    projectId: string;
    actor: Actor;
    now: number;
    withdrawal: "gone" | "schedule-disarmed";
  },
) {
  const { schedule, projectId, actor, now, withdrawal } = input;
  await ctx.db.delete(schedule._id);
  await cancelAutomationJobs(
    ctx,
    projectId,
    (_job, payload) =>
      payload.automationId === schedule.automationId && payload.trigger === "schedule",
    now,
    actor,
    withdrawal,
  );
  await clearPauseAttention(ctx, projectId, schedule.armedByUserId, now);
  await recordBoardEvents(ctx, projectId, actor, now, [
    {
      ticketId: null,
      payload: {
        kind: "automation_schedule_armed",
        automationId: parseId("automation", schedule.automationId),
        runnerId: null,
      },
    },
  ]);
}

function automationPayload(job: Doc<"runnerJobs">) {
  return parseJobPayload("automation.run", job.payload);
}

/** Disarms columns that no longer match after an edit/delete; a chosen Run is independent of the column arm. */
export async function reconcileColumns(
  ctx: MutationCtx,
  automation: Doc<"automations">,
  now: number,
  actor: Actor,
) {
  const rows = await ctx.db
    .query("automationArmings")
    .withIndex("by_automation", (q) => q.eq("automationId", automation.id))
    .collect();
  const events: BoardEventDraft[] = [];
  for (const row of rows) {
    if (
      automation.deletedAt === null &&
      automationTriggersColumn(automationFacts(automation), row.status)
    )
      continue;
    await ctx.db.delete(row._id);
    await cancelAutomationJobs(
      ctx,
      row.projectId,
      (_job, payload) =>
        payload.trigger === "arrival" &&
        payload.origin === "armed" &&
        payload.status === row.status &&
        payload.automationId === automation.id,
      now,
      actor,
      "disarmed",
    );
    events.push({
      ticketId: null,
      payload: { kind: "automation_armed", status: row.status, automationId: null, runnerId: null },
    });
    await clearPauseAttention(ctx, row.projectId, row.armedByUserId, now);
  }
  await recordBoardEvents(ctx, automation.projectId, actor, now, events);
}

export async function clearPauseAttention(
  ctx: MutationCtx,
  projectId: string,
  userId: string,
  now: number,
) {
  const columns = await ctx.db
    .query("automationArmings")
    .withIndex("by_project_status", (q) => q.eq("projectId", projectId))
    .collect();
  if (columns.some((row) => row.armedByUserId === userId && row.pausedAt != null)) return;
  const schedules = await ctx.db
    .query("automationSchedules")
    .withIndex("by_armer", (q) => q.eq("armedByUserId", userId))
    .collect();
  for (const row of schedules) {
    if (
      row.pausedAt != null &&
      (await findAutomation(ctx, row.automationId))?.projectId === projectId
    )
      return;
  }
  await clearAttention(ctx, automationPauseAttentionId(projectId, userId), "resolved", now);
}

/**
 * Access loss is transactional with the Member/runner write, not delayed until
 * a sweep: no intervening arrival can enqueue under the old arm. Pauses survive
 * rejoining or runner replacement; only an explicit re-arm clears them.
 */
export async function pauseArmingsFor(
  ctx: MutationCtx,
  target: { userId: string; workspaceId: string } | { runnerId: string },
  now: number,
) {
  const byUser = "userId" in target;
  const columns = byUser
    ? await ctx.db
        .query("automationArmings")
        .withIndex("by_armer", (q) => q.eq("armedByUserId", target.userId))
        .collect()
    : await ctx.db
        .query("automationArmings")
        .withIndex("by_runner", (q) => q.eq("runnerId", target.runnerId))
        .collect();
  const schedules = byUser
    ? await ctx.db
        .query("automationSchedules")
        .withIndex("by_armer", (q) => q.eq("armedByUserId", target.userId))
        .collect()
    : await ctx.db
        .query("automationSchedules")
        .withIndex("by_runner", (q) => q.eq("runnerId", target.runnerId))
        .collect();
  const reason = byUser ? "armer_left" : "runner_removed";
  const actor: Actor = { kind: "volli", reason: "policy" };
  const affected = new Map<string, { events: BoardEventDraft[]; users: Set<string> }>();
  async function registerAffectedProject(projectId: string) {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_uuid", (q) => q.eq("id", projectId))
      .unique();
    if (
      project === null ||
      project.deletedAt !== null ||
      (byUser && project.workspaceId !== target.workspaceId)
    )
      return null;
    let group = affected.get(projectId);
    if (!group) {
      group = { events: [], users: new Set() };
      affected.set(projectId, group);
    }
    return group;
  }
  for (const row of columns) {
    const group = await registerAffectedProject(row.projectId);
    if (group === null || row.pausedAt != null) continue;
    await ctx.db.patch(row._id, { pausedAt: now, pausedReason: reason });
    group.users.add(row.armedByUserId);
    group.events.push({
      ticketId: null,
      payload: {
        kind: "automation_armed",
        status: row.status,
        automationId: parseId("automation", row.automationId),
        runnerId: null,
      },
    });
  }
  for (const row of schedules) {
    const automation = await findAutomation(ctx, row.automationId);
    if (automation === null) continue;
    const group = await registerAffectedProject(automation.projectId);
    if (group === null || row.pausedAt != null) continue;
    await ctx.db.patch(row._id, {
      pausedAt: now,
      pausedReason: reason,
      pendingJobId: null,
      pendingRunId: null,
      gapRunId: null,
    });
    group.users.add(row.armedByUserId);
    group.events.push({
      ticketId: null,
      payload: {
        kind: "automation_schedule_armed",
        automationId: parseId("automation", row.automationId),
        runnerId: null,
      },
    });
  }
  // Include by-hand/picked jobs even when this person had no stored arm.
  if (byUser) {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_workspace", (q) =>
        q.eq("workspaceId", target.workspaceId).eq("deletedAt", null),
      )
      .collect();
    for (const project of projects) await registerAffectedProject(project.id);
  } else {
    const jobs = await ctx.db
      .query("runnerJobs")
      .withIndex("by_runner_ready", (q) => q.eq("runnerId", target.runnerId).eq("status", "queued"))
      .collect();
    for (const job of jobs)
      if (job.kind === "automation.run") await registerAffectedProject(job.projectId);
  }
  for (const [projectId, group] of affected) {
    await cancelAutomationJobs(
      ctx,
      projectId,
      (job, payload) =>
        byUser
          ? (payload.armedByUserId ?? actorUserId(job.createdBy as Actor)) === target.userId
          : job.runnerId === target.runnerId,
      now,
      actor,
      { kind: "runner-unavailable", code: reason },
    );
    await recordBoardEvents(ctx, projectId, actor, now, group.events);
    for (const userId of group.users) {
      if (!(await ownerMayWorkOn(ctx, userId, projectId))) continue;
      await raiseAttention(ctx, {
        id: automationPauseAttentionId(projectId, userId),
        userId,
        projectId,
        ticketId: null,
        sessionId: null,
        source: "runner_alert",
        sourceId: byUser ? projectId : target.runnerId,
        kind: "automation_paused",
        title: "Automations paused",
        detail: "Re-arm on an available runner.",
        raisedAt: now,
      });
    }
  }
}

/** Public rows never expose Convex document ids. Absent expand fields read as null. */
export function publicArming<T extends Doc<"automationArmings"> | Doc<"automationSchedules">>(
  row: T,
) {
  return {
    ...publicRow(row),
    pausedAt: row.pausedAt ?? null,
    pausedReason: row.pausedReason ?? null,
  };
}
