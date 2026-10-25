/**
 * Needs-you attention, as people and runners call it: `markSeen` (a person,
 * their own items), `raiseFromRunner` (`volli notify`: the runner holding a
 * Session raises an item for the Session's owner) and the internal
 * `sweepAccess` (a Member who lost access to a Workspace has their items
 * there cleared). Every write goes through `lib/attention.ts`, the one writer;
 * the cross-Workspace Needs-you reads are `needsYou.ts` (B8), and a Session's
 * own items are `sessions.attention`.
 */

import { ConvexError, v } from "convex/values";

import {
  ATTENTION_LIMITS,
  isActiveMember,
  isUuid,
  notifySourceId,
  sessionAttentionId,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import {
  clearForLostAccess,
  findAttention,
  inWorkspace,
  markAttentionSeen,
  raiseSessionAttention,
} from "./lib/attention";
import { findMembership, findVisibleProject, requireViewer } from "./lib/auth";
import { requireRunnerForWrite } from "./lib/runnerAuth";
import { nullable } from "./lib/validators";

export type AttentionErrorCode = "invalid_argument" | "not_found" | "fenced";

export type AttentionErrorData = { code: AttentionErrorCode; message: string };

function attentionError(code: AttentionErrorCode, message: string) {
  return new ConvexError<AttentionErrorData>({ code, message });
}

/** Items one sweep step reads; a full page schedules the next step. */
const SWEEP_PAGE = 200;

/**
 * Marks the viewer's own items seen (at most {@link ATTENTION_LIMITS.markSeenIds}).
 * An id that is not the viewer's, or no longer open, is skipped, so two
 * devices marking the same item both succeed. A `notify` item clears once
 * seen: it asked for nothing but to be read.
 */
export const markSeen = mutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }): Promise<{ marked: number }> => {
    const viewer = await requireViewer(ctx);
    if (ids.length > ATTENTION_LIMITS.markSeenIds) {
      throw attentionError(
        "invalid_argument",
        `Mark at most ${ATTENTION_LIMITS.markSeenIds} items at a time.`,
      );
    }
    const now = Date.now();
    let marked = 0;
    for (const id of new Set(ids)) {
      const item = await findAttention(ctx, id);
      if (item === null || item.userId !== viewer.userId) continue;
      if (await markAttentionSeen(ctx, item, now)) marked += 1;
    }
    return { marked };
  },
});

/**
 * `volli notify`: the runner holding a Session tells the Session's owner
 * something in Needs you. Idempotent by `notifyId` (the runner's retry of one
 * call lands on the same item and never reopens one already seen). A runner
 * that does not hold the Session's claim is refused, so a runner cannot raise
 * an item through a Session it is not running.
 *
 * Receiving wiring (no production caller yet): S6-3 (VC-894) routes the
 * agent's `notify` verb here on a cloud Session, with the runner's token, and
 * answers the agent with "queued for {displayName}"; the unattended
 * Automation-run alert (`run-attention.ts`) uses the same call once
 * Automations run on runners.
 */
export const raiseFromRunner = mutation({
  args: {
    sessionId: v.string(),
    notifyId: v.string(),
    title: v.string(),
    detail: nullable(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ attentionId: string; userId: string; displayName: string; duplicate: boolean }> => {
    const caller = await requireRunnerForWrite(ctx);
    if (!isUuid(args.sessionId))
      throw attentionError("invalid_argument", "sessionId must be a UUID");
    if (!isUuid(args.notifyId)) throw attentionError("invalid_argument", "notifyId must be a UUID");
    const title = args.title.trim();
    if (title === "" || title.length > ATTENTION_LIMITS.notifyTitleLength) {
      throw attentionError(
        "invalid_argument",
        `A notification needs a title of 1 to ${ATTENTION_LIMITS.notifyTitleLength} characters.`,
      );
    }
    const detail = args.detail?.trim() || null;
    if (detail !== null && detail.length > ATTENTION_LIMITS.notifyDetailLength) {
      throw attentionError(
        "invalid_argument",
        `A notification's detail takes at most ${ATTENTION_LIMITS.notifyDetailLength} characters.`,
      );
    }
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", args.sessionId))
      .unique();
    // Another person's Session reads as absent: its existence is not the runner's to learn.
    if (
      session === null ||
      session.deletedAt !== null ||
      session.ownerUserId !== caller.ownerUserId
    ) {
      throw attentionError("not_found", "That session does not exist.");
    }
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", session.id))
      .unique();
    if (
      intake === null ||
      intake.state === "released" ||
      intake.claim.runnerId !== caller.runnerId
    ) {
      throw attentionError("fenced", "This runner does not hold the session's claim.");
    }
    if ((await findVisibleProject(ctx, caller.ownerUserId, session.projectId)) === null) {
      throw attentionError("not_found", "That session does not exist.");
    }
    const owner = await ctx.db
      .query("users")
      .withIndex("by_uuid", (q) => q.eq("id", session.ownerUserId))
      .unique();
    const sourceId = notifySourceId(args.notifyId);
    const attentionId = sessionAttentionId(session.id, sourceId);
    const duplicate = (await findAttention(ctx, attentionId)) !== null;
    if (!duplicate) {
      await raiseSessionAttention(ctx, session, {
        source: "notify",
        sourceId,
        kind: "notify",
        title,
        detail,
        raisedAt: Date.now(),
      });
    }
    return {
      attentionId,
      userId: session.ownerUserId,
      displayName: owner?.displayName ?? "the session's owner",
      duplicate,
    };
  },
});

/**
 * Clears, as `access_lost`, the open items `userId` holds in `workspaceId`
 * (through each item's project's current Workspace, or a billing item's own),
 * one page per step. Scheduled by a Member's suspension, removal or departure;
 * a person who is active there again by the time it runs keeps their items.
 */
export const sweepAccess = internalMutation({
  args: { userId: v.string(), workspaceId: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ cleared: number; done: boolean }> => {
    const membership = await findMembership(ctx, args.workspaceId, args.userId);
    if (
      isActiveMember({ userId: args.userId as UserId }, args.workspaceId as WorkspaceId, membership)
    ) {
      return { cleared: 0, done: true };
    }
    const page = await ctx.db
      .query("attentionItems")
      .withIndex("by_user_open", (q) => q.eq("userId", args.userId).eq("clearedAt", null))
      .paginate({ numItems: SWEEP_PAGE, cursor: args.cursor ?? null });
    const there = inWorkspace(ctx, args.workspaceId);
    const now = Date.now();
    let cleared = 0;
    for (const item of page.page) {
      if ((await there(item)) && (await clearForLostAccess(ctx, item, now))) cleared += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.attention.sweepAccess, {
        userId: args.userId,
        workspaceId: args.workspaceId,
        cursor: page.continueCursor,
      });
    }
    return { cleared, done: page.isDone };
  },
});
