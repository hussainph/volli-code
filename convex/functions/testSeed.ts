/**
 * Test-only seeding for the fixture backend (`test:backend`). Internal, so
 * only an admin key can call it, and it refuses to run on any deployment
 * that does not trust the test issuer (`VOLLI_TEST_JWKS`), which no cloud
 * deployment may set. It goes when the areas that create these rows for
 * real (Workspaces, the board, runner registration) are all in place.
 */

import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { seedTestRunner, seedTestWorld } from "./lib/testWorld";

function requireTestDeployment(): void {
  let trusted: string | undefined;
  try {
    trusted = process.env["VOLLI_TEST_JWKS"];
  } catch {
    trusted = undefined;
  }
  if (!trusted) throw new Error("Test seeding runs only on a test deployment.");
}

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
