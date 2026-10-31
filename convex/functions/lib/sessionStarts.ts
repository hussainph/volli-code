/**
 * What the backend owes a `session.start` beyond its job: the first message
 * staged under a Session that may never be born (`sessionStarts.ts`).
 */
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server";

/**
 * Drops the first message staged for a start whose Session was never born,
 * as the sweep deletes the finished job: nothing else references that row
 * (a project purge finds staged bodies through their Session), so it would
 * otherwise keep the person's words with no owner. A born Session's rows are
 * its own and stay.
 */
export async function dropUnbornStartBody(
  ctx: Pick<MutationCtx, "db">,
  job: Doc<"runnerJobs">,
): Promise<void> {
  if (job.kind !== "session.start" || job.sessionId === null) return;
  const sessionId = job.sessionId;
  const born = await ctx.db
    .query("sessions")
    .withIndex("by_uuid", (q) => q.eq("id", sessionId))
    .unique();
  if (born !== null) return;
  for (const row of await ctx.db
    .query("transcriptArtifacts")
    .withIndex("by_session_digest", (q) => q.eq("sessionId", sessionId))
    .take(16)) {
    if (row.uploadedBy === "client" && row.firstSequence === null) await ctx.db.delete(row._id);
  }
}
