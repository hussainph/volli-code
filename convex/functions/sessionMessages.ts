/**
 * The commands an owner sent their Session, as a reload reads them back
 * (`pending`): what the runner's engine has not answered (no receipt), still
 * waiting or ended without an answer (failed, cancelled, expired) with the
 * typed reason, and a message's staged body to show it by.
 *
 * A runner reads the same staged bodies through `transcripts.commandArtifact`
 * (claim-fenced), whether a person's client (`body`) or an agent
 * (`artifact`) staged them with `sessions.command`.
 *
 * Bodies are a client's own message text: they leave only to the Session's
 * owner (here) and to its claimed runner, and never name a path.
 */

import { v } from "convex/values";

import { decodeSessionCommandIntent, type TranscriptReference } from "@volli/shared";
import { parseJobPayload, SESSION_INTERRUPT_FORMAT, type JobStatus } from "@volli/shared/cloud";

import type { Doc } from "./_generated/dataModel.js";
import { query, type QueryCtx } from "./_generated/server";
import { PERSON_OR_AGENT, requireActor } from "./lib/actorAuth";
import { requireSessionActor } from "./lib/auth";

/** A job's intent; `interrupt` for an interrupt, `null` for a payload this build cannot read. */
function readIntent(job: Doc<"runnerJobs">) {
  try {
    const payload = parseJobPayload("session.command", job.payload);
    if (payload.format === SESSION_INTERRUPT_FORMAT) return "interrupt" as const;
    return decodeSessionCommandIntent(JSON.parse(payload.intent), "intent");
  } catch {
    return null;
  }
}

async function stagedBody(
  ctx: Pick<QueryCtx, "db">,
  sessionId: string,
  digest: string | null,
): Promise<string | null> {
  if (digest === null) return null;
  const row = await ctx.db
    .query("transcriptArtifacts")
    .withIndex("by_session_digest", (q) => q.eq("sessionId", sessionId).eq("digest", digest))
    .first();
  return row?.body ?? null;
}

/** Commands listed at most, newest first. */
const PENDING_LIMIT = 20;
/** Jobs read at most, so a long Session's history of answered commands stays cheap. */
const PENDING_SCAN_LIMIT = 100;
/** Bodies returned at most, in total; past it a command is listed without one. */
const PENDING_BODY_BYTES = 512 * 1024;

/** How much of a runner-reported failure detail is passed on. */
const FAILURE_DETAIL_MAX = 280;

export interface PendingCommand {
  commandId: string;
  /**
   * `queued`/`leased`: waiting for the runner. `done`: run, its receipt not
   * yet folded back. `failed`/`cancelled`/`expired`: it ended with no engine
   * answer, so nothing else will say what became of it.
   */
  status: JobStatus;
  kind: string;
  createdAt: number;
  /** The transcript reference a message or an answer names; `null` for other commands. */
  reference: TranscriptReference | null;
  /** A message's id, read from its staged body. */
  messageId: string | null;
  /** A message's staged body (its canonical transcript artifact JSON), or `null` past the budget. */
  body: string | null;
  /**
   * The last failure: on an ended job, why it ended; on a queued one, why it
   * is being retried. `code` is a typed reason; `detail` is the runner's
   * fixed, path-free sentence for it.
   */
  failure: { code: string; detail: string | null; retryable: boolean; attempt: number } | null;
}

function messageIdOf(body: string): string | null {
  try {
    const value: unknown = JSON.parse(body);
    const message =
      typeof value === "object" && value !== null
        ? (value as { message?: { id?: unknown } }).message
        : undefined;
    return typeof message?.id === "string" ? message.id : null;
  } catch {
    return null;
  }
}

/**
 * The owner's commands for their Session that the backend accepted and the
 * engine has not answered (the job has no receipt), waiting or ended, newest
 * first. Ended jobs leave with the job sweep (a week after they end). Bounded:
 * the newest {@link PENDING_SCAN_LIMIT} jobs are read and at most
 * {@link PENDING_LIMIT} listed.
 */
export const pending = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<{ commands: PendingCommand[] }> => {
    const caller = await requireActor(ctx, PERSON_OR_AGENT);
    const { session } = await requireSessionActor(ctx, args.sessionId, caller.viewer);
    const jobs = await ctx.db
      .query("runnerJobs")
      .withIndex("by_session", (q) => q.eq("sessionId", session.id))
      .order("desc")
      .take(PENDING_SCAN_LIMIT);
    const commands: PendingCommand[] = [];
    let bytes = 0;
    for (const job of jobs) {
      if (commands.length >= PENDING_LIMIT) break;
      // A receipt is the engine's answer: the Session's history says the rest.
      if (job.kind !== "session.command" || job.receipt !== null) continue;
      if (job.commandId === null) continue;
      const read = readIntent(job);
      if (read === null) continue;
      const intent = read === "interrupt" ? null : read;
      const reference =
        intent !== null &&
        (intent.kind === "message.submit" || intent.kind === "interaction.resolve")
          ? intent.reference
          : null;
      let body: string | null = null;
      if (intent?.kind === "message.submit") {
        const staged = await stagedBody(ctx, session.id, intent.reference.digest);
        const size = staged === null ? 0 : new TextEncoder().encode(staged).length;
        if (staged !== null && bytes + size <= PENDING_BODY_BYTES) {
          body = staged;
          bytes += size;
        }
      }
      commands.push({
        commandId: job.commandId,
        status: job.status,
        kind: intent?.kind ?? "executor.interrupt",
        createdAt: job.createdAt,
        reference,
        messageId: body === null ? null : messageIdOf(body),
        body,
        failure:
          job.failure == null
            ? null
            : {
                code: job.failure.code,
                detail: job.failure.detail?.slice(0, FAILURE_DETAIL_MAX) ?? null,
                retryable: job.failure.retryable,
                attempt: job.failure.attempt,
              },
      });
    }
    return { commands };
  },
});
