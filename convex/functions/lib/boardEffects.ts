/**
 * A board write's machine side effects, as runner jobs.
 *
 * The pure rules say WHAT must happen (`BoardSideEffect`); this module says
 * WHERE: which runner holds the ticket's Working copies or runs its Sessions,
 * or which runner an armed column's armer chose. Each becomes a `runnerJobs`
 * row in the board write's own transaction, so the job exists exactly when
 * the write committed. Nothing here runs the work: the runner claims the job,
 * re-checks what it depended on, and reports the outcome.
 *
 * Jobs go in through the runner inbox (`tryEnqueueJob`), which checks each
 * payload against `JobPayloads` and applies the routing rules: a runner only
 * runs its owner's work, in projects its owner is still a Member of. A job the
 * inbox will not route is skipped rather than failing the board write; the
 * board fact stands, and what did not start is reported in the reply (a
 * picked run that cannot run, a worktree that was not asked for). A malformed
 * job (a defect, not a routing refusal) still fails the write, loudly.
 *
 * An Automation run is only queued for a runner that advertises the executor
 * in its capability report (a desktop runner from 0.3.0 names it), so an
 * older build is never handed an `automation.run` job it cannot execute; the
 * board fact still stands.
 */

import {
  actorUserId,
  newId,
  SESSION_INTERRUPT_FORMAT,
  type Actor,
  type BoardSideEffect,
  type JobKind,
  type RunnerCapabilities,
  type UserId,
} from "@volli/shared/cloud";

import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import { cancelJob, tryEnqueueJob, type JobDraft, type JobRefusalCode } from "./jobs";

/** A job this module builds; the project and ticket are the effect's ticket's. */
type EffectJob = Omit<JobDraft, "projectId" | "ticketId">;

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
 * An Automation run a person picked that has nowhere to run, reported in the
 * move's reply rather than dropped silently.
 */
interface UnstartedRun {
  ticketId: string;
  automationId: string;
  /**
   * `no_place`: the ticket has no Place yet. `place_not_yours`: its Place is
   * another person's runner (a pick never runs on a teammate's machine).
   * `runner_unavailable`: the runner it would run on was removed.
   * `not_a_member`: the person whose work it is left the Workspace.
   * `runner_unsupported`: the runner does not advertise the Automation
   * executor, so a cloud launch keeps the run off (VC-569).
   *
   * Open-ended: this is an additive output with no schema validator, so a
   * reader handles the reasons it knows and tolerates any it does not.
   */
  reason:
    | "no_place"
    | "place_not_yours"
    | "runner_unavailable"
    | "not_a_member"
    | "runner_unsupported";
}

export interface SideEffectReport {
  /** Picked Automation runs that could not start. */
  unstartedRuns: UnstartedRun[];
  /**
   * Tickets switched to a worktree whose Working copy was not asked for: the
   * Place is not the switcher's runner. The Place's owner makes it when they
   * next work on the ticket there (the runner reports the Working copy it
   * makes, with the runner registration work).
   */
  deferredWorktrees: string[];
}

function unstartedReason(refused: JobRefusalCode): UnstartedRun["reason"] {
  if (refused === "runner_unavailable" || refused === "not_a_member") return refused;
  return "place_not_yours";
}

/**
 * The one `runners.capabilities.tools` entry this module reads as a job
 * capability. That list is primarily platform tools (`xcode`, `simulator`);
 * `automation.run` is not a platform tool but the explicit capability with
 * which a runner says it executes this job kind. It is spelled like the job
 * kind on purpose: one name for one thing, and the runner's versioned
 * capability report is the channel that already exists (VC-569 flips it on by
 * naming it). A runner that has never reported, or reports no such entry, is
 * not assumed to have an executor; the other tools in the list mean nothing
 * here.
 */
const AUTOMATION_RUN_CAPABILITY = "automation.run" satisfies JobKind;

function advertisesAutomationRun(runner: Doc<"runners">): boolean {
  const tools = (runner.capabilities as Partial<RunnerCapabilities> | null)?.tools;
  return Array.isArray(tools) && tools.includes(AUTOMATION_RUN_CAPABILITY);
}

/** Inserts the jobs a write's side effects need; reports what did not start. */
export async function enqueueSideEffects(
  context: EffectContext,
  effects: readonly BoardSideEffect[],
): Promise<SideEffectReport> {
  const report: SideEffectReport = { unstartedRuns: [], deferredWorktrees: [] };
  for (const effect of effects) {
    const ticket = context.tickets.get(effect.ticketId);
    if (ticket === undefined)
      throw new Error(`Side effect for an unloaded ticket ${effect.ticketId}`);
    for (const job of await jobsFor(context, ticket, effect, report.unstartedRuns)) {
      const outcome = await tryEnqueueJob(context.ctx, {
        ...job,
        projectId: ticket.projectId,
        ticketId: ticket.id,
      });
      if (!("refused" in outcome)) continue;
      // Work no one is waiting on (a trim, an interrupt, an armed run) has no
      // one to tell; the log keeps why it did not start.
      console.warn("board side effect not routed", {
        effect: effect.kind,
        job: job.kind,
        ticketId: ticket.id,
        refused: outcome.refused,
      });
      if (job.kind === "automation.run") {
        const payload = job.payload as { automationId: string; origin: string };
        if (payload.origin === "chosen") {
          report.unstartedRuns.push({
            ticketId: ticket.id,
            automationId: payload.automationId,
            reason: unstartedReason(outcome.refused),
          });
        }
      }
      if (job.kind === "workingCopy.materialize") report.deferredWorktrees.push(ticket.id);
    }
  }
  return report;
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
): Promise<EffectJob[]> {
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
          // Housekeeping of a copy the runner holds: its owner's own disk.
          onBehalfOf: null,
        }));
    }

    case "interrupt_sessions": {
      // Every running agent of the ticket is told to stop; nothing is killed,
      // and the transcript stays for a later resume.
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_ticket_activity", (q) => q.eq("ticketId", ticket.id))
        .collect();
      const jobs: EffectJob[] = [];
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
            format: SESSION_INTERRUPT_FORMAT,
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
          onBehalfOf: session.ownerUserId,
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
          await cancelJob(ctx, job, now, {
            code: "superseded",
            detail: "A later move replaced this arrival.",
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
      const activeArming = arming?.pausedAt == null ? arming : null;
      const automationId =
        effect.choice?.kind === "automation"
          ? effect.choice.automationId
          : activeArming?.automationId;
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
      const armed = activeArming !== null && activeArming.automationId === automationId;
      // An armed run goes to the runner its armer chose (their own). A pick of
      // another Automation runs on the ticket's Place only when that runner
      // is the picker's own: work never lands on a teammate's machine.
      const picker = actorUserId(actor);
      let runnerId: string;
      let runner: Doc<"runners"> | null;
      if (armed) {
        runnerId = activeArming!.runnerId;
        runner = await ctx.db
          .query("runners")
          .withIndex("by_uuid", (q) => q.eq("id", runnerId))
          .unique();
      } else {
        const place = ticket.placeRunnerId;
        if (place === null) {
          unstarted.push({ ticketId: ticket.id, automationId, reason: "no_place" });
          return [];
        }
        runner = await ctx.db
          .query("runners")
          .withIndex("by_uuid", (q) => q.eq("id", place))
          .unique();
        if (runner === null || runner.ownerUserId !== picker) {
          unstarted.push({ ticketId: ticket.id, automationId, reason: "place_not_yours" });
          return [];
        }
        runnerId = place;
      }
      // A removed runner is the inbox's refusal to report (`runner_unavailable`),
      // not a capability gap: let `tryEnqueueJob` answer that unchanged. A live
      // runner that does not advertise the executor gets no job at all, so no
      // ghost run waits for a kind this launch cannot execute.
      if (
        runner !== null &&
        runner.revokedAt === null &&
        runner.status !== "revoked" &&
        !advertisesAutomationRun(runner)
      ) {
        console.warn("board side effect not enqueued", {
          effect: effect.kind,
          job: "automation.run",
          ticketId: ticket.id,
          runnerId,
          reason: "capability_absent",
        });
        if (effect.choice?.kind === "automation") {
          unstarted.push({
            ticketId: ticket.id,
            automationId,
            reason: "runner_unsupported",
          });
        }
        return [];
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
            armedByUserId: armed ? activeArming!.armedByUserId : null,
          },
          availableAt: effect.notBefore,
          createdBy: actor,
          // Armed: the armer's work, with their credentials. Picked: the picker's.
          onBehalfOf: armed ? activeArming!.armedByUserId : picker,
        },
      ];
    }

    case "materialize_working_copy": {
      // The first Session start materializes a ticket with no Place yet. The
      // switch that asked for this was refused if a worktree existed or was
      // being made (`hasLiveWorktree`), so there is none to duplicate.
      if (ticket.placeRunnerId === null) return [];
      const runnerId = ticket.placeRunnerId;
      const switcher = actorUserId(actor);
      if (switcher === null) return [];
      return [
        {
          runnerId,
          kind: "workingCopy.materialize",
          payload: { ticketId: ticket.id, reason: "checkout_mode_changed" },
          availableAt: now,
          createdBy: actor,
          // The switch is the switcher's request, and making a worktree runs
          // the project's setup: it happens only on the switcher's own runner.
          // Elsewhere it is reported as deferred (`SideEffectReport`).
          onBehalfOf: switcher,
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
