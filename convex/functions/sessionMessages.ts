/**
 * The message bodies a client staged with its Session commands
 * (`sessions.command`), as their runner and their owner read them back.
 *
 * - `forRunner` (runner): the staged body of one `message.submit` command,
 *   for the runner that holds the Session's claim and leased that command.
 *   The runner checks the body against the command's reference and stores it
 *   through its own transcript codec before delivering the message.
 * - `pending` (client): the owner's commands the runner's engine has not
 *   answered (no receipt): still waiting, or ended without an answer (failed,
 *   cancelled, expired) with the typed reason. A reload shows what was sent
 *   and what became of it, with a message's body to show it by.
 *
 * Bodies are a client's own message text: they leave only to the Session's
 * owner and to the owner's claimed runner, and never name a path.
 */

import { ConvexError, v } from "convex/values";

import { decodeSessionCommandIntent, type TranscriptReference } from "@volli/shared";
import { parseJobPayload, SESSION_INTERRUPT_FORMAT, type JobStatus } from "@volli/shared/cloud";

import type { Doc } from "./_generated/dataModel.js";
import { query, type QueryCtx } from "./_generated/server";
import { PERSON_OR_AGENT, requireActor } from "./lib/actorAuth";
import { findVisibleProject, requireSessionActor } from "./lib/auth";
import { requireRunner } from "./lib/runnerAuth";

function fail(
  code: "invalid_request" | "not_found" | "not_your_runner" | "fenced",
  message: string,
) {
  return new ConvexError({ code, message });
}

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

function intentOf(job: Doc<"runnerJobs">) {
  const intent = readIntent(job);
  return intent === "interrupt" ? null : intent;
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

// ── the runner ──────────────────────────────────────────────────────────────

export type RunnerMessageBody = { status: "staged"; body: string } | { status: "missing" };

/**
 * The staged body of `commandId`, a `message.submit` job of `sessionId`, for
 * the runner that holds the Session's active claim and the job. The Session must be
 * the runner owner's, in a project they are still an active Member of.
 * `missing`: no inline body is staged for the command's reference.
 */
export const forRunner = query({
  args: { sessionId: v.string(), commandId: v.string() },
  handler: async (ctx, args): Promise<RunnerMessageBody> => {
    const caller = await requireRunner(ctx);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", args.sessionId))
      .unique();
    if (session === null || session.deletedAt !== null)
      throw fail("not_found", "That session does not exist.");
    if (session.ownerUserId !== caller.ownerUserId)
      throw fail("not_your_runner", "This runner does not run that owner's work.");
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", session.id))
      .unique();
    if (intake === null || intake.state !== "active" || intake.claim.runnerId !== caller.runnerId)
      throw fail("fenced", "This runner no longer holds the session's claim.");
    if ((await findVisibleProject(ctx, caller.ownerUserId, session.projectId)) === null)
      throw fail("not_found", "That session does not exist.");
    const job = await ctx.db
      .query("runnerJobs")
      .withIndex("by_uuid", (q) => q.eq("id", args.commandId))
      .unique();
    if (
      job === null ||
      job.kind !== "session.command" ||
      job.sessionId !== session.id ||
      job.runnerId !== caller.runnerId
    )
      throw fail("not_found", "That command is not this runner's.");
    const intent = intentOf(job);
    if (intent === null || intent.kind !== "message.submit")
      throw fail("invalid_request", "That command carries no message.");
    const body = await stagedBody(ctx, session.id, intent.reference.digest);
    return body === null ? { status: "missing" } : { status: "staged", body };
  },
});

// ── the owner ───────────────────────────────────────────────────────────────

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
