/**
 * Who may see and do what in a Workspace (0.3), evaluated once.
 *
 * Pure predicates the backend's queries and mutations call, and that clients
 * may call for optimistic UI. Membership is looked up by `(workspaceId,
 * userId)` through the project's CURRENT Workspace; a suspended or departed
 * Member sees nothing in that Workspace, while their rows stay attributed to
 * them.
 *
 * - Every active Member sees every project, ticket, comment, signal, label and
 *   board event of the Workspace.
 * - A `shared` Session is visible to every active Member; a `private` one to
 *   its owner, or to everyone while the Workspace's `shareAll` policy is on.
 *   `shareAll` is read-time only: turning it off restores per-Session
 *   visibility because nothing was rewritten.
 * - Only the owner acts on a Session in 0.3 (no co-chat until 1.0).
 * - Attention belongs to one person, whatever `shareAll` says.
 */

import type { UserId, WorkspaceId } from "./ids";

export const MEMBER_ROLES = ["owner", "admin", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_STATUSES = ["active", "suspended", "left"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const SESSION_VISIBILITIES = ["shared", "private"] as const;
export type SessionVisibility = (typeof SESSION_VISIBILITIES)[number];

export const WHO_CAN_INVITE = ["admins", "members"] as const;
export type WhoCanInvite = (typeof WHO_CAN_INVITE)[number];

export interface Viewer {
  userId: UserId;
}

/** A Workspace membership as the predicates read it. */
export interface MembershipFacts {
  workspaceId: WorkspaceId;
  userId: UserId;
  role: MemberRole;
  status: MemberStatus;
}

/** The admin policy fields the predicates read. */
export interface PolicyFacts {
  shareAll: boolean;
  whoCanInvite: WhoCanInvite;
}

/** The policy a Workspace has before anyone edits it. */
export const DEFAULT_WORKSPACE_POLICY: PolicyFacts = { shareAll: false, whoCanInvite: "members" };

/** Whether `membership` is the viewer's active membership of `workspaceId`. */
export function isActiveMember(
  viewer: Viewer,
  workspaceId: WorkspaceId,
  membership: MembershipFacts | null,
): membership is MembershipFacts {
  return (
    membership !== null &&
    membership.status === "active" &&
    membership.userId === viewer.userId &&
    membership.workspaceId === workspaceId
  );
}

/** Every active Member of the project's current Workspace sees the project and everything on its board. */
export function canSeeProject(
  viewer: Viewer,
  project: { workspaceId: WorkspaceId },
  membership: MembershipFacts | null,
): boolean {
  return isActiveMember(viewer, project.workspaceId, membership);
}

/**
 * A Session is visible to its owner, to every active Member when shared, and
 * to every active Member when the Workspace shares everything. An owner who
 * has left the Workspace no longer sees it there.
 */
export function canSeeSession(
  viewer: Viewer,
  session: { ownerUserId: UserId; visibility: SessionVisibility },
  project: { workspaceId: WorkspaceId },
  membership: MembershipFacts | null,
  policy: Pick<PolicyFacts, "shareAll">,
): boolean {
  if (!canSeeProject(viewer, project, membership)) return false;
  return (
    session.ownerUserId === viewer.userId || session.visibility === "shared" || policy.shareAll
  );
}

/** 0.3: only the Session's owner acts on it. */
export function canActOnSession(viewer: Viewer, session: { ownerUserId: UserId }): boolean {
  return session.ownerUserId === viewer.userId;
}

/** A Needs-you item belongs to the one person it names. */
export function canSeeAttention(viewer: Viewer, item: { userId: UserId }): boolean {
  return item.userId === viewer.userId;
}

/** Role-gated Workspace actions. */
export const MANAGE_GATES = ["billing", "invite", "members", "policy", "settings"] as const;
export type ManageGate = (typeof MANAGE_GATES)[number];

/**
 * Whether an active Member may perform a gated Workspace action: billing,
 * Member management, policy and settings need an owner or admin; inviting
 * follows the Workspace's `whoCanInvite` policy.
 */
export function canManage(
  viewer: Viewer,
  workspaceId: WorkspaceId,
  membership: MembershipFacts | null,
  gate: ManageGate,
  policy: Pick<PolicyFacts, "whoCanInvite">,
): boolean {
  if (!isActiveMember(viewer, workspaceId, membership)) return false;
  if (membership.role === "owner" || membership.role === "admin") return true;
  return gate === "invite" && policy.whoCanInvite === "members";
}
