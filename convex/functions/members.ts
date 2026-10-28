/**
 * Members: the roster, the attribution read, role changes, suspend and
 * unsuspend, remove, leave.
 *
 * The rules are `decideMemberChange` in `@volli/shared/cloud`: owners and
 * admins manage Members, only an owner touches an owner, a Workspace always
 * keeps an active owner, and nobody suspends or removes themselves. A
 * suspended Member is not a seat and sees nothing in the Workspace; a removed
 * or departed one is `left`. Either way their rows stay attributed to them,
 * and a departed Member can be invited back. A suspended Member cannot leave
 * (they can do nothing in the Workspace); an owner or admin removes them.
 * Losing access (suspend, remove, leave) clears the person's Needs-you items
 * in the Workspace as `access_lost` (`attention.sweepAccess`).
 *
 * `list` is the roster (current Members, with role and email); `people` is
 * what every row of the Workspace is attributed to (current and departed, a
 * name and a status each).
 */

import { v } from "convex/values";

import {
  MEMBER_ROLES,
  MEMBER_STATUSES,
  decideMemberChange,
  type MemberChange,
  type MemberRole,
  type MemberStatus,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel.js";
import { audit, type AuditKind, type AuditValue } from "./lib/audit";
import { authError, membershipFacts, requireManage, requireMember } from "./lib/auth";
import { literals } from "./lib/validators";
import { pauseArmingsFor } from "./lib/automations";
import {
  activeOwnerCount,
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

/**
 * One person a Workspace's rows are attributed to. Attribution only: who they
 * are, and whether they are still here. A departed Member's rows keep their
 * name, so old work still reads as theirs.
 */
export type MemberPerson = {
  userId: string;
  displayName: string;
  /** `left` for someone removed or departed; `suspended` for someone without access now. */
  status: MemberStatus;
};

export type MemberPeople = {
  /** The caller: the UI marks their own rows, and needs no second read to name itself. */
  viewerUserId: string;
  people: MemberPerson[];
};

/**
 * Everyone this Workspace's rows are attributed to, for naming a Session's
 * owner, a board event's actor or a ticket's assignee: every current Member
 * (active and suspended) and every departed one, once each, sorted by user id.
 *
 * Any active Member may read it. It carries attribution and nothing more: no
 * email, avatar or role, which the roster (`list`) has, and no `leftAt`. A
 * Session's own visibility is what keeps its title and content from a
 * teammate, never this: a name here says who owns a row, not what is in it.
 */
export const people = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args): Promise<MemberPeople> => {
    const { viewer, workspace } = await requireMember(ctx, args.workspaceId);
    const rows: Doc<"workspaceMembers">[] = [];
    for (const status of MEMBER_STATUSES) {
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
    return {
      viewerUserId: viewer.userId,
      people: rows
        .map((row) => ({
          userId: row.userId,
          displayName: users.get(row.userId)?.displayName ?? "Unknown",
          status: row.status,
        }))
        .toSorted((left, right) => left.userId.localeCompare(right.userId)),
    };
  },
});

export type MemberChangeResult = {
  userId: string;
  role: MemberRole;
  status: MemberStatus;
  /** False when the Member was already in the state asked for. */
  changed: boolean;
};

/**
 * Runs one Member change: the caller's access, the shared decision, the
 * write, the seat recount and the audit row, in one transaction. The target
 * is `null` (the viewer) for leave; otherwise a user id, checked after the caller's access.
 */
async function applyChange(
  ctx: MutationCtx,
  workspaceId: string,
  targetUserId: string | null,
  change: MemberChange,
): Promise<MemberChangeResult> {
  const access =
    change.kind === "leave"
      ? await requireMember(ctx, workspaceId)
      : await requireManage(ctx, workspaceId, "members");
  const { viewer, workspace, membership } = access;
  const userId = targetUserId === null ? viewer.userId : idArg("user", targetUserId);
  const target = await findMemberRow(ctx, workspace.id, userId);
  const refusal = decideMemberChange(
    membership,
    target === null ? null : membershipFacts(target),
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
  let write: {
    patch: Partial<Doc<"workspaceMembers">>;
    kind: AuditKind;
    detail: { [key: string]: AuditValue };
  } | null = null;
  switch (change.kind) {
    case "set_role":
      if (row.role !== change.role) {
        write = {
          patch: { role: change.role },
          kind: "member.role_changed",
          detail: { from: row.role, to: change.role },
        };
      }
      break;
    case "suspend":
      if (row.status === "active") {
        write = {
          patch: { status: "suspended", suspendedAt: now },
          kind: "member.suspended",
          detail: {},
        };
      }
      break;
    case "unsuspend":
      if (row.status === "suspended") {
        write = {
          // The tier follows the plan, which may have changed while they were away.
          patch: { status: "active", suspendedAt: null, billingTier: workspace.planKey },
          kind: "member.unsuspended",
          detail: {},
        };
      }
      break;
    case "remove":
    case "leave":
      write = {
        patch: { status: "left", leftAt: now, suspendedAt: null },
        kind: change.kind === "remove" ? "member.removed" : "member.left",
        detail: { role: row.role, wasStatus: row.status },
      };
      break;
  }
  if (write === null) {
    return { userId: row.userId, role: row.role, status: row.status, changed: false };
  }
  await ctx.db.patch(row._id, write.patch);
  await syncSeats(ctx, workspace.id);
  await audit(ctx, {
    workspaceId: workspace.id,
    actor: personActor(viewer),
    kind: write.kind,
    targetKind: "member",
    targetId: row.id,
    at: now,
    detail: { userId: row.userId, ...write.detail },
  });
  // Reads already hide what they can no longer see; the sweep keeps their
  // stored Needs-you items (counts, pushes) honest.
  if (change.kind === "suspend" || change.kind === "remove" || change.kind === "leave") {
    await pauseArmingsFor(ctx, { userId: row.userId, workspaceId: workspace.id }, now);
    await ctx.scheduler.runAfter(0, internal.attention.sweepAccess, {
      userId: row.userId,
      workspaceId: workspace.id,
    });
  }
  const after = (await ctx.db.get(row._id))!;
  return { userId: after.userId, role: after.role, status: after.status, changed: true };
}

const memberArgs = { workspaceId: v.string(), userId: v.string() };

/** Changes a Member's role (owners and admins; only an owner grants or takes away `owner`). */
export const setRole = mutation({
  args: { ...memberArgs, role: literals(MEMBER_ROLES) },
  handler: async (ctx, args): Promise<MemberChangeResult> =>
    await applyChange(ctx, args.workspaceId, args.userId, { kind: "set_role", role: args.role }),
});

/** Suspends a Member: no access, not billed, history still theirs. */
export const suspend = mutation({
  args: memberArgs,
  handler: async (ctx, args): Promise<MemberChangeResult> =>
    await applyChange(ctx, args.workspaceId, args.userId, { kind: "suspend" }),
});

/** Gives a suspended Member their access (and seat) back. */
export const unsuspend = mutation({
  args: memberArgs,
  handler: async (ctx, args): Promise<MemberChangeResult> =>
    await applyChange(ctx, args.workspaceId, args.userId, { kind: "unsuspend" }),
});

/** Removes a Member (active or suspended). They can be invited back later. */
export const remove = mutation({
  args: memberArgs,
  handler: async (ctx, args): Promise<MemberChangeResult> =>
    await applyChange(ctx, args.workspaceId, args.userId, { kind: "remove" }),
});

/** The viewer leaves the Workspace. The last active owner hands the role on first. */
export const leave = mutation({
  args: { workspaceId: v.string() },
  handler: async (ctx, args): Promise<MemberChangeResult> =>
    await applyChange(ctx, args.workspaceId, null, { kind: "leave" }),
});
