/** A runner's project checkout metadata. Its absolute directory stays local. */
import { v } from "convex/values";

import { parseId } from "@volli/shared/cloud";

import { mutation, query } from "./_generated/server";
import { publicRow } from "./lib/board";
import { requireRunner, requireRunnerForWrite } from "./lib/runnerAuth";
import { checkGitMetadata, primaryRepo, reportedRepo, runnerProject } from "./lib/runnerContext";
import { literals, nullable } from "./lib/validators";

/** Upserts by the calling runner and repository, including a folder project's first report. */
export const report = mutation({
  args: {
    projectId: v.string(),
    projectRepoId: v.string(),
    kind: literals(["main", "managed_clone"]),
    headBranch: nullable(v.string()),
    headSha: v.optional(nullable(v.string())),
  },
  handler: async (ctx, args) => {
    const caller = await requireRunnerForWrite(ctx);
    const project = await runnerProject(ctx, caller, args.projectId);
    await reportedRepo(ctx, project, args.projectRepoId);
    checkGitMetadata([args.headBranch, args.headSha]);
    const existing = await ctx.db
      .query("projectCheckouts")
      .withIndex("by_runner_repo", (q) =>
        q.eq("runnerId", caller.runnerId).eq("projectRepoId", args.projectRepoId),
      )
      .unique();
    const patch = {
      kind: args.kind,
      headBranch: args.headBranch,
      ...(args.headSha === undefined ? {} : { headSha: args.headSha }),
      reportedAt: Date.now(),
    };
    if (existing === null) {
      await ctx.db.insert("projectCheckouts", {
        runnerId: caller.runnerId,
        projectId: project.id,
        projectRepoId: args.projectRepoId,
        ...patch,
      });
    } else {
      await ctx.db.patch(existing._id, patch);
    }
    return { projectRepoId: args.projectRepoId };
  },
});

/** Only this runner's checkout; omitting projectRepoId selects the primary repository. */
export const locate = query({
  args: { projectId: v.string(), projectRepoId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const caller = await requireRunner(ctx);
    const project = await runnerProject(ctx, caller, args.projectId);
    const projectRepoId = args.projectRepoId ?? (await primaryRepo(ctx, project)).id;
    parseId("projectRepo", projectRepoId);
    const checkout = await ctx.db
      .query("projectCheckouts")
      .withIndex("by_runner_repo", (q) =>
        q.eq("runnerId", caller.runnerId).eq("projectRepoId", projectRepoId),
      )
      .unique();
    if (checkout === null || checkout.projectId !== project.id) return null;
    return { ...publicRow(checkout), headSha: checkout.headSha ?? null };
  },
});
