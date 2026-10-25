/**
 * Who is calling, and what they may see: the identity and membership checks
 * every public function starts with.
 *
 * Every public function requires an identity (a local backend reflects any
 * CORS origin, so "public" must never mean "anonymous"). The identity maps to
 * one `users` row through `authIdentities`; that row's `id` is the `userId`
 * every Actor, membership and owner field names. Membership is looked up by
 * `(workspaceId, userId)` through a project's CURRENT Workspace, and the
 * decisions themselves are the pure predicates in `@volli/shared/cloud`, so a
 * client's optimistic UI and the backend agree.
 *
 * Failures are `ConvexError`s with a typed `code` (see {@link AuthErrorCode}).
 */

import type { GenericDatabaseReader, GenericDatabaseWriter, UserIdentity } from "convex/server";
import { ConvexError } from "convex/values";

import {
  DEFAULT_WORKSPACE_POLICY,
  canActOnSession,
  canManage,
  canSeeProject,
  canSeeSession,
  isActiveMember,
  newId,
  type ManageGate,
  type MembershipFacts,
  type PolicyFacts,
  type ProjectId,
  type SessionId,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import type { DataModel, Doc } from "../_generated/dataModel.js";

export type AuthErrorCode =
  | "unauthenticated"
  | "no_viewer"
  | "account_deleted"
  | "not_found"
  | "not_a_member"
  | "forbidden";

export type AuthErrorData = { code: AuthErrorCode; message: string };

export function authError(code: AuthErrorCode, message: string): ConvexError<AuthErrorData> {
  return new ConvexError({ code, message });
}

type AuthCtx = { auth: { getUserIdentity(): Promise<UserIdentity | null> } };
type ReadCtx = AuthCtx & { db: GenericDatabaseReader<DataModel> };
type WriteCtx = AuthCtx & { db: GenericDatabaseWriter<DataModel> };

/** The signed-in person, resolved to their `users` row. */
export interface Viewer {
  userId: UserId;
  user: Doc<"users">;
}

// ── identity ─────────────────────────────────────────────────────────────────

/** The caller's verified identity, or `unauthenticated`. */
export async function requireIdentity(ctx: AuthCtx): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw authError("unauthenticated", "Sign in to continue.");
  return identity;
}

/**
 * The profile a new `users` row starts from, read from the identity's claims.
 *
 * This is the hook the real sign-in provider plugs into: the accounts work
 * maps its provider's claims here (and adds it to `auth.config.ts`). Until
 * then the only issuer is the test one, whose tokens may carry the standard
 * OIDC `email`, `email_verified` and `name` claims.
 */
export interface ViewerProfile {
  primaryEmail: string | null;
  emailVerified: boolean;
  displayName: string;
}

export type ProfileFromIdentity = (identity: UserIdentity) => ViewerProfile;

/** Lower-cased and trimmed, as invites match it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const profileFromIdentity: ProfileFromIdentity = (identity) => {
  const email =
    typeof identity.email === "string" && identity.email.trim() !== ""
      ? normalizeEmail(identity.email)
      : null;
  const name = [identity.name, identity.nickname].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return {
    primaryEmail: email,
    emailVerified: email !== null && identity.emailVerified === true,
    displayName: name?.trim() ?? email?.split("@")[0] ?? "Volli user",
  };
};

/** `lastSeenAt` is refreshed at most this often, so a busy client does not churn the row. */
export const LAST_SEEN_RESOLUTION_MS = 60 * 60 * 1000;

async function userOf(ctx: ReadCtx, identity: UserIdentity): Promise<Doc<"users"> | null> {
  const link = await ctx.db
    .query("authIdentities")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
  if (link === null) return null;
  return ctx.db
    .query("users")
    .withIndex("by_uuid", (q) => q.eq("id", link.userId))
    .unique();
}

function liveViewer(user: Doc<"users">): Viewer {
  if (user.status === "deleted") {
    throw authError("account_deleted", "This account has been deleted.");
  }
  return { userId: user.id as UserId, user };
}

/** The viewer, or `null` when this identity has never called {@link ensureViewer}. */
export async function findViewer(ctx: ReadCtx): Promise<Viewer | null> {
  const user = await userOf(ctx, await requireIdentity(ctx));
  return user === null ? null : liveViewer(user);
}

/** The viewer, or `no_viewer` (call `accounts.ensureViewer` first). For queries. */
export async function requireViewer(ctx: ReadCtx): Promise<Viewer> {
  const viewer = await findViewer(ctx);
  if (viewer === null) throw authError("no_viewer", "This account is not set up yet.");
  return viewer;
}

/**
 * The viewer, creating the `users` row (and its identity link) on the first
 * call. Idempotent: concurrent first calls serialize on the `by_token` read.
 * The backend mints the user id: a person is a fact it originates.
 */
export async function ensureViewer(
  ctx: WriteCtx,
  profileOf: ProfileFromIdentity = profileFromIdentity,
): Promise<Viewer & { created: boolean }> {
  const identity = await requireIdentity(ctx);
  const now = Date.now();
  const existing = await userOf(ctx, identity);
  if (existing !== null) {
    const viewer = liveViewer(existing);
    if (now - existing.lastSeenAt >= LAST_SEEN_RESOLUTION_MS) {
      await ctx.db.patch(existing._id, { lastSeenAt: now });
    }
    return { ...viewer, created: false };
  }
  const userId = newId("user");
  const profile = profileOf(identity);
  const docId = await ctx.db.insert("users", {
    id: userId,
    primaryEmail: profile.primaryEmail,
    emailVerified: profile.emailVerified,
    displayName: profile.displayName,
    avatarKey: null,
    status: "active",
    deletionRequestedAt: null,
    purgeAfter: null,
    trialSeededWorkspaceId: null,
    createdAt: now,
    lastSeenAt: now,
  });
  await ctx.db.insert("authIdentities", {
    userId,
    issuer: identity.issuer,
    subject: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    createdAt: now,
  });
  const user = await ctx.db.get(docId);
  return { userId, user: user!, created: true };
}

// ── membership ────────────────────────────────────────────────────────────

function membershipFacts(member: Doc<"workspaceMembers">): MembershipFacts {
  return {
    workspaceId: member.workspaceId as WorkspaceId,
    userId: member.userId as UserId,
    role: member.role,
    status: member.status,
  };
}

/** The person's membership of a Workspace, active or not, or `null`. */
export async function findMembership(
  ctx: { db: GenericDatabaseReader<DataModel> },
  workspaceId: string,
  userId: string,
): Promise<MembershipFacts | null> {
  const member = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
    .unique();
  return member === null ? null : membershipFacts(member);
}

/** A Workspace's admin policy, or the defaults when none has been written. */
export async function findPolicy(
  ctx: { db: GenericDatabaseReader<DataModel> },
  workspaceId: string,
): Promise<PolicyFacts> {
  const policy = await ctx.db
    .query("workspacePolicies")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return policy === null
    ? DEFAULT_WORKSPACE_POLICY
    : { shareAll: policy.shareAll, whoCanInvite: policy.whoCanInvite };
}

async function liveWorkspace(ctx: ReadCtx, workspaceId: string): Promise<Doc<"workspaces">> {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_uuid", (q) => q.eq("id", workspaceId))
    .unique();
  if (workspace === null || workspace.deletedAt !== null) {
    throw authError("not_found", "That workspace does not exist.");
  }
  return workspace;
}

/** The viewer and their ACTIVE membership of a live Workspace, or `not_found` / `not_a_member`. */
export async function requireMember(
  ctx: ReadCtx,
  workspaceId: string,
): Promise<{ viewer: Viewer; workspace: Doc<"workspaces">; membership: MembershipFacts }> {
  const viewer = await requireViewer(ctx);
  const workspace = await liveWorkspace(ctx, workspaceId);
  const membership = await findMembership(ctx, workspaceId, viewer.userId);
  if (!isActiveMember(viewer, workspaceId as WorkspaceId, membership)) {
    throw authError("not_a_member", "You are not a member of this workspace.");
  }
  return { viewer, workspace, membership };
}

/** The viewer may perform a role-gated action in the Workspace, or `forbidden`. */
export async function requireManage(
  ctx: ReadCtx,
  workspaceId: string,
  gate: ManageGate,
): Promise<{ viewer: Viewer; workspace: Doc<"workspaces">; membership: MembershipFacts }> {
  const access = await requireMember(ctx, workspaceId);
  const policy = await findPolicy(ctx, workspaceId);
  if (!canManage(access.viewer, workspaceId as WorkspaceId, access.membership, gate, policy)) {
    throw authError("forbidden", "Your role does not allow this.");
  }
  return access;
}

/** A live project the viewer can see (active member of its CURRENT Workspace). */
export async function requireProject(
  ctx: ReadCtx,
  projectId: ProjectId | string,
): Promise<{ viewer: Viewer; project: Doc<"projects">; membership: MembershipFacts | null }> {
  const viewer = await requireViewer(ctx);
  const project = await ctx.db
    .query("projects")
    .withIndex("by_uuid", (q) => q.eq("id", projectId))
    .unique();
  if (project === null || project.deletedAt !== null) {
    throw authError("not_found", "That project does not exist.");
  }
  const membership = await findMembership(ctx, project.workspaceId, viewer.userId);
  if (!canSeeProject(viewer, { workspaceId: project.workspaceId as WorkspaceId }, membership)) {
    throw authError("not_a_member", "You are not a member of this project's workspace.");
  }
  return { viewer, project, membership };
}

/** A live Session the viewer can see: owner, shared, or the Workspace shares everything. */
export async function requireSessionVisible(
  ctx: ReadCtx,
  sessionId: SessionId | string,
): Promise<{ viewer: Viewer; session: Doc<"sessions">; project: Doc<"projects"> }> {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_uuid", (q) => q.eq("id", sessionId))
    .unique();
  if (session === null || session.deletedAt !== null) {
    throw authError("not_found", "That session does not exist.");
  }
  const { viewer, project, membership } = await requireProject(ctx, session.projectId);
  const policy = await findPolicy(ctx, project.workspaceId);
  const visible = canSeeSession(
    viewer,
    { ownerUserId: session.ownerUserId as UserId, visibility: session.visibility },
    { workspaceId: project.workspaceId as WorkspaceId },
    membership,
    policy,
  );
  // A private Session is reported as absent rather than forbidden: its
  // existence is part of what is private.
  if (!visible) throw authError("not_found", "That session does not exist.");
  return { viewer, session, project };
}

/** A Session the viewer may act on (0.3: its owner only). */
export async function requireSessionActor(
  ctx: ReadCtx,
  sessionId: SessionId | string,
): Promise<{ viewer: Viewer; session: Doc<"sessions">; project: Doc<"projects"> }> {
  const access = await requireSessionVisible(ctx, sessionId);
  if (!canActOnSession(access.viewer, { ownerUserId: access.session.ownerUserId as UserId })) {
    throw authError("forbidden", "Only the session's owner can do this.");
  }
  return access;
}
