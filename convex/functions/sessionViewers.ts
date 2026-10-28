/**
 * Who is watching a Session: the gate on streamed text.
 *
 * A client that shows a Session opens a viewer, renews it every
 * {@link SESSION_VIEWER_HEARTBEAT_MS} and closes it when the Session leaves
 * the screen. The runner that runs the Session subscribes to `watched` and
 * streams chunks only for the Sessions in it; an unwatched Session sends
 * facts only.
 *
 * The keep-alive lives in `sessionViewerHeartbeats`, a separate document, so
 * the runner's `watched` subscription re-runs on open and close only, never
 * on a heartbeat. A viewer whose heartbeat expires is swept by a cron, which
 * is how a client that vanished without closing stops a stream.
 */

import { ConvexError, v } from "convex/values";

import { SESSION_VIEWER_HEARTBEAT_MS, SESSION_VIEWER_TTL_MS, isUuid } from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { requireSessionVisible, requireViewer } from "./lib/auth";
import { requireRunner } from "./lib/runnerAuth";

export type SessionViewerErrorCode = "invalid_viewer" | "id_taken" | "too_many_viewers";

function viewerError(code: SessionViewerErrorCode, message: string) {
  return new ConvexError({ code, message });
}

/** The most viewer rows `watched` reads for one runner. */
export const WATCHED_MAX_VIEWERS = 1000;
/**
 * The most viewers one Session may have open, so no one Session (or person)
 * can crowd the others out of their runner's `watched` read.
 */
export const SESSION_MAX_VIEWERS = 32;
/** Lapsed viewers one sweep step removes before it schedules the next. */
export const VIEWER_SWEEP_BATCH = 256;

export interface ViewerLease {
  viewerId: string;
  /** When the viewer lapses unless renewed. */
  expiresAt: number;
  /** How often the client renews it. */
  heartbeatMs: number;
}

async function viewerRow(
  ctx: MutationCtx,
  viewerId: string,
): Promise<Doc<"sessionViewers"> | null> {
  return ctx.db
    .query("sessionViewers")
    .withIndex("by_uuid", (q) => q.eq("id", viewerId))
    .unique();
}

async function renew(ctx: MutationCtx, viewerId: string, expiresAt: number): Promise<void> {
  const beat = await ctx.db
    .query("sessionViewerHeartbeats")
    .withIndex("by_viewer", (q) => q.eq("viewerId", viewerId))
    .unique();
  if (beat === null) await ctx.db.insert("sessionViewerHeartbeats", { viewerId, expiresAt });
  else await ctx.db.patch(beat._id, { expiresAt });
}

async function remove(ctx: MutationCtx, viewer: Doc<"sessionViewers">): Promise<void> {
  const beat = await ctx.db
    .query("sessionViewerHeartbeats")
    .withIndex("by_viewer", (q) => q.eq("viewerId", viewer.id))
    .unique();
  if (beat !== null) await ctx.db.delete(beat._id);
  await ctx.db.delete(viewer._id);
}

/**
 * The caller starts watching a Session they can see. The client mints
 * `viewerId`; opening it again (a retry, a reconnect) renews it.
 */
export const open = mutation({
  args: {
    viewerId: v.string(),
    sessionId: v.string(),
    clientSessionId: v.string(),
    // New windows can probe a runner-originated birth without a server-error
    // log. Missing and hidden Sessions stay indistinguishable; older clients
    // retain their not_found contract.
    allowMissing: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ViewerLease | { open: false }> => {
    let scope: Awaited<ReturnType<typeof requireSessionVisible>>;
    try {
      scope = await requireSessionVisible(ctx, args.sessionId);
    } catch (error) {
      if (args.allowMissing && error instanceof ConvexError && error.data?.code === "not_found")
        return { open: false };
      throw error;
    }
    const { viewer, session } = scope;
    if (!isUuid(args.viewerId)) throw viewerError("invalid_viewer", "A viewer id is a UUID.");
    if (args.clientSessionId.length === 0 || args.clientSessionId.length > 200) {
      throw viewerError("invalid_viewer", "A client session id is 1 to 200 characters.");
    }
    const now = Date.now();
    const existing = await viewerRow(ctx, args.viewerId);
    if (existing === null) {
      const opened = await ctx.db
        .query("sessionViewers")
        .withIndex("by_session", (q) => q.eq("sessionId", session.id))
        .take(SESSION_MAX_VIEWERS);
      if (opened.length >= SESSION_MAX_VIEWERS) {
        throw viewerError("too_many_viewers", "This session has too many viewers open.");
      }
      await ctx.db.insert("sessionViewers", {
        id: args.viewerId,
        sessionId: session.id,
        runnerId: session.placeRunnerId,
        userId: viewer.userId,
        clientSessionId: args.clientSessionId,
        openedAt: now,
      });
    } else if (existing.userId !== viewer.userId || existing.sessionId !== session.id) {
      throw viewerError("id_taken", "That viewer id is in use.");
    }
    const expiresAt = now + SESSION_VIEWER_TTL_MS;
    await renew(ctx, args.viewerId, expiresAt);
    return { viewerId: args.viewerId, expiresAt, heartbeatMs: SESSION_VIEWER_HEARTBEAT_MS };
  },
});

/**
 * Renews the caller's viewer. `open: false` means it lapsed, was closed, or
 * its Session is no longer one the caller can see: open a new one to watch
 * again.
 */
export const heartbeat = mutation({
  args: { viewerId: v.string() },
  handler: async (ctx, args): Promise<{ open: false } | ({ open: true } & ViewerLease)> => {
    const { userId } = await requireViewer(ctx);
    const existing = await viewerRow(ctx, args.viewerId);
    if (existing === null || existing.userId !== userId) return { open: false };
    try {
      await requireSessionVisible(ctx, existing.sessionId);
    } catch (error) {
      // The Session is gone or no longer the caller's to see: that ends the
      // viewer. Anything else is a real failure.
      if (!(error instanceof ConvexError) || error.data?.code !== "not_found") throw error;
      await remove(ctx, existing);
      return { open: false };
    }
    const expiresAt = Date.now() + SESSION_VIEWER_TTL_MS;
    await renew(ctx, existing.id, expiresAt);
    return {
      open: true,
      viewerId: existing.id,
      expiresAt,
      heartbeatMs: SESSION_VIEWER_HEARTBEAT_MS,
    };
  },
});

/** The caller stops watching. Idempotent. */
export const close = mutation({
  args: { viewerId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const { userId } = await requireViewer(ctx);
    const existing = await viewerRow(ctx, args.viewerId);
    if (existing !== null && existing.userId === userId) await remove(ctx, existing);
    return null;
  },
});

/**
 * The Sessions the calling runner runs that someone is watching: the runner's
 * one subscription. It reads viewer rows only, which change on open and
 * close, so a heartbeat never re-runs it.
 */
export const watched = query({
  args: {},
  handler: async (ctx): Promise<{ sessionIds: string[] }> => {
    const { runnerId } = await requireRunner(ctx);
    const viewers = await ctx.db
      .query("sessionViewers")
      .withIndex("by_runner", (q) => q.eq("runnerId", runnerId))
      .take(WATCHED_MAX_VIEWERS);
    return { sessionIds: [...new Set(viewers.map((viewer) => viewer.sessionId))].toSorted() };
  },
});

/** Removes viewers whose heartbeat lapsed, in batches. */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const beats = await ctx.db
      .query("sessionViewerHeartbeats")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(VIEWER_SWEEP_BATCH + 1);
    const batch = beats.slice(0, VIEWER_SWEEP_BATCH);
    for (const beat of batch) {
      const viewer = await viewerRow(ctx, beat.viewerId);
      if (viewer !== null) await ctx.db.delete(viewer._id);
      await ctx.db.delete(beat._id);
    }
    if (beats.length > VIEWER_SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.sessionViewers.sweepExpired, {});
    }
    return batch.length;
  },
});
