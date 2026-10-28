/**
 * Cloud Automation policy and the backend ↔ runner contract. No clock or store.
 *
 * Receiving-task wiring: B3b-2 uses change/arming decisions in its mutations;
 * B3b-3 uses schedule-fire in the minute cron, produces executable job payloads,
 * serves fenced runContext and consumes completion; B3b-4 consumes that context
 * before Sessions.start and completes the inbox job. B3b-5 may optimistically
 * project these decisions, but displays the backend's nextFireAt, not its clock.
 * The signed-out scheduler deliberately keeps its existing skip-while-closed rule.
 */
import {
  automationDraftProblem,
  automationTriggersColumn,
  isValidAutomationRuntime,
  parseAutomationRuntime,
  parseAutomationTrigger,
  type ArmedRunAbandonReason,
  type AutomationDraft,
  type AutomationRunAttendance,
  type AutomationSkipReason,
  type ResolvedAutomationModel,
} from "../automation";
import { nextScheduleOccurrence, type AutomationSchedule } from "../automation-schedule";
import type { TicketStatus } from "../ticket";
import type { AutomationId, ProjectId, RunnerId, SessionId, TicketId, UserId } from "./ids";
import type { AutomationRunJobPayload } from "./job-payloads";
import type { RunnerStatus } from "./runners";

/** Cloud write bounds; the job codec also checks the whole serialized payload. */
export const AUTOMATION_NAME_MAX_CHARS = 200;
export const AUTOMATION_INSTRUCTIONS_MAX_CHARS = 32_000;

export interface CloudAutomationDefinition extends AutomationDraft {
  id: AutomationId;
  projectId: ProjectId;
  deletedAt: number | null;
}

type Refused = { kind: "refused"; code: string };

/** Inputs are untrusted draft values; malformed triggers must not silently save as `none`. */
export function decideAutomationChange(input: {
  change: "create" | "update" | "delete";
  automationId: AutomationId;
  projectId: ProjectId;
  existing: readonly CloudAutomationDefinition[];
  draft?: { name: string; instructions: string; runtime: unknown; trigger: unknown };
}): { kind: "delete" } | { kind: "save"; draft: AutomationDraft } | Refused {
  const current = input.existing.find((row) => row.id === input.automationId);
  if (input.change !== "create" && (!current || current.deletedAt !== null)) {
    return { kind: "refused", code: "automation_not_found" };
  }
  if (current && current.projectId !== input.projectId) {
    return { kind: "refused", code: "automation_not_in_project" };
  }
  if (input.change === "delete") return { kind: "delete" };
  if (input.change === "create" && current) return { kind: "refused", code: "automation_exists" };
  const draft = input.draft;
  if (!draft || automationDraftProblem(draft) !== null) {
    return { kind: "refused", code: "invalid_draft" };
  }
  const name = draft.name.trim();
  if (
    name.length > AUTOMATION_NAME_MAX_CHARS ||
    draft.instructions.length > AUTOMATION_INSTRUCTIONS_MAX_CHARS
  ) {
    return { kind: "refused", code: "draft_too_large" };
  }
  if (
    input.existing.some(
      (row) =>
        row.id !== input.automationId &&
        row.projectId === input.projectId &&
        row.deletedAt === null &&
        row.name.trim().toLowerCase() === name.toLowerCase(),
    )
  ) {
    return { kind: "refused", code: "name_taken" };
  }
  const runtime = parseAutomationRuntime(draft.runtime);
  if (!isValidAutomationRuntime(runtime)) return { kind: "refused", code: "invalid_runtime" };
  const trigger = parseAutomationTrigger(draft.trigger);
  if (trigger.kind === "none" && (draft.trigger as { kind?: unknown } | null)?.kind !== "none") {
    return { kind: "refused", code: "invalid_trigger" };
  }
  return { kind: "save", draft: { name, instructions: draft.instructions, runtime, trigger } };
}

export interface AutomationRunner {
  id: RunnerId;
  ownerUserId: UserId;
  status: RunnerStatus;
  tools: readonly string[];
}

function runnerProblem(
  runner: AutomationRunner | null,
  callerUserId: UserId,
  live: boolean,
): string | null {
  if (runner === null || runner.status === "revoked") return "runner_unavailable";
  if (runner.ownerUserId !== callerUserId) return "runner_not_yours";
  if (!runner.tools.includes("automation.run")) return "runner_needs_update";
  if (live && runner.status !== "online" && runner.status !== "degraded") return "runner_not_live";
  return null;
}

interface ArmingInput {
  projectId: ProjectId;
  callerUserId: UserId;
  /** Any board editor may replace an arming; auth is resolved by the caller. */
  canEdit: boolean;
  automation: CloudAutomationDefinition | null;
  runner: AutomationRunner | null;
}

function armingProblem(input: ArmingInput): string | null {
  if (input.automation === null || input.automation.deletedAt !== null)
    return "automation_not_found";
  if (input.automation.projectId !== input.projectId) return "automation_not_in_project";
  return runnerProblem(input.runner, input.callerUserId, true);
}

/** Re-arm is arm again: the writing mutation replaces the armer and clears pause fields. */
export function decideArming(
  input: ArmingInput & { status: TicketStatus; disarm: boolean },
):
  | { kind: "disarm" }
  | { kind: "arm"; automationId: AutomationId; runnerId: RunnerId; armedByUserId: UserId }
  | Refused {
  if (!input.canEdit) return { kind: "refused", code: "forbidden" };
  if (input.disarm) return { kind: "disarm" };
  const problem = armingProblem(input);
  if (problem !== null) return { kind: "refused", code: problem };
  const automation = input.automation!;
  if (!automationTriggersColumn(automation, input.status))
    return { kind: "refused", code: "wrong_trigger" };
  return {
    kind: "arm",
    automationId: automation.id,
    runnerId: input.runner!.id,
    armedByUserId: input.callerUserId,
  };
}

/** First sight/re-arm owes nothing. The stored zone is the arming's snapshot. */
export function decideScheduleArming(input: ArmingInput & { disarm: boolean; now: number }):
  | { kind: "disarm" }
  | {
      kind: "arm";
      automationId: AutomationId;
      runnerId: RunnerId;
      armedByUserId: UserId;
      timezone: string;
      nextFireAt: number;
    }
  | Refused {
  if (!input.canEdit) return { kind: "refused", code: "forbidden" };
  if (input.disarm) return { kind: "disarm" };
  const problem = armingProblem(input);
  if (problem !== null) return { kind: "refused", code: problem };
  const automation = input.automation!;
  if (automation.trigger.kind !== "schedule") return { kind: "refused", code: "wrong_trigger" };
  const spec = automation.trigger.schedule;
  return {
    kind: "arm",
    automationId: automation.id,
    runnerId: input.runner!.id,
    armedByUserId: input.callerUserId,
    timezone: spec.timeZone,
    nextFireAt: nextScheduleOccurrence({
      schedule: spec,
      staggerKey: automation.id,
      after: input.now,
    }),
  };
}

/** By-hand/agent Runs use an owned ticket Place, else the caller's current runner. Never a teammate's. */
export function decideAutomationRunRouting(input: {
  callerUserId: UserId;
  callerRunner: AutomationRunner | null;
  ticketPlace: AutomationRunner | null;
}): { kind: "route"; runnerId: RunnerId; onBehalfOf: UserId } | Refused {
  const runner =
    input.ticketPlace?.ownerUserId === input.callerUserId ? input.ticketPlace : input.callerRunner;
  const problem = runnerProblem(runner, input.callerUserId, false);
  if (problem !== null) return { kind: "refused", code: problem };
  return { kind: "route", runnerId: runner!.id, onBehalfOf: input.callerUserId };
}

export interface CloudAutomationSchedule {
  automationId: AutomationId;
  spec: AutomationSchedule;
  /** Authoritative even if a stale spec has another zone. */
  timezone: string;
  nextFireAt: number;
  pausedAt: number | null;
  automationDeleted: boolean;
  runnerId: RunnerId;
  runnerStatus: RunnerStatus | "removed";
  armerActive: boolean;
  /** The open skip row for the waiting job; closed when that job is leased. */
  gapRunId: string | null;
}

export interface PendingAutomationScheduleRun {
  jobId: string;
  runId: string;
  dueAt: number;
  /** Number of superseded occurrences already covered by this waiting job's gap row. */
  missedCount: number;
  status: "queued" | "leased";
  /** A retry queued after a lease is NOT patchable (it may already have started a Session). */
  attempt: number;
}

export interface AutomationScheduleGap {
  /** null: insert a new gap row; otherwise update this SAME row, not a second skip. */
  runId: string | null;
  dueAt: number;
  missedCount: number;
  reason: AutomationSkipReason;
}

export type ScheduleFireDecision =
  | { kind: "ignore"; reason: "inactive" | "early" }
  | {
      kind: "skip";
      nextFireAt: number;
      pauseReason: "runner_removed" | "armer_left";
      gap: AutomationScheduleGap;
    }
  | {
      kind: "enqueue";
      dueAt: number;
      missedCount: number;
      nextFireAt: number;
      gap: AutomationScheduleGap | null;
    }
  | {
      kind: "supersede";
      jobId: string;
      runId: string;
      dueAt: number;
      missedCount: number;
      nextFireAt: number;
      gap: AutomationScheduleGap;
    };

/**
 * Wait, coalesced: keep only the latest due occurrence, with one skip per gap.
 * Commit the returned job/Run/gap AND nextFireAt in one transaction. A patch
 * also advances the job's availableAt to dueAt. A skip pauses the schedule,
 * cancels its never-leased job, and raises one armer attention item. Only a
 * never-leased job may be patched. A leased/retry job starts a new gap; the
 * executor's fresh-context single-flight check handles previous_run_active.
 */
export function decideScheduleFire(input: {
  schedule: CloudAutomationSchedule;
  pending: PendingAutomationScheduleRun | null;
  now: number;
}): ScheduleFireDecision {
  const { schedule, pending, now } = input;
  if (schedule.pausedAt !== null || schedule.automationDeleted)
    return { kind: "ignore", reason: "inactive" };
  if (schedule.nextFireAt > now) return { kind: "ignore", reason: "early" };
  const occurrence = (after: number) =>
    nextScheduleOccurrence({
      schedule: { ...schedule.spec, timeZone: schedule.timezone },
      staggerKey: schedule.automationId,
      after,
    });
  let dueAt = schedule.nextFireAt;
  let previousDueAt = dueAt;
  let count = 1;
  let nextFireAt = occurrence(dueAt);
  while (nextFireAt <= now) {
    previousDueAt = dueAt;
    dueAt = nextFireAt;
    count += 1;
    nextFireAt = occurrence(dueAt);
  }
  const patchable = pending !== null && pending.status === "queued" && pending.attempt === 0;
  if (
    !schedule.armerActive ||
    schedule.runnerStatus === "revoked" ||
    schedule.runnerStatus === "removed"
  ) {
    const pauseReason = !schedule.armerActive ? "armer_left" : "runner_removed";
    return {
      kind: "skip",
      nextFireAt,
      pauseReason,
      gap: {
        runId: patchable ? schedule.gapRunId : null,
        dueAt,
        missedCount: count + (patchable ? pending.missedCount + 1 : 0),
        reason: { kind: "runner-unavailable", code: pauseReason },
      },
    };
  }
  const reason: AutomationSkipReason =
    schedule.runnerStatus === "asleep"
      ? { kind: "runner-asleep", runnerId: schedule.runnerId }
      : { kind: "superseded" };
  if (patchable) {
    const missedCount = pending.missedCount + count;
    return {
      kind: "supersede",
      jobId: pending.jobId,
      runId: pending.runId,
      dueAt,
      missedCount,
      nextFireAt,
      gap: {
        runId: schedule.gapRunId,
        dueAt: count === 1 ? pending.dueAt : previousDueAt,
        missedCount,
        reason,
      },
    };
  }
  const missedCount = count - 1;
  return {
    kind: "enqueue",
    dueAt,
    missedCount,
    nextFireAt,
    gap: missedCount === 0 ? null : { runId: null, dueAt: previousDueAt, missedCount, reason },
  };
}

/** runContext is fenced against the inbox's CURRENT lease, not just the runner id. */
export interface AutomationRunContextRequest {
  jobId: string;
  bootId: string;
  attempt: number;
}

/** Backend facts read again immediately before starting; never trust an enqueue-time arming. */
export type AutomationRunContext =
  | { kind: "unavailable"; reason: "lease_lost" }
  | {
      kind: "ready";
      payload: AutomationRunJobPayload;
      projectId: ProjectId;
      automation: CloudAutomationDefinition | null;
      ticket: {
        id: TicketId;
        projectId: ProjectId;
        status: TicketStatus;
        archived: boolean;
      } | null;
      columnArming: {
        automationId: AutomationId;
        runnerId: RunnerId;
        pausedAt: number | null;
      } | null;
      scheduleArming: {
        automationId: AutomationId;
        runnerId: RunnerId;
        pausedAt: number | null;
      } | null;
      previousRunActive: boolean;
    };

/**
 * B3b-4 uses operationId `automation-run:{runId}` (create command suffix
 * `:create`) and stable derived message ids; these derivations freeze when
 * the executor ships. Complete only after Session start AND first-message delivery.
 * B3b-3 records started + event + automatic caller watch (the Session's first
 * accept may still be in flight); abandoned arrivals leave no Run row, other
 * abandons become skipped; refused/dead-letter becomes failed + armer attention.
 */
export type AutomationRunCompletion =
  | {
      kind: "started";
      sessionId: SessionId;
      model: ResolvedAutomationModel;
      attendance: AutomationRunAttendance;
    }
  | {
      kind: "abandoned";
      reason: ArmedRunAbandonReason | "schedule-disarmed" | "previous_run_active";
    }
  | { kind: "refused"; code: string; detail: string | null };
