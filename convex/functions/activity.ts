/**
 * The activity feed: a project's or a Workspace's board history, newest
 * first, folded into feed items for the viewer (`lib/activity.ts`; the
 * view-model and the folding rules are `activity.ts` in `@volli/shared/cloud`).
 *
 * Both queries take `page: {numItems, cursor, endCursor?}` and return an
 * `ActivityPage`. The contract is Convex's pagination with our own cursor,
 * so `usePaginatedQuery` does not drive it: a client requests the first
 * page with `cursor: null`, each next page with the previous page's
 * `continueCursor`, and pins every loaded page to its own `continueCursor`
 * (`endCursor`) once it requests the page after it, so pages stay
 * contiguous while new events arrive at the top. `numItems` counts feed
 * items, not events.
 *
 * Optional filters: `person` (what one person did, through any client, agent
 * or Automation) and `since` (a time window). Every function requires a
 * signed-in active Member of the Workspace, refused with the shared codes
 * (`not_found`, `not_a_member`) otherwise.
 */

import { v } from "convex/values";

import type { WorkspaceId } from "@volli/shared/cloud";

import { query } from "./_generated/server.js";
import { findPolicy, requireMember, requireProject } from "./lib/auth";
import { readFeed, sessionVisibility, type FeedFilter } from "./lib/activity";
import { nullable } from "./lib/validators";

const page = v.object({
  numItems: v.number(),
  cursor: nullable(v.string()),
  endCursor: v.optional(nullable(v.string())),
});

const filters = {
  person: v.optional(nullable(v.string())),
  since: v.optional(nullable(v.number())),
};

function filterOf(args: { person?: string | null; since?: number | null }): FeedFilter {
  return { person: args.person ?? null, since: args.since ?? null };
}

/** One project's activity. */
export const project = query({
  args: { projectId: v.string(), page, ...filters },
  handler: async (ctx, args) => {
    const access = await requireProject(ctx, args.projectId);
    const { viewer, membership } = access;
    const policy = await findPolicy(ctx, access.project.workspaceId);
    return readFeed(
      ctx,
      {
        viewer,
        workspaceId: access.project.workspaceId as WorkspaceId,
        projects: [access.project],
        canSee: sessionVisibility(ctx, viewer, membership, policy),
      },
      filterOf(args),
      args.page,
    );
  },
});

/** A Workspace's activity: every live project's, archived ones included, merged by time. */
export const workspace = query({
  args: { workspaceId: v.string(), page, ...filters },
  handler: async (ctx, args) => {
    const { viewer, membership } = await requireMember(ctx, args.workspaceId);
    const policy = await findPolicy(ctx, args.workspaceId);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId).eq("deletedAt", null))
      .collect();
    return readFeed(
      ctx,
      {
        viewer,
        workspaceId: args.workspaceId as WorkspaceId,
        projects,
        canSee: sessionVisibility(ctx, viewer, membership, policy),
      },
      filterOf(args),
      args.page,
    );
  },
});
