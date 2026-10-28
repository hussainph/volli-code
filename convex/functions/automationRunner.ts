/**
 * What a runner reads before it starts a cloud Automation Run.
 *
 * `runContext` answers the backend facts a claimed `automation.run` job
 * depended on, as they are NOW, so the runner's last check
 * (`automationRunVerdict` in `@volli/shared/cloud`) never trusts what was
 * true at enqueue: the Automation, the ticket's column, the column's arming,
 * the schedule's arming, and whether an earlier Run of the same ticket or
 * schedule still has a working Session (single-flight, as locally).
 *
 * It is fenced by the job's CURRENT lease (`bootId`, `attempt`), not merely
 * by the runner: an attempt whose lease was taken away reads `lease_lost`.
 */
import { v } from "convex/values";
import { isTicketStatus } from "@volli/shared";
import {
  parseId,
  type AutomationId,
  type AutomationRunContext,
  type JobId,
  type ProjectId,
  type RunnerId,
  type TicketId,
} from "@volli/shared/cloud";

import type { Doc } from "./_generated/dataModel.js";
import { query, type QueryCtx } from "./_generated/server";
import { automationFacts, findAutomation } from "./lib/automations";
import { executablePayload } from "./lib/automationRuns";
import { leaseMayContinue } from "./lib/jobs";
import { requireRunner } from "./lib/runnerAuth";

/** How many earlier Runs of one ticket or schedule the single-flight check reads. */
const PRIOR_RUNS = 25;
/** A started Run whose Session row has not arrived yet is still being born for this long. */
const BIRTH_GRACE_MS = 10 * 60_000;

const LEASE_LOST: AutomationRunContext = { kind: "unavailable", reason: "lease_lost" };

export const runContext = query({
  args: { jobId: v.string(), bootId: v.string(), attempt: v.number() },
  handler: async (ctx, args): Promise<AutomationRunContext> => {
    const { runnerId } = await requireRunner(ctx);
    const job = await ctx.db
      .query("runnerJobs")
      .withIndex("by_uuid", (q) => q.eq("id", args.jobId))
      .unique();
    if (
      job === null ||
      job.runnerId !== runnerId ||
      job.kind !== "automation.run" ||
      !leaseMayContinue(job, { bootId: args.bootId, attempt: args.attempt })
    )
      return LEASE_LOST;
    const payload = executablePayload(job);
    // A legacy arrival has no Run identity; the executor refuses it before asking.
    if (payload === null) return LEASE_LOST;

    const automationRow =
      payload.automationId === null ? null : await findAutomation(ctx, payload.automationId);
    const ticketRow =
      payload.ticketId === null
        ? null
        : await ctx.db
            .query("tickets")
            .withIndex("by_uuid", (q) => q.eq("id", payload.ticketId!))
            .unique();
    const ticket =
      ticketRow === null || ticketRow.deletedAt !== null || !isTicketStatus(ticketRow.status)
        ? null
        : {
            id: ticketRow.id as TicketId,
            projectId: ticketRow.projectId as ProjectId,
            status: ticketRow.status,
            archived: ticketRow.archivedAt !== null,
          };
    const arming =
      payload.trigger === "arrival"
        ? await ctx.db
            .query("automationArmings")
            .withIndex("by_project_status", (q) =>
              q.eq("projectId", job.projectId).eq("status", payload.status),
            )
            .unique()
        : null;
    const schedule =
      payload.trigger === "schedule"
        ? await ctx.db
            .query("automationSchedules")
            .withIndex("by_automation", (q) => q.eq("automationId", payload.automationId))
            .unique()
        : null;
    return {
      kind: "ready",
      payload,
      projectId: job.projectId as ProjectId,
      automation: automationRow === null ? null : automationFacts(automationRow),
      ticket,
      columnArming: arming === null ? null : armingFacts(arming),
      scheduleArming: schedule === null ? null : armingFacts(schedule),
      previousRunActive: await previousRunActive(ctx, {
        runId: payload.runId,
        ticketId: payload.ticketId,
        automationId: payload.automationId,
        projectId: job.projectId,
      }),
    };
  },
});

function armingFacts(row: Doc<"automationArmings"> | Doc<"automationSchedules">) {
  return {
    automationId: parseId("automation", row.automationId) as AutomationId,
    runnerId: parseId("runner", row.runnerId) as RunnerId,
    pausedAt: row.pausedAt ?? null,
  };
}

/**
 * Local single-flight: a ticket gets another Run only once every earlier
 * Run-owned Session on it is quiet, and a project-level Run (a schedule's, or
 * its "Run now") only once the same Automation's earlier one is. A Run whose
 * Session is working or waiting on a person keeps the next one out; one that
 * is stopped, idle or archived does not. A Session not yet accepted is
 * assumed live for a short grace (the completion can outrun the first
 * accept), then not.
 */
async function previousRunActive(
  ctx: QueryCtx,
  input: { runId: string; ticketId: string | null; automationId: string | null; projectId: string },
): Promise<boolean> {
  const prior =
    input.ticketId !== null
      ? await ctx.db
          .query("automationRuns")
          .withIndex("by_ticket", (q) => q.eq("ticketId", input.ticketId))
          .order("desc")
          .take(PRIOR_RUNS)
      : input.automationId === null
        ? []
        : (
            await ctx.db
              .query("automationRuns")
              .withIndex("by_automation", (q) => q.eq("automationId", input.automationId))
              .order("desc")
              .take(PRIOR_RUNS)
          ).filter((run) => run.ticketId === null && run.projectId === input.projectId);
  const now = Date.now();
  for (const run of prior) {
    if (run.id === input.runId || run.status !== "started" || run.sessionId === null) continue;
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", run.sessionId!))
      .unique();
    if (session === null) {
      const job =
        run.jobId == null
          ? null
          : await ctx.db
              .query("runnerJobs")
              .withIndex("by_uuid", (q) => q.eq("id", run.jobId as JobId))
              .unique();
      if (job?.completedAt != null && now - job.completedAt < BIRTH_GRACE_MS) return true;
      continue;
    }
    if (session.deletedAt !== null || session.status !== "open" || session.stopped !== null)
      continue;
    const activity =
      session.listing?.activity ??
      (session.turnActive ? "working" : session.needsUser ? "waiting" : "idle");
    if (activity === "working" || activity === "waiting") return true;
  }
  return false;
}
