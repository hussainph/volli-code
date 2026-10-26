/**
 * The linking doors' rate limits (`lib/runnerLinkRateLimit.ts`): the
 * admissions `runnerHttp.ts` asks for before it does any work, and the hourly
 * sweep of refilled buckets (`crons.ts`).
 *
 * Each `ip` is the address Convex saw for the request (`ctx.meta`), passed by
 * the HTTP action; these functions are internal, so no caller can name
 * another address.
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import {
  RATE_LIMIT_SWEEP_PAGE_SIZE,
  admit,
  linkBuckets,
  linkPollBuckets,
  linkStartBuckets,
  sweepRefilled,
  type Admission,
} from "./lib/runnerLinkRateLimit";
import { nullable } from "./lib/validators";

/** One device-code start. */
export const admitLinkStart = internalMutation({
  args: { ip: nullable(v.string()) },
  handler: (ctx, { ip }): Promise<Admission> => admit(ctx, linkStartBuckets(ip), Date.now()),
});

/** One install-token link; a token that names a real row also takes from that token's bucket. */
export const admitLink = internalMutation({
  args: { ip: nullable(v.string()), tokenHash: v.string() },
  handler: async (ctx, { ip, tokenHash }): Promise<Admission> => {
    const token = await ctx.db
      .query("runnerInstallTokens")
      .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    return admit(ctx, linkBuckets(ip, token?.id ?? null), Date.now());
  },
});

/** One device-code poll; a request id that names a real request also takes from its bucket. */
export const admitLinkPoll = internalMutation({
  args: { ip: nullable(v.string()), requestId: v.string() },
  handler: async (ctx, { ip, requestId }): Promise<Admission> => {
    const request = await ctx.db
      .query("runnerLinkRequests")
      .withIndex("by_uuid", (q) => q.eq("id", requestId))
      .unique();
    return admit(ctx, linkPollBuckets(ip, request?.id ?? null), Date.now());
  },
});

/** Deletes buckets that have refilled (an absent bucket is a full one), a page at a time. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const deleted = await sweepRefilled(ctx, Date.now());
    if (deleted === RATE_LIMIT_SWEEP_PAGE_SIZE) {
      await ctx.scheduler.runAfter(0, internal.runnerLinkRateLimit.sweep, {});
    }
    return { deleted };
  },
});
