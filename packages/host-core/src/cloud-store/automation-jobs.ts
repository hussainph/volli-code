/**
 * The runner's `automation.run` executor: a cloud Automation Run, started on
 * the runner its armer chose (or the by-hand caller's), through the same
 * Session start every runner-born Session takes.
 *
 * Volli Cloud owns the clock and the records: it queued this job when a
 * ticket arrived in an armed column, a schedule came due, or a person or an
 * agent ran an Automation by hand, and it writes the Run row from this job's
 * outcome. This executor's whole job, per claimed job:
 *
 *  1. Re-check what the Run depended on against fresh backend facts, read
 *     under this job's current lease (`automationRunner.runContext`), with the
 *     shared rule (`automationRunVerdict`). A ticket that left its column, a
 *     column or schedule disarmed or paused, an Automation deleted or a Run
 *     still busy before it completes `abandoned`, and nothing starts.
 *  2. Expand the Instructions with the composer's grammar from this runner's
 *     checkout of the project, as the local Run door does.
 *  3. Mint the Session (`Sessions.create`) under the backend-minted Session id
 *     and a derived operation id, with the model resolved from THIS runner's
 *     settings: the armer's own model connections, never a teammate's. An
 *     unavailable pin or tier completes `refused` and nothing exists. An
 *     inherited default is not inspected at mint (as locally): one gone stale
 *     fails the attach, and the Session's `error` reaches run-attention.
 *  4. Attach and deliver the first message under derived ids, answered when
 *     its turn opens (a held message when the attach is not ready).
 *  5. Complete `started` with the Session and its resolved model.
 *
 * **Crash safety.** Every durable step is keyed by an id derived from the
 * producer-minted `runId` (`automationRunIds`), so a re-leased job lands on
 * the same Session and the same first message. A Session that already exists
 * is the commitment: the target is not re-checked (the Run's own agent may
 * well have moved the ticket since); the birth is replayed under its
 * operation id, which finishes one a crash cut short, and the first message
 * is sent if it is still owed. A Session whose Automation was deleted before
 * its message went completes `refused`, so the armer hears of it. The inbox's
 * job journal replays a recorded outcome without running again.
 *
 * No local Automation ledger is written: the job journal and the derived ids
 * are this Run's plan, and the backend's Run row is its record.
 */
import { randomUUID } from "node:crypto";

import type { HostedSessionRuntime, SessionEngine } from "@volli/session-engine";
import {
  expandCommandInvocation,
  isAutomationRuntimeTier,
  roleImpliedByTicket,
  skillResourcePart,
  UNBOUND_RUN_LABEL,
  type AutomationRunAttendance,
  type PromptResource,
  type ResolvedAutomationModel,
  type SessionOrigin,
  type ValidAutomationRuntime,
} from "@volli/shared";
import {
  automationRunStart,
  automationRunVerdict,
  InvalidJobPayloadError,
  isExecutableAutomationRun,
  parseJobPayload,
  type AutomationRunCompletion,
  type AutomationRunContext,
  type AutomationRunContextRequest,
  type AutomationRunJobPayload,
  type ClaimedJob,
  type JobKind,
  type JobOutcome,
  type RunnerId,
} from "@volli/shared/cloud";

import type { InboxWorker, JobContext, JobExecutor } from "../cloud-runner/inbox";
import { automationRunIds } from "../cloud-runner/derived-id";
import type { AutomationPromptSupply } from "../automations/run";
import type { AutoTitleRequest } from "../session-runtime/auto-title";
import {
  sessionCreateCommandId,
  StructuredSessionsError,
  type SessionModelOverride,
  type Sessions,
} from "../session-runtime/sessions";
import { hostLogger } from "../log/root";
import { SessionOwnerError } from "./owner";

const log = hostLogger("runner-automation-jobs");

/** The Session services a Run needs, bound once runtime recovery has finished. */
export interface AutomationRunSessions {
  sessions: Pick<Sessions, "create" | "attach">;
  runtime: Pick<
    HostedSessionRuntime,
    "command" | "openNativeBindings" | "reportMessageDeliveryFailure"
  >;
  /** The composer's `/` supply from this runner's checkout of the project. */
  promptSupply(projectId: string): Promise<AutomationPromptSupply>;
  refineAutoTitle?(request: AutoTitleRequest): void;
}

export interface AutomationRunJobOptions {
  runnerId: RunnerId;
  /** The owner-scoped engine: another account's Session reads as absent. */
  engine: Pick<SessionEngine, "getSession">;
  /**
   * The bound Session services, waiting (abortably, renewed by the inbox) for
   * runtime recovery rather than spending one of the job's attempts on it.
   * `null`: they did not arrive in time.
   */
  sessions(signal: AbortSignal): Promise<AutomationRunSessions | null>;
  /** `automationRunner.runContext`, fenced by the job's current lease. */
  runContext(request: AutomationRunContextRequest): Promise<AutomationRunContext>;
  /** The Run's Session exists on this runner (fresh or resumed): what run-attention keys on. */
  onSessionBorn?(input: {
    sessionId: string;
    attendance: AutomationRunAttendance;
    /** No first message yet, so the Session has needed nobody: a known baseline. */
    fresh: boolean;
  }): void;
  newOperationId?(): string;
}

const failed = (code: string, detail: string, retryable = false): JobOutcome => ({
  status: "failed",
  code,
  detail: detail.slice(0, 500),
  retryable,
});
const done = (result: AutomationRunCompletion): JobOutcome => ({ status: "done", result });
const LEASE_LOST = () => failed("lease_lost", "This job no longer holds its lease.");

/**
 * The Session override a Run's Runtime becomes: a pin as the exact model and
 * level, a tier by name, resolved from this runner's settings. Unlike the
 * local Run door (which records an unavailable pin for the attach to refuse),
 * an unavailable model refuses BEFORE anything exists: the backend records
 * the Run failed and tells the armer, wherever they are, and no empty Session
 * in `error` is left on a Mac nobody is looking at.
 */
function runtimeOverride(runtime: NonNullable<ValidAutomationRuntime>): SessionModelOverride {
  if (isAutomationRuntimeTier(runtime)) return { tier: runtime.tier, whenUnavailable: "refuse" };
  return {
    model: { providerId: runtime.providerId, modelId: runtime.modelId },
    reasoningLevel: runtime.reasoningLevel,
    whenUnavailable: "refuse",
  };
}

interface FirstMessage {
  text: string;
  resources: readonly PromptResource[];
  automationName: string | null;
}

export function createAutomationRunExecutor(options: AutomationRunJobOptions): JobExecutor {
  const newOperationId = options.newOperationId ?? randomUUID;

  async function firstMessage(
    ports: AutomationRunSessions,
    projectId: string,
    instructions: string,
    automationName: string | null,
  ): Promise<FirstMessage> {
    let supply: AutomationPromptSupply = { templates: [], skills: [] };
    try {
      supply = await ports.promptSupply(projectId);
    } catch (error) {
      // Composer behaviour: an unreadable supply leaves the literal text.
      log.warn("Automation Run could not read the prompt supply", { projectId, error });
    }
    const expanded = expandCommandInvocation(instructions, supply.templates, supply.skills);
    return { text: expanded.text, resources: expanded.resources, automationName };
  }

  async function deliver(
    ports: AutomationRunSessions,
    sessionId: string,
    payload: AutomationRunJobPayload,
    message: FirstMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const ids = automationRunIds(payload.runId);
    const origin: SessionOrigin = {
      kind: "automation",
      automationRunId: payload.runId,
      automationName: message.automationName,
    };
    const live = ports.runtime
      .openNativeBindings()
      .some((binding) => binding.sessionId === sessionId);
    // A fresh operation per attempt, as the local recovery's reattach: a
    // replayed attach receipt from a process that died proves no live binding.
    const ready =
      live ||
      (
        await ports.sessions.attach({
          operationId: newOperationId(),
          sessionId,
          origin,
        })
      ).state === "ready";
    signal.throwIfAborted();
    const userMessage = {
      id: ids.messageId,
      role: "user" as const,
      parts: [
        { type: "text" as const, text: message.text },
        ...message.resources.map(skillResourcePart),
      ],
    };
    if (!ready) {
      // Nothing can run it yet: hold it in the Session's own queue under the
      // same ids, released at its next ready attach (the Session's Retry).
      await ports.runtime.command({
        origin,
        commandId: ids.messageCommandId,
        sessionId,
        command: { kind: "message.submit", message: userMessage, delivery: "queue" },
      });
      return;
    }
    const pending = ports.runtime.command({
      origin,
      commandId: ids.messageCommandId,
      sessionId,
      // Answered as the turn opens, not when the agent finishes.
      command: { kind: "message.submit", message: userMessage, settle: "opened" },
    });
    try {
      ports.refineAutoTitle?.({
        sessionId,
        firstMessage: message.text,
        heuristicTitle: message.automationName ?? UNBOUND_RUN_LABEL,
        ...(message.automationName === null
          ? {}
          : { automation: { name: message.automationName } }),
      });
    } catch (error) {
      log.warn("Automation Run could not refine its Session title", { sessionId, error });
    }
    const { receipt } = await pending;
    if (receipt?.status === "rejected" || receipt?.status === "unreconciled") {
      // The Session is the Run's record: its failure is Session Attention,
      // which puts it in `error` where run-attention and its dot find it.
      const reason = receipt.detail ?? (receipt.status === "rejected" ? receipt.code : null);
      await ports.runtime.reportMessageDeliveryFailure({
        sessionId,
        commandId: ids.messageCommandId,
        detail: `The Automation Run's first message was not delivered${reason ? `: ${reason}` : "."}`,
      });
    }
  }

  return async (claimed: ClaimedJob, context: JobContext): Promise<JobOutcome> => {
    const { job, lease } = claimed;
    if (job.runnerId !== options.runnerId)
      return failed("not_your_runner", "This machine does not execute another runner's jobs.");
    let payload: AutomationRunJobPayload;
    try {
      const parsed = parseJobPayload("automation.run", job.payload);
      if (!isExecutableAutomationRun(parsed))
        return failed(
          "legacy_automation_run",
          "This arrival was queued without a Run identity and cannot start.",
        );
      payload = parsed;
    } catch (error) {
      if (error instanceof InvalidJobPayloadError)
        return failed("invalid_job_payload", "This Automation Run's payload is invalid.");
      throw error;
    }
    if (payload.ticketId !== job.ticketId)
      return failed("invalid_job_payload", "Ticket identity does not match the job.");
    if (context.signal.aborted) return LEASE_LOST();
    const ports = await options.sessions(context.signal);
    if (context.signal.aborted) return LEASE_LOST();
    if (ports === null)
      return failed("runtime_unavailable", "This runner's Session runtime is not ready.", true);

    const ids = automationRunIds(payload.runId);
    const sessionId = payload.sessionId;
    const existing = await options.engine.getSession({ sessionId });
    if (
      existing !== null &&
      !existing.commands.some((command) => command.id === sessionCreateCommandId(ids.operationId))
    )
      return failed("session_conflict", "This Run's Session id belongs to another Session.");
    const started = (model: ResolvedAutomationModel) =>
      done({ kind: "started", sessionId, model, attendance: payload.attendance });
    if (existing !== null && existing.commands.some((c) => c.id === ids.messageCommandId)) {
      // Born and delivered before a crash (a birth records its model before
      // `create` returns): only the completion is owed.
      if (existing.modelSelection === null)
        return failed("model_unrecorded", "This Run's Session recorded no model.");
      options.onSessionBorn?.({ sessionId, attendance: payload.attendance, fresh: false });
      return started(existing.modelSelection);
    }

    const facts = await options.runContext({
      jobId: job.id,
      bootId: lease.bootId,
      attempt: lease.attempt,
    });
    if (facts.kind !== "ready") return LEASE_LOST();
    if (facts.projectId !== job.projectId)
      return failed("context_mismatch", "Volli Cloud answered this Run for another project.");
    // A Session that exists is the commitment: the target's state (its own
    // agent may already have moved the ticket) no longer decides, so only
    // what the Run starts with is read again.
    const start =
      existing === null
        ? automationRunVerdict({ payload, context: facts, runnerId: options.runnerId })
        : automationRunStart({ payload, context: facts });
    if (start.kind === "abandon") return done({ kind: "abandoned", reason: start.reason });
    if (start.kind === "refuse")
      return start.code === "context_mismatch"
        ? failed(start.code, start.detail)
        : done({ kind: "refused", code: start.code, detail: start.detail });
    const message = await firstMessage(
      ports,
      start.projectId,
      start.instructions,
      start.automationName,
    );
    // Not a fence (a renewal that cannot reach the backend still answers
    // true): a lease already taken away stops here rather than minting a
    // Session for nothing. Exactly-once is the derived ids' job.
    if (!(await context.renew())) return LEASE_LOST();
    if (context.signal.aborted) return LEASE_LOST();
    // Noted before the Session can exist, so an unattended Run whose attach
    // fails is announced even across a crash. A Session with no first message
    // has needed nobody yet: its first fold is an edge from a known baseline.
    options.onSessionBorn?.({ sessionId, attendance: payload.attendance, fresh: true });
    let model: ResolvedAutomationModel;
    try {
      // A resumed Run replays the same create: the facade finishes a birth a
      // crash cut short (model, skills, grants, tool surface) under the same
      // operation id, and answers the model the Session recorded.
      const created = await ports.sessions.create({
        operationId: ids.operationId,
        requestedSessionId: sessionId,
        projectId: start.projectId,
        ticketId: start.ticketId,
        // A ticket Run opens a Ticket Session; a schedule's opens a Board Session.
        role: roleImpliedByTicket(start.ticketId),
        title: start.automationName ?? UNBOUND_RUN_LABEL,
        actor: { kind: "automation" },
        origin: {
          kind: "automation",
          automationRunId: payload.runId,
          automationName: start.automationName,
        },
        // Inherit lets a decision model choose from the Instructions (VC-432).
        ...(start.runtime === null
          ? { autoSelect: { request: message.text } }
          : { modelOverride: runtimeOverride(start.runtime) }),
      });
      if (created.sessionId !== sessionId)
        return failed("session_conflict", "The Run's Session was born under another id.");
      model = created.model;
    } catch (error) {
      if (error instanceof StructuredSessionsError)
        return done({ kind: "refused", code: error.code, detail: error.message });
      throw error;
    }
    await deliver(ports, sessionId, payload, message, context.signal);
    return started(model);
  };
}

/** Registers the executor on the runner's inbox; a throw is a retryable attempt, logged. */
export function registerAutomationRunJob(
  worker: Pick<InboxWorker, "register">,
  options: AutomationRunJobOptions,
): void {
  const execute = createAutomationRunExecutor(options);
  worker.register("automation.run", async (claimed, context) => {
    try {
      return await execute(claimed, context);
    } catch (error) {
      log.warn("Automation Run job failed", { jobId: claimed.job.id, error });
      // Another account's Session under this id: never this runner's to retry.
      if (error instanceof SessionOwnerError)
        return failed("not_your_runner", "This Session does not belong to this runner's owner.");
      return failed(
        "automation_run_failed",
        "This Automation Run could not start on this runner. See this runner's log.",
        !context.signal.aborted,
      );
    }
  });
}

/** The job kind this module executes: what the runner's capability report advertises. */
export const AUTOMATION_RUN_CAPABILITY = "automation.run" satisfies JobKind;
