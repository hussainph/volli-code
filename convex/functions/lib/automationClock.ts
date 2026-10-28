/**
 * The Automation clock: one pass over the schedules that are due.
 *
 * Volli Cloud owns time for cloud Automations. A one-minute cron
 * (`automationSchedules.fireDue`) reads `automationSchedules.by_next_fire`
 * up to now, a page at a time, and applies the shared `decideScheduleFire`
 * to each row in that row's own transaction slice:
 *
 * - **Never early.** Only rows whose `nextFireAt` has passed are read, and the
 *   job a fire enqueues is not handed out before its `dueAt`
 *   (`availableAt`). A row is at most one cron period (~60 s) late.
 * - **Exactly once.** The fire advances `nextFireAt` in the same transaction
 *   that writes its Run row and job, so two overlapping passes conflict on the
 *   row and Convex retries the later one, which no longer finds it due.
 * - **Wait, coalesced.** At most one pending Run per schedule. An occurrence
 *   that comes due while the previous Run still waits for an asleep runner
 *   moves that Run to the new due time, and the superseded occurrences become
 *   ONE skip row with their count. A weekend asleep is one skip row and one
 *   Run when the runner wakes.
 * - A removed runner or a departed armer pauses the schedule (one skip row,
 *   one Needs-you item while the armer is still a Member). Paused rows, rows
 *   of a deleted Automation and rows of a project that is not live are passed
 *   over untouched; the pass continues past them rather than stalling on them.
 *
 * `nextFireAt` is computed only here and at arming, with the stored IANA zone
 * (`test/automationClock.intl.backend.test.ts` proves the runtime's zone data
 * agrees with Node's); clients show the backend's answer.
 */
import { parseAutomationSchedule } from "@volli/shared";
import {
  automationPauseAttentionId,
  decideScheduleFire,
  isTerminalJobStatus,
  newId,
  parseId,
  type Actor,
  type AutomationRunJobPayload,
  type BoardEventDraft,
  type CloudAutomationSkipReason,
  type PendingAutomationScheduleRun,
  type RunnerStatus,
} from "@volli/shared/cloud";

import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server";
import { raiseAttention } from "./attention";
import { isShownProject } from "./auth";
import { recordBoardEvents } from "./board";
import { executablePayload, findRun, newRunId, queuedRunRow, runActor } from "./automationRuns";
import { cancelJob, ownerMayWorkOn, patchQueuedJob, tryEnqueueJob } from "./jobs";

/** Schedules one clock transaction fires; small enough to stay clear of OCC contention. */
const FIRE_PAGE_SIZE = 50;

const POLICY: Actor = { kind: "volli", reason: "policy" };

interface FirePageResult {
  /** Due rows read in this page, fired or passed over. */
  read: number;
  /** Rows whose cursor this page advanced. */
  fired: number;
  /** Where the next page of this pass starts, or null when the pass is done. */
  continueCursor: string | null;
}

/** One page of one clock pass at `now`. A continuation passes the same `now` and its cursor. */
export async function fireDuePage(
  ctx: MutationCtx,
  input: { now: number; cursor: string | null },
): Promise<FirePageResult> {
  const page = await ctx.db
    .query("automationSchedules")
    .withIndex("by_next_fire", (q) => q.lte("nextFireAt", input.now))
    .paginate({ numItems: FIRE_PAGE_SIZE, cursor: input.cursor });
  let fired = 0;
  for (const row of page.page) if (await fireSchedule(ctx, row, input.now)) fired += 1;
  return {
    read: page.page.length,
    fired,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

function runnerStatusOf(runner: Doc<"runners"> | null): RunnerStatus | "removed" {
  if (runner === null) return "removed";
  return runner.revokedAt !== null ? "revoked" : runner.status;
}

async function pendingOf(
  ctx: MutationCtx,
  row: Doc<"automationSchedules">,
): Promise<{ job: Doc<"runnerJobs">; pending: PendingAutomationScheduleRun } | null> {
  if (row.pendingJobId == null) return null;
  const job = await ctx.db
    .query("runnerJobs")
    .withIndex("by_uuid", (q) => q.eq("id", row.pendingJobId!))
    .unique();
  if (job === null || isTerminalJobStatus(job.status)) return null;
  const payload = executablePayload(job);
  if (payload === null || payload.runId !== row.pendingRunId) return null;
  return {
    job,
    pending: {
      jobId: parseId("job", job.id),
      runId: payload.runId,
      dueAt: payload.dueAt,
      missedCount: payload.missedCount,
      status: job.status === "leased" ? "leased" : "queued",
      // A lease survives its expiry on the row: any lease ever taken makes it unpatchable.
      attempt: job.lease?.attempt ?? 0,
    },
  };
}

function skipRow(input: {
  automation: Doc<"automations">;
  schedule: Doc<"automationSchedules">;
  dueAt: number;
  missedCount: number;
  reason: CloudAutomationSkipReason;
  now: number;
}): Omit<Doc<"automationRuns">, "_id" | "_creationTime"> {
  return {
    id: newRunId(),
    automationId: input.automation.id,
    automationName: input.automation.name,
    projectId: input.automation.projectId,
    ticketId: null,
    sessionId: null,
    trigger: "schedule",
    status: "skipped",
    skipReason: input.reason,
    missedCount: input.missedCount,
    dueAt: input.dueAt,
    model: null,
    attendance: "unattended",
    armedByUserId: input.schedule.armedByUserId,
    runnerId: input.schedule.runnerId,
    createdAt: input.now,
    jobId: null,
    requestedBySessionId: null,
    instructions: null,
  };
}

function reasonCode(reason: CloudAutomationSkipReason): string {
  return reason.kind === "runner-unavailable" || reason.kind === "run-refused"
    ? reason.code
    : reason.kind;
}

/**
 * Reads what one due row's fire depends on and decides it, writing nothing.
 * A row this pass cannot read is logged and passed over: one bad row must
 * never roll back the page, or stall every other schedule every minute.
 */
async function readFire(ctx: MutationCtx, row: Doc<"automationSchedules">, now: number) {
  if (row.pausedAt != null) return null;
  try {
    const automation = await ctx.db
      .query("automations")
      .withIndex("by_uuid", (q) => q.eq("id", row.automationId))
      .unique();
    if (automation === null || automation.deletedAt !== null) return null;
    const project = await ctx.db
      .query("projects")
      .withIndex("by_uuid", (q) => q.eq("id", automation.projectId))
      .unique();
    // A project being moved in, deleted or archived runs nothing; it is not this
    // schedule's armer leaving, so it neither pauses nor records a skip.
    if (project === null || !isShownProject(project) || project.archivedAt !== null) return null;
    const spec = parseAutomationSchedule({ ...(row.spec as object), timeZone: row.timezone });
    if (spec === null) throw new Error("unreadable schedule");
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", row.runnerId))
      .unique();
    const armerActive =
      (runner === null || runner.ownerUserId === row.armedByUserId) &&
      (await ownerMayWorkOn(ctx, row.armedByUserId, project.id));
    const pending = await pendingOf(ctx, row);
    const decision = decideScheduleFire({
      schedule: {
        automationId: parseId("automation", row.automationId),
        spec,
        timezone: row.timezone,
        nextFireAt: row.nextFireAt,
        pausedAt: null,
        automationDeleted: false,
        runnerId: parseId("runner", row.runnerId),
        runnerStatus: runnerStatusOf(runner),
        armerActive,
        gapRunId: row.gapRunId ?? null,
      },
      pending: pending?.pending ?? null,
      now,
    });
    if (decision.kind !== "ignore") parseId("user", row.armedByUserId);
    return { automation, project, pending, decision };
  } catch (error) {
    console.error("automation schedule passed over", { automationId: row.automationId, error });
    return null;
  }
}

/** Fires one due schedule row at `now`. Returns whether its cursor moved. */
async function fireSchedule(
  ctx: MutationCtx,
  row: Doc<"automationSchedules">,
  now: number,
): Promise<boolean> {
  const read = await readFire(ctx, row, now);
  if (read === null) return false;
  const { automation, project, pending, decision } = read;
  if (decision.kind === "ignore") return false;

  const events: { actor: Actor; draft: BoardEventDraft }[] = [];
  const emit = (actor: Actor, draft: BoardEventDraft) => events.push({ actor, draft });
  const skipped = (runId: string, reason: CloudAutomationSkipReason) =>
    events.push({
      actor: runActor(row.armedByUserId, automation.id, runId),
      draft: {
        ticketId: null,
        payload: {
          kind: "automation_run_skipped",
          automationId: parseId("automation", automation.id),
          runId,
          reason: reasonCode(reason),
        },
      },
    });
  const flush = async () => {
    for (const { actor, draft } of events)
      await recordBoardEvents(ctx, project.id, actor, now, [draft]);
  };

  if (decision.kind === "skip") {
    await pauseSchedule(ctx, {
      row,
      automation,
      now,
      nextFireAt: decision.nextFireAt,
      pauseReason: decision.pauseReason,
      settlePending: decision.settlePending,
      gap: decision.gap,
      pendingJob: pending?.job ?? null,
      skipped,
      emit,
    });
    await flush();
    return true;
  }

  if (decision.kind === "supersede") {
    const job = pending!.job;
    const payload = executablePayload(job)!;
    const moved = { ...payload, dueAt: decision.dueAt, missedCount: decision.missedCount };
    if (!(await patchQueuedJob(ctx, job, moved)))
      throw new Error("A never-leased schedule job changed inside its own transaction.");
    await ctx.db.patch(job._id, { availableAt: decision.dueAt });
    const waiting = await findRun(ctx, decision.runId);
    if (waiting !== null) await ctx.db.patch(waiting._id, { dueAt: decision.dueAt });
    let gapRunId = decision.gap.runId;
    const gapRow = gapRunId === null ? null : await findRun(ctx, gapRunId);
    if (gapRow !== null) {
      await ctx.db.patch(gapRow._id, {
        dueAt: decision.gap.dueAt,
        missedCount: decision.gap.missedCount,
        skipReason: decision.gap.reason,
      });
    } else {
      const inserted = skipRow({ automation, schedule: row, ...decision.gap, now });
      await ctx.db.insert("automationRuns", inserted);
      gapRunId = inserted.id;
      skipped(inserted.id, decision.gap.reason);
    }
    await ctx.db.patch(row._id, {
      nextFireAt: decision.nextFireAt,
      lastFiredAt: decision.dueAt,
      gapRunId,
    });
    await flush();
    return true;
  }

  // Enqueue: a fresh Run, with the occurrences it covers as one skip row.
  const runId = newRunId();
  const payload: AutomationRunJobPayload = {
    trigger: "schedule",
    automationId: parseId("automation", automation.id),
    ticketId: null,
    armedByUserId: parseId("user", row.armedByUserId),
    runId,
    sessionId: newId("session"),
    dueAt: decision.dueAt,
    missedCount: decision.missedCount,
    attendance: "unattended",
    modelOverride: null,
    requestedBySessionId: null,
  };
  const outcome = await tryEnqueueJob(ctx, {
    runnerId: row.runnerId,
    kind: "automation.run",
    projectId: project.id,
    ticketId: null,
    payload,
    availableAt: decision.dueAt,
    createdBy: runActor(row.armedByUserId, automation.id, runId),
    onBehalfOf: row.armedByUserId,
  });
  if ("refused" in outcome) {
    // The inbox would not route it (its owner or runner changed under the
    // arming): pause, as for a removed runner, with every occurrence covered.
    const pauseReason = outcome.refused === "not_a_member" ? "armer_left" : "runner_removed";
    await pauseSchedule(ctx, {
      row,
      automation,
      now,
      nextFireAt: decision.nextFireAt,
      pauseReason,
      settlePending: null,
      gap: {
        runId: null,
        dueAt: decision.dueAt,
        missedCount: decision.missedCount + 1,
        reason: { kind: "runner-unavailable", code: pauseReason },
      },
      pendingJob: null,
      skipped,
      emit,
    });
    await flush();
    return true;
  }
  let gapRunId: string | null = null;
  if (decision.gap !== null) {
    const inserted = skipRow({ automation, schedule: row, ...decision.gap, now });
    await ctx.db.insert("automationRuns", inserted);
    gapRunId = inserted.id;
    skipped(inserted.id, decision.gap.reason);
  }
  await ctx.db.insert(
    "automationRuns",
    queuedRunRow({
      payload,
      jobId: outcome.jobId,
      projectId: project.id,
      runnerId: row.runnerId,
      automationName: automation.name,
      now,
    }),
  );
  await ctx.db.patch(row._id, {
    nextFireAt: decision.nextFireAt,
    lastFiredAt: decision.dueAt,
    pendingJobId: outcome.jobId,
    pendingRunId: runId,
    gapRunId,
  });
  await flush();
  return true;
}

/** A schedule whose runner or armer is gone: one skip row, paused, one Needs-you item. */
async function pauseSchedule(
  ctx: MutationCtx,
  input: {
    row: Doc<"automationSchedules">;
    automation: Doc<"automations">;
    now: number;
    nextFireAt: number;
    pauseReason: "runner_removed" | "armer_left";
    settlePending: { jobId: string; runId: string } | null;
    gap: {
      runId: string | null;
      dueAt: number;
      missedCount: number;
      reason: CloudAutomationSkipReason;
    };
    pendingJob: Doc<"runnerJobs"> | null;
    skipped: (runId: string, reason: CloudAutomationSkipReason) => void;
    emit: (actor: Actor, draft: BoardEventDraft) => void;
  },
): Promise<void> {
  const { row, automation, now, gap } = input;
  if (input.settlePending !== null && input.pendingJob !== null)
    await cancelJob(ctx, input.pendingJob, now, {
      code: input.pauseReason,
      detail: "The runner or armer is no longer available.",
    });
  const gapRow = gap.runId === null ? null : await findRun(ctx, gap.runId);
  let gapRunId: string;
  // A gap row already announced its skip; only a new or converted one is news.
  let announce = gapRow === null || gapRow.status === "queued";
  if (gapRow !== null) {
    // The waiting Run itself becomes the skip, or folds into the open gap row.
    await ctx.db.patch(gapRow._id, {
      status: "skipped",
      skipReason: gap.reason,
      dueAt: gap.dueAt,
      missedCount: gap.missedCount,
    });
    gapRunId = gapRow.id;
    if (input.settlePending !== null && input.settlePending.runId !== gap.runId) {
      const waiting = await findRun(ctx, input.settlePending.runId);
      if (waiting?.status === "queued") await ctx.db.delete(waiting._id);
    }
  } else {
    const inserted = skipRow({ automation, schedule: row, ...gap, now });
    await ctx.db.insert("automationRuns", inserted);
    gapRunId = inserted.id;
    announce = true;
  }
  if (announce) input.skipped(gapRunId, gap.reason);
  await ctx.db.patch(row._id, {
    nextFireAt: input.nextFireAt,
    pausedAt: now,
    pausedReason: input.pauseReason,
    pendingJobId: null,
    pendingRunId: null,
    gapRunId: null,
  });
  input.emit(POLICY, {
    ticketId: null,
    payload: {
      kind: "automation_schedule_armed",
      automationId: parseId("automation", automation.id),
      runnerId: null,
    },
  });
  if (!(await ownerMayWorkOn(ctx, row.armedByUserId, automation.projectId))) return;
  await raiseAttention(ctx, {
    id: automationPauseAttentionId(automation.projectId, row.armedByUserId),
    userId: row.armedByUserId,
    projectId: automation.projectId,
    ticketId: null,
    sessionId: null,
    source: "runner_alert",
    sourceId: input.pauseReason === "armer_left" ? automation.projectId : row.runnerId,
    kind: "automation_paused",
    title: "Automations paused",
    detail: "Re-arm on an available runner.",
    raisedAt: now,
  });
}
