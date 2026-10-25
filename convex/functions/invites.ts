/**
 * Invites: by email or as a link, revoked by the inviter or an owner/admin,
 * accepted by the invitee. An invitee becomes a Member only on acceptance.
 *
 * - Who may invite is the Workspace's `whoCanInvite` policy (default
 *   `members`); an inviter grants at most their own role.
 * - An email invite is bound to that address: only a signed-in person whose
 *   VERIFIED email matches may accept it, by its id (from `listMine`) or by
 *   its link. Inviting a pending address again reissues the same invite.
 * - A link invite names no address: whoever signs in with the link first
 *   accepts it, once.
 * - Both carry a token, minted here and returned once to the inviter to build
 *   the link; only its sha256 is stored. Ids are not secrets, so a link
 *   invite is never accepted by id.
 * - Sending the email is not here yet (no mail provider): the client shares
 *   the link.
 */

import { v } from "convex/values";

import {
  MEMBER_ROLES,
  canInviteAs,
  canRevokeInvite,
  newId,
  type MemberRole,
  type UserId,
} from "@volli/shared/cloud";

import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel.js";
import { authError, findPolicy, requireMember, requireViewer, type Viewer } from "./lib/auth";
import { literals, nullable } from "./lib/validators";
import {
  INVITE_TTL_MS,
  audit,
  findMemberRow,
  findWorkspace,
  hashInviteToken,
  idArg,
  inviteEmail,
  inviteState,
  joinWorkspace,
  mintInviteToken,
  personActor,
  usersById,
  workspaceError,
  type InviteState,
} from "./lib/workspaces";

export type CreatedInvite = {
  inviteId: string;
  /** The secret the link carries. Returned only here; only its hash is stored. */
  token: string;
  expiresAt: number;
  /** An earlier pending invite to the same address was reissued with a fresh token. */
  reissued: boolean;
};

export type PendingInvite = {
  inviteId: string;
  /** `null` for a link invite. */
  email: string | null;
  role: MemberRole;
  invitedByUserId: string;
  invitedByName: string;
  createdAt: number;
  expiresAt: number;
};

export type MyInvite = {
  inviteId: string;
  workspaceId: string;
  workspaceName: string;
  role: MemberRole;
  invitedByName: string;
  expiresAt: number;
};

export type InvitePreview =
  | { status: "invalid" }
  | {
      status: Exclude<InviteState, "pending"> | "valid" | "email_mismatch" | "already_member";
      workspaceId: string;
      workspaceName: string;
      role: MemberRole;
      invitedByName: string;
      email: string | null;
      expiresAt: number;
    };

export type AcceptedInvite = { workspaceId: string; role: MemberRole; alreadyMember: boolean };

/**
 * Invites someone by email, or (with `email: null`) makes a single-use link.
 * Inviting an address with a pending invite reissues it: a fresh token and
 * expiry, the new role and inviter, the old link dead.
 */
export const create = mutation({
  args: { workspaceId: v.string(), email: nullable(v.string()), role: literals(MEMBER_ROLES) },
  handler: async (ctx, args): Promise<CreatedInvite> => {
    const { viewer, workspace, membership } = await requireMember(ctx, args.workspaceId);
    const policy = await findPolicy(ctx, workspace.id);
    if (!canInviteAs(viewer, membership, args.role, policy)) {
      throw authError("forbidden", "Your role does not allow this invite.");
    }
    const email = args.email === null ? null : inviteEmail(args.email);
    const now = Date.now();
    const token = mintInviteToken();
    const tokenHash = await hashInviteToken(token);
    const expiresAt = now + INVITE_TTL_MS;
    const actor = personActor(viewer);

    if (email !== null) {
      await refuseExistingMember(ctx, workspace.id, email);
      const pending = (
        await ctx.db
          .query("workspaceInvites")
          .withIndex("by_workspace_email", (q) =>
            q.eq("workspaceId", workspace.id).eq("email", email),
          )
          .collect()
      ).find((invite) => inviteState(invite, now) === "pending");
      if (pending !== undefined) {
        await ctx.db.patch(pending._id, {
          tokenHash,
          expiresAt,
          role: args.role,
          invitedByUserId: viewer.userId,
        });
        await audit(ctx, {
          workspaceId: workspace.id,
          actor,
          kind: "invite.reissued",
          targetKind: "invite",
          targetId: pending.id,
          at: now,
          detail: { email, role: args.role, expiresAt },
        });
        return { inviteId: pending.id, token, expiresAt, reissued: true };
      }
    }

    const inviteId = newId("invite");
    await ctx.db.insert("workspaceInvites", {
      id: inviteId,
      workspaceId: workspace.id,
      email,
      role: args.role,
      invitedByUserId: viewer.userId,
      tokenHash,
      expiresAt,
      acceptedByUserId: null,
      acceptedAt: null,
      revokedAt: null,
      createdAt: now,
    });
    await audit(ctx, {
      workspaceId: workspace.id,
      actor,
      kind: "invite.created",
      targetKind: "invite",
      targetId: inviteId,
      at: now,
      detail: { email, role: args.role, expiresAt, link: email === null },
    });
    return { inviteId, token, expiresAt, reissued: false };
  },
});

async function refuseExistingMember(ctx: MutationCtx, workspaceId: string, email: string) {
  const users = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("primaryEmail", email))
    .collect();
  for (const user of users) {
    const member = await findMemberRow(ctx, workspaceId, user.id);
    if (member !== null && member.status !== "left") {
      throw workspaceError(
        "already_member",
        member.status === "suspended"
          ? "That person is a suspended member. Unsuspend them instead."
          : "That person is already a member.",
      );
    }
  }
}

async function findInvite(
  ctx: { db: QueryCtx["db"] },
  inviteId: string,
): Promise<Doc<"workspaceInvites"> | null> {
  return await ctx.db
    .query("workspaceInvites")
    .withIndex("by_uuid", (q) => q.eq("id", inviteId))
    .unique();
}

/** Revokes a pending invite: its sender, or any owner or admin. */
export const revoke = mutation({
  args: { inviteId: v.string() },
  handler: async (ctx, args): Promise<{ inviteId: string; revoked: boolean }> => {
    const inviteId = idArg("invite", args.inviteId);
    const viewer = await requireViewer(ctx);
    const invite = await findInvite(ctx, inviteId);
    if (invite === null) throw authError("not_found", "That invite does not exist.");
    const { membership } = await requireMember(ctx, invite.workspaceId);
    if (
      !canRevokeInvite(viewer, membership, { invitedByUserId: invite.invitedByUserId as UserId })
    ) {
      throw authError("forbidden", "Your role does not allow this.");
    }
    if (invite.revokedAt !== null) return { inviteId, revoked: false };
    if (invite.acceptedAt !== null) {
      throw workspaceError("invite_invalid", "That invite was already accepted.");
    }
    const now = Date.now();
    await ctx.db.patch(invite._id, { revokedAt: now });
    await audit(ctx, {
      workspaceId: invite.workspaceId,
      actor: personActor(viewer),
      kind: "invite.revoked",
      targetKind: "invite",
      targetId: inviteId,
      at: now,
      detail: { email: invite.email, role: invite.role },
    });
    return { inviteId, revoked: true };
  },
});

/** The Workspace's pending, unexpired invites, for any active Member. Never a token. */
export const list = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args): Promise<PendingInvite[]> => {
    const { workspace } = await requireMember(ctx, args.workspaceId);
    const now = Date.now();
    const invites = (
      await ctx.db
        .query("workspaceInvites")
        .withIndex("by_workspace_email", (q) => q.eq("workspaceId", workspace.id))
        .collect()
    ).filter((invite) => inviteState(invite, now) === "pending");
    const users = await usersById(
      ctx,
      invites.map((invite) => invite.invitedByUserId),
    );
    return invites
      .map((invite) => ({
        inviteId: invite.id,
        email: invite.email,
        role: invite.role,
        invitedByUserId: invite.invitedByUserId,
        invitedByName: users.get(invite.invitedByUserId)?.displayName ?? "Unknown",
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
      }))
      .toSorted((a, b) => a.createdAt - b.createdAt);
  },
});

function verifiedEmail(viewer: Viewer): string | null {
  return viewer.user.emailVerified ? viewer.user.primaryEmail : null;
}

/**
 * Pending invites addressed to the viewer's verified email, in Workspaces
 * they are not already in: what "join" offers right after sign-in.
 */
export const listMine = query({
  args: {},
  handler: async (ctx): Promise<MyInvite[]> => {
    const viewer = await requireViewer(ctx);
    const email = verifiedEmail(viewer);
    if (email === null) return [];
    const now = Date.now();
    const invites = (
      await ctx.db
        .query("workspaceInvites")
        .withIndex("by_email", (q) => q.eq("email", email))
        .collect()
    ).filter((invite) => inviteState(invite, now) === "pending");
    const users = await usersById(
      ctx,
      invites.map((invite) => invite.invitedByUserId),
    );
    const mine: MyInvite[] = [];
    for (const invite of invites) {
      const workspace = await findWorkspace(ctx, invite.workspaceId);
      if (workspace === null || workspace.deletedAt !== null) continue;
      const member = await findMemberRow(ctx, workspace.id, viewer.userId);
      if (member !== null && member.status !== "left") continue;
      mine.push({
        inviteId: invite.id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        role: invite.role,
        invitedByName: users.get(invite.invitedByUserId)?.displayName ?? "Unknown",
        expiresAt: invite.expiresAt,
      });
    }
    return mine.toSorted((a, b) => a.expiresAt - b.expiresAt);
  },
});

async function inviteByToken(
  ctx: { db: QueryCtx["db"] },
  token: string,
): Promise<Doc<"workspaceInvites"> | null> {
  if (token.length < 16 || token.length > 128) return null;
  const tokenHash = await hashInviteToken(token);
  return await ctx.db
    .query("workspaceInvites")
    .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
    .unique();
}

/** What a link would do for the signed-in viewer: the landing page before "Join". */
export const preview = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<InvitePreview> => {
    const viewer = await requireViewer(ctx);
    const invite = await inviteByToken(ctx, args.token);
    if (invite === null) return { status: "invalid" };
    const workspace = await findWorkspace(ctx, invite.workspaceId);
    if (workspace === null || workspace.deletedAt !== null) return { status: "invalid" };
    const inviter = (await usersById(ctx, [invite.invitedByUserId])).get(invite.invitedByUserId);
    const member = await findMemberRow(ctx, workspace.id, viewer.userId);
    const state = inviteState(invite, Date.now());
    let status: Exclude<InvitePreview["status"], "invalid">;
    if (state !== "pending") status = state;
    else if (member?.status === "active") status = "already_member";
    else if (invite.email !== null && invite.email !== verifiedEmail(viewer)) {
      status = "email_mismatch";
    } else status = "valid";
    return {
      status,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      role: invite.role,
      invitedByName: inviter?.displayName ?? "Unknown",
      email: invite.email,
      expiresAt: invite.expiresAt,
    };
  },
});

/**
 * Joins the invite's Workspace. Already an active Member: a no-op that leaves
 * the invite for whoever it was meant for. A suspended Member must be
 * unsuspended instead. A departed one comes back with the invite's role.
 */
async function acceptInvite(
  ctx: MutationCtx,
  viewer: Viewer,
  invite: Doc<"workspaceInvites">,
): Promise<AcceptedInvite> {
  const now = Date.now();
  const workspace = await findWorkspace(ctx, invite.workspaceId);
  if (workspace === null || workspace.deletedAt !== null) {
    throw authError("not_found", "That workspace does not exist.");
  }
  const member = await findMemberRow(ctx, workspace.id, viewer.userId);
  const state = inviteState(invite, now);
  if (
    state === "accepted" &&
    invite.acceptedByUserId === viewer.userId &&
    member?.status === "active"
  ) {
    return { workspaceId: workspace.id, role: member.role, alreadyMember: true };
  }
  if (state === "revoked" || state === "accepted") {
    throw workspaceError("invite_invalid", "This invite is no longer valid.");
  }
  if (state === "expired") throw workspaceError("invite_expired", "This invite has expired.");
  if (invite.email !== null && invite.email !== verifiedEmail(viewer)) {
    throw workspaceError(
      "invite_email_mismatch",
      "This invite is for a different email address. Sign in with that address to accept it.",
    );
  }
  if (member?.status === "active") {
    return { workspaceId: workspace.id, role: member.role, alreadyMember: true };
  }
  if (member?.status === "suspended") {
    throw workspaceError(
      "suspended",
      "You are suspended in this workspace. Ask an admin to restore you.",
    );
  }
  await ctx.db.patch(invite._id, { acceptedByUserId: viewer.userId, acceptedAt: now });
  const actor = personActor(viewer);
  await audit(ctx, {
    workspaceId: workspace.id,
    actor,
    kind: "invite.accepted",
    targetKind: "invite",
    targetId: invite.id,
    at: now,
    detail: { userId: viewer.userId, role: invite.role },
  });
  await joinWorkspace(ctx, actor, {
    workspaceId: workspace.id,
    userId: viewer.userId,
    role: invite.role,
    invitedByUserId: invite.invitedByUserId as UserId,
    via: "invite",
    inviteId: invite.id,
  });
  return { workspaceId: workspace.id, role: invite.role, alreadyMember: false };
}

/** Accepts an email invite addressed to the viewer's verified email, by id (from `listMine`). */
export const accept = mutation({
  args: { inviteId: v.string() },
  handler: async (ctx, args): Promise<AcceptedInvite> => {
    const viewer = await requireViewer(ctx);
    const invite = await findInvite(ctx, idArg("invite", args.inviteId));
    // A link invite is accepted only with its token: ids are not secrets.
    if (invite === null || invite.email === null) {
      throw authError("not_found", "That invite does not exist.");
    }
    return await acceptInvite(ctx, viewer, invite);
  },
});

/** Accepts an invite by the token its link carries. */
export const acceptLink = mutation({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<AcceptedInvite> => {
    const viewer = await requireViewer(ctx);
    const invite = await inviteByToken(ctx, args.token);
    if (invite === null) throw workspaceError("invite_invalid", "This invite link is not valid.");
    return await acceptInvite(ctx, viewer, invite);
  },
});
