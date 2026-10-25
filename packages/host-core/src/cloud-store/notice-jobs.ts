/**
 * The runner's `session.notice` executor (VC-887): a notice the backend
 * queued for a watcher (or a parent) whose claim is on this runner.
 *
 * 1. Parse the payload (`parseJobPayload`, `volli.session-notice/1`); one
 *    that does not parse, or names another notice's command id, fails the job
 *    permanently (`invalid_job_payload`).
 * 2. Unless the runner's durable host-notice outbox already holds (or has
 *    settled) the job's frozen notice command id, compose the text with the
 *    shared composer (`composeSessionNotice`), minting the envelope nonce
 *    once for the notice, and put it there.
 * 4. Answer `done {stage: "on_runner"}` as soon as that put has committed.
 *
 * From there the outbox's delivery owns timing (live → steer, idle → a turn,
 * detached → parked until it attaches, stopped → dropped), and the final
 * receipt is the notice message's own `command.receipt.recorded`, which the
 * fact drain sends. A re-lease after a crash finds the id already stored (it
 * is sent as stored) or settled (nothing happens), so it composes nothing:
 * the nonce is never re-minted and the notice never sent twice. Should two
 * attempts race past that read, the put is still first-writer-wins.
 *
 * Owner checks are the guarded inbox's (`ownerGuardedInbox`): this executor
 * only ever sees a Session this launch's owner holds.
 */
import { randomUUID } from "node:crypto";
import type { HostNotice } from "@volli/session-engine";
import { shortSessionId } from "@volli/shared";
import {
  composeSessionNotice,
  InvalidJobPayloadError,
  INVALID_JOB_PAYLOAD,
  parseJobPayload,
  type ClaimedJob,
  type JobOutcome,
  type JobPayload,
} from "@volli/shared/cloud";
import type { InboxWorker, JobExecutor } from "../cloud-runner/inbox";

/** The first stage of a notice's two: it is durable on this runner. */
export const SESSION_NOTICE_ON_RUNNER = { stage: "on_runner" } as const;

/** The outbox door the runtime lifecycle binds (`enqueueHostNotice`). */
export interface SessionNoticeOutbox {
  /**
   * Resolves once committed: the first stored notice, or `null` when already
   * settled. `compose` runs only for an id the outbox has never held.
   */
  enqueue(intent: {
    sessionId: string;
    commandId: string;
    compose(): HostNotice;
  }): Promise<HostNotice | null>;
}

const failed = (code: string, detail: string, retryable = false): JobOutcome => ({
  status: "failed",
  code,
  detail,
  retryable,
});

const malformed = () => failed(INVALID_JOB_PAYLOAD, "This Session notice is malformed.");

/** Sanitized, handles only: what host diagnostics say about one notice. */
function noticeLabel(payload: JobPayload<"session.notice">, readerSessionId: string): string {
  const reader = shortSessionId(readerSessionId);
  return payload.notice === "watch"
    ? `watch notice to ${reader}`
    : `subagent notice for ${shortSessionId(payload.childSessionId)} to parent ${reader}`;
}

export function registerSessionNoticeJob(
  worker: Pick<InboxWorker, "register">,
  input: {
    /** `null` until the runtime lifecycle binds it, or in a launch with no runtime. */
    outbox(): SessionNoticeOutbox | null;
    newId?(): string;
  },
): void {
  const newId = input.newId ?? randomUUID;
  const execute: JobExecutor = async (claimed: ClaimedJob, context) => {
    context.signal.throwIfAborted();
    const { job } = claimed;
    if (job.sessionId === null)
      return failed(INVALID_JOB_PAYLOAD, "A Session notice needs the Session it is for.");
    let payload: JobPayload<"session.notice">;
    try {
      payload = parseJobPayload("session.notice", job.payload);
    } catch (error) {
      if (error instanceof InvalidJobPayloadError) return malformed();
      throw error;
    }
    // The backend mints the notice's frozen command id as the job's own; a
    // payload naming another id would put a different notice.
    if ((job.commandId ?? job.id) !== payload.commandId) return malformed();
    const outbox = input.outbox();
    if (outbox === null)
      return failed("runtime_unavailable", "The Session runtime is not ready.", true);
    const sessionId = job.sessionId;
    context.signal.throwIfAborted();
    await outbox.enqueue({
      sessionId,
      commandId: payload.commandId,
      // Only for an id the outbox never held: a re-lease of a stored or
      // settled notice composes nothing and mints no second nonce.
      compose: () => {
        const nonce = newId();
        const composed = composeSessionNotice(payload, { sessionId, nonce: () => nonce });
        return {
          sessionId,
          commandId: composed.commandId,
          messageId: composed.messageId,
          text: composed.text,
          metadata: composed.metadata,
          label: noticeLabel(payload, sessionId),
        };
      },
    });
    // Stored now, or settled before: either way this job's work is done.
    return { status: "done", result: SESSION_NOTICE_ON_RUNNER };
  };
  worker.register("session.notice", execute);
}
