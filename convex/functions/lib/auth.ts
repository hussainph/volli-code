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
 *
 * A machine is never a viewer: a runner token or an Agent token is
 * `not_a_person` here. A function an agent may call resolves its caller with
 * `requireActor` (`lib/actorAuth.ts`) and hands the resolved viewer (the
 * Session owner) to the helpers below through their optional `viewer`
 * argument; every helper left to resolve its own viewer stays person-only.
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
import { isAgentIdentity, isRunnerIdentity } from "./runnerAuth";
import { requirePreviewAccess } from "./previewAccess";

export type AuthErrorCode =
  | "unauthenticated"
  | "no_viewer"
  | "account_deleted"
  | "account_deletion_pending"
  | "identity_conflict"
  | "not_a_person"
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
  const displayName = [identity.name, identity.nickname, email?.split("@")[0]]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value !== "");
  return {
    primaryEmail: email,
    // A `customJwt` provider passes claims through as named (`email_verified`);
    // an OIDC provider maps them (`emailVerified`).
    emailVerified:
      email !== null && (identity.emailVerified === true || identity["email_verified"] === true),
    displayName: displayName ?? "Volli user",
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
  const user = await ctx.db
    .query("users")
    .withIndex("by_uuid", (q) => q.eq("id", link.userId))
    .unique();
  // A link to no user is corruption: minting a second user (and a second link
  // for the same token) would make every later lookup ambiguous.
  if (user === null) {
    throw authError("identity_conflict", "This sign-in is linked to an account that is missing.");
  }
  return user;
}

function liveViewer(user: Doc<"users">): Viewer {
  if (user.status === "deleted") {
    throw authError("account_deleted", "This account has been deleted.");
  }
  return { userId: user.id as UserId, user };
}

/** A runner or an agent: a machine identity, which never resolves to a person. */
function isMachineIdentity(identity: UserIdentity): boolean {
  return isRunnerIdentity(identity) || isAgentIdentity(identity);
}

/**
 * The viewer, or `null` when this identity has never called {@link ensureViewer}.
 * A runner or an agent is `not_a_person`.
 */
export async function findViewer(ctx: ReadCtx): Promise<Viewer | null> {
  const identity = await requireIdentity(ctx);
  if (isMachineIdentity(identity)) {
    throw authError("not_a_person", "Only a person can do this.");
  }
  const user = await userOf(ctx, identity);
  return user === null ? null : liveViewer(user);
}

/**
 * The viewer with live preview access and current agreement, or `no_viewer`
 * (call `accounts.ensureViewer` first). Enrollment/recovery uses `findViewer`.
 *
 * An account whose deletion is pending is signed out of everything but the
 * `accounts` functions that show it and restore it (`account_deletion_pending`):
 * those use {@link findViewer}.
 */
export async function requireViewer(ctx: ReadCtx): Promise<Viewer> {
  const viewer = await findViewer(ctx);
  if (viewer === null) throw authError("no_viewer", "This account is not set up yet.");
  if (viewer.user.status === "deletion_pending") {
    throw authError(
      "account_deletion_pending",
      "This account is scheduled for deletion. Restore it to continue.",
    );
  }
  // Account enrollment/recovery uses findViewer instead. Every product call
  // rechecks the live grant, including calls using an existing membership.
  await requirePreviewAccess(ctx, viewer);
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
  // A runner or Agent token is a machine, never a person: it must not mint a `users` row.
  if (isMachineIdentity(identity)) {
    throw authError("not_a_person", "A runner or an agent cannot sign in as a person.");
  }
  const now = Date.now();
  const existing = await userOf(ctx, identity);
  if (existing !== null) {
    let viewer = liveViewer(existing);
    const profile = profileOf(identity);
    // Email grants follow today's verified identity, never a stale stored address.
    if (
      profile.primaryEmail !== existing.primaryEmail ||
      profile.emailVerified !== existing.emailVerified
    ) {
      await ctx.db.patch(existing._id, {
        primaryEmail: profile.primaryEmail,
        emailVerified: profile.emailVerified,
      });
      viewer = liveViewer((await ctx.db.get(existing._id))!);
    }
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

export function membershipFacts(member: Doc<"workspaceMembers">): MembershipFacts {
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
  resolved?: Viewer,
): Promise<{ viewer: Viewer; workspace: Doc<"workspaces">; membership: MembershipFacts }> {
  const viewer = resolved ?? (await requireViewer(ctx));
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

/**
 * Whether a project is shown at all: not deleted, and not still being
 * imported. A project a person-authorized import is writing
 * (`moveState: "importing"`, `projectImports.ts`) is hidden from everyone,
 * its importer included, until the import commits: every read that finds a
 * project by id goes through {@link projectAccess}, and every read that
 * lists a Workspace's projects filters with this.
 */
export function isShownProject(project: Pick<Doc<"projects">, "deletedAt" | "moveState">): boolean {
  return project.deletedAt === null && project.moveState !== "importing";
}

/**
 * Whether a project is still being imported (`projectImports.ts`): its jobs
 * are neither handed out nor cancelled; they wait, untouched, for the commit.
 */
export async function projectImporting(
  ctx: { db: GenericDatabaseReader<DataModel> },
  projectId: string,
): Promise<boolean> {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_uuid", (q) => q.eq("id", projectId))
    .unique();
  return project?.moveState === "importing";
}

type ProjectAccess =
  | { kind: "ok"; project: Doc<"projects">; membership: MembershipFacts }
  | { kind: "not_found" }
  | { kind: "not_a_member" };

async function projectAccess(
  ctx: { db: GenericDatabaseReader<DataModel> },
  viewer: { userId: UserId },
  projectId: string,
): Promise<ProjectAccess> {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_uuid", (q) => q.eq("id", projectId))
    .unique();
  // Deleted, or still being imported: not found, for everyone.
  if (project === null || !isShownProject(project)) return { kind: "not_found" };
  // A deleted Workspace hides everything in it at once.
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_uuid", (q) => q.eq("id", project.workspaceId))
    .unique();
  if (workspace === null || workspace.deletedAt !== null) return { kind: "not_found" };
  const membership = await findMembership(ctx, project.workspaceId, viewer.userId);
  if (!canSeeProject(viewer, { workspaceId: project.workspaceId as WorkspaceId }, membership)) {
    return { kind: "not_a_member" };
  }
  return { kind: "ok", project, membership };
}

/**
 * The live project (in a live Workspace) `userId` can see, or `null`: for a
 * caller acting for someone other than the signed-in viewer (a runner for its
 * owner) and for reads that skip what a person can no longer see.
 */
export async function findVisibleProject(
  ctx: { db: GenericDatabaseReader<DataModel> },
  userId: UserId,
  projectId: string,
): Promise<Doc<"projects"> | null> {
  const access = await projectAccess(ctx, { userId }, projectId);
  return access.kind === "ok" ? access.project : null;
}

/** A live project (in a live Workspace) the viewer can see: an active Member of its CURRENT Workspace. */
export async function requireProject(
  ctx: ReadCtx,
  projectId: ProjectId | string,
  resolved?: Viewer,
): Promise<{ viewer: Viewer; project: Doc<"projects">; membership: MembershipFacts }> {
  const viewer = resolved ?? (await requireViewer(ctx));
  const access = await projectAccess(ctx, viewer, projectId);
  if (access.kind === "not_found") throw authError("not_found", "That project does not exist.");
  if (access.kind === "not_a_member") {
    throw authError("not_a_member", "You are not a member of this project's workspace.");
  }
  return { viewer, project: access.project, membership: access.membership };
}

/** The Session fields a visibility decision reads. */
export type SessionVisibilityRow = Pick<
  Doc<"sessions">,
  "projectId" | "ownerUserId" | "visibility" | "deletedAt" | "role"
>;

/** A Session row as the shared predicates read it. */
export function sessionFacts(
  session: Pick<Doc<"sessions">, "ownerUserId" | "visibility" | "role">,
): {
  ownerUserId: UserId;
  visibility: Doc<"sessions">["visibility"];
  role: Doc<"sessions">["role"];
} {
  return {
    ownerUserId: session.ownerUserId as UserId,
    visibility: session.visibility,
    role: session.role,
  };
}

/** A Session the viewer can see, with the project and policy its visibility was decided under. */
export interface VisibleSession {
  viewer: Viewer;
  session: Doc<"sessions">;
  project: Doc<"projects">;
  policy: PolicyFacts;
}

/**
 * One project's Sessions as the viewer may see them: the viewer, their active
 * membership and the Workspace policy, each looked up once, and `canSee`, the
 * decision for any number of that project's Session rows. `shareAll` is read
 * here, at read time, and nowhere is it written onto a Session.
 */
export interface SessionScope {
  viewer: Viewer;
  project: Doc<"projects">;
  membership: MembershipFacts;
  policy: PolicyFacts;
  /** Live, in this project, and visible to the viewer (owner, shared, or `shareAll`). */
  canSee(session: SessionVisibilityRow): boolean;
}

async function sessionScope(
  ctx: ReadCtx,
  viewer: Viewer,
  project: Doc<"projects">,
  membership: MembershipFacts,
): Promise<SessionScope> {
  const policy = await findPolicy(ctx, project.workspaceId);
  const workspace = { workspaceId: project.workspaceId as WorkspaceId };
  return {
    viewer,
    project,
    membership,
    policy,
    canSee: (session) =>
      session.deletedAt === null &&
      session.projectId === project.id &&
      canSeeSession(viewer, sessionFacts(session), workspace, membership, policy),
  };
}

/**
 * The scope for reading a project's Sessions (listings, feeds): the project
 * must be live and the viewer an active Member of its CURRENT Workspace, or
 * `not_found` / `not_a_member` as {@link requireProject} says. Filter each
 * Session row with `canSee`.
 */
export async function requireSessionScope(
  ctx: ReadCtx,
  projectId: ProjectId | string,
  resolved?: Viewer,
): Promise<SessionScope> {
  const { viewer, project, membership } = await requireProject(ctx, projectId, resolved);
  return sessionScope(ctx, viewer, project, membership);
}

/**
 * A live Session the viewer can see: owner, shared, or the Workspace shares
 * everything. Whether a Session exists is part of what may be private, so
 * every refusal after sign-in reads the same: `not_found`.
 */
export async function requireSessionVisible(
  ctx: ReadCtx,
  sessionId: SessionId | string,
  resolved?: Viewer,
): Promise<VisibleSession> {
  const absent = () => authError("not_found", "That session does not exist.");
  const viewer = resolved ?? (await requireViewer(ctx));
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_uuid", (q) => q.eq("id", sessionId))
    .unique();
  if (session === null || session.deletedAt !== null) throw absent();
  const access = await projectAccess(ctx, viewer, session.projectId);
  if (access.kind !== "ok") throw absent();
  const scope = await sessionScope(ctx, viewer, access.project, access.membership);
  if (!scope.canSee(session)) throw absent();
  return { viewer, session, project: access.project, policy: scope.policy };
}

/** A Session the viewer may act on (0.3: its owner only). */
export async function requireSessionActor(
  ctx: ReadCtx,
  sessionId: SessionId | string,
  resolved?: Viewer,
): Promise<VisibleSession> {
  const access = await requireSessionVisible(ctx, sessionId, resolved);
  if (!canActOnSession(access.viewer, sessionFacts(access.session))) {
    throw authError("forbidden", "Only the session's owner can do this.");
  }
  return access;
}
