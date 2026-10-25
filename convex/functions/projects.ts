/**
 * Projects within a Workspace: create, rename, archive and restore, and the
 * reads a project rail needs.
 *
 * Any active Member of the Workspace may create or change a project (all
 * Members see all projects in 0.3); every change is a board event on the
 * project (`ticketId: null`), so the project's history and the activity feed
 * carry it. The ticket prefix is fixed at creation and unique among the
 * Workspace's live projects then. Creating a project also creates its
 * counter document, which numbers its tickets and orders its board events.
 *
 * Out of scope here: repositories and the GitHub App (P1), moving a project
 * between Workspaces (P1), the Free plan's project cap (billing), deletion
 * (retention).
 */

import { v } from "convex/values";

import {
  decideArchiveProject,
  decideCreateProject,
  decideRenameProject,
  parseId,
  type ProjectDecision,
} from "@volli/shared/cloud";

import { mutation, query, type MutationCtx } from "./_generated/server.js";
import { requireMember, requireProject } from "./lib/auth";
import { boardActor, boardError, publicRow, recordBoardEvents } from "./lib/board";
import { withBoardReceipt } from "./lib/boardReceipts";
import { literals } from "./lib/validators";

/** The projects of a Workspace the viewer belongs to, archived ones included, by name. */
export const list = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, { workspaceId }) => {
    await requireMember(ctx, workspaceId);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("deletedAt", null))
      .collect();
    return projects.map(publicRow);
  },
});

/** One project the viewer can see. */
export const get = query({
  args: { projectId: v.string() },
  handler: async (ctx, { projectId }) => publicRow((await requireProject(ctx, projectId)).project),
});

/**
 * Creates a project with a caller-minted id. `origin` says where it came
 * from: a GitHub repository (P1 adds its repositories), a promoted local
 * project, or nothing yet (`blank`: a desktop's "New project", VC-889);
 * migrated projects are created by the migration, not here.
 */
export const create = mutation({
  args: {
    commandId: v.string(),
    workspaceId: v.string(),
    projectId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    ticketPrefix: v.optional(v.string()),
    origin: literals(["github", "promoted_local", "blank"]),
  },
  handler: async (ctx, args) => {
    const { commandId, ...intent } = args;
    return withBoardReceipt(ctx, { commandId, operation: "projects.create", intent }, async () => {
      const { viewer } = await requireMember(ctx, args.workspaceId);
      const projectId = parseId("project", args.projectId);
      const taken = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", projectId))
        .unique();
      if (taken !== null) throw boardError("id_taken", "That project id is already in use.");
      const live = await ctx.db
        .query("projects")
        .withIndex("by_workspace", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("deletedAt", null),
        )
        .collect();
      const decision = decideCreateProject(
        { projects: live },
        { name: args.name, description: args.description, ticketPrefix: args.ticketPrefix },
      );
      const now = Date.now();
      await ctx.db.insert("projects", {
        id: projectId,
        workspaceId: args.workspaceId,
        name: decision.name,
        description: decision.description,
        iconKey: null,
        colorIndex: decision.colorIndex,
        ticketPrefix: decision.ticketPrefix,
        origin: args.origin,
        shipBehaviour: "pr",
        customShipPrompt: null,
        coAuthorDefault: true,
        countsTowardCap: true,
        createdByUserId: viewer.userId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        purgeAfter: null,
      });
      await ctx.db.insert("projectCounters", { projectId, nextTicketNumber: 1, boardSeq: 0 });
      await recordBoardEvents(ctx, projectId, boardActor(viewer), now, decision.events);
      return { projectId, reply: { projectId, ticketPrefix: decision.ticketPrefix } };
    });
  },
});

async function changeProject(
  ctx: MutationCtx,
  args: { commandId: string; projectId: string },
  operation: string,
  intent: unknown,
  decide: (project: { name: string; archivedAt: number | null }, now: number) => ProjectDecision,
) {
  return withBoardReceipt(ctx, { commandId: args.commandId, operation, intent }, async () => {
    const { viewer, project } = await requireProject(ctx, args.projectId);
    const now = Date.now();
    const decision = decide(project, now);
    if (decision.events.length > 0) {
      await ctx.db.patch(project._id, { ...decision.patch, updatedAt: now });
      await recordBoardEvents(ctx, project.id, boardActor(viewer), now, decision.events);
    }
    return {
      projectId: project.id,
      reply: { projectId: project.id, changed: decision.events.length > 0 },
    };
  });
}

/** Renames a project; its ticket prefix (and so every ticket key) stays. */
export const rename = mutation({
  args: { commandId: v.string(), projectId: v.string(), name: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    changeProject(
      ctx,
      { commandId, projectId: intent.projectId },
      "projects.rename",
      intent,
      (project) => decideRenameProject(project, intent.name),
    ),
});

/** Archives a project: hidden from the rail, its board takes no writes, everything is kept. */
export const archive = mutation({
  args: { commandId: v.string(), projectId: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    changeProject(
      ctx,
      { commandId, projectId: intent.projectId },
      "projects.archive",
      intent,
      (project, now) => decideArchiveProject(project, true, now),
    ),
});

/** Restores an archived project. */
export const unarchive = mutation({
  args: { commandId: v.string(), projectId: v.string() },
  handler: async (ctx, { commandId, ...intent }) =>
    changeProject(
      ctx,
      { commandId, projectId: intent.projectId },
      "projects.unarchive",
      intent,
      (project, now) => decideArchiveProject(project, false, now),
    ),
});
