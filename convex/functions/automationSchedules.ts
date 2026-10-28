/**
 * The Automation clock's cron entry (`crons.ts`, every minute). One pass reads
 * the due schedules a page per transaction (`lib/automationClock.ts`) and
 * chains itself for the next page with the same `now`, so a busy top of the
 * hour never becomes one large transaction.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { fireDuePage } from "./lib/automationClock";
import { nullable } from "./lib/validators";

export const fireDue = internalMutation({
  args: { now: v.optional(v.number()), cursor: v.optional(nullable(v.string())) },
  handler: async (ctx, args) => {
    // Never early: a continuation keeps its pass's `now`, never a later one.
    const now = Math.min(args.now ?? Date.now(), Date.now());
    const result = await fireDuePage(ctx, { now, cursor: args.cursor ?? null });
    if (result.continueCursor !== null)
      await ctx.scheduler.runAfter(0, internal.automationSchedules.fireDue, {
        now,
        cursor: result.continueCursor,
      });
    return result;
  },
});
