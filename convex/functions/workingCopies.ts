/** Runner-reported Working copy facts, naturally idempotent by (ticket, runner, repo). */
import { v } from "convex/values";

import { newId, WORKING_COPY_STATES } from "@volli/shared/cloud";

import { mutation } from "./_generated/server";
import { requireRunnerForWrite } from "./lib/runnerAuth";
import { checkGitMetadata, reportedRepo, runnerProject, runnerTicket } from "./lib/runnerContext";
import { literals, nullable } from "./lib/validators";

/**
 * The runner id and owner come only from the token. A runner-originated start
 * needs no pre-existing job or Working copy id; the backend mints the id once.
 * Existing dirty/ahead/setup metadata is not reset by this smaller report.
 */
export const report = mutation({
  args: {
    ticketId: v.string(),
    projectRepoId: v.string(),
    kind: literals(["worktree", "main_checkout", "clone", "sandbox"]),
    state: literals(WORKING_COPY_STATES),
    branch: nullable(v.string()),
    baseBranch: nullable(v.string()),
    headSha: nullable(v.string()),
  },
  handler: async (ctx, args) => {
    const caller = await requireRunnerForWrite(ctx);
    const ticket = await runnerTicket(ctx, args.ticketId);
    const project = await runnerProject(ctx, caller, ticket.projectId);
    await reportedRepo(ctx, project, args.projectRepoId);
    checkGitMetadata([args.branch, args.baseBranch, args.headSha]);
    const existing = await ctx.db
      .query("workingCopies")
      .withIndex("by_ticket_runner_repo", (q) =>
        q
          .eq("ticketId", ticket.id)
          .eq("runnerId", caller.runnerId)
          .eq("projectRepoId", args.projectRepoId),
      )
      .unique();
    const now = Date.now();
    const patch = {
      kind: args.kind,
      state: args.state,
      branch: args.branch,
      baseBranch: args.baseBranch,
      headSha: args.headSha,
      reportedAt: now,
    };
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        ...patch,
        ...(args.state === "failed" ? {} : { failure: null }),
      });
      return { workingCopyId: existing.id };
    }
    const workingCopyId = newId("workingCopy");
    await ctx.db.insert("workingCopies", {
      id: workingCopyId,
      ticketId: ticket.id,
      projectId: project.id,
      runnerId: caller.runnerId,
      projectRepoId: args.projectRepoId,
      ...patch,
      failure: null,
      upstreamSha: null,
      ahead: 0,
      behind: 0,
      dirty: { files: 0, insertions: 0, deletions: 0, untracked: 0, truncated: false },
      changeSetRevision: null,
      firstRun: { copy: args.state === "ready" ? "done" : "pending", setup: "pending" },
      setupRecipeSha: null,
      setupOutcome: null,
      lastResumeAt: null,
      lastResumeBootId: null,
      createdAt: now,
    });
    return { workingCopyId };
  },
});
