/**
 * Starting a Session on any of the person's runners (C2).
 *
 * A Session is born on a runner: the backend first hears of it from its first
 * accepted fact, which claims it for the runner that sent it
 * (`lib/sessionIntake.ts`). So a client that wants a Session on a runner other
 * than the machine it runs on (a Linux box, an always-on Mac mini) asks the
 * backend to queue a `session.start` job for that runner, and the runner
 * starts the Session when it claims the job. A runner that is asleep or
 * offline keeps the job queued until it is back.
 *
 * - `startOn` (person): mints the Session id, stages the first message's body
 *   as `sessions.command` stages a body (once per digest, no sequence yet), and
 *   enqueues the job in the same transaction. Idempotent by `clientRequestId`,
 *   which is also the job's id and the first message's command id, so
 *   `sessions.receipt` follows the first message like any other.
 * - `status` (person): the start as its requester reads it before and after
 *   its Session exists ("Waiting for hetzner-1").
 * - `startContext` (runner): what the runner holding the job's CURRENT lease
 *   reads before it starts the Session: the project and ticket as they are
 *   now, and the staged body (`transcripts.commandArtifact` answers only the
 *   runner holding a Session's claim, and this Session has none yet).
 *
 * Runners are personal: a person starts only on their own runners, and
 * another person's runner reads as absent (`not_found`).
 */

import { ConvexError, v } from "convex/values";

import {
  autoTitleFromMessage,
  cloudMessageSubmit,
  cloudMessageText,
  CLOUD_MESSAGE_MEDIA_TYPE,
  readCloudMessageBody,
  type CloudUiMessage,
} from "@volli/shared";
import {
  InvalidJobPayloadError,
  isUuid,
  lacksSessionStart,
  newId,
  parseJobPayload,
  sessionStartState,
  SESSION_START_FORMAT,
  JOB_TITLE_MAX_CHARS,
  type ProjectId,
  type RunnerId,
  type SessionStartContext,
  type SessionStartJobPayload,
  type SessionStartOnArgs,
  type SessionStartOnResult,
  type SessionStartStatus,
  type TicketId,
} from "@volli/shared/cloud";

import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireProject, requireViewer } from "./lib/auth";
import { enqueueJob, leaseMayContinue, ownerMayWorkOn } from "./lib/jobs";
import { requireRunner } from "./lib/runnerAuth";
import { personActor } from "./lib/workspaces";
import { stageArtifactRows } from "./transcripts";

function fail(code: string, message: string) {
  return new ConvexError({ code, message });
}

const modelChoice = v.union(
  v.null(),
  v.object({
    providerId: v.string(),
    modelId: v.string(),
    reasoningLevel: v.union(v.string(), v.null()),
  }),
);

function readMessage(body: string): CloudUiMessage {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    throw fail("invalid_request", "The message is not JSON.");
  }
  if (message === null || typeof message !== "object" || Array.isArray(message))
    throw fail("invalid_request", "The message is not a user message.");
  return message as CloudUiMessage;
}

/** The canonical first message for this Session and command, checked as `sessions.command` checks a body. */
function firstMessageOf(sessionId: string, commandId: string, message: CloudUiMessage) {
  try {
    const built = cloudMessageSubmit({ sessionId, commandId, message });
    readCloudMessageBody({ sessionId, commandId, reference: built.reference, body: built.body });
    return built;
  } catch (error) {
    throw fail("invalid_request", error instanceof Error ? error.message : "Unreadable message.");
  }
}

/**
 * Starts a Session on one of the caller's runners. `body` is the first
 * message as a UI message's JSON text (`{ id, role: "user", parts }`); the
 * backend binds it to the Session it mints. `model` pins one; `null` takes
 * the runner's default. Answers the new Session's id.
 *
 * Refused: another person's (or a removed) runner as `not_found`, a runner cut
 * off from its account as `runner_unavailable`, and a runner whose report says
 * it cannot start Sessions as `runner_needs_update`. An asleep, offline or
 * updating runner gets the job queued. A replay of the same request answers
 * the same Session; another request under a used id is `id_taken`.
 */
export const startOn = mutation({
  args: {
    clientRequestId: v.string(),
    runnerId: v.string(),
    projectId: v.string(),
    ticketId: v.union(v.string(), v.null()),
    body: v.string(),
    model: modelChoice,
  },
  handler: async (ctx, input): Promise<SessionStartOnResult> => {
    // The validator above is the shared contract, checked here at compile time.
    const args: SessionStartOnArgs = input;
    const { viewer, project } = await requireProject(ctx, args.projectId);
    if (!isUuid(args.clientRequestId))
      throw fail("invalid_request", "clientRequestId must be a lowercase UUID.");
    // A replay answers first: whatever changed since (the runner slept, was
    // updated or replaced, the ticket was archived), it is the same start.
    const existing = await ctx.db
      .query("runnerJobs")
      .withIndex("by_uuid", (q) => q.eq("id", args.clientRequestId))
      .unique();
    if (existing !== null) {
      const replay = sameStart(existing, args, viewer.userId);
      const sameMessage =
        replay !== null &&
        firstMessageOf(replay.sessionId, args.clientRequestId, readMessage(args.body)).reference
          .digest === replay.payload.firstMessage.body.digest;
      if (replay === null || !sameMessage)
        throw fail("id_taken", "That request id was used for another request.");
      return { sessionId: replay.sessionId };
    }
    if (!isUuid(args.runnerId)) throw fail("not_found", "No such runner.");
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", args.runnerId))
      .unique();
    if (runner === null || runner.ownerUserId !== viewer.userId)
      throw fail("not_found", "No such runner.");
    if (runner.status === "revoked" || runner.revokedAt !== null)
      throw fail(
        "runner_unavailable",
        `${runner.name} is no longer connected to your account. Link it again to start Sessions there.`,
      );
    if (lacksSessionStart(runner.capabilities))
      throw fail(
        "runner_needs_update",
        `${runner.name} needs an update before it can start Sessions from another device.`,
      );
    if (args.ticketId !== null) {
      const ticket = isUuid(args.ticketId)
        ? await ctx.db
            .query("tickets")
            .withIndex("by_uuid", (q) => q.eq("id", args.ticketId!))
            .unique()
        : null;
      if (ticket === null || ticket.projectId !== project.id || ticket.deletedAt !== null)
        throw fail("not_found", "That ticket does not exist.");
      if (ticket.archivedAt !== null)
        throw fail("ticket_archived", "That ticket is archived. Unarchive it to start a Session.");
    }
    const message = readMessage(args.body);
    const commandId = args.clientRequestId;

    const sessionId = newId("session");
    const first = firstMessageOf(sessionId, commandId, message);
    const title = autoTitleFromMessage(cloudMessageText(message));
    let payload: SessionStartJobPayload;
    try {
      payload = parseJobPayload("session.start", {
        format: SESSION_START_FORMAT,
        projectId: project.id,
        ticketId: args.ticketId,
        title: title === null ? null : title.slice(0, JOB_TITLE_MAX_CHARS),
        firstMessage: {
          commandId,
          body: {
            id: first.reference.id,
            mediaType: first.reference.mediaType,
            digest: first.reference.digest,
          },
        },
        model: args.model,
      });
    } catch (error) {
      if (error instanceof InvalidJobPayloadError) throw fail("invalid_request", error.message);
      throw error;
    }
    await enqueueJob(ctx, {
      id: commandId,
      runnerId: runner.id,
      kind: "session.start",
      projectId: project.id,
      sessionId,
      ticketId: args.ticketId,
      commandId,
      payload,
      createdBy: personActor(viewer),
      onBehalfOf: viewer.userId,
    });
    // Staged in the job's transaction: the job exists exactly when its body does.
    await stageArtifactRows(
      ctx,
      { sessionId, projectId: project.id },
      [
        {
          digest: first.reference.digest!,
          mediaType: CLOUD_MESSAGE_MEDIA_TYPE,
          bytes: new TextEncoder().encode(first.body).length,
          body: first.body,
          spillKey: null,
          sequence: null,
        },
      ],
      "client",
      Date.now(),
    );
    return { sessionId };
  },
});

/** The job a replayed request names, when it is the same start; `null` otherwise. */
function sameStart(
  job: Doc<"runnerJobs">,
  args: {
    projectId: string;
    ticketId: string | null;
    model: { providerId: string; modelId: string; reasoningLevel: string | null } | null;
  },
  userId: string,
): { sessionId: string; payload: SessionStartJobPayload } | null {
  if (job.kind !== "session.start" || job.sessionId === null) return null;
  const createdBy = job.createdBy as { kind?: string; userId?: string };
  if (createdBy.kind !== "person" || createdBy.userId !== userId) return null;
  let payload: SessionStartJobPayload;
  try {
    payload = parseJobPayload("session.start", job.payload);
  } catch {
    return null;
  }
  const model = args.model;
  const sameModel =
    model === null
      ? payload.model === null
      : payload.model !== null &&
        payload.model.providerId === model.providerId &&
        payload.model.modelId === model.modelId &&
        payload.model.reasoningLevel === model.reasoningLevel;
  // The runner is not compared: a replaced Mac's successor takes its queued work.
  if (job.projectId !== args.projectId || job.ticketId !== args.ticketId || !sameModel) return null;
  return { sessionId: job.sessionId, payload };
}

async function startJobOf(ctx: QueryCtx, sessionId: string): Promise<Doc<"runnerJobs"> | null> {
  for await (const job of ctx.db
    .query("runnerJobs")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))) {
    if (job.kind === "session.start") return job;
  }
  return null;
}

/**
 * A start the caller asked for, by its Session id: queued, starting, started
 * or failed, with the runner it waits for. `null` for a start that is not the
 * caller's, or that the sweep has since removed (its Session, once born, is
 * read through `sessions` instead).
 */
export const status = query({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }): Promise<SessionStartStatus | null> => {
    const viewer = await requireViewer(ctx);
    if (!isUuid(sessionId)) return null;
    const job = await startJobOf(ctx, sessionId);
    const createdBy = job?.createdBy as { kind?: string; userId?: string } | undefined;
    if (job === null || createdBy?.kind !== "person" || createdBy.userId !== viewer.userId)
      return null;
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", job.runnerId))
      .unique();
    const mine = runner !== null && runner.ownerUserId === viewer.userId ? runner : null;
    const open = job.status === "queued" || job.status === "leased";
    // An open start whose runner was cut off or removed waits for nothing.
    const stranded =
      open && (mine === null || mine.status === "revoked" || mine.revokedAt !== null);
    return {
      sessionId,
      state: stranded ? "failed" : sessionStartState(job.status),
      runner:
        mine === null
          ? null
          : {
              id: mine.id as RunnerId,
              name: mine.name,
              kind: mine.kind,
              status: mine.status,
              statusChangedAt: mine.statusChangedAt,
            },
      // The last failure, also on a start queued again for a retry.
      failure: stranded
        ? {
            code: "runner_unavailable",
            detail: "That runner is no longer connected to your account.",
          }
        : job.failure !== null && job.failure !== undefined
          ? { code: job.failure.code, detail: job.failure.detail }
          : open || job.status === "done"
            ? null
            : { code: job.status, detail: null },
    };
  },
});

const LEASE_LOST: SessionStartContext = { kind: "unavailable", reason: "lease_lost" };

/**
 * What the runner holding a `session.start` job's CURRENT lease (`bootId`,
 * `attempt`) reads before it starts the Session: the project and ticket as
 * they are now, its own name as the person knows it, and the staged first
 * message. An attempt whose lease was taken away reads `lease_lost`.
 */
export const startContext = query({
  args: { jobId: v.string(), bootId: v.string(), attempt: v.number() },
  handler: async (ctx, args): Promise<SessionStartContext> => {
    const { runnerId, ownerUserId, runner } = await requireRunner(ctx);
    if (!isUuid(args.jobId)) return LEASE_LOST;
    const job = await ctx.db
      .query("runnerJobs")
      .withIndex("by_uuid", (q) => q.eq("id", args.jobId))
      .unique();
    if (
      job === null ||
      job.runnerId !== runnerId ||
      job.kind !== "session.start" ||
      job.sessionId === null ||
      !leaseMayContinue(job, { bootId: args.bootId, attempt: args.attempt })
    )
      return LEASE_LOST;
    let payload: SessionStartJobPayload;
    try {
      payload = parseJobPayload("session.start", job.payload);
    } catch {
      return LEASE_LOST;
    }
    if (!(await ownerMayWorkOn(ctx, ownerUserId, job.projectId)))
      return { kind: "unavailable", reason: "project_unavailable" };
    let ticket: { id: TicketId; live: boolean } | null = null;
    if (job.ticketId !== null) {
      const row = await ctx.db
        .query("tickets")
        .withIndex("by_uuid", (q) => q.eq("id", job.ticketId!))
        .unique();
      ticket = {
        id: job.ticketId as TicketId,
        live:
          row !== null &&
          row.projectId === job.projectId &&
          row.deletedAt === null &&
          row.archivedAt === null,
      };
    }
    const digest = payload.firstMessage.body.digest;
    const staged =
      digest === null
        ? null
        : await ctx.db
            .query("transcriptArtifacts")
            .withIndex("by_session_digest", (q) =>
              q.eq("sessionId", job.sessionId!).eq("digest", digest),
            )
            .first();
    return {
      kind: "ready",
      projectId: job.projectId as ProjectId,
      ticket,
      runnerName: runner.name,
      body: staged?.body ?? null,
    };
  },
});
