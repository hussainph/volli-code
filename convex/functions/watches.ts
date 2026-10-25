/** Agent-scoped durable watch commands. The runner never keeps a second copy. */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query, internalMutation } from "./_generated/server";
import { requireActor, PERSON_OR_AGENT } from "./lib/actorAuth";
import { requireSessionActor } from "./lib/auth";
import { armWatch, endWatch, watchAccess, watchError } from "./lib/watches";

const target = v.object({
  kind: v.union(v.literal("session"), v.literal("ticket")),
  id: v.string(),
});

async function watcher(ctx: Parameters<typeof requireActor>[0], id: string) {
  const caller = await requireActor(ctx, PERSON_OR_AGENT);
  if (caller.kind !== "agent" || caller.agent.sessionId !== id) {
    throw watchError("forbidden", "Only the watching Session can manage its watches.");
  }
  const { session } = await requireSessionActor(ctx, id, caller.viewer);
  return { caller, session };
}

export const watch = mutation({
  args: { watcherSessionId: v.string(), target, commandId: v.string() },
  handler: async (ctx, args) => {
    const { caller, session } = await watcher(ctx, args.watcherSessionId);
    const watchId = await armWatch(ctx, {
      watcher: session,
      target: args.target,
      origin: "explicit",
      actor: caller.actor,
      commandId: args.commandId,
    });
    return { watchId };
  },
});

export const unwatch = mutation({
  args: { watcherSessionId: v.string(), targets: v.optional(v.array(target)) },
  handler: async (ctx, args) => {
    await watcher(ctx, args.watcherSessionId);
    const rows = await ctx.db
      .query("watches")
      .withIndex("by_watcher", (q) =>
        q.eq("watcherSessionId", args.watcherSessionId).eq("endedAt", null),
      )
      .collect();
    let ended = 0;
    for (const row of rows) {
      if (
        args.targets === undefined ||
        args.targets.some((t) => t.kind === row.target.kind && t.id === row.target.id)
      ) {
        await endWatch(ctx, row, "unwatched");
        ended += 1;
      }
    }
    return { ended };
  },
});

export const list = query({
  args: { watcherSessionId: v.string() },
  handler: async (ctx, args) => {
    await watcher(ctx, args.watcherSessionId);
    const rows = await ctx.db
      .query("watches")
      .withIndex("by_watcher", (q) =>
        q.eq("watcherSessionId", args.watcherSessionId).eq("endedAt", null),
      )
      .collect();
    return rows.map((row) => ({
      id: row.id,
      target: row.target,
      origin: row.origin ?? "explicit",
      turnArmed: row.turnArmed ?? true,
      createdAt: row.createdAt,
    }));
  },
});

/** Bounded pages, including dormant watches: expiry/access loss need no new fact to clean them. */
export const sweep = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("watches")
      .withIndex("by_open", (q) => q.eq("endedAt", null))
      .paginate({ cursor: args.cursor ?? null, numItems: 100 });
    for (const row of page.page) await watchAccess(ctx, row);
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.watches.sweep, { cursor: page.continueCursor });
    const receipts = await ctx.db
      .query("watchReceipts")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now()))
      .take(100);
    for (const receipt of receipts) await ctx.db.delete(receipt._id);
    if (page.isDone && receipts.length === 100)
      await ctx.scheduler.runAfter(0, internal.watches.sweep, {});
  },
});
