/**
 * The board receipts' sweep. A receipt answers retries for seven days
 * (`lib/boardReceipts.ts`); past that it already reads as absent, so this only
 * reclaims the space, a batch at a time, from the hourly cron (`crons.ts`).
 */

import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

/** How many expired receipts one sweep removes before it reschedules itself. */
export const RECEIPT_SWEEP_BATCH = 256;

/** Removes expired receipts, oldest first; reschedules itself while a full batch came back. */
export const prune = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ removed: number }> => {
    const expired = await ctx.db
      .query("boardReceipts")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now()))
      .take(RECEIPT_SWEEP_BATCH);
    for (const receipt of expired) await ctx.db.delete(receipt._id);
    if (expired.length === RECEIPT_SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.boardReceipts.prune, {});
    }
    return { removed: expired.length };
  },
});
