/**
 * Test-only hooks into the runner inbox for the fixture backend
 * (`test:backend`): enqueue a job the way a producer does, read a job row, and
 * age a lease without waiting a minute. Internal, so only an admin key can
 * call them, and each refuses to run on a deployment that does not trust the
 * test issuer (`VOLLI_TEST_JWKS`), which no cloud deployment may set.
 */

import { v } from "convex/values";

import { internalMutation, type MutationCtx } from "./_generated/server";
import { enqueueJob, type JobDraft } from "./lib/jobs";

function requireTestDeployment(): void {
  let trusted: string | undefined;
  try {
    trusted = process.env["VOLLI_TEST_JWKS"];
  } catch {
    trusted = undefined;
  }
  if (!trusted) throw new Error("Test hooks run only on a test deployment.");
}

async function row(ctx: Pick<MutationCtx, "db">, jobId: string) {
  return ctx.db
    .query("runnerJobs")
    .withIndex("by_uuid", (q) => q.eq("id", jobId))
    .unique();
}

export const enqueue = internalMutation({
  args: { draft: v.any() },
  handler: async (ctx, { draft }) => {
    requireTestDeployment();
    return enqueueJob(ctx, draft as JobDraft);
  },
});

export const inspect = internalMutation({
  args: { jobId: v.string() },
  handler: async (ctx, { jobId }) => {
    requireTestDeployment();
    const job = await row(ctx, jobId);
    if (job === null) return null;
    const { _id, _creationTime, ...fields } = job;
    void _id;
    void _creationTime;
    return fields;
  },
});

/** Makes the job's current lease run out now, as if its minute had passed. */
export const ageLease = internalMutation({
  args: { jobId: v.string() },
  handler: async (ctx, { jobId }) => {
    requireTestDeployment();
    const job = await row(ctx, jobId);
    if (job === null || job.lease === null) throw new Error("No lease to age.");
    await ctx.db.patch(job._id, { lease: { ...job.lease, expiresAt: Date.now() - 1 } });
  },
});
