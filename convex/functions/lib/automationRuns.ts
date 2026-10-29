/**
 * Automation Run rows: what a cloud Run's `automation.run` job became.
 *
 * One Run row per Run, written by the backend: `queued` when a schedule
 * occurrence, a by-hand Run or an agent's `automation_run` enqueues it, and
 * inserted at its outcome for an arrival (whose pending state is the inbox
 * countdown, as locally). Then `started`, `skipped` or `failed`, here, from
 * the job's terminal transition in the runner inbox:
 *
 * - `started` (the runner's completion): the Run row names its Session, an
 *   `automation_run_started` board event carries the `automation` Actor, and
 *   an agent caller's automatic watch on the new Session is armed (or left to
 *   the Session's first accept, which may still be in flight).
 * - `abandoned` (the runner's fresh-facts check said no): an arrival leaves no
 *   row, as locally; any other Run is `skipped` with the true reason.
 * - `refused`, a permanent failure, or a dead letter: `failed`, an
 *   `automation_run_failed` event and one Needs-you item for the person whose
 *   work it was. A failed arrival keeps a Retry command id.
 * - withdrawn before any runner held it: a queued Run row becomes `skipped`.
 *
 * Every caller is a terminal transition of the job, which the inbox makes at
 * most once (its lease fence and `alreadyReported`), so each Run settles once.
 */
import {
  actorUserId,
  automationAbandonSkipReason,
  automationRunFailedAttentionId,
  isExecutableAutomationRun,
  parseId,
  parseJobPayload,
  type Actor,
  type AutomationRunAbandonReason,
  type AutomationRunCompletion,
  type AutomationRunJobPayload,
  type BoardEventDraft,
  type CloudAutomationSkipReason,
  type TicketId,
  type UserId,
} from "@volli/shared/cloud";
import { AUTOMATION_RUN_ATTENDANCE, type AutomationRunAttendance } from "@volli/shared";

import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server";
import { clearAttention, raiseAttention } from "./attention";
import { recordBoardEvents } from "./board";
import { ownerMayWorkOn } from "./jobs";
import { armAutomationRunWatch } from "./watches";

type Reader = Pick<MutationCtx, "db">;
type RunRow = Omit<Doc<"automationRuns">, "_id" | "_creationTime">;

/** A producer-minted Run id: a UUID, carried by the job so a re-lease lands on the same Run. */
export function newRunId(): string {
  return globalThis.crypto.randomUUID();
}

export function findRun(ctx: Reader, runId: string) {
  return ctx.db
    .query("automationRuns")
    .withIndex("by_uuid", (q) => q.eq("id", runId))
    .unique();
}

/** The Actor a Run's board events carry: the person whose credentials it runs on. */
export function runActor(
  userId: string,
  automationId: string,
  runId: string,
  sessionId?: string,
): Actor {
  return {
    kind: "automation",
    userId: parseId("user", userId),
    automationId,
    runId,
    ...(sessionId === undefined ? {} : { sessionId: parseId("session", sessionId) }),
  };
}

/** The executable payload of an `automation.run` job, or null for a legacy or unreadable one. */
export function executablePayload(job: Doc<"runnerJobs">): AutomationRunJobPayload | null {
  if (job.kind !== "automation.run") return null;
  try {
    const payload = parseJobPayload("automation.run", job.payload);
    return isExecutableAutomationRun(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** A queued Run row as its producer writes it. */
export function queuedRunRow(input: {
  payload: AutomationRunJobPayload;
  jobId: string;
  projectId: string;
  runnerId: string;
  automationName: string | null;
  now: number;
}): RunRow {
  const { payload } = input;
  return {
    id: payload.runId,
    automationId: payload.automationId,
    automationName: input.automationName,
    projectId: input.projectId,
    ticketId: payload.ticketId,
    sessionId: null,
    trigger: payload.trigger,
    status: "queued",
    skipReason: null,
    missedCount: null,
    dueAt: payload.dueAt,
    model: null,
    attendance: payload.attendance,
    armedByUserId: payload.armedByUserId,
    runnerId: input.runnerId,
    createdAt: input.now,
    jobId: input.jobId,
    requestedBySessionId: payload.requestedBySessionId,
    instructions: "instructions" in payload ? payload.instructions : null,
  };
}

// A Record, so a new abandon reason fails to compile until it is read here too.
const ABANDON_REASONS: Readonly<Record<AutomationRunAbandonReason, true>> = {
  gone: true,
  "left-column": true,
  disarmed: true,
  "schedule-disarmed": true,
  previous_run_active: true,
};

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** A runner's `done` result for an `automation.run` job, or null when it is not one. */
function parseRunCompletion(raw: unknown): AutomationRunCompletion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (row.kind === "started") {
    const model = row.model as Record<string, unknown> | null | undefined;
    if (
      typeof row.sessionId !== "string" ||
      typeof model !== "object" ||
      model === null ||
      !boundedText(model.providerId, 200) ||
      !boundedText(model.modelId, 200) ||
      !boundedText(model.reasoningLevel, 50) ||
      !AUTOMATION_RUN_ATTENDANCE.includes(row.attendance as never)
    )
      return null;
    return {
      kind: "started",
      sessionId: parseId("session", row.sessionId),
      model: {
        providerId: model.providerId as string,
        modelId: model.modelId as string,
        reasoningLevel: model.reasoningLevel as string,
      },
      attendance: row.attendance as AutomationRunAttendance,
    };
  }
  if (row.kind === "abandoned") {
    return typeof row.reason === "string" && Object.hasOwn(ABANDON_REASONS, row.reason)
      ? { kind: "abandoned", reason: row.reason as AutomationRunAbandonReason }
      : null;
  }
  if (row.kind === "refused" && boundedText(row.code, 200)) {
    if (row.detail !== null && typeof row.detail !== "string") return null;
    return {
      kind: "refused",
      code: row.code as string,
      detail: row.detail === null ? null : (row.detail as string).slice(0, 2_000),
    };
  }
  return null;
}

/** How a terminal `automation.run` job ended, as the inbox saw it. */
type AutomationJobEnd =
  | { kind: "done"; result: unknown }
  | { kind: "failed"; code: string; detail: string | null }
  | { kind: "withdrawn"; code: string; reason: CloudAutomationSkipReason };

/**
 * Settles the Run a terminal `automation.run` job stood for: its row, its
 * board event, attention, and an agent caller's watch. Call it once, in the
 * transaction that made the job terminal. A legacy arrival (no Run identity)
 * has no Run to settle.
 */
export async function settleAutomationRunJob(
  ctx: MutationCtx,
  job: Doc<"runnerJobs">,
  end: AutomationJobEnd,
  now: number,
): Promise<void> {
  const payload = executablePayload(job);
  if (payload === null) return;
  await releaseSchedulePointer(ctx, payload, job.id);
  const run = await findRun(ctx, payload.runId);
  // A Retry moved the Run to a newer job: an older job's late word is not its outcome.
  if (run !== null && run.jobId != null && run.jobId !== job.id) return;
  const automation =
    payload.automationId === null
      ? null
      : await ctx.db
          .query("automations")
          .withIndex("by_uuid", (q) => q.eq("id", payload.automationId!))
          .unique();
  const runner = await ctx.db
    .query("runners")
    .withIndex("by_uuid", (q) => q.eq("id", job.runnerId))
    .unique();
  const whose =
    runner?.ownerUserId ?? payload.armedByUserId ?? actorUserId(job.createdBy as Actor) ?? null;
  const name = automation?.name ?? run?.automationName ?? null;
  const base = queuedRunRow({
    payload,
    jobId: job.id,
    projectId: job.projectId,
    runnerId: job.runnerId,
    automationName: name,
    now,
  });
  const write = async (patch: Partial<RunRow>) => {
    if (run !== null) return ctx.db.patch(run._id, patch);
    const row = Object.fromEntries(
      Object.entries({ ...base, ...patch }).filter(([, value]) => value !== undefined),
    ) as RunRow;
    await ctx.db.insert("automationRuns", row);
  };
  const event = async (draft: BoardEventDraft["payload"], sessionId?: string) => {
    if (payload.automationId === null || whose === null) return;
    await recordBoardEvents(
      ctx,
      job.projectId,
      runActor(whose, payload.automationId, payload.runId, sessionId),
      now,
      [{ ticketId: payload.ticketId as TicketId | null, payload: draft }],
    );
  };

  if (end.kind === "withdrawn") {
    // Only an unstarted projection is withdrawn; an arrival's countdown has no row.
    if (run?.status !== "queued") return;
    await write({ status: "skipped", skipReason: end.reason });
    if (payload.automationId !== null)
      await event({
        kind: "automation_run_skipped",
        automationId: parseId("automation", payload.automationId),
        runId: payload.runId,
        reason: end.code,
      });
    return;
  }

  const completion =
    end.kind === "done"
      ? (parseRunCompletion(end.result) ?? {
          kind: "refused" as const,
          code: "invalid_result",
          detail: "The runner reported an outcome this backend cannot read.",
        })
      : { kind: "refused" as const, code: end.code, detail: end.detail };

  if (completion.kind === "started" && completion.sessionId !== payload.sessionId) {
    // A Session under another id is not this Run's: record it as the defect it is.
    return settleFailed({
      code: "session_mismatch",
      detail: "The runner started this Run under another Session id.",
    });
  }
  if (completion.kind === "started") {
    await write({
      status: "started",
      sessionId: completion.sessionId,
      model: completion.model,
      attendance: completion.attendance,
      skipReason: null,
      error: undefined,
      retryCommandId: undefined,
    });
    if (payload.automationId !== null)
      await event(
        {
          kind: "automation_run_started",
          automationId: parseId("automation", payload.automationId),
          runId: payload.runId,
          sessionId: completion.sessionId,
        },
        completion.sessionId,
      );
    await clearAttention(ctx, automationRunFailedAttentionId(payload.runId), "resolved", now);
    const target = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", completion.sessionId))
      .unique();
    await armAutomationRunWatch(
      ctx,
      {
        id: payload.runId,
        projectId: job.projectId,
        requestedBySessionId: payload.requestedBySessionId,
        sessionId: completion.sessionId,
      },
      target,
    );
    return;
  }
  if (completion.kind === "abandoned") {
    // Local parity: an arrival whose ticket moved on, or whose column was
    // disarmed, simply ends its countdown. A retried arrival already has a row.
    if (payload.trigger === "arrival" && run === null) return;
    const skipReason = automationAbandonSkipReason(completion.reason);
    await write({ status: "skipped", skipReason });
    if (payload.automationId !== null)
      await event({
        kind: "automation_run_skipped",
        automationId: parseId("automation", payload.automationId),
        runId: payload.runId,
        reason: completion.reason,
      });
    return;
  }
  return settleFailed({ code: completion.code, detail: completion.detail });

  async function settleFailed(failure: { code: string; detail: string | null }) {
    const arrival = payload!.trigger === "arrival" || run?.trigger === "arrival";
    // A Session that exists is this Run's, so a later Retry resumes it rather than conflicting.
    const born = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", payload!.sessionId))
      .unique();
    await write({
      status: "failed",
      ...(born === null ? {} : { sessionId: payload!.sessionId }),
      error: failure.detail ?? failure.code,
      // A failed arrival can be retried under this id (`automations.retryArrival`).
      ...(arrival ? { retryCommandId: globalThis.crypto.randomUUID() } : {}),
    });
    if (payload!.automationId !== null)
      await event({
        kind: "automation_run_failed",
        automationId: parseId("automation", payload!.automationId),
        runId: payload!.runId,
        code: failure.code,
        detail: failure.detail,
      });
    if (whose === null || !(await ownerMayWorkOn(ctx, whose, job.projectId))) return;
    await raiseAttention(ctx, {
      id: automationRunFailedAttentionId(payload!.runId),
      userId: whose as UserId,
      projectId: job.projectId,
      ticketId: payload!.ticketId,
      sessionId: null,
      source: "runner_alert",
      sourceId: payload!.runId,
      kind: "automation_run_failed",
      title: name === null ? "An Automation Run didn't start" : `${name} didn't start`,
      detail: failure.detail ?? failure.code,
      raisedAt: now,
    });
  }
}

/** A schedule's pending pointer ends with its job, so the next occurrence enqueues afresh. */
async function releaseSchedulePointer(
  ctx: MutationCtx,
  payload: AutomationRunJobPayload,
  jobId: string,
): Promise<void> {
  if (payload.trigger !== "schedule") return;
  const schedule = await ctx.db
    .query("automationSchedules")
    .withIndex("by_automation", (q) => q.eq("automationId", payload.automationId))
    .unique();
  if (schedule === null || schedule.pendingJobId !== jobId) return;
  await ctx.db.patch(schedule._id, { pendingJobId: null, pendingRunId: null, gapRunId: null });
}
