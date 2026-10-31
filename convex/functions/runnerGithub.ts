/**
 * `POST /runner/github-token` (`runnerHttp.ts`): a runner's GitHub user
 * token, for git in work it holds.
 *
 * The route authenticates the runner by its own token (`Authorization:
 * Bearer …`); {@link authorizeToken} then decides, in one read:
 * - the runner is live and its owner active ({@link requireRunner});
 * - it holds the claim the request names: a Session whose intake claim names
 *   this runner, or one not accepted yet that a job leased to this runner is
 *   starting; or a job leased to it now (`not_claimed` otherwise);
 * - the Session, when there is one, is the runner owner's (`not_your_runner`):
 *   a runner only runs its owner's work, so the token is always its owner's;
 * - the owner may still see the project (`not_found`), and the repository is
 *   the project's (`invalid_repo`).
 *
 * The token itself comes from `mintGithubToken` (`githubTokens.ts`): handed
 * out until 30 minutes before it expires, refreshed under a lease. Only the
 * access token leaves; the refresh token never does.
 */

import { ConvexError, v } from "convex/values";

import {
  githubNoreplyEmail,
  type RunnerGitIdentity,
  type RunnerGithubTokenClaim,
  type RunnerGithubTokenErrorCode,
} from "@volli/shared/cloud";

import type { Doc } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { requireRunner, type CallingRunner } from "./lib/runnerAuth";
import { projectRepoOf, runnerProject } from "./lib/runnerContext";

/** How many of a Session's newest jobs are searched for the lease that is starting it. */
const STARTING_JOB_SCAN = 32;

function refuse(code: RunnerGithubTokenErrorCode, message: string) {
  return new ConvexError({ code, message });
}

function notClaimed() {
  return refuse("not_claimed", "This runner does not hold that claim.");
}

function liveLease(job: Doc<"runnerJobs">, caller: CallingRunner, now: number): boolean {
  return (
    job.runnerId === caller.runnerId &&
    job.status === "leased" &&
    job.lease !== null &&
    job.lease.expiresAt > now
  );
}

async function sessionOf(ctx: QueryCtx, sessionId: string) {
  return ctx.db
    .query("sessions")
    .withIndex("by_uuid", (q) => q.eq("id", sessionId))
    .unique();
}

/** The project the claim's work is in, after the claim and ownership checks. */
async function claimedProject(
  ctx: QueryCtx,
  caller: CallingRunner,
  claim: RunnerGithubTokenClaim,
): Promise<string> {
  const now = Date.now();
  let sessionId: string | null;
  let projectId: string | null = null;
  if (claim.kind === "session") {
    sessionId = claim.sessionId;
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", claim.sessionId))
      .unique();
    if (intake !== null) {
      if (intake.state === "released" || intake.claim.runnerId !== caller.runnerId) {
        throw notClaimed();
      }
    } else {
      // Not accepted yet: a Session this runner is starting under a leased job.
      const jobs = await ctx.db
        .query("runnerJobs")
        .withIndex("by_session", (q) => q.eq("sessionId", claim.sessionId))
        .order("desc")
        .take(STARTING_JOB_SCAN);
      const starting = jobs.find((job) => liveLease(job, caller, now));
      if (starting === undefined) throw notClaimed();
      projectId = starting.projectId;
    }
  } else {
    const job = await ctx.db
      .query("runnerJobs")
      .withIndex("by_uuid", (q) => q.eq("id", claim.jobId))
      .unique();
    if (job === null || !liveLease(job, caller, now)) throw notClaimed();
    sessionId = job.sessionId;
    projectId = job.projectId;
  }
  const session = sessionId === null ? null : await sessionOf(ctx, sessionId);
  if (session !== null) {
    if (session.deletedAt !== null) throw refuse("not_found", "That session does not exist.");
    if (session.ownerUserId !== caller.ownerUserId) {
      throw refuse("not_your_runner", "A runner only runs its owner's sessions.");
    }
    if (projectId !== null && projectId !== session.projectId) throw notClaimed();
    projectId = session.projectId;
  }
  if (projectId === null) throw notClaimed();
  return projectId;
}

/** The commit identity for a GitHub account: its name (or login) and no-reply email. */
function gitIdentityOf(
  connection: Pick<Doc<"githubConnections">, "name" | "login" | "githubUserId">,
): RunnerGitIdentity {
  const name = connection.name?.trim() || connection.login;
  return { name, email: githubNoreplyEmail(connection.githubUserId, connection.login) };
}

/**
 * Whose GitHub token a runner may have for this claim and repository (always
 * the runner's owner), and the git identity commits take. Internal:
 * `/runner/github-token` calls it under the runner's own identity.
 */
export const authorizeToken = internalQuery({
  args: {
    claim: v.union(
      v.object({ kind: v.literal("session"), sessionId: v.string() }),
      v.object({ kind: v.literal("job"), jobId: v.string() }),
    ),
    projectRepoId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ownerUserId: string; identity: RunnerGitIdentity | null }> => {
    const caller = await requireRunner(ctx);
    const projectId = await claimedProject(ctx, caller, args.claim as RunnerGithubTokenClaim);
    const project = await runnerProject(ctx, caller, projectId);
    await projectRepoOf(ctx, project, args.projectRepoId);
    const connection = await ctx.db
      .query("githubConnections")
      .withIndex("by_user", (q) => q.eq("userId", caller.ownerUserId))
      .unique();
    return {
      ownerUserId: caller.ownerUserId,
      identity: connection === null ? null : gitIdentityOf(connection),
    };
  },
});
