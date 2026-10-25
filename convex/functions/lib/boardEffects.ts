/**
 * A board write's machine side effects, as runner jobs.
 *
 * TODO(B3): insert through the runner inbox's `tryEnqueueJob` (one way to add
 * a job, with its routing rules) once it lands, instead of writing
 * `runnerJobs` rows here.
 *
 * The pure rules say WHAT must happen (`BoardSideEffect`); this module says
 * WHERE: which runner holds the ticket's Working copies or runs its Sessions,
 * or which runner an armed column's armer chose. Each becomes a `runnerJobs`
 * row in the board write's own transaction, so the job exists exactly when
 * the write committed. Nothing here runs the work: the runner claims the job,
 * re-checks what it depended on, and reports the outcome.
 *
 * Job payloads are this module's until the runner tickets that execute each
 * kind type them in `@volli/shared/cloud` (`JobPayloads`).
 */

import {
  actorUserId,
  jobRank,
  newId,
  TERMINAL_JOB_TTL_MS,
  type Actor,
  type BoardSideEffect,
  type JobKind,
  type JobPriority,
  type UserId,
} from "@volli/shared/cloud";

import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";

interface JobDraft {
  id?: string;
  runnerId: string;
  kind: JobKind;
  sessionId?: string | null;
  workingCopyId?: string | null;
  commandId?: string | null;
  payload: Record<string, unknown>;
  priority?: JobPriority;
  availableAt: number;
  createdBy: Actor;
}

export interface EffectContext {
  ctx: MutationCtx;
  /**
   * The tickets the write touched, as they were loaded for it. Effects read
   * only fields a board write does not change (Place, retention, project).
   */
  tickets: ReadonlyMap<string, Doc<"tickets">>;
  actor: Actor;
  now: number;
}

/**
 * An Automation run a person picked that has nowhere to run: the pick is not
 * the column's armed Automation, and the ticket has no Place or its Place is
 * someone else's runner. Reported in
 * the move's reply rather than dropped silently.
 */
interface UnstartedRun {
  ticketId: string;
  automationId: string;
  /** No Place yet, or the Place is another person's runner (a pick never runs on a teammate's machine). */
  reason: "no_place" | "place_not_yours";
}

/** Inserts the jobs a write's side effects need; returns the runs it could not place. */
export async function enqueueSideEffects(
  context: EffectContext,
  effects: readonly BoardSideEffect[],
): Promise<UnstartedRun[]> {
  const unstarted: UnstartedRun[] = [];
  for (const effect of effects) {
    const ticket = context.tickets.get(effect.ticketId);
    if (ticket === undefined)
      throw new Error(`Side effect for an unloaded ticket ${effect.ticketId}`);
    const jobs = await jobsFor(context, ticket, effect, unstarted);
    for (const job of jobs) await insertJob(context, ticket, job);
  }
  return unstarted;
}

async function insertJob(
  { ctx, now }: EffectContext,
  ticket: Doc<"tickets">,
  job: JobDraft,
): Promise<void> {
  const id = job.id ?? newId("job");
  const priority = job.priority ?? "normal";
  await ctx.db.insert("runnerJobs", {
    id,
    runnerId: job.runnerId,
    kind: job.kind,
    projectId: ticket.projectId,
    sessionId: job.sessionId ?? null,
    ticketId: ticket.id,
    workingCopyId: job.workingCopyId ?? null,
    commandId: job.commandId ?? null,
    payload: job.payload,
    priority,
    rank: jobRank(priority),
    status: "queued",
    availableAt: job.availableAt,
    lease: null,
    receipt: null,
    result: null,
    createdBy: job.createdBy,
    createdAt: now,
    completedAt: null,
    expiresAt: null,
  });
}

async function ticketJobs(ctx: MutationCtx, ticketId: string): Promise<Doc<"runnerJobs">[]> {
  return ctx.db
    .query("runnerJobs")
    .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
    .collect();
}

/** What an arrival's run says started it, so a later move replaces only arrivals. */
const ARRIVAL_TRIGGER = "arrival";

const isPending = (job: Doc<"runnerJobs">) => job.status === "queued" || job.status === "leased";

async function jobsFor(
  context: EffectContext,
  ticket: Doc<"tickets">,
  effect: BoardSideEffect,
  unstarted: UnstartedRun[],
): Promise<JobDraft[]> {
  const { ctx, actor, now } = context;
  switch (effect.kind) {
    case "trim_working_copies": {
      // A ticket a person asked to keep is never trimmed.
      if (ticket.retentionKeep) return [];
      const copies = await ctx.db
        .query("workingCopies")
        .withIndex("by_ticket_runner_repo", (q) => q.eq("ticketId", ticket.id))
        .collect();
      const pending = (await ticketJobs(ctx, ticket.id)).filter(
        (job) => job.kind === "workingCopy.trim" && isPending(job),
      );
      return copies
        .filter((copy) => copy.kind === "worktree" && copy.state === "ready")
        .filter((copy) => !pending.some((job) => job.workingCopyId === copy.id))
        .map((copy) => ({
          runnerId: copy.runnerId,
          kind: "workingCopy.trim",
          workingCopyId: copy.id,
          payload: { ticketId: ticket.id, workingCopyId: copy.id, reason: effect.reason },
          availableAt: now,
          createdBy: actor,
        }));
    }

    case "interrupt_sessions": {
      // Every running agent of the ticket is told to stop; nothing is killed,
      // and the transcript stays for a later resume.
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_ticket_activity", (q) => q.eq("ticketId", ticket.id))
        .collect();
      const jobs: JobDraft[] = [];
      for (const session of sessions) {
        if (
          session.deletedAt !== null ||
          session.status !== "open" ||
          session.stopped !== null ||
          !session.turnActive
        ) {
          continue;
        }
        const intake = await ctx.db
          .query("sessionIntake")
          .withIndex("by_session", (q) => q.eq("sessionId", session.id))
          .unique();
        if (intake === null || intake.state !== "active") continue;
        // The job carries a Session command, so its id is the command's.
        const commandId = newId("command");
        jobs.push({
          id: commandId,
          runnerId: intake.claim.runnerId,
          kind: "session.command",
          sessionId: session.id,
          commandId,
          payload: {
            sessionId: session.id,
            commandId,
            intent: { kind: "executor.interrupt" },
            reason: "ticket_left_active_columns",
            from: effect.from,
            to: effect.to,
          },
          priority: "urgent",
          availableAt: now,
          createdBy: {
            kind: "volli",
            reason: "supervision",
            onBehalfOf: session.ownerUserId as UserId,
          },
        });
      }
      return jobs;
    }

    case "column_arrival": {
      // A ticket cannot be arriving in two columns at once: a later move
      // replaces an earlier arrival's run that has not been claimed yet. Runs
      // with another trigger (schedules, manual runs) are left alone.
      for (const job of await ticketJobs(ctx, ticket.id)) {
        if (
          job.kind === "automation.run" &&
          job.status === "queued" &&
          (job.payload as { trigger?: unknown }).trigger === ARRIVAL_TRIGGER
        ) {
          await ctx.db.patch(job._id, {
            status: "cancelled",
            completedAt: now,
            expiresAt: now + TERMINAL_JOB_TTL_MS,
          });
        }
      }
      if (effect.choice?.kind === "move-only") return [];
      const arming = await ctx.db
        .query("automationArmings")
        .withIndex("by_project_status", (q) =>
          q.eq("projectId", ticket.projectId).eq("status", effect.to),
        )
        .first();
      const automationId =
        effect.choice?.kind === "automation" ? effect.choice.automationId : arming?.automationId;
      if (automationId === undefined) return [];
      const automation = await ctx.db
        .query("automations")
        .withIndex("by_uuid", (q) => q.eq("id", automationId))
        .unique();
      // Never substitute the column's arming for a picked Automation that is
      // gone. Whether the Automation still triggers on this column, and the
      // column is still armed with it, the runner re-checks when the run is
      // due (`armedRunVerdict`), as the local board does at its deadline.
      if (automation === null || automation.deletedAt !== null) return [];
      if (automation.projectId !== ticket.projectId) return [];
      const armed = arming !== null && arming.automationId === automationId;
      // An armed run goes to the runner its armer chose (their own). A pick of
      // another Automation runs on the ticket's Place only when that runner
      // is the picker's own: work never lands on a teammate's machine.
      let runnerId: string;
      if (armed) {
        runnerId = arming.runnerId;
      } else {
        const place = ticket.placeRunnerId;
        if (place === null) {
          unstarted.push({ ticketId: ticket.id, automationId, reason: "no_place" });
          return [];
        }
        const runner = await ctx.db
          .query("runners")
          .withIndex("by_uuid", (q) => q.eq("id", place))
          .unique();
        if (runner === null || runner.ownerUserId !== actorUserId(actor)) {
          unstarted.push({ ticketId: ticket.id, automationId, reason: "place_not_yours" });
          return [];
        }
        runnerId = place;
      }
      return [
        {
          runnerId,
          kind: "automation.run",
          payload: {
            trigger: ARRIVAL_TRIGGER,
            ticketId: ticket.id,
            automationId,
            from: effect.from,
            status: effect.to,
            origin: effect.choice?.kind === "automation" ? "chosen" : "armed",
            armedByUserId: armed ? arming.armedByUserId : null,
          },
          availableAt: effect.notBefore,
          createdBy: actor,
        },
      ];
    }

    case "materialize_working_copy": {
      // The first Session start materializes a ticket with no Place yet. The
      // switch that asked for this was refused if a worktree existed or was
      // being made (`hasLiveWorktree`), so there is none to duplicate.
      if (ticket.placeRunnerId === null) return [];
      const runnerId = ticket.placeRunnerId;
      return [
        {
          runnerId,
          kind: "workingCopy.materialize",
          payload: { ticketId: ticket.id, reason: "checkout_mode_changed" },
          availableAt: now,
          createdBy: actor,
        },
      ];
    }
  }
}

/**
 * Whether the ticket has a worktree on any runner, or one is being made (a
 * materialization queued or running): its checkout mode is then locked. A
 * reclaimed worktree is gone and a failed one never existed, so neither locks.
 */
export async function hasLiveWorktree(ctx: MutationCtx, ticketId: string): Promise<boolean> {
  const copies = await ctx.db
    .query("workingCopies")
    .withIndex("by_ticket_runner_repo", (q) => q.eq("ticketId", ticketId))
    .collect();
  if (copies.some((copy) => copy.kind === "worktree" && isLiveWorktree(copy))) return true;
  return (await ticketJobs(ctx, ticketId)).some(
    (job) => job.kind === "workingCopy.materialize" && isPending(job),
  );
}

function isLiveWorktree(copy: Doc<"workingCopies">): boolean {
  return copy.state !== "reclaimed" && copy.state !== "failed";
}
