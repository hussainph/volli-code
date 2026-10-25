/**
 * Workspaces: the switcher's list, one Workspace's summary, creating one
 * (beyond the personal one every account gets at sign-up), its name and its
 * admin policy.
 *
 * There are no Workspace types. A Workspace is a set of Members with roles,
 * one plan and one policy. The policy has two settings: `shareAll` ("make
 * everything shared") and `whoCanInvite` (default `members`). Owners and
 * admins change them; every Member reads them.
 */

import { v } from "convex/values";

import {
  DEFAULT_WORKSPACE_POLICY,
  WHO_CAN_INVITE,
  type MemberRole,
  type WhoCanInvite,
} from "@volli/shared/cloud";

import { requirePreviewAccess } from "./lib/previewAccess";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel.js";
import { requireManage, requireMember, requireViewer } from "./lib/auth";
import { literals } from "./lib/validators";
import { audit } from "./lib/audit";
import {
  createWorkspace,
  findMemberRow,
  findWorkspace,
  idArg,
  personActor,
  policyRow,
  workspaceError,
  workspaceName,
} from "./lib/workspaces";

export type WorkspaceSummary = {
  workspaceId: string;
  name: string;
  slug: string;
  iconKey: string | null;
  planKey: string;
  activeMemberCount: number;
  /** The viewer's role here. */
  role: MemberRole;
  /** When the viewer joined (the switcher's order). */
  joinedAt: number;
};

export type WorkspacePolicy = {
  shareAll: boolean;
  whoCanInvite: WhoCanInvite;
  /** Bumped by every change; pass it back as `expectedRevision` to refuse a stale write. */
  revision: number;
  updatedByUserId: string | null;
  updatedAt: number | null;
};

function summary(
  workspace: Doc<"workspaces">,
  role: MemberRole,
  joinedAt: number,
): WorkspaceSummary {
  return {
    workspaceId: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    iconKey: workspace.iconKey,
    planKey: workspace.planKey,
    activeMemberCount: workspace.activeMemberCount,
    role,
    joinedAt,
  };
}

/**
 * The switcher: every live Workspace the viewer is an ACTIVE Member of,
 * oldest membership first (the personal Workspace leads). Suspended and
 * departed memberships are not listed: they see nothing there.
 */
export const listMine = query({
  args: {},
  handler: async (ctx): Promise<WorkspaceSummary[]> => {
    const viewer = await requireViewer(ctx);
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", viewer.userId))
      .collect();
    const rows: WorkspaceSummary[] = [];
    for (const member of memberships) {
      if (member.status !== "active") continue;
      const workspace = await findWorkspace(ctx, member.workspaceId);
      if (workspace === null || workspace.deletedAt !== null) continue;
      rows.push(summary(workspace, member.role, member.joinedAt));
    }
    return rows.toSorted((a, b) => a.joinedAt - b.joinedAt || a.name.localeCompare(b.name));
  },
});

/** One Workspace the viewer is an active Member of. */
export const get = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args): Promise<WorkspaceSummary> => {
    const { viewer, workspace, membership } = await requireMember(ctx, args.workspaceId);
    const member = await findMemberRow(ctx, workspace.id, viewer.userId);
    return summary(workspace, membership.role, member!.joinedAt);
  },
});

/**
 * Creates a Workspace with the viewer as its owner. The client mints the id;
 * repeating the create while still a Member is a no-op that returns the same
 * Workspace (whatever it has been renamed to since), and any other use of
 * that id is `id_taken`.
 */
export const create = mutation({
  args: { workspaceId: v.string(), name: v.string() },
  handler: async (ctx, args): Promise<{ workspaceId: string; slug: string; created: boolean }> => {
    const viewer = await requireViewer(ctx);
    await requirePreviewAccess(ctx, viewer);
    const workspaceId = idArg("workspace", args.workspaceId);
    const name = workspaceName(args.name);
    const existing = await findWorkspace(ctx, workspaceId);
    if (existing !== null) {
      const member = await findMemberRow(ctx, workspaceId, viewer.userId);
      if (
        existing.createdByUserId === viewer.userId &&
        existing.deletedAt === null &&
        member?.status === "active"
      ) {
        return { workspaceId, slug: existing.slug, created: false };
      }
      throw workspaceError("id_taken", "That workspace id is already in use.");
    }
    const workspace = await createWorkspace(ctx, viewer, { workspaceId, name, via: "create" });
    return { workspaceId, slug: workspace.slug, created: true };
  },
});

/** Renames a Workspace (owners and admins). The slug stays, so links keep working. */
export const rename = mutation({
  args: { workspaceId: v.string(), name: v.string() },
  handler: async (ctx, args): Promise<{ name: string }> => {
    const { viewer, workspace } = await requireManage(ctx, args.workspaceId, "settings");
    const name = workspaceName(args.name);
    if (name !== workspace.name) {
      await ctx.db.patch(workspace._id, { name });
      await audit(ctx, {
        workspaceId: workspace.id,
        actor: personActor(viewer),
        kind: "workspace.renamed",
        targetKind: "workspace",
        targetId: workspace.id,
        at: Date.now(),
        detail: { from: workspace.name, to: name },
      });
    }
    return { name };
  },
});

function policyOf(row: Doc<"workspacePolicies"> | null): WorkspacePolicy {
  return row === null
    ? { ...DEFAULT_WORKSPACE_POLICY, revision: 0, updatedByUserId: null, updatedAt: null }
    : {
        shareAll: row.shareAll,
        whoCanInvite: row.whoCanInvite,
        revision: row.revision,
        updatedByUserId: row.updatedByUserId,
        updatedAt: row.updatedAt,
      };
}

/** The Workspace's admin policy. Every active Member reads it. */
export const policy = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args): Promise<WorkspacePolicy> => {
    await requireMember(ctx, args.workspaceId);
    return policyOf(await policyRow(ctx, args.workspaceId));
  },
});

/**
 * Changes the admin policy (owners and admins). Fields left out stay as they
 * are. With `expectedRevision`, a write over someone else's newer change is
 * refused (`revision_conflict`). Every change is audited with before and after.
 */
export const setPolicy = mutation({
  args: {
    workspaceId: v.string(),
    shareAll: v.optional(v.boolean()),
    whoCanInvite: v.optional(literals(WHO_CAN_INVITE)),
    expectedRevision: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<WorkspacePolicy> => {
    const { viewer, workspace } = await requireManage(ctx, args.workspaceId, "policy");
    const row = await policyRow(ctx, workspace.id);
    const before = policyOf(row);
    if (args.expectedRevision !== undefined && args.expectedRevision !== before.revision) {
      throw workspaceError("revision_conflict", "The policy changed since you loaded it.");
    }
    const next = {
      shareAll: args.shareAll ?? before.shareAll,
      whoCanInvite: args.whoCanInvite ?? before.whoCanInvite,
    };
    if (next.shareAll === before.shareAll && next.whoCanInvite === before.whoCanInvite) {
      return before;
    }
    const now = Date.now();
    const fields = {
      ...next,
      revision: before.revision + 1,
      updatedByUserId: viewer.userId,
      updatedAt: now,
    };
    if (row === null) {
      await ctx.db.insert("workspacePolicies", { workspaceId: workspace.id, ...fields });
    } else {
      await ctx.db.patch(row._id, fields);
    }
    await audit(ctx, {
      workspaceId: workspace.id,
      actor: personActor(viewer),
      kind: "policy.updated",
      targetKind: "policy",
      targetId: workspace.id,
      at: now,
      detail: {
        before: { shareAll: before.shareAll, whoCanInvite: before.whoCanInvite },
        after: next,
        revision: fields.revision,
      },
    });
    return { ...next, revision: fields.revision, updatedByUserId: viewer.userId, updatedAt: now };
  },
});
