/** Runner-local Session commands delivered by the durable inbox. */
import type {
  HostedSessionRuntime,
  SessionEngine,
  TranscriptArtifactStore,
  SessionClientCommand,
} from "@volli/session-engine";
import { decodeSessionCommandIntent, LOCAL_RUNNER, type SessionOrigin } from "@volli/shared";
import {
  parseJobPayload,
  SESSION_INTERRUPT_FORMAT,
  type ClaimedJob,
  type JobOutcome,
  type JobPayload,
} from "@volli/shared/cloud";
import type { InboxWorker, JobExecutor } from "../cloud-runner/inbox";
import { hostLogger } from "../log/root";

const log = hostLogger("runner-session-jobs");

const failed = (code: string, detail: string): JobOutcome => ({
  status: "failed",
  code,
  detail,
  retryable: false,
});

/** Every Session executor, including later follow-up/notice registrations, crosses the same owner gate. */
export function ownerGuardedInbox(
  worker: Pick<InboxWorker, "register">,
  input: {
    engine: SessionEngine;
    ownerUserId: string;
    owns(sessionId: string): boolean;
  },
): Pick<InboxWorker, "register"> {
  return {
    register(kind, execute) {
      worker.register(kind, async (claimed, context) => {
        try {
          if (context.signal.aborted)
            return failed("lease_lost", "This job no longer holds its lease.");
          if (kind.startsWith("session.")) {
            const id = claimed.job.sessionId;
            const session =
              id === null ? null : await input.engine.getBaseSession({ sessionId: id });
            if (
              id === null ||
              !input.owns(id) ||
              session === null ||
              (session.ownerUserId !== undefined && session.ownerUserId !== input.ownerUserId)
            )
              return failed(
                "not_your_runner",
                "This Session does not belong to this runner's owner.",
              );
          }
          return await execute(claimed, context);
        } catch (error) {
          log.warn("Session job failed", { jobId: claimed.job.id, error });
          return {
            status: "failed",
            code: "executor_error",
            detail: "This Session job could not run on this runner. See this runner's log.",
            retryable: true,
          };
        }
      });
    },
  };
}

export function registerSessionCommandJob(
  worker: Pick<InboxWorker, "register">,
  input: {
    engine: SessionEngine;
    runtime(): HostedSessionRuntime | null;
    artifacts(): TranscriptArtifactStore | null;
  },
): void {
  const execute: JobExecutor = async (claimed: ClaimedJob, context) => {
    context.signal.throwIfAborted();
    const { job } = claimed;
    if (job.sessionId === null || job.commandId === null)
      return failed("invalid_job_payload", "A Session command needs its Session and command ids.");
    let payload: JobPayload<"session.command">;
    let intent: ReturnType<typeof decodeSessionCommandIntent> | null = null;
    try {
      payload = parseJobPayload("session.command", job.payload);
      if (payload.format !== SESSION_INTERRUPT_FORMAT)
        intent = decodeSessionCommandIntent(JSON.parse(payload.intent), "runner job intent");
    } catch {
      return failed("invalid_job_payload", "This Session command is malformed.");
    }
    const runtime = input.runtime();
    if (runtime === null)
      return {
        status: "failed",
        code: "runtime_unavailable",
        detail: "The Session runtime is not ready.",
        retryable: true,
      };
    if (payload.format === SESSION_INTERRUPT_FORMAT) {
      await runtime.command({
        sessionId: job.sessionId,
        commandId: job.commandId,
        command: { kind: "executor.interrupt" },
      });
      return { status: "done", result: null };
    }
    if (intent === null || intent.kind === "session.create")
      return failed("invalid_job_payload", "A Session command cannot create a Session.");
    const origin: SessionOrigin =
      job.createdBy.kind === "agent"
        ? { kind: "session", sessionId: job.createdBy.sessionId }
        : { kind: "user" };
    let command: Exclude<SessionClientCommand, { kind: "session.create" }>;
    switch (intent.kind) {
      case "message.submit": {
        const artifacts = input.artifacts();
        if (artifacts === null)
          return failed("transcript_unavailable", "This runner cannot read the message body.");
        const artifact = await artifacts.read(intent.reference);
        command = { kind: "message.submit", message: artifact.message, settle: "opened" };
        break;
      }
      case "interaction.resolve":
        command = {
          kind: intent.kind,
          interactionId: intent.interactionId,
          resolution: intent.resolution,
        };
        break;
      case "session.stop":
        command = {
          kind: intent.kind,
          ...(intent.reason === null ? {} : { reason: intent.reason }),
        };
        break;
      case "executor.stop":
        command = { kind: "adapter.release", attachmentId: intent.attachmentId };
        break;
      case "executor.start":
        command = { kind: "adapter.attach", continuity: intent.continuity };
        break;
      case "session.archive":
      case "session.retitle":
      case "session.signal": {
        const result = await input.engine.submit({
          sessionId: job.sessionId,
          commandId: job.commandId,
          intent,
          provenance: {
            source: { kind: "system", id: "runner-inbox", detail: { sessionOrigin: origin } },
            venue: LOCAL_RUNNER,
          },
        });
        if (result.receipt?.status === "rejected")
          return failed("command_refused", "The Session refused this command.");
        return { status: "done", result: null };
      }
      default:
        command = intent;
    }
    context.signal.throwIfAborted();
    const result = await runtime.command({
      sessionId: job.sessionId,
      commandId: job.commandId,
      command,
      origin,
    });
    if (result.receipt?.status === "rejected")
      return failed("command_refused", "The Session refused this command.");
    return { status: "done", result: null };
  };
  worker.register("session.command", execute);
}
