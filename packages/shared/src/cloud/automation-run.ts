/**
 * The runner's last word on a claimed `automation.run` job: whether to start
 * it, against the fresh backend facts `automationRunner.runContext` reads
 * under the job's current lease. No clock and no store.
 *
 * Enqueue-time facts are never trusted. Between the producer and the claim a
 * ticket can leave its column, a column or schedule can be disarmed or
 * paused, and an Automation can be deleted or edited; a Run that waited for a
 * sleeping Mac must still start only if what it depended on is still true.
 * The local board re-checks the same things at its countdown's deadline
 * (`armedRunVerdict`); this is that rule over the cloud's records.
 *
 * Receiving-task wiring: the runner executor (`cloud-store/automation-jobs.ts`
 * in host-core) calls it before `Sessions.start`, never after: once a Run's
 * Session exists, a crash resumes that Session rather than asking again.
 */
import { automationTriggersColumn, isValidAutomationRuntime } from "../automation-policy";
import type { ValidAutomationRuntime } from "../automation";
import type { ProjectId, RunnerId, SessionId, TicketId } from "./ids";
import type { AutomationRunJobPayload } from "./job-payloads";
import type {
  AutomationRunAbandonReason,
  AutomationRunContext,
  CloudAutomationDefinition,
} from "./automations";
import type { RunnerStatus } from "./runners";

type ReadyContext = Extract<AutomationRunContext, { kind: "ready" }>;

export type AutomationRunVerdict =
  | {
      kind: "start";
      projectId: ProjectId;
      /** `null`: a schedule's project Run, which opens a Board Session. */
      ticketId: TicketId | null;
      /** `null` for an Unbound Run, whose Session wears the unbound label. */
      automationName: string | null;
      /** The text before the composer's `/` and `@` expansion. */
      instructions: string;
      /** This Run's Runtime: the invocation's override, else the record's; `null` inherits. */
      runtime: ValidAutomationRuntime;
    }
  | { kind: "abandon"; reason: AutomationRunAbandonReason }
  | {
      kind: "refuse";
      /** `context_mismatch`: the backend answered for another Run (a defect, never retried). */
      code: "context_mismatch" | "invalid_runtime";
      detail: string;
    };

/**
 * What is true of the target now decides; the order only picks which true
 * reason is named. A gone Automation or ticket outranks a moved ticket, which
 * outranks a disarmed column, which outranks a Run still busy before it.
 *
 * A pick (`origin: "chosen"`) needs only the ticket still in its column, as
 * locally: a person chose it on a deliberate move, not the column's arming.
 * An invalid saved Runtime refuses even under an invocation override: the
 * record needs repair, not a quieter way around it (the local Run door's rule).
 */
export function automationRunVerdict(input: {
  payload: AutomationRunJobPayload;
  context: ReadyContext;
  /** The executing runner: an arming moved to another runner is not this Run's. */
  runnerId: RunnerId;
}): AutomationRunVerdict {
  const { payload, context, runnerId } = input;
  if (
    context.payload.runId !== payload.runId ||
    context.payload.sessionId !== payload.sessionId ||
    context.payload.trigger !== payload.trigger
  )
    return {
      kind: "refuse",
      code: "context_mismatch",
      detail: "Volli Cloud answered this Run's context for another Run.",
    };
  const automation: CloudAutomationDefinition | null =
    payload.automationId === null ? null : context.automation;
  if (
    payload.automationId !== null &&
    (automation === null ||
      automation.deletedAt !== null ||
      automation.id !== payload.automationId ||
      automation.projectId !== context.projectId)
  )
    return { kind: "abandon", reason: "gone" };
  const ticket = context.ticket;
  if (
    payload.ticketId !== null &&
    (ticket === null ||
      ticket.archived ||
      ticket.id !== payload.ticketId ||
      ticket.projectId !== context.projectId)
  )
    return { kind: "abandon", reason: "gone" };
  if (payload.trigger === "arrival") {
    if (ticket!.status !== payload.status) return { kind: "abandon", reason: "left-column" };
    const arming = context.columnArming;
    if (
      payload.origin === "armed" &&
      (arming === null ||
        arming.automationId !== payload.automationId ||
        arming.runnerId !== runnerId ||
        arming.pausedAt !== null ||
        !automationTriggersColumn(automation!, payload.status))
    )
      return { kind: "abandon", reason: "disarmed" };
  }
  if (payload.trigger === "schedule") {
    const arming = context.scheduleArming;
    if (
      arming === null ||
      arming.automationId !== payload.automationId ||
      arming.runnerId !== runnerId ||
      arming.pausedAt !== null ||
      automation!.trigger.kind !== "schedule"
    )
      return { kind: "abandon", reason: "schedule-disarmed" };
  }
  if (context.previousRunActive) return { kind: "abandon", reason: "previous_run_active" };
  if (automation !== null && !isValidAutomationRuntime(automation.runtime))
    return {
      kind: "refuse",
      code: "invalid_runtime",
      detail:
        "This Automation's saved Runtime is invalid. Edit it and choose a valid model-and-reasoning pair.",
    };
  const recordRuntime = automation === null ? null : (automation.runtime as ValidAutomationRuntime);
  return {
    kind: "start",
    projectId: context.projectId,
    ticketId: payload.ticketId,
    automationName: automation?.name ?? null,
    // The parser admits a null Automation only on an Unbound Run, which carries its own text.
    instructions:
      automation?.instructions ??
      (payload as Extract<AutomationRunJobPayload, { instructions: string }>).instructions,
    runtime: payload.modelOverride ?? recordRuntime,
  };
}

/**
 * What `automations.run` answers a by-hand or agent Run on a ticket: the
 * producer-minted ids and the runner the Run waits for. The Run is queued,
 * not started; the runner's completion records `started`.
 *
 * Receiving-task wiring: the clock/Run task's `automations.run` mutation
 * returns this shape; the cloud agent route (`automation_run` in a cloud
 * launch) words it for the calling Session.
 */
export interface AutomationRunQueued {
  runId: string;
  sessionId: SessionId;
  runner: { id: RunnerId; name: string; status: RunnerStatus };
}
