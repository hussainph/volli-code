/** Follow-up intake and runner-held edits/cancels share the existing runtime queue. */
import { SessionRuntimeConflictError } from "@volli/session-engine";
import { QueueRevisionConflictError } from "@volli/shared";
import type {
  HostedSessionRuntime,
  SessionClientCommand,
  TranscriptArtifactStore,
} from "@volli/session-engine";
import {
  decodeCloudSessionIntent,
  isFollowUpIntent,
  type ClaimedJob,
  type FollowUpIntent,
  type JobOutcome,
} from "@volli/shared/cloud";
import type { JobContext } from "../cloud-runner/inbox";
import { readMessageBody, type CommandArtifactSource } from "./command-artifact";

export interface FollowUpJobInput {
  runtime(): HostedSessionRuntime | null;
  artifacts(): TranscriptArtifactStore | null;
  commandArtifact?: CommandArtifactSource;
  publish(sessionId: string): Promise<void>;
}
const failed = (code: string, detail: string, retryable = false): JobOutcome => ({
  status: "failed",
  code,
  detail,
  retryable,
});
/** Null means an ordinary durable Session command, handled by the existing executor. */
export async function executeFollowUpJob(
  claimed: ClaimedJob,
  context: JobContext,
  input: FollowUpJobInput,
): Promise<JobOutcome | null> {
  const { job } = claimed;
  if (job.sessionId === null || job.commandId === null)
    return failed("invalid_job_payload", "A follow-up needs Session and command ids.");
  let intent: FollowUpIntent;
  try {
    const decoded = decodeCloudSessionIntent(
      JSON.parse((job.payload as { intent: string }).intent),
    );
    if (!isFollowUpIntent(decoded))
      return job.kind === "session.followUp"
        ? failed("invalid_job_payload", "A follow-up needs a queued message intent.")
        : null;
    intent = decoded;
    if (
      job.kind === "session.followUp" &&
      (intent.kind !== "message.submit" || intent.delivery !== "queue")
    )
      return failed("invalid_job_payload", "A follow-up intake must queue a message.");
  } catch {
    return failed("invalid_job_payload", "This follow-up intent is malformed.");
  }
  const runtime = input.runtime();
  if (runtime === null)
    return failed("runtime_unavailable", "The Session runtime is not ready.", true);
  let command: Exclude<SessionClientCommand, { kind: "session.create" }>;
  if (intent.kind === "message.cancel") command = intent;
  else if (intent.kind === "message.submit" && intent.delivery === "steer") {
    const queued = (await runtime.projection({ sessionId: job.sessionId })).projection.queue?.find(
      (item) => item.id === intent.messageId,
    );
    if (queued === undefined)
      return {
        status: "done",
        result: { receipt: { status: "rejected", code: "message_not_queued", detail: null } },
      };
    command = {
      kind: "message.submit",
      message: queued.message,
      delivery: "steer",
      settle: "opened",
    };
  } else {
    const artifacts = input.artifacts();
    if (artifacts === null)
      return failed("transcript_unavailable", "This runner cannot read the message body.", true);
    const body = await readMessageBody(
      artifacts,
      input.commandArtifact,
      job.sessionId,
      intent.reference,
    );
    if ("outcome" in body) return body.outcome;
    const { artifact } = body;
    if (artifact.message.id !== intent.messageId)
      return failed("artifact_mismatch", "The body names another message.");
    command =
      intent.kind === "message.edit"
        ? {
            kind: "message.edit",
            messageId: intent.messageId,
            message: artifact.message,
            ...(intent.expectedRevision === undefined
              ? {}
              : { expectedRevision: intent.expectedRevision }),
          }
        : {
            kind: "message.submit",
            message: artifact.message,
            delivery: intent.delivery,
            settle: "opened",
          };
  }
  context.signal.throwIfAborted();
  let result: Awaited<ReturnType<HostedSessionRuntime["command"]>>;
  try {
    result = await runtime.command({
      sessionId: job.sessionId,
      commandId: job.commandId,
      command,
      origin:
        job.createdBy.kind === "agent"
          ? { kind: "session", sessionId: job.createdBy.sessionId }
          : { kind: "user" },
    });
  } catch (error) {
    if (
      error instanceof QueueRevisionConflictError ||
      error instanceof SessionRuntimeConflictError
    ) {
      await input.publish(job.sessionId);
      return {
        status: "done",
        result: {
          receipt: {
            status: "rejected",
            code:
              error instanceof QueueRevisionConflictError
                ? "queue_revision_conflict"
                : "command_refused",
            detail: error.message,
          },
        },
      };
    }
    throw error;
  }
  // This await is the ordering barrier: complete must never hide intake before
  // the mirror includes it (or already shows the item released).
  await input.publish(job.sessionId);
  const receipt = result.receipt;
  return {
    status: "done",
    result: {
      receipt:
        receipt === null
          ? null
          : {
              status: receipt.status,
              code: receipt.status === "rejected" ? receipt.code : null,
              detail: receipt.status === "rejected" ? receipt.detail : null,
            },
    },
  };
}
