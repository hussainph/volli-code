/**
 * Members: the roster, role changes, suspend and unsuspend, remove, leave.
 *
 * The rules are `decideMemberChange` in `@volli/shared/cloud`: owners and
 * admins manage Members, only an owner touches an owner, a Workspace always
 * keeps an active owner, and nobody suspends or removes themselves. A
 * suspended Member is not a seat and sees nothing in the Workspace; a removed
 * or departed one is `left`. Either way their rows stay attributed to them,
 * and a departed Member can be invited back.
 */

import { v } from "convex/values";

import {
  MEMBER_ROLES,
  decideMemberChange,
  type MemberChange,
  type MemberRole,
  type MemberStatus,
  type MembershipFacts,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel.js";
import { authError, requireManage, requireMember } from "./lib/auth";
import { literals } from "./lib/validators";
import {
  activeOwnerCount,
  audit,
  findMemberRow,
  idArg,
  personActor,
  syncSeats,
  usersById,
  workspaceError,
} from "./lib/workspaces";

export type MemberSummary = {
  memberId: string;
  userId: string;
  displayName: string;
  /** Co-members see each other's email (as in Linear). */
  email: string | null;
  avatarKey: string | null;
  role: MemberRole;
  status: Exclude<MemberStatus, "left">;
  billingTier: string;
  joinedAt: number;
  suspendedAt: number | null;
};

/**
 * Everyone who is a Member now, active and suspended, for any active Member
 * to read. Departed Members are not listed.
 */
export const list = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args): Promise<MemberSummary[]> => {
    const { workspace } = await requireMember(ctx, args.workspaceId);
    const rows: Doc<"workspaceMembers">[] = [];
    for (const status of ["active", "suspended"] as const) {
      rows.push(
        ...(await ctx.db
          .query("workspaceMembers")
          .withIndex("by_workspace_status", (q) =>
            q.eq("workspaceId", workspace.id).eq("status", status),
          )
          .collect()),
      );
    }
    const users = await usersById(
      ctx,
      rows.map((row) => row.userId),
    );
    return rows
      .map((row) => {
        const user = users.get(row.userId);
        return {
          memberId: row.id,
          userId: row.userId,
          displayName: user?.displayName ?? "Unknown",
          email: user?.primaryEmail ?? null,
          avatarKey: user?.avatarKey ?? null,
          role: row.role,
          status: row.status as Exclude<MemberStatus, "left">,
          billingTier: row.billingTier,
          joinedAt: row.joinedAt,
          suspendedAt: row.suspendedAt,
        };
      })
      .toSorted((a, b) => a.joinedAt - b.joinedAt);
  },
});

function factsOf(row: Doc<"workspaceMembers">): MembershipFacts {
  return {
    workspaceId: row.workspaceId as WorkspaceId,
    userId: row.userId as UserId,
    role: row.role,
    status: row.status,
  };
}

type ChangeResult = { userId: string; role: MemberRole; status: MemberStatus; changed: boolean };

/**
 * Runs one Member change: the caller's access, the shared decision, the
 * write, the seat recount and the audit row, in one transaction.
 */
async function applyChange(
  ctx: MutationCtx,
  workspaceId: string,
  targetUserId: string,
  change: MemberChange,
): Promise<ChangeResult> {
  const access =
    change.kind === "leave"
      ? await requireMember(ctx, workspaceId)
      : await requireManage(ctx, workspaceId, "members");
  const { viewer, workspace, membership } = access;
  const target = await findMemberRow(ctx, workspace.id, targetUserId);
  const refusal = decideMemberChange(
    membership,
    target === null ? null : factsOf(target),
    change,
    await activeOwnerCount(ctx, workspace.id),
  );
  if (refusal === "not_a_member") {
    throw authError("not_found", "That person is not a member of this workspace.");
  }
  if (refusal === "forbidden") throw authError("forbidden", "Your role does not allow this.");
  if (refusal === "last_owner") {
    throw workspaceError(
      "last_owner",
      "A workspace needs an owner. Make someone else owner first.",
    );
  }
  if (refusal === "self") {
    throw workspaceError("self", "You can't do that to yourself. Leave the workspace instead.");
  }
  const row = target!;
  const now = Date.now();
  let patch: Partial<Doc<"workspaceMembers">> | null = null;
  let kind = "";
  let detail: Record<string, unknown> = { userId: row.userId };
  switch (change.kind) {
    case "set_role":
      if (row.role !== change.role) {
        patch = { role: change.role };
        kind = "member.role_changed";
        detail = { ...detail, from: row.role, to: change.role };
      }
      break;
    case "suspend":
      if (row.status === "active") {
        patch = { status: "suspended", suspendedAt: now };
        kind = "member.suspended";
      }
      break;
    case "unsuspend":
      if (row.status === "suspended") {
        patch = { status: "active", suspendedAt: null };
        kind = "member.unsuspended";
      }
      break;
    case "remove":
    case "leave":
      patch = { status: "left", leftAt: now, suspendedAt: null };
      kind = change.kind === "remove" ? "member.removed" : "member.left";
      detail = { ...detail, role: row.role, wasStatus: row.status };
      break;
  }
  if (patch === null) {
    return { userId: row.userId, role: row.role, status: row.status, changed: false };
  }
  await ctx.db.patch(row._id, patch);
  await syncSeats(ctx, workspace.id);
  await audit(ctx, {
    workspaceId: workspace.id,
    actor: personActor(viewer),
    kind,
    targetKind: "member",
    targetId: row.id,
    at: now,
    detail,
  });
  const after = (await ctx.db.get(row._id))!;
  return { userId: after.userId, role: after.role, status: after.status, changed: true };
}

const target = { workspaceId: v.string(), userId: v.string() };

/** Changes a Member's role (owners and admins; only an owner grants or takes away `owner`). */
export const setRole = mutation({
  args: { ...target, role: literals(MEMBER_ROLES) },
  handler: async (ctx, args) =>
    await applyChange(ctx, args.workspaceId, idArg("user", args.userId), {
      kind: "set_role",
      role: args.role,
    }),
});

/** Suspends a Member: no access, not billed, history still theirs. */
export const suspend = mutation({
  args: target,
  handler: async (ctx, args) =>
    await applyChange(ctx, args.workspaceId, idArg("user", args.userId), { kind: "suspend" }),
});

/** Gives a suspended Member their access (and seat) back. */
export const unsuspend = mutation({
  args: target,
  handler: async (ctx, args) =>
    await applyChange(ctx, args.workspaceId, idArg("user", args.userId), { kind: "unsuspend" }),
});

/** Removes a Member (active or suspended). They can be invited back later. */
export const remove = mutation({
  args: target,
  handler: async (ctx, args) =>
    await applyChange(ctx, args.workspaceId, idArg("user", args.userId), { kind: "remove" }),
});

/** The viewer leaves the Workspace. The last active owner hands the role on first. */
export const leave = mutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const { viewer } = await requireMember(ctx, args.workspaceId);
    return await applyChange(ctx, args.workspaceId, viewer.userId, { kind: "leave" });
  },
});
