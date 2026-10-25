/**
 * Invites: by email or as a link, revoked by the sender or an owner/admin,
 * accepted by the invitee. An invitee becomes a Member only on acceptance.
 *
 * - Who may invite is the Workspace's `whoCanInvite` policy (default
 *   `members`); an inviter grants at most their own role. An invite is only as
 *   good as its sender: once they could no longer send it (suspended, gone,
 *   demoted, or the policy changed), it can no longer be accepted.
 * - An email invite is bound to that address: only a signed-in person whose
 *   VERIFIED email matches may accept it, by its id (from `listMine`) or by
 *   its link. Inviting a pending address again reissues the same invite, if
 *   the person asking could have revoked it.
 * - A link invite names no address: whoever signs in with the link first
 *   accepts it, once.
 * - Both carry a token, minted here and returned once to the inviter to build
 *   the link; only its sha256 is stored. Ids are not secrets, so a link
 *   invite is never accepted by id.
 * - Sending the email is not here yet (no mail provider): the client shares
 *   the link.
 *
 * Listing queries read the clock: an invite that expires while a list is
 * subscribed stays listed until the list next re-runs. Acceptance always
 * checks expiry.
 */

import { v } from "convex/values";

import {
  MEMBER_ROLES,
  canInviteAs,
  canReissueInvite,
  canRevokeInvite,
  decideInviteAcceptance,
  newId,
  type InviteAcceptance,
  type InviteFacts,
  type InviteState,
  type MemberRole,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import { requirePreviewAccess } from "./lib/previewAccess";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel.js";
import { audit } from "./lib/audit";
import {
  authError,
  findMembership,
  findPolicy,
  normalizeEmail,
  requireMember,
  requireViewer,
  type Viewer,
} from "./lib/auth";
import { literals, nullable } from "./lib/validators";
import {
  findMemberRow,
  findWorkspace,
  idArg,
  joinWorkspace,
  personActor,
  usersById,
  workspaceError,
} from "./lib/workspaces";

/** How long an invite (email or link) stays acceptable. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;

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

/** What a link would do for the viewer: `valid` joins; anything else is why not. */
export type InvitePreviewStatus = Exclude<InviteAcceptance, "join"> | "valid";

export type InvitePreview =
  | { status: "invalid" }
  | {
      status: InvitePreviewStatus;
      workspaceId: string;
      workspaceName: string;
      role: MemberRole;
      invitedByName: string;
      email: string | null;
      expiresAt: number;
    };

export type AcceptedInvite = { workspaceId: string; role: MemberRole; alreadyMember: boolean };

// ── tokens and invite facts ─────────────────────────────────────────────────

/** A fresh invite token: 32 random bytes, base64url. */
function mintInviteToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The stored form of an invite token: its sha256, lowercase hex. */
async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function inviteState(invite: Doc<"workspaceInvites">, now: number): InviteState {
  if (invite.revokedAt !== null) return "revoked";
  if (invite.acceptedAt !== null) return "accepted";
  if (invite.expiresAt <= now) return "expired";
  return "pending";
}

function inviteFacts(invite: Doc<"workspaceInvites">): InviteFacts {
  return {
    workspaceId: invite.workspaceId as WorkspaceId,
    invitedByUserId: invite.invitedByUserId as UserId,
    role: invite.role,
  };
}

/** A plausible email address, normalized, or `invalid_argument`. */
function inviteEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw workspaceError("invalid_argument", "That is not an email address.");
  }
  return email;
}

function verifiedEmail(viewer: Viewer): string | null {
  return viewer.user.emailVerified ? viewer.user.primaryEmail : null;
}

async function pendingEmailInvites(
  ctx: { db: QueryCtx["db"] },
  workspaceId: string,
  email: string,
  now: number,
): Promise<Doc<"workspaceInvites">[]> {
  return (
    await ctx.db
      .query("workspaceInvites")
      .withIndex("by_workspace_email", (q) => q.eq("workspaceId", workspaceId).eq("email", email))
      .collect()
  ).filter((invite) => inviteState(invite, now) === "pending");
}

// ── create, revoke ──────────────────────────────────────────────────────────

/**
 * Invites someone by email, or (with `email: null`) makes a single-use link.
 * Inviting an address with a pending invite reissues it (a fresh token and
 * expiry, the new role and sender, the old link dead) when the person asking
 * could have revoked it and could have sent it; otherwise `already_invited`.
 */
export const create = mutation({
  args: { workspaceId: v.string(), email: nullable(v.string()), role: literals(MEMBER_ROLES) },
  handler: async (ctx, args): Promise<CreatedInvite> => {
    const { viewer, workspace, membership } = await requireMember(ctx, args.workspaceId);
    const policy = await findPolicy(ctx, workspace.id);
    if (!canInviteAs(viewer, workspace.id as WorkspaceId, membership, args.role, policy)) {
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
      const [pending] = await pendingEmailInvites(ctx, workspace.id, email, now);
      if (pending !== undefined) {
        if (!canReissueInvite(viewer, membership, inviteFacts(pending), args.role, policy)) {
          throw workspaceError(
            "already_invited",
            "Someone else has already invited this address. Ask them or an admin to change it.",
          );
        }
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

/** An address that already belongs to a Member (by a verified email) is not invited again. */
async function refuseExistingMember(ctx: MutationCtx, workspaceId: string, email: string) {
  const users = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("primaryEmail", email))
    .collect();
  for (const user of users) {
    if (!user.emailVerified) continue;
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
    const viewer = await requireViewer(ctx);
    const inviteId = idArg("invite", args.inviteId);
    const invite = await findInvite(ctx, inviteId);
    if (invite === null) throw authError("not_found", "That invite does not exist.");
    const { membership } = await requireMember(ctx, invite.workspaceId);
    if (!canRevokeInvite(viewer, membership, inviteFacts(invite))) {
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

// ── reads ───────────────────────────────────────────────────────────────────

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

/**
 * The one decision both `preview` and acceptance read: what accepting this
 * invite would do for the viewer now. `null` when its Workspace is gone.
 */
async function acceptanceOf(
  ctx: { db: QueryCtx["db"] },
  viewer: Viewer,
  invite: Doc<"workspaceInvites">,
): Promise<{
  decision: InviteAcceptance;
  workspace: Doc<"workspaces">;
  member: Doc<"workspaceMembers"> | null;
} | null> {
  const workspace = await findWorkspace(ctx, invite.workspaceId);
  if (workspace === null || workspace.deletedAt !== null) return null;
  const member = await findMemberRow(ctx, workspace.id, viewer.userId);
  const sender = { userId: invite.invitedByUserId as UserId };
  const decision = decideInviteAcceptance({
    state: inviteState(invite, Date.now()),
    acceptedByViewer: invite.acceptedByUserId === viewer.userId,
    emailMismatch: invite.email !== null && invite.email !== verifiedEmail(viewer),
    viewerStatus: member?.status ?? null,
    senderMayInvite: canInviteAs(
      sender,
      workspace.id as WorkspaceId,
      await findMembership(ctx, workspace.id, sender.userId),
      invite.role,
      await findPolicy(ctx, workspace.id),
    ),
  });
  return { decision, workspace, member };
}

/** What a link would do for the signed-in viewer: the landing page before "Join". */
export const preview = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<InvitePreview> => {
    const viewer = await requireViewer(ctx);
    const invite = await inviteByToken(ctx, args.token);
    if (invite === null) return { status: "invalid" };
    const acceptance = await acceptanceOf(ctx, viewer, invite);
    if (acceptance === null) return { status: "invalid" };
    const inviter = (await usersById(ctx, [invite.invitedByUserId])).get(invite.invitedByUserId);
    return {
      status: acceptance.decision === "join" ? "valid" : acceptance.decision,
      workspaceId: acceptance.workspace.id,
      workspaceName: acceptance.workspace.name,
      role: invite.role,
      invitedByName: inviter?.displayName ?? "Unknown",
      email: invite.email,
      expiresAt: invite.expiresAt,
    };
  },
});

/**
 * Joins the invite's Workspace, or says why not. Already an active Member: a
 * no-op that leaves the invite for whoever it was meant for. A suspended
 * Member is restored by unsuspend, not by an invite. A departed one comes
 * back with the invite's role. Joining also settles any other pending email
 * invites to the viewer's address there.
 */
async function acceptInvite(
  ctx: MutationCtx,
  viewer: Viewer,
  invite: Doc<"workspaceInvites">,
): Promise<AcceptedInvite> {
  const acceptance = await acceptanceOf(ctx, viewer, invite);
  if (acceptance === null)
    throw workspaceError("invite_invalid", "This invite is no longer valid.");
  const { decision, workspace, member } = acceptance;
  switch (decision) {
    case "already_member":
      return { workspaceId: workspace.id, role: member!.role, alreadyMember: true };
    case "accepted":
    case "revoked":
    case "sender_cannot_invite":
      throw workspaceError("invite_invalid", "This invite is no longer valid.");
    case "expired":
      throw workspaceError("invite_expired", "This invite has expired.");
    case "email_mismatch":
      throw workspaceError(
        "invite_email_mismatch",
        "This invite is for a different email address. Sign in with that address to accept it.",
      );
    case "suspended":
      throw workspaceError(
        "suspended",
        "You are suspended in this workspace. Ask an admin to restore you.",
      );
    case "join":
      break;
  }
  const now = Date.now();
  const actor = personActor(viewer);
  const email = verifiedEmail(viewer);
  const settled =
    email === null
      ? [invite]
      : [invite, ...(await pendingEmailInvites(ctx, workspace.id, email, now))];
  for (const each of new Map(settled.map((row) => [row._id, row])).values()) {
    await ctx.db.patch(each._id, { acceptedByUserId: viewer.userId, acceptedAt: now });
    await audit(ctx, {
      workspaceId: workspace.id,
      actor,
      kind: "invite.accepted",
      targetKind: "invite",
      targetId: each.id,
      at: now,
      detail: { userId: viewer.userId, role: each.role },
    });
  }
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
    await requirePreviewAccess(ctx, viewer);
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
    await requirePreviewAccess(ctx, viewer);
    const invite = await inviteByToken(ctx, args.token);
    if (invite === null) throw workspaceError("invite_invalid", "This invite link is not valid.");
    return await acceptInvite(ctx, viewer, invite);
  },
});
