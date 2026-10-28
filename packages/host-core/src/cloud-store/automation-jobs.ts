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
 *     unavailable model completes `refused` and nothing exists.
 *  4. Attach and deliver the first message under derived ids, answered when
 *     its turn opens (a held message when the attach is not ready).
 *  5. Complete `started` with the Session and its resolved model.
 *
 * **Crash safety.** Every durable step is keyed by an id derived from the
 * producer-minted `runId` (`automationRunIds`), so a re-leased job lands on
 * the same Session and the same first message. A Session that already exists
 * is the commitment: the re-check is not asked again (the Run's own agent may
 * well have moved the ticket since), only the steps still owed are done. The
 * inbox's job journal replays a recorded outcome without running again.
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
  type SessionOrigin,
  type ValidAutomationRuntime,
} from "@volli/shared";
import {
  automationRunVerdict,
  InvalidJobPayloadError,
  isExecutableAutomationRun,
  parseJobPayload,
  type AutomationRunCompletion,
  type AutomationRunContext,
  type AutomationRunContextRequest,
  type AutomationRunJobPayload,
  type ClaimedJob,
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
  runnerId: string;
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
    /** Minted by this attempt, rather than found from an earlier one. */
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
    const started = (model: { providerId: string; modelId: string; reasoningLevel: string }) =>
      done({ kind: "started", sessionId, model, attendance: payload.attendance });
    if (existing !== null && existing.commands.some((c) => c.id === ids.messageCommandId)) {
      // Started and delivered before a crash: only the completion is owed.
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
    if (existing !== null) {
      // Born before a crash, its first message still owed. The Session is the
      // commitment: the ticket may have moved since (its own agent may have
      // moved it), so only the Instructions are read again.
      if (facts.payload.runId !== payload.runId)
        return failed(
          "context_mismatch",
          "Volli Cloud answered this Run's context for another Run.",
        );
      const automation = facts.automation;
      if (
        payload.automationId !== null &&
        (automation === null ||
          automation.deletedAt !== null ||
          automation.id !== payload.automationId)
      )
        return done({ kind: "abandoned", reason: "gone" });
      if (existing.modelSelection === null)
        return failed("model_unrecorded", "This Run's Session recorded no model.");
      const message = await firstMessage(
        ports,
        facts.projectId,
        payload.automationId === null
          ? (payload as Extract<AutomationRunJobPayload, { instructions: string }>).instructions
          : automation!.instructions,
        payload.automationId === null ? null : automation!.name,
      );
      options.onSessionBorn?.({ sessionId, attendance: payload.attendance, fresh: false });
      await deliver(ports, sessionId, payload, message, context.signal);
      return started(existing.modelSelection);
    }

    const verdict = automationRunVerdict({
      payload,
      context: facts,
      runnerId: options.runnerId as RunnerId,
    });
    if (verdict.kind === "abandon") return done({ kind: "abandoned", reason: verdict.reason });
    if (verdict.kind === "refuse")
      return verdict.code === "context_mismatch"
        ? failed(verdict.code, verdict.detail)
        : done({ kind: "refused", code: verdict.code, detail: verdict.detail });
    const message = await firstMessage(
      ports,
      verdict.projectId,
      verdict.instructions,
      verdict.automationName,
    );
    // The fence before the durable start: a lease taken away while the
    // context was read must not mint a Session another attempt also will.
    if (!(await context.renew())) return LEASE_LOST();
    if (context.signal.aborted) return LEASE_LOST();
    let model: { providerId: string; modelId: string; reasoningLevel: string };
    try {
      const created = await ports.sessions.create({
        operationId: ids.operationId,
        requestedSessionId: sessionId,
        projectId: verdict.projectId,
        ticketId: verdict.ticketId,
        // A ticket Run opens a Ticket Session; a schedule's opens a Board Session.
        role: roleImpliedByTicket(verdict.ticketId),
        title: verdict.automationName ?? UNBOUND_RUN_LABEL,
        actor: { kind: "automation" },
        origin: {
          kind: "automation",
          automationRunId: payload.runId,
          automationName: verdict.automationName,
        },
        // Inherit lets a decision model choose from the Instructions (VC-432).
        ...(verdict.runtime === null
          ? { autoSelect: { request: message.text } }
          : { modelOverride: runtimeOverride(verdict.runtime) }),
      });
      if (created.sessionId !== sessionId)
        return failed("session_conflict", "The Run's Session was born under another id.");
      model = created.model;
    } catch (error) {
      if (error instanceof StructuredSessionsError)
        return done({ kind: "refused", code: error.code, detail: error.message });
      throw error;
    }
    options.onSessionBorn?.({ sessionId, attendance: payload.attendance, fresh: true });
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

/** The job kinds this module executes: what the runner's capability report advertises. */
export const AUTOMATION_RUN_CAPABILITY = "automation.run";
