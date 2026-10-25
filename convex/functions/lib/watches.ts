/** Durable watch intent and the single producer of cloud watch notice jobs. */
import { ConvexError } from "convex/values";
import {
  SESSION_AWAIT_KINDS,
  TICKET_AWAIT_KINDS,
  readSessionOrigin,
  noticeProse,
  sessionWatchChanges,
  ticketWatchChanges,
  NOTICE_PROSE_LIMIT,
  WATCH_ANSWER_NOTICE_LIMIT,
  type NoticeAnswer,
  type WatchChangeV1,
  type SessionAwaitKind,
  type TicketAwaitKind,
  type SessionEvent,
} from "@volli/shared";
import {
  isUuid,
  isDerivedId,
  newId,
  TERMINAL_JOB_TTL_MS,
  parseJobPayload,
  mergeWatchNotice,
  newWatchNotice,
  watchNoticeCommandId,
  JOB_TITLE_MAX_CHARS,
  WATCH_CHANGE_MAX_PENDING,
  boardEventWatchActor,
  renderTicketKey,
  type CloudSessionView,
  type BoardEventDraft,
  type UserId,
  type SessionId,
  type TicketId,
  type Actor,
} from "@volli/shared/cloud";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireProject, requireSessionVisible, type Viewer } from "./auth";
import { cancelJob, patchQueuedJob, tryEnqueueJob } from "./jobs";
const WATCH_COALESCE_MS = 1_500;

export type WatchTarget = { kind: "session" | "ticket"; id: string };
type WatchOrigin = NonNullable<Doc<"watches">["origin"]>;
type EndReason = NonNullable<Doc<"watches">["endedReason"]>;
type Reader = Pick<MutationCtx, "db">;
const TICKET_WATCH_IDLE_MS = 14 * 24 * 60 * 60_000;

export function watchError(code: string, message: string) {
  return new ConvexError({ code, message });
}

async function sessionRow(ctx: Reader, id: string) {
  return ctx.db
    .query("sessions")
    .withIndex("by_uuid", (q) => q.eq("id", id))
    .unique();
}

async function ownerViewer(ctx: Reader, session: Doc<"sessions">): Promise<Viewer | null> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_uuid", (q) => q.eq("id", session.ownerUserId))
    .unique();
  return user?.status === "active" ? { userId: user.id as Viewer["userId"], user } : null;
}

/** Never report whether a hidden target exists. Called again at each fire. */
async function visibleTarget(ctx: MutationCtx, viewer: Viewer, target: WatchTarget) {
  if (target.kind === "session") {
    const { session } = await requireSessionVisible(ctx, target.id, viewer);
    return session;
  }
  const ticket = await ctx.db
    .query("tickets")
    .withIndex("by_uuid", (q) => q.eq("id", target.id))
    .unique();
  if (ticket === null || ticket.deletedAt !== null)
    throw watchError("not_found", "That ticket does not exist.");
  await requireProject(ctx, ticket.projectId, viewer);
  return ticket;
}

export async function armWatch(
  ctx: MutationCtx,
  input: {
    watcher: Doc<"sessions">;
    target: WatchTarget;
    origin: WatchOrigin;
    actor: Actor;
    commandId: string;
    /** Auto-arms happen within a folded batch, before its later facts. */
    armedThroughSequence?: number;
  },
): Promise<string> {
  if (!isDerivedId(input.commandId))
    throw watchError("invalid_request", "The watch command id is invalid.");
  if (!isUuid(input.target.id))
    throw watchError("invalid_request", "The watch target id is invalid.");
  const receipt = await ctx.db
    .query("watchReceipts")
    .withIndex("by_command", (q) => q.eq("commandId", input.commandId))
    .unique();
  if (receipt !== null) {
    if (
      receipt.watcherSessionId !== input.watcher.id ||
      receipt.target.kind !== input.target.kind ||
      receipt.target.id !== input.target.id
    ) {
      throw watchError("id_taken", "That command id armed a different watch.");
    }
    return receipt.watchId;
  }
  const viewer = await ownerViewer(ctx, input.watcher);
  if (viewer === null) throw watchError("not_found", "That watcher does not exist.");
  await requireSessionVisible(ctx, input.watcher.id, viewer);
  if (input.watcher.status !== "open" || input.watcher.stopped !== null) {
    throw watchError("watcher_stopped", "A stopped or archived Session cannot watch work.");
  }
  if (input.target.kind === "session" && input.target.id === input.watcher.id) {
    throw watchError("self_watch", "A Session cannot watch itself.");
  }
  const target = await visibleTarget(ctx, viewer, input.target);
  if (
    ("stopped" in target && (target.stopped !== null || target.status !== "open")) ||
    ("archivedAt" in target && target.archivedAt !== null)
  ) {
    throw watchError(
      "target_stopped",
      "That work is stopped or archived; there is nothing left to watch.",
    );
  }
  const now = Date.now();
  const watches = await ctx.db
    .query("watches")
    .withIndex("by_watcher", (q) => q.eq("watcherSessionId", input.watcher.id).eq("endedAt", null))
    .collect();
  const existing = watches.find(
    (w) => w.target.kind === input.target.kind && w.target.id === input.target.id,
  );
  if (existing === undefined && watches.length >= 200)
    throw watchError("watch_limit", "A Session can watch at most 200 targets.");
  const kinds =
    input.target.kind === "session" ? [...SESSION_AWAIT_KINDS] : [...TICKET_AWAIT_KINDS];
  const id = existing?.id ?? newId("watch");
  const intake =
    input.target.kind === "session"
      ? await ctx.db
          .query("sessionIntake")
          .withIndex("by_session", (q) => q.eq("sessionId", input.target.id))
          .unique()
      : null;
  const armedThroughSequence = input.armedThroughSequence ?? intake?.acceptedThrough ?? 0;
  if (existing !== undefined) {
    await ctx.db.patch(existing._id, {
      origin: input.origin,
      turnArmed: true,
      kinds,
      armedThroughSequence,
      lastArmedAt: now,
    });
  } else {
    await ctx.db.insert("watches", {
      id,
      watcherSessionId: input.watcher.id,
      target: input.target,
      createdBy: input.actor,
      createdAt: now,
      endedAt: null,
      origin: input.origin,
      turnArmed: true,
      kinds,
      armedThroughSequence,
      lastArmedAt: now,
    });
  }
  await ctx.db.insert("watchReceipts", {
    commandId: input.commandId,
    watcherSessionId: input.watcher.id,
    target: input.target,
    watchId: id,
    expiresAt: now + TERMINAL_JOB_TTL_MS,
  });
  return id;
}

export async function endWatch(ctx: MutationCtx, watch: Doc<"watches">, reason: EndReason) {
  await ctx.db.patch(watch._id, { endedAt: Date.now(), endedReason: reason, turnArmed: false });
}

async function endWatcher(ctx: MutationCtx, watcherSessionId: string) {
  const watches = await ctx.db
    .query("watches")
    .withIndex("by_watcher", (q) => q.eq("watcherSessionId", watcherSessionId).eq("endedAt", null))
    .collect();
  for (const watch of watches) await endWatch(ctx, watch, "watcher_stopped");
  const jobs = await ctx.db
    .query("runnerJobs")
    .withIndex("by_session_kind_status", (q) =>
      q.eq("sessionId", watcherSessionId).eq("kind", "session.notice").eq("status", "queued"),
    )
    .collect();
  for (const job of jobs)
    if (job.kind === "session.notice" && job.status === "queued")
      await cancelJob(ctx, job, Date.now(), {
        code: "reader_stopped",
        detail: "The watching Session stopped.",
      });
}

/** Historical buffered starts/steers cannot resurrect a watch after its owner stopped. */
async function autoArm(ctx: MutationCtx, target: Doc<"sessions">, fact: SessionEvent) {
  const { payload } = fact;
  if (payload.kind !== "command.recorded") return;
  const intent = payload.command.intent;
  if (intent.kind !== "session.create" && intent.kind !== "message.submit") return;
  const detail = fact.provenance.source.detail;
  const origin = readSessionOrigin(
    typeof detail === "object" && detail !== null && !Array.isArray(detail)
      ? (detail as Record<string, unknown>).sessionOrigin
      : null,
  );
  if (origin?.kind !== "session" || !isUuid(origin.sessionId) || origin.sessionId === target.id)
    return;
  if (target.role === "subagent" && target.parentSessionId === origin.sessionId) return;
  const watcher = await sessionRow(ctx, origin.sessionId);
  if (
    watcher === null ||
    watcher.ownerUserId !== target.ownerUserId ||
    watcher.status !== "open" ||
    watcher.stopped !== null
  )
    return;
  try {
    await armWatch(ctx, {
      watcher,
      target: { kind: "session", id: target.id },
      origin: intent.kind === "session.create" ? "started" : "steered",
      actor: {
        kind: "agent",
        userId: watcher.ownerUserId as Viewer["userId"],
        sessionId: watcher.id as SessionId,
        ticketId: watcher.ticketId as TicketId | null,
      },
      commandId: payload.command.id,
      armedThroughSequence: fact.sequence,
    });
  } catch (error) {
    // A formerly visible target or a stopped watcher is ordinary for buffered
    // facts. It must not prevent the runner from draining immutable history.
    if (!(error instanceof ConvexError)) throw error;
  }
}

export async function watchAccess(
  ctx: MutationCtx,
  watch: Doc<"watches">,
): Promise<Doc<"sessions"> | null> {
  const watcher = await sessionRow(ctx, watch.watcherSessionId);
  if (
    watcher === null ||
    watcher.status !== "open" ||
    watcher.stopped !== null ||
    watcher.deletedAt !== null
  ) {
    await endWatch(ctx, watch, "watcher_stopped");
    return null;
  }
  const viewer = await ownerViewer(ctx, watcher);
  try {
    if (viewer === null) throw watchError("not_found", "No watcher owner.");
    await requireSessionVisible(ctx, watcher.id, viewer);
    await visibleTarget(ctx, viewer, watch.target);
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    await endWatch(ctx, watch, "access_lost");
    return null;
  }
  if (
    watch.target.kind === "ticket" &&
    Date.now() -
      Math.max(watch.lastNoticeAt ?? watch.createdAt, watch.lastArmedAt ?? watch.createdAt) >=
      TICKET_WATCH_IDLE_MS
  ) {
    await endWatch(ctx, watch, "expired");
    return null;
  }
  return watcher;
}

// Notice production is below; called only from the accepted-fact and board
// append choke points, never from an in-process bus.
export async function onSessionFact(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  fact: SessionEvent,
  view?: CloudSessionView,
) {
  await autoArm(ctx, session, fact);
  if (
    fact.sequence === 1 &&
    fact.payload.kind === "command.recorded" &&
    fact.payload.command.intent.kind === "session.create"
  )
    await deferForLateChild(ctx, session);
  if (fact.payload.kind === "session.stopped" || fact.payload.kind === "session.archived")
    await endWatcher(ctx, session.id);
  if (
    !["turn.completed", "turn.interrupted", "session.signaled", "session.stopped"].includes(
      fact.payload.kind,
    )
  )
    return;
  const pending = (await pendingChildren(ctx, session.id)).slice(0, WATCH_CHANGE_MAX_PENDING);
  const title = view === undefined ? session.title : view.session.title;
  const rows = await ctx.db
    .query("watches")
    .withIndex("by_target", (q) =>
      q.eq("target.kind", "session").eq("target.id", session.id).eq("endedAt", null),
    )
    .collect();
  for (const watch of rows) {
    const watcher = await watchAccess(ctx, watch);
    if (watcher === null) continue;
    if (fact.sequence <= (watch.armedThroughSequence ?? 0)) {
      if (fact.payload.kind === "session.stopped") await endWatch(ctx, watch, "target_stopped");
      continue;
    }
    const step = sessionWatchChanges(
      fact.payload,
      {
        targetSessionId: session.id,
        title: title === null ? null : noticeProse(title, JOB_TITLE_MAX_CHARS).text,
        kinds: (watch.kinds ?? SESSION_AWAIT_KINDS) as SessionAwaitKind[],
        turnArmed: watch.turnArmed ?? true,
      },
      {
        watcherSessionId: watcher.id,
        pendingChildren: pending,
        occurredAt: fact.occurredAt,
        proseLimit: NOTICE_PROSE_LIMIT,
      },
    );
    if (step.change !== null) {
      if (step.change.fact === "turn-completed" || step.change.fact === "turn-interrupted")
        step.change.lastMessage = await lastMessage(ctx, session.id, view);
      if (step.change.fact === "turn-interrupted" && step.change.stopDetail !== null) {
        const stop = step.change.stopDetail;
        step.change.stopDetail = {
          ...stop,
          message:
            stop.message === null ? null : noticeProse(stop.message, NOTICE_PROSE_LIMIT).text,
          providerType:
            stop.providerType === null ? null : noticeProse(stop.providerType, 200).text,
        };
      }
      await noticeFor(ctx, watcher, step.change);
      await ctx.db.patch(watch._id, { lastNoticeAt: Date.now() });
    }
    if (step.ended) await endWatch(ctx, watch, "target_stopped");
    else if (step.turnArmed !== (watch.turnArmed ?? true))
      await ctx.db.patch(watch._id, { turnArmed: step.turnArmed });
  }
}

async function pendingChildren(ctx: Reader, parentSessionId: string): Promise<string[]> {
  const rows = await ctx.db
    .query("delegations")
    .withIndex("by_parent_status", (q) => q.eq("parentSessionId", parentSessionId))
    .collect();
  return rows
    .filter((row) => row.status === "running" || row.status === "starting")
    .map((row) => row.childSessionId);
}

/** The runner composes only staged text; spilled or unavailable bodies stay pointers. */
async function lastMessage(
  ctx: Reader,
  sessionId: string,
  view?: CloudSessionView,
): Promise<NoticeAnswer> {
  const reference = view?.latestReply?.reference;
  if (reference === undefined) return { state: "unread" };
  const row = await ctx.db
    .query("transcriptArtifacts")
    .withIndex("by_session_digest", (q) => q.eq("sessionId", sessionId).eq("digest", reference.id))
    .unique();
  if (row?.body === null || row?.body === undefined) return { state: "unread" };
  try {
    const artifact = JSON.parse(row.body) as {
      message?: { role?: string; parts?: { type?: string; text?: unknown }[] };
    };
    if (artifact.message?.role !== "assistant" || !Array.isArray(artifact.message.parts))
      return { state: "unread" };
    const text = artifact.message.parts
      .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("\n")
      .trim();
    return text.length === 0
      ? { state: "none" }
      : { state: "text", message: noticeProse(text, WATCH_ANSWER_NOTICE_LIMIT) };
  } catch {
    return { state: "unread" };
  }
}

async function noticeFor(ctx: MutationCtx, watcher: Doc<"sessions">, change: WatchChangeV1) {
  const jobs = await ctx.db
    .query("runnerJobs")
    .withIndex("by_session_kind_status", (q) =>
      q.eq("sessionId", watcher.id).eq("kind", "session.notice").eq("status", "queued"),
    )
    .collect();
  const queued = jobs.find(
    (job) =>
      job.kind === "session.notice" &&
      job.status === "queued" &&
      job.lease === null &&
      parseJobPayload("session.notice", job.payload).notice === "watch",
  );
  if (queued !== undefined) {
    const payload = parseJobPayload("session.notice", queued.payload);
    if (payload.notice === "watch")
      await patchQueuedJob(ctx, queued, mergeWatchNotice(payload, [change]));
    return;
  }
  const intake = await ctx.db
    .query("sessionIntake")
    .withIndex("by_session", (q) => q.eq("sessionId", watcher.id))
    .unique();
  if (intake === null || intake.state === "released") return;
  // This command id is durable: local outbox dedupe and the second receipt
  // both compare the exact pre-cloud watch:{session}:{uuid} string.
  const commandId = watchNoticeCommandId(watcher.id, newId("job"));
  await tryEnqueueJob(ctx, {
    id: commandId,
    commandId,
    kind: "session.notice",
    runnerId: intake.claim.runnerId,
    projectId: watcher.projectId,
    sessionId: watcher.id,
    ticketId: watcher.ticketId,
    payload: mergeWatchNotice(newWatchNotice(commandId), [change]),
    availableAt: Date.now() + WATCH_COALESCE_MS,
    onBehalfOf: watcher.ownerUserId,
    createdBy: { kind: "volli", reason: "watch_notice", onBehalfOf: watcher.ownerUserId as UserId },
  });
}

export async function onBoardEvents(
  ctx: MutationCtx,
  input: {
    projectId: string;
    actor: Actor;
    at: number;
    events: readonly BoardEventDraft[];
  },
) {
  for (const event of input.events) {
    if (
      event.ticketId === null ||
      !["status_changed", "commented", "signaled"].includes(event.payload.kind)
    )
      continue;
    const rows = await ctx.db
      .query("watches")
      .withIndex("by_target", (q) =>
        q.eq("target.kind", "ticket").eq("target.id", event.ticketId!).eq("endedAt", null),
      )
      .collect();
    const ticket = await ctx.db
      .query("tickets")
      .withIndex("by_uuid", (q) => q.eq("id", event.ticketId!))
      .unique();
    const project = await ctx.db
      .query("projects")
      .withIndex("by_uuid", (q) => q.eq("id", input.projectId))
      .unique();
    if (ticket === null || project === null) continue;
    const { by, actorSessionId } = boardEventWatchActor(input.actor);
    let comment: string | null = null;
    if (event.payload.kind === "commented") {
      const id = event.payload.commentId;
      const row = await ctx.db
        .query("ticketComments")
        .withIndex("by_uuid", (q) => q.eq("id", id))
        .unique();
      comment = row?.deletedAt === null ? row.body : null;
    }
    for (const watch of rows) {
      const watcher = await watchAccess(ctx, watch);
      if (watcher === null) continue;
      const change = ticketWatchChanges(
        event.payload,
        {
          ticketId: ticket.id,
          display: renderTicketKey(project, ticket.number),
          kinds: (watch.kinds ?? TICKET_AWAIT_KINDS) as TicketAwaitKind[],
        },
        {
          watcherSessionId: watcher.id,
          actorSessionId,
          by,
          comment,
          occurredAt: input.at,
          proseLimit: NOTICE_PROSE_LIMIT,
        },
      );
      if (change !== null) {
        await noticeFor(ctx, watcher, change);
        await ctx.db.patch(watch._id, { lastNoticeAt: Date.now() });
      }
    }
  }
}

/** A child can drain its birth just after the parent's turn end. Until claim
 * (and only inside the initial coalescing window), retract that premature
 * completion and keep the turn arm for the parent's real final turn. */
async function deferForLateChild(ctx: MutationCtx, child: Doc<"sessions">) {
  if (child.role !== "subagent" || child.parentSessionId === null) return;
  const rows = await ctx.db
    .query("watches")
    .withIndex("by_target", (q) =>
      q.eq("target.kind", "session").eq("target.id", child.parentSessionId!).eq("endedAt", null),
    )
    .collect();
  for (const watch of rows) {
    const jobs = await ctx.db
      .query("runnerJobs")
      .withIndex("by_session_kind_status", (q) =>
        q
          .eq("sessionId", watch.watcherSessionId)
          .eq("kind", "session.notice")
          .eq("status", "queued"),
      )
      .collect();
    for (const job of jobs) {
      if (job.lease !== null || Date.now() > job.availableAt) continue;
      const payload = parseJobPayload("session.notice", job.payload);
      if (payload.notice !== "watch") continue;
      const changes = payload.changes.filter(
        (change) =>
          !(
            change.subject === "session" &&
            change.sessionId === child.parentSessionId &&
            change.fact === "turn-completed" &&
            change.occurredAt !== null &&
            change.occurredAt >= child.createdAt
          ),
      );
      if (changes.length === payload.changes.length) continue;
      await ctx.db.patch(watch._id, { turnArmed: true });
      if (changes.length === 0 && payload.overflow === 0)
        await cancelJob(ctx, job, Date.now(), {
          code: "watch_deferred",
          detail: "The target still has a running subagent.",
        });
      else await patchQueuedJob(ctx, job, { ...payload, changes });
    }
  }
}
