/**
 * Test-only seeding and fixture resets for `test:backend`. Internal, so
 * only an admin key can call it, and it refuses to run on any deployment
 * that does not trust the test issuer (`VOLLI_TEST_JWKS`), which no cloud
 * deployment may set. Seeds create isolated worlds; resets prevent the
 * serial suite's shared loopback IP from sharing quotas between tests.
 */

import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { seedTestRunner, seedTestWorld } from "./lib/testWorld";
import { RATE_LIMIT_SWEEP_PAGE_SIZE } from "./lib/runnerLinkRateLimit";

function requireTestDeployment(): void {
  let trusted: string | undefined;
  try {
    trusted = process.env["VOLLI_TEST_JWKS"];
  } catch {
    trusted = undefined;
  }
  if (!trusted) throw new Error("Test seeding runs only on a test deployment.");
}

/** Each serial backend test gets fresh limiter state, not a shared loopback-IP quota. */
export const resetRunnerLinkLimits = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    requireTestDeployment();
    const rows = await ctx.db.query("runnerLinkRateLimits").take(RATE_LIMIT_SWEEP_PAGE_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

export const seedWorld = internalMutation({
  args: {
    ownerUserId: v.string(),
    memberUserIds: v.optional(v.array(v.string())),
    runners: v.optional(v.number()),
    shareAll: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    requireTestDeployment();
    return seedTestWorld(ctx, args);
  },
});

export const seedRunner = internalMutation({
  args: { ownerUserId: v.string(), name: v.string() },
  handler: async (ctx, { ownerUserId, name }) => {
    requireTestDeployment();
    return seedTestRunner(ctx, ownerUserId, name);
  },
});
