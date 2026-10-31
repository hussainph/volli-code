/**
 * The runner's `session.start` executor (C2): a person's Session, started on
 * this runner from a client that may be on another machine ("Start on
 * hetzner-1" in the composer). Mac runners execute it too, so a Session can
 * be started on one Mac from another.
 *
 * Volli Cloud minted the Session id and staged the first message's body
 * (`sessionStarts.startOn`); nothing about the Session exists anywhere yet.
 * This executor's whole job, per claimed job:
 *
 *  1. Re-check what the start depends on against fresh backend facts, read
 *     under this job's current lease (`sessionStarts.startContext`): the
 *     project is still the owner's to work in, the ticket still live. The
 *     staged first message comes back in the same read: the claim-fenced
 *     `transcripts.commandArtifact` cannot answer for a Session no runner
 *     has claimed yet.
 *  2. Write the body into this runner's artifact store, which re-derives its
 *     reference from the canonical bytes; only the body the job names is
 *     delivered.
 *  3. Mint the Session (`Sessions.create`) under the backend-minted id and an
 *     operation id derived from the job, with the pinned model when the job
 *     names one. A model this runner cannot serve refuses BEFORE anything
 *     exists, in words that say where to sign in.
 *  4. Attach and deliver the first message under the job's command id (the
 *     command the backend staged the body for), answered when its turn opens
 *     (held in the Session's queue when the attach is not ready).
 *  5. Complete `started`. The Session's first accepted fact claims it for
 *     this runner, so every later command reaches it here.
 *
 * **Crash safety.** The Session id comes from the job and the operation id is
 * derived from the job's id (FROZEN: {@link sessionStartOperationId}), so a
 * re-leased job lands on the same Session and the same first message. A
 * Session that already exists is the commitment: the ticket is not re-checked
 * (its own agent may have moved it), the birth is replayed under its
 * operation id, and the first message is sent if it is still owed.
 */
import { randomUUID } from "node:crypto";

import type {
  HostedSessionRuntime,
  SessionEngine,
  SessionTranscriptArtifact,
  TranscriptArtifactStore,
} from "@volli/session-engine";
import {
  autoTitleFromMessage,
  cloudMessageText,
  isCommandIntentConflict,
  roleImpliedByTicket,
  type ModelSelection,
  type SessionOrigin,
} from "@volli/shared";
import {
  parseJobPayload,
  SESSION_START_CAPABILITY,
  type ClaimedJob,
  type JobKind,
  type JobOutcome,
  type RunnerId,
  type SessionStartContext,
  type SessionStartJobPayload,
} from "@volli/shared/cloud";

import type { InboxWorker, JobContext, JobExecutor } from "../cloud-runner/inbox";
import type { AutoTitleRequest } from "../session-runtime/auto-title";
import {
  sessionCreateCommandId,
  StructuredSessionsError,
  type SessionModelOverride,
  type Sessions,
} from "../session-runtime/sessions";
import { hostLogger } from "../log/root";
import { readMessageBody } from "./command-artifact";
import { SessionOwnerError } from "./owner";

const log = hostLogger("runner-session-start-jobs");

/** The Session services a start needs, bound once runtime recovery has finished. */
export interface SessionStartSessions {
  sessions: Pick<Sessions, "create" | "attach">;
  runtime: Pick<
    HostedSessionRuntime,
    "command" | "openNativeBindings" | "reportMessageDeliveryFailure"
  >;
  refineAutoTitle?(request: AutoTitleRequest): void;
}

export interface SessionStartJobOptions {
  runnerId: RunnerId;
  /** The owner-scoped engine: another account's Session reads as absent or throws. */
  engine: Pick<SessionEngine, "getSession">;
  /**
   * The bound Session services, waiting (abortably, renewed by the inbox) for
   * runtime recovery. `null`: they did not arrive in time.
   */
  sessions(signal: AbortSignal): Promise<SessionStartSessions | null>;
  /** This runner's transcript artifact store, once the runtime is bound. */
  artifacts(): TranscriptArtifactStore | null;
  /** `sessionStarts.startContext`, fenced by the job's current lease. */
  startContext(request: {
    jobId: string;
    bootId: string;
    attempt: number;
  }): Promise<SessionStartContext>;
  /**
   * How a person signs a provider in on this runner, as one instruction
   * (`run \`volli-runner login anthropic\``); `null` or absent says nothing more.
   */
  signInHint?(providerId: string): string | null;
  newOperationId?(): string;
}

/**
 * The operation id a start's `Sessions.create` runs under. DURABLE: a
 * re-leased job must replay the same birth (its create command is
 * `<operationId>:create`), never mint a second one.
 */
export function sessionStartOperationId(jobId: string): string {
  return `session-start:${jobId}`;
}

const failed = (code: string, detail: string, retryable = false): JobOutcome => ({
  status: "failed",
  code,
  detail: detail.slice(0, 500),
  retryable,
});
const LEASE_LOST = () => failed("lease_lost", "This job no longer holds its lease.");
const started = (sessionId: string, model: ModelSelection): JobOutcome => ({
  status: "done",
  result: { kind: "started", sessionId, model },
});

/** The job, checked: its payload, and the ids it must agree with. */
function readJob(
  claimed: ClaimedJob,
): { payload: SessionStartJobPayload; sessionId: string } | JobOutcome {
  const { job } = claimed;
  let payload: SessionStartJobPayload;
  try {
    payload = parseJobPayload("session.start", job.payload);
  } catch {
    // The codec throws only `InvalidJobPayloadError`: corruption, never retried.
    return failed("invalid_job_payload", "This Session start's payload is invalid.");
  }
  if (
    job.sessionId === null ||
    job.commandId !== payload.firstMessage.commandId ||
    job.id !== payload.firstMessage.commandId ||
    job.projectId !== payload.projectId ||
    job.ticketId !== payload.ticketId
  )
    return failed("invalid_job_payload", "This Session start names another Session or place.");
  return { payload, sessionId: job.sessionId };
}

/** A pinned model as the override `Sessions.create` refuses before anything exists. */
function modelOverride(model: NonNullable<SessionStartJobPayload["model"]>): SessionModelOverride {
  return {
    model: { providerId: model.providerId, modelId: model.modelId },
    ...(model.reasoningLevel === null ? {} : { reasoningLevel: model.reasoningLevel }),
    whenUnavailable: "refuse",
  };
}

/**
 * The first message, sent now; `null` when an earlier attempt already held
 * it in the Session's queue (its command id belongs to the follow-up
 * ledger, which refuses a second, direct send of it).
 */
async function submit(
  ports: SessionStartSessions,
  request: Parameters<SessionStartSessions["runtime"]["command"]>[0],
): Promise<Awaited<ReturnType<SessionStartSessions["runtime"]["command"]>> | null> {
  try {
    return await ports.runtime.command(request);
  } catch (error) {
    if (isCommandIntentConflict(error)) return null;
    throw error;
  }
}

export function createSessionStartExecutor(options: SessionStartJobOptions): JobExecutor {
  const newOperationId = options.newOperationId ?? randomUUID;

  /** A model this runner cannot serve, in words that say where to fix it. */
  function unavailable(
    model: NonNullable<SessionStartJobPayload["model"]>,
    runnerName: string,
    error: StructuredSessionsError,
  ): JobOutcome {
    // `Sessions.create` words a provider that needs sign-in this way.
    const signIn = error.message.startsWith("Sign in to ");
    const hint = options.signInHint?.(model.providerId) ?? null;
    const what = signIn
      ? `${model.providerId} isn't signed in on ${runnerName}`
      : `${model.providerId}/${model.modelId} isn't available on ${runnerName}`;
    return failed("model_unavailable", hint === null ? `${what}.` : `${what} — ${hint}.`);
  }

  async function deliver(
    ports: SessionStartSessions,
    sessionId: string,
    commandId: string,
    message: SessionTranscriptArtifact["message"],
    title: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    const origin: SessionOrigin = { kind: "user" };
    const live = ports.runtime
      .openNativeBindings()
      .some((binding) => binding.sessionId === sessionId);
    // A fresh operation per attempt: a replayed attach receipt from a process
    // that died proves no live binding.
    const ready =
      live ||
      (await ports.sessions.attach({ operationId: newOperationId(), sessionId, origin })).state ===
        "ready";
    signal.throwIfAborted();
    if (!ready) {
      // Nothing can run it yet: held in the Session's own queue under the
      // same command id, released at its next ready attach.
      await ports.runtime.command({
        origin,
        commandId,
        sessionId,
        command: { kind: "message.submit", message, delivery: "queue" },
      });
      return;
    }
    const pending = submit(ports, {
      origin,
      commandId,
      sessionId,
      // Answered as the turn opens, not when the agent finishes.
      command: { kind: "message.submit", message, settle: "opened" },
    });
    if (title !== null) {
      try {
        ports.refineAutoTitle?.({
          sessionId,
          firstMessage: cloudMessageText(message),
          heuristicTitle: title,
        });
      } catch (error) {
        log.warn("Session start could not refine its title", { sessionId, error });
      }
    }
    const result = await pending;
    // Already held in the Session's queue by an earlier attempt: it is the
    // queue's to deliver now, and this start is done.
    if (result === null) return;
    const { receipt } = result;
    if (receipt?.status === "rejected" || receipt?.status === "unreconciled") {
      const reason = receipt.detail ?? (receipt.status === "rejected" ? receipt.code : null);
      await ports.runtime.reportMessageDeliveryFailure({
        sessionId,
        commandId,
        detail: `The first message was not delivered${reason ? `: ${reason}` : "."}`,
      });
    }
  }

  return async (claimed: ClaimedJob, context: JobContext): Promise<JobOutcome> => {
    const { job, lease } = claimed;
    if (job.runnerId !== options.runnerId)
      return failed("not_your_runner", "This machine does not execute another runner's jobs.");
    const read = readJob(claimed);
    if ("status" in read) return read;
    const { payload, sessionId } = read;
    const commandId = payload.firstMessage.commandId;
    if (context.signal.aborted) return LEASE_LOST();
    const ports = await options.sessions(context.signal);
    if (context.signal.aborted) return LEASE_LOST();
    if (ports === null)
      return failed("runtime_unavailable", "This runner's Session runtime is not ready.", true);

    const operationId = sessionStartOperationId(job.id);
    const existing = await options.engine.getSession({ sessionId });
    if (
      existing !== null &&
      !existing.commands.some((command) => command.id === sessionCreateCommandId(operationId))
    )
      return failed("session_conflict", "This start's Session id belongs to another Session.");
    if (existing !== null && existing.commands.some((command) => command.id === commandId)) {
      // Born and delivered before a crash: only the completion is owed.
      if (existing.modelSelection === null)
        return failed("model_unrecorded", "This start's Session recorded no model.");
      return started(sessionId, existing.modelSelection);
    }

    const facts = await options.startContext({
      jobId: job.id,
      bootId: lease.bootId,
      attempt: lease.attempt,
    });
    if (facts.kind === "unavailable")
      return facts.reason === "lease_lost"
        ? LEASE_LOST()
        : failed("project_unavailable", "This project is no longer one you can work in.");
    if (facts.projectId !== payload.projectId)
      return failed("context_mismatch", "Volli Cloud answered this start for another project.");
    // A Session that exists is the commitment: its ticket no longer decides.
    if (
      existing === null &&
      payload.ticketId !== null &&
      (facts.ticket === null || facts.ticket.id !== payload.ticketId || !facts.ticket.live)
    )
      return failed("ticket_unavailable", "This ticket was archived or deleted before it started.");

    const artifacts = options.artifacts();
    if (artifacts === null)
      return failed(
        "transcript_unavailable",
        "This runner cannot store the first message yet.",
        true,
      );
    const reference = payload.firstMessage.body;
    const body = await readMessageBody(
      artifacts,
      async () => facts.body,
      sessionId,
      reference,
    ).catch((error: unknown) => {
      // Nothing staged and nothing here: final. A store that cannot write is retried.
      if (facts.body === null) return null;
      throw error;
    });
    if (body === null)
      return failed("message_unavailable", "The first message is no longer staged.");
    if ("outcome" in body) return body.outcome;
    const message = body.artifact.message;
    if (message.role !== "user")
      return failed("invalid_artifact", "The first message is not a person's message.");
    const text = cloudMessageText(message);
    const title = payload.title ?? autoTitleFromMessage(text);

    // Not a fence (a renewal that cannot reach the backend still answers
    // true): a lease already taken away stops here rather than minting a
    // Session for nothing. Exactly-once is the derived ids' job.
    if (!(await context.renew())) return LEASE_LOST();
    if (context.signal.aborted) return LEASE_LOST();
    let model: ModelSelection;
    try {
      // A resumed start replays the same create: the facade finishes a birth
      // a crash cut short under the same operation id, and answers the model
      // the Session recorded.
      const created = await ports.sessions.create({
        operationId,
        requestedSessionId: sessionId,
        projectId: payload.projectId,
        ticketId: payload.ticketId,
        role: roleImpliedByTicket(payload.ticketId),
        title,
        actor: { kind: "user" },
        origin: { kind: "user" },
        ...(payload.model !== null
          ? { modelOverride: modelOverride(payload.model) }
          : text.trim() === ""
            ? {}
            : { autoSelect: { request: text } }),
      });
      if (created.sessionId !== sessionId)
        return failed("session_conflict", "The Session was born under another id.");
      model = created.model;
    } catch (error) {
      if (error instanceof StructuredSessionsError) {
        if (error.code === "MODEL_UNAVAILABLE" && payload.model !== null)
          return unavailable(payload.model, facts.runnerName, error);
        return failed(error.code.toLowerCase(), `${facts.runnerName}: ${error.message}`);
      }
      throw error;
    }
    await deliver(ports, sessionId, commandId, message, title, context.signal);
    return started(sessionId, model);
  };
}

/**
 * Registers the executor on the runner's inbox, NOT behind the owner gate
 * every other `session.*` kind crosses: that gate refuses a Session this
 * runner does not hold yet, and a start's Session is born here. The executor
 * runs its own checks; a throw is a retryable attempt, logged.
 */
export function registerSessionStartJob(
  worker: Pick<InboxWorker, "register">,
  options: SessionStartJobOptions,
): void {
  const execute = createSessionStartExecutor(options);
  worker.register("session.start", async (claimed, context) => {
    try {
      return await execute(claimed, context);
    } catch (error) {
      log.warn("Session start job failed", { jobId: claimed.job.id, error });
      // Another account's Session under this id: never this runner's to retry.
      if (error instanceof SessionOwnerError)
        return failed("not_your_runner", "This Session does not belong to this runner's owner.");
      return failed(
        "session_start_failed",
        "This Session could not start on this runner. See this runner's log.",
        !context.signal.aborted,
      );
    }
  });
}

/** The job kind this module executes: what the runner's capability report advertises. */
export const SESSION_START_JOB_CAPABILITY = SESSION_START_CAPABILITY satisfies JobKind;
