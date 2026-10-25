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
 *   board event of the Workspace, except a board event about a Session they
 *   cannot see (see {@link boardEventSessionId}).
 * - A `shared` Session is visible to every active Member; a `private` one to
 *   its owner, or to everyone while the Workspace's `shareAll` policy is on.
 *   `shareAll` is read-time only: turning it off restores per-Session
 *   visibility because nothing was rewritten. A Member's role never widens
 *   what Sessions they see: an admin sees a teammate's private chat only
 *   through `shareAll`, like everyone else.
 * - A Session's visibility is set once, at creation, from its role: ticket
 *   work is `shared`, ad-hoc chats and Board Sessions are `private`, and a
 *   subagent takes its parent's. After that it only ever moves one way,
 *   `private → shared` (someone may already have read a shared Session), and
 *   a subagent moves with its parent, never on its own. `sharedAt` is when it
 *   became shared: its creation time when born shared, the flip's time
 *   otherwise, `null` while private.
 * - Only the owner acts on a Session in 0.3 (no co-chat until 1.0).
 * - Attention belongs to one person, whatever `shareAll` says.
 * - Usage: a Member sees their own; owners and admins see everyone's.
 *
 * Who is a Member is evaluated here and nowhere else, so a departed or
 * suspended Member's private Sessions are visible to nobody (unless
 * `shareAll` is on), and a teammate who joins later sees every shared
 * Session, including ones created before they arrived.
 */

import type { SessionRole } from "../agent-runtime";
import type { SessionId, UserId, WorkspaceId } from "./ids";

export const MEMBER_ROLES = ["owner", "admin", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_STATUSES = ["active", "suspended", "left"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const SESSION_VISIBILITIES = ["shared", "private"] as const;
export type SessionVisibility = (typeof SESSION_VISIBILITIES)[number];

/**
 * Why a Session has the visibility it has, stored beside it:
 * - `ticket`: ticket work, shared at creation;
 * - `adhoc`: an ad-hoc chat or a Board Session, private at creation;
 * - `inherited`: a subagent took its parent's visibility, at its creation or
 *   when its parent was shared;
 * - `owner_shared`: the owner shared it;
 * - `collaborative`: it was shared because another Member joined it (1.0
 *   co-chat; nothing writes it in 0.3).
 */
export const SESSION_VISIBILITY_REASONS = [
  "ticket",
  "adhoc",
  "inherited",
  "owner_shared",
  "collaborative",
] as const;
export type SessionVisibilityReason = (typeof SESSION_VISIBILITY_REASONS)[number];

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

/**
 * Every active Member of the project's current Workspace sees the project and
 * its board (board events about a Session follow that Session's visibility).
 */
export function canSeeProject(
  viewer: Viewer,
  project: { workspaceId: WorkspaceId },
  membership: MembershipFacts | null,
): membership is MembershipFacts {
  return isActiveMember(viewer, project.workspaceId, membership);
}

/**
 * Who a Session is visible to, as the Workspace's current policy makes it:
 * its owner alone, or every active Member, either because the Session is
 * shared or because the Workspace shares everything (`via: "policy"`, which
 * stops the moment `shareAll` is turned off).
 */
export type SessionAudience = { kind: "owner" } | { kind: "workspace"; via: "session" | "policy" };

export function sessionAudience(
  session: { visibility: SessionVisibility },
  policy: Pick<PolicyFacts, "shareAll">,
): SessionAudience {
  if (session.visibility === "shared") return { kind: "workspace", via: "session" };
  if (policy.shareAll) return { kind: "workspace", via: "policy" };
  return { kind: "owner" };
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
    session.ownerUserId === viewer.userId || sessionAudience(session, policy).kind === "workspace"
  );
}

/** What a new Session's visibility is derived from: its role and, for a subagent, its parent. */
export type SessionVisibilitySource =
  | { role: Exclude<SessionRole, "subagent"> }
  | { role: "subagent"; parent: { visibility: SessionVisibility } };

/** The visibility fields a Session row stores. */
export interface SessionVisibilityFacts {
  visibility: SessionVisibility;
  visibilityReason: SessionVisibilityReason;
  /** When it became shared; `null` while private. */
  sharedAt: number | null;
}

function born(
  visibility: SessionVisibility,
  visibilityReason: SessionVisibilityReason,
  createdAt: number,
): SessionVisibilityFacts {
  return { visibility, visibilityReason, sharedAt: visibility === "shared" ? createdAt : null };
}

/**
 * A new Session's visibility: ticket work (an Automation run on a ticket
 * included) is shared, an ad-hoc chat or Board Session is private, and a
 * subagent takes its parent's. A migrated Session is derived the same way, so
 * migrated ticket history is readable by teammates invited later.
 */
export function sessionVisibilityAtCreation(
  source: SessionVisibilitySource,
  createdAt: number,
): SessionVisibilityFacts {
  switch (source.role) {
    case "ticket":
      return born("shared", "ticket", createdAt);
    case "project":
      return born("private", "adhoc", createdAt);
    case "subagent":
      return born(source.parent.visibility, "inherited", createdAt);
  }
}

/**
 * The owner's "Share": the one-way flip of a private Session to shared.
 * There is no way back (`shared → private` is never offered): someone may
 * already have read it. Sharing an already shared Session changes nothing.
 * Only the owner shares in 0.3, and only a root Session: a subagent follows
 * its parent (share the parent and it carries down, {@link inheritedShare}).
 * 1.0 co-chat adds a second way to flip, reason `collaborative`, when another
 * Member joins; nothing decides that yet.
 */
export type SessionShareDecision =
  | { kind: "share"; patch: SessionVisibilityFacts & { sharedAt: number } }
  | { kind: "already_shared" }
  | { kind: "refused"; code: "not_owner" | "subagent" };

export function decideSessionShare(
  viewer: Viewer,
  session: { ownerUserId: UserId; visibility: SessionVisibility; role: SessionRole },
  now: number,
): SessionShareDecision {
  if (!canActOnSession(viewer, session)) return { kind: "refused", code: "not_owner" };
  if (session.visibility === "shared") return { kind: "already_shared" };
  if (session.role === "subagent") return { kind: "refused", code: "subagent" };
  return {
    kind: "share",
    patch: { visibility: "shared", visibilityReason: "owner_shared", sharedAt: now },
  };
}

/**
 * What a subagent becomes when an ancestor is shared: a subagent of a shared
 * Session is shared, so the flip carries down the tree. `null` leaves an
 * already shared descendant (and the reason it was shared) alone.
 */
export function inheritedShare(
  descendant: { visibility: SessionVisibility },
  now: number,
): (SessionVisibilityFacts & { sharedAt: number }) | null {
  if (descendant.visibility === "shared") return null;
  return { visibility: "shared", visibilityReason: "inherited", sharedAt: now };
}

/**
 * The Session a board event is about, if any. A board event that names a
 * Session (its start, resume, signal, stop or failure, an Automation run's
 * Session) is shown only to those who can see that Session; every other board
 * event is visible to every active Member. Read from the stored payload, so a
 * kind added later that names a `sessionId` is gated without a change here.
 *
 * A Session id carried as attribution on a board change everyone sees (the
 * Actor's `sessionId` when an agent made the change, a `session` origin) does
 * not hide the change: the change and the person it acted for are board facts,
 * and the id is an opaque reference that reads as `not_found` to anyone who
 * cannot see that Session.
 */
export function boardEventSessionId(payload: object): SessionId | null {
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? (sessionId as SessionId) : null;
}

/** 0.3: only the Session's owner acts on it. */
export function canActOnSession(viewer: Viewer, session: { ownerUserId: UserId }): boolean {
  return session.ownerUserId === viewer.userId;
}

/**
 * A Needs-you item belongs to the one person it names. An item in a Workspace
 * (through its project's CURRENT Workspace, or the Workspace a billing item
 * names) is shown only while that person is an active Member there; pass
 * `scope: null` for an item that belongs to no Workspace (a runner alert),
 * which its person always sees. `shareAll` never shows one person's attention
 * to anyone else.
 */
export function canSeeAttention(
  viewer: Viewer,
  item: { userId: UserId },
  scope: { workspaceId: WorkspaceId } | null,
  membership: MembershipFacts | null,
): boolean {
  if (item.userId !== viewer.userId) return false;
  return scope === null || isActiveMember(viewer, scope.workspaceId, membership);
}

/**
 * A usage row (it carries the Workspace the spend happened in): an active
 * Member sees their own; owners and admins see every Member's.
 */
export function canSeeUsage(
  viewer: Viewer,
  row: { workspaceId: WorkspaceId; userId: UserId },
  membership: MembershipFacts | null,
): boolean {
  if (!isActiveMember(viewer, row.workspaceId, membership)) return false;
  return row.userId === viewer.userId || membership.role === "owner" || membership.role === "admin";
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
