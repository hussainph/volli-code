/**
 * Runner-local Session commands delivered by the durable inbox.
 *
 * A `session.command` job is a person's command for their Session, or an
 * agent's for a Session it supervises (the backend checked the scope:
 * `convex/functions/lib/sessionCommands.ts`). What the runner adds:
 *
 * - **A message body it never wrote.** A `message.submit` names its body by
 *   reference. Sent from another runner, the body is not in this runner's
 *   artifact store; the backend staged it with the command, so the runner
 *   reads it back (`commandArtifact`, the claim-fenced
 *   `transcripts.commandArtifact`) and writes it to its own store, which
 *   re-verifies the digest, before delivery.
 * - **An agent's send is a steer.** As `session_send` is locally
 *   (`supervise-session.ts`): delivered into a turn in flight now rather than
 *   after it, settled when the turn opens. The durable intent carries no
 *   delivery (it is transport detail), so the job's `createdBy` decides it;
 *   a person's command keeps the runtime's default.
 * - **An agent's stop is the agent's.** The three acts of a stop (record,
 *   interrupt, release: `stopResolvedSession`) under the job's command id,
 *   attributed to the calling Session exactly as the local `session_stop`
 *   records it. A person's stop goes through the runtime's own stop, which
 *   records the person.
 */
import {
  SuperviseSessionError,
  stopResolvedSession,
  type HostedSessionRuntime,
  type SessionEngine,
  type SessionTranscriptArtifact,
  type TranscriptArtifactStore,
  type SessionClientCommand,
} from "@volli/session-engine";
import {
  decodeSessionCommandIntent,
  LOCAL_RUNNER,
  shortSessionId,
  type SessionCommandIntent,
  type SessionOrigin,
  type TranscriptReference,
} from "@volli/shared";
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

/**
 * Reads a staged message body from the backend for a Session this runner
 * holds: `transcripts.commandArtifact({ sessionId, generation, digest })`
 * with this runner's token and claim generation, answering its `body`, or
 * `null` when the backend has none staged. A transport failure throws (the
 * job retries).
 */
export type CommandArtifactSource = (input: {
  sessionId: string;
  digest: string;
}) => Promise<string | null>;

export interface SessionCommandJobInput {
  engine: SessionEngine;
  runtime(): HostedSessionRuntime | null;
  artifacts(): TranscriptArtifactStore | null;
  /** Hydrates a body this runner never wrote; absent, a missing body fails as before. */
  commandArtifact?: CommandArtifactSource;
}

type Hydrated = { artifact: SessionTranscriptArtifact } | { outcome: JobOutcome };

/** The referenced body: from this runner's store, else staged by the backend and written here first. */
async function readMessageBody(
  artifacts: TranscriptArtifactStore,
  source: CommandArtifactSource | undefined,
  sessionId: string,
  reference: TranscriptReference,
): Promise<Hydrated> {
  try {
    return { artifact: await artifacts.read(reference) };
  } catch (error) {
    if (source === undefined || reference.digest === null) throw error;
    const body = await source({ sessionId, digest: reference.digest });
    // Nothing staged: the local failure is the one to report.
    if (body === null) throw error;
    let parsed: SessionTranscriptArtifact;
    try {
      parsed = JSON.parse(body) as SessionTranscriptArtifact;
    } catch {
      return { outcome: failed("invalid_artifact", "The staged message body is unreadable.") };
    }
    // The store derives the reference from the canonical bytes it verified.
    const written = await artifacts.write(parsed);
    if (written.id !== reference.id) {
      return {
        outcome: failed(
          "artifact_mismatch",
          "The staged message body does not match its reference.",
        ),
      };
    }
    return { artifact: await artifacts.read(reference) };
  }
}

/** An agent's stop of a Session this runner holds: the local `session_stop`'s three acts. */
async function stopAsAgent(
  input: SessionCommandJobInput,
  runtime: HostedSessionRuntime,
  job: { id: string; sessionId: string; commandId: string },
  intent: Extract<SessionCommandIntent, { kind: "session.stop" }>,
  callerSessionId: string,
): Promise<JobOutcome> {
  if (intent.by.kind !== "session" || intent.by.sessionId !== callerSessionId)
    return failed("invalid_job_payload", "An agent's stop is recorded as its own Session's.");
  const read = async () => {
    const projection = await input.engine.getSession({ sessionId: job.sessionId });
    if (projection === null) throw new SuperviseSessionError("Unknown session.");
    return projection;
  };
  try {
    const outcome = await stopResolvedSession(
      { sessionEngine: input.engine, runtime },
      await read(),
      read,
      {
        operationId: job.commandId,
        by: intent.by,
        reason: intent.reason,
        name: `Session ${shortSessionId(job.sessionId)}`,
        provenance: {
          kind: "system",
          id: "session-supervision",
          detail: { sessionOrigin: { kind: "session", sessionId: callerSessionId } },
        },
      },
    );
    if (outcome.failures.length > 0) {
      // The failures are runtime errors (paths, native detail): logged here, never journaled.
      log.warn("Session stop left its executor running", {
        jobId: job.id,
        failures: outcome.failures,
      });
      return {
        status: "failed",
        code: "stop_incomplete",
        detail: "The stop is recorded, but the Session's executor did not let go yet.",
        retryable: true,
      };
    }
    return { status: "done", result: null };
  } catch (error) {
    if (error instanceof SuperviseSessionError) return failed("command_refused", error.message);
    throw error;
  }
}

export function registerSessionCommandJob(
  worker: Pick<InboxWorker, "register">,
  input: SessionCommandJobInput,
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
        const body = await readMessageBody(
          artifacts,
          input.commandArtifact,
          job.sessionId,
          intent.reference,
        );
        if ("outcome" in body) return body.outcome;
        command = {
          kind: "message.submit",
          message: body.artifact.message,
          settle: "opened",
          // An agent's send is a steer, as `session_send` is locally.
          ...(job.createdBy.kind === "agent" ? { delivery: "steer" as const } : {}),
        };
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
        if (job.createdBy.kind === "agent") {
          context.signal.throwIfAborted();
          return stopAsAgent(
            input,
            runtime,
            { id: job.id, sessionId: job.sessionId, commandId: job.commandId },
            intent,
            job.createdBy.sessionId,
          );
        }
        // The runtime's own stop: the same three acts, recorded as the person's.
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
    let result: Awaited<ReturnType<HostedSessionRuntime["command"]>>;
    try {
      result = await runtime.command({
        sessionId: job.sessionId,
        commandId: job.commandId,
        command,
        origin,
      });
    } catch (error) {
      // A named refusal (a stop of a Session with nothing running) is final, not a retry.
      if (error instanceof SuperviseSessionError) return failed("command_refused", error.message);
      throw error;
    }
    if (result.receipt?.status === "rejected")
      return failed("command_refused", "The Session refused this command.");
    return { status: "done", result: null };
  };
  worker.register("session.command", execute);
}
