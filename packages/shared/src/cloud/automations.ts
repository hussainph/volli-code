/**
 * Cloud Automation policy and the backend ↔ runner contract. No clock or store.
 *
 * Receiving-task wiring: the cloud Automation records task uses change/arming
 * decisions in its mutations. The clock/Run task uses schedule-fire in the
 * minute cron, routing in manual/agent Run mutations, produces executable
 * payloads, serves fenced runContext and consumes completion. The runner
 * executor task consumes that context before Sessions.start and completes
 * the inbox job. The cloud UI task uses the limits in its editor and reads
 * skips with parseCloudAutomationSkipReason; it may optimistically project
 * decisions but displays the backend's nextFireAt, not its own clock.
 * The signed-out scheduler deliberately keeps its existing skip-while-closed rule.
 */
import {
  automationDraftProblem,
  automationTriggersColumn,
  isValidAutomationRuntime,
  parseAutomationRuntime,
  parseAutomationTrigger,
  parseAutomationSkipReason,
  type ArmedRunAbandonReason,
  type AutomationDraft,
  type AutomationRuntime,
  type AutomationRunAttendance,
  type AutomationSkipReason,
  type ResolvedAutomationModel,
} from "../automation";
import { nextScheduleOccurrence, type AutomationSchedule } from "../automation-schedule";
import type { TicketStatus } from "../ticket";
import {
  isUuid,
  type AutomationId,
  type JobId,
  type ProjectId,
  type RunnerId,
  type SessionId,
  type TicketId,
  type UserId,
} from "./ids";
import type { AutomationRunJobPayload } from "./job-payloads";
import type { RunnerStatus } from "./runners";

/** Cloud write bounds; the job codec also checks the whole serialized payload. */
export const AUTOMATION_NAME_MAX_CHARS = 200;
export const AUTOMATION_INSTRUCTIONS_MAX_CHARS = 32_000;

export interface CloudAutomationDefinition extends Omit<AutomationDraft, "runtime"> {
  /** Preserve invalid imported pins so the executor refuses, never silently inherits. */
  runtime: AutomationRuntime;
  id: AutomationId;
  projectId: ProjectId;
  deletedAt: number | null;
}

type AutomationDecisionRefusalCode =
  | "automation_not_found"
  | "automation_not_in_project"
  | "automation_exists"
  | "invalid_draft"
  | "draft_too_large"
  | "name_taken"
  | "invalid_runtime"
  | "invalid_trigger"
  | "forbidden"
  | "wrong_trigger"
  | "runner_unavailable"
  | "runner_not_yours"
  | "runner_needs_update"
  | "runner_not_live";
type Refused = { kind: "refused"; code: AutomationDecisionRefusalCode };

/** Cloud-only additions keep the frozen signed-out skip vocabulary unchanged. */
export type CloudAutomationSkipReason =
  | AutomationSkipReason
  | { kind: "runner-asleep"; runnerId: RunnerId }
  | { kind: "runner-unavailable"; code: string }
  | { kind: "superseded" };

/** Open on read: malformed/new reasons still preserve the skipped occurrence. */
export function parseCloudAutomationSkipReason(raw: unknown): CloudAutomationSkipReason {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (record.kind === "superseded") return { kind: "superseded" };
    if (record.kind === "runner-asleep" && isUuid(record.runnerId))
      return { kind: "runner-asleep", runnerId: record.runnerId as RunnerId };
    if (
      record.kind === "runner-unavailable" &&
      typeof record.code === "string" &&
      record.code.length > 0
    )
      return { kind: "runner-unavailable", code: record.code };
  }
  return parseAutomationSkipReason(raw);
}

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
): AutomationDecisionRefusalCode | null {
  if (runner === null || runner.status === "revoked") return "runner_unavailable";
  if (runner.ownerUserId !== callerUserId) return "runner_not_yours";
  if (!runner.tools.includes("automation.run")) return "runner_needs_update";
  // Arming needs a runner accepting new work, not merely emitting heartbeats.
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

function armingProblem(input: ArmingInput): AutomationDecisionRefusalCode | null {
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

/**
 * By-hand/agent Runs use an owned ticket Place, else the caller's current runner.
 * An owned but unusable Place refuses rather than silently changing machines.
 * Asleep/offline is usable: the Run waits. Never borrow a teammate's credentials.
 */
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
  /**
   * The skip row belonging to the current never-leased pending Run.
   * EVERY enqueue replaces this with its new gap id, or null (even if the
   * old job was leased). No hook in the generic claim path is required.
   */
  gapRunId: string | null;
}

export interface PendingAutomationScheduleRun {
  jobId: JobId;
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
  reason: CloudAutomationSkipReason;
}

export type ScheduleFireDecision =
  | { kind: "ignore"; reason: "inactive" | "early" }
  | {
      kind: "skip";
      nextFireAt: number;
      pauseReason: "runner_removed" | "armer_left";
      /** Cancel the job. Convert this queued Run to the gap if ids match;
       * otherwise delete it after merging into the existing gap row. Both
       * are unstarted projections; the single skip retains every occurrence.
       */
      settlePending: { jobId: JobId; runId: string } | null;
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
      jobId: JobId;
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
 * settles its never-leased job/Run via settlePending, and raises one armer
 * attention item. Only a never-leased job may be patched. A leased/retry job
 * starts a new gap; the
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
  // A stale schedule pointer must never rewrite a finished gap from an older job.
  const openGapRunId = patchable && pending.missedCount > 0 ? schedule.gapRunId : null;
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
      settlePending: patchable ? { jobId: pending.jobId, runId: pending.runId } : null,
      gap: {
        runId: openGapRunId ?? (patchable ? pending.runId : null),
        dueAt,
        missedCount: count + (patchable ? pending.missedCount + 1 : 0),
        reason: { kind: "runner-unavailable", code: pauseReason },
      },
    };
  }
  const reason: CloudAutomationSkipReason =
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
        runId: openGapRunId,
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
  jobId: JobId;
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
 * The runner executor uses operationId `automation-run:{runId}` (create command suffix
 * `:create`) and stable derived message ids; these derivations freeze when
 * the executor ships. Complete only after Session start AND first-message delivery.
 * The backend clock/Run task records started + event + automatic caller watch (the Session's first
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
      reason: AutomationRunAbandonReason;
    }
  | { kind: "refused"; code: string; detail: string | null };

/** Cloud arming is the switch: there is no machine-local `switched-off` state. */
export type AutomationRunAbandonReason =
  | Exclude<ArmedRunAbandonReason, "switched-off">
  | "schedule-disarmed"
  | "previous_run_active";

/** The backend completion hook uses this for skipped schedule/manual Runs; arrivals leave no row. */
export function automationAbandonSkipReason(
  reason: AutomationRunAbandonReason,
): AutomationSkipReason {
  const errors: Record<AutomationRunAbandonReason, string> = {
    gone: "The Automation or its target no longer exists.",
    "left-column": "The ticket left the column.",
    disarmed: "The column is no longer armed with this Automation.",
    "schedule-disarmed": "The schedule is no longer armed on this runner.",
    previous_run_active: "The previous Run is still active.",
  };
  return { kind: "run-refused", code: reason, error: errors[reason] };
}
