/**
 * Who may change whose membership of a Workspace (0.3), evaluated once.
 *
 * Pure decisions the backend's Member and invite mutations run, and that a
 * client may run to show only the actions that will succeed. The caller has
 * already resolved the acting person's ACTIVE membership; these rules decide
 * the rest:
 *
 * - Roles rank `member` < `admin` < `owner`. An inviter grants at most their
 *   own role (a member, where `whoCanInvite` lets them invite, invites
 *   members).
 * - Owners and admins manage Members. Only an owner touches an owner: grants
 *   the role, takes it away, suspends or removes one.
 * - A Workspace always keeps an active owner: the last one cannot be demoted,
 *   suspended, removed or leave. Hand the role to someone first.
 * - Nobody suspends or removes themselves; leaving is its own action.
 * - A departed (`left`) Member is no longer a Member: nothing applies to them
 *   until they are invited back.
 */

import type { UserId } from "./ids";
import type { MemberRole, MembershipFacts, PolicyFacts } from "./visibility";
import { isActiveMember } from "./visibility";

const ROLE_RANK: Record<MemberRole, number> = { member: 0, admin: 1, owner: 2 };

/** Whether `role` ranks at or above `floor`. */
export function roleAtLeast(role: MemberRole, floor: MemberRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[floor];
}

/** A change to one Member's membership. */
export type MemberChange =
  | { kind: "set_role"; role: MemberRole }
  | { kind: "suspend" }
  | { kind: "unsuspend" }
  | { kind: "remove" }
  | { kind: "leave" };

/** Why a {@link MemberChange} is refused. */
export type MemberChangeRefusal =
  /** The actor's role does not allow it (or only an owner may touch an owner). */
  | "forbidden"
  /** It would leave the Workspace with no active owner. */
  | "last_owner"
  /** Suspending or removing yourself; leave instead. */
  | "self"
  /** The target is not (or no longer) a Member. */
  | "not_a_member";

/**
 * Whether `actor` (an active Member) may apply `change` to `target` in the
 * same Workspace, given how many ACTIVE owners it has now. `null` means
 * allowed; a change that would not change anything (suspending a suspended
 * Member) is allowed and is the caller's no-op.
 */
export function decideMemberChange(
  actor: MembershipFacts,
  target: MembershipFacts | null,
  change: MemberChange,
  activeOwners: number,
): MemberChangeRefusal | null {
  if (target === null || target.status === "left" || target.workspaceId !== actor.workspaceId) {
    return "not_a_member";
  }
  const self = target.userId === actor.userId;
  // Taking an active owner out of the owner set needs another active owner.
  const losesAnOwner =
    target.role === "owner" &&
    target.status === "active" &&
    (change.kind === "suspend" ||
      change.kind === "remove" ||
      change.kind === "leave" ||
      (change.kind === "set_role" && change.role !== "owner"));

  if (change.kind === "leave") {
    if (!self) return "forbidden";
    return losesAnOwner && activeOwners <= 1 ? "last_owner" : null;
  }
  if (!roleAtLeast(actor.role, "admin")) return "forbidden";
  if (self && (change.kind === "suspend" || change.kind === "remove")) return "self";
  const touchesOwner =
    target.role === "owner" || (change.kind === "set_role" && change.role === "owner");
  if (touchesOwner && actor.role !== "owner") return "forbidden";
  return losesAnOwner && activeOwners <= 1 ? "last_owner" : null;
}

/**
 * Whether an active Member may invite someone as `role`: the Workspace's
 * `whoCanInvite` policy lets them invite at all, and they grant at most their
 * own role.
 */
export function canInviteAs(
  viewer: { userId: UserId },
  membership: MembershipFacts | null,
  role: MemberRole,
  policy: Pick<PolicyFacts, "whoCanInvite">,
): boolean {
  if (membership === null || !isActiveMember(viewer, membership.workspaceId, membership)) {
    return false;
  }
  const mayInvite = roleAtLeast(membership.role, "admin") || policy.whoCanInvite === "members";
  return mayInvite && roleAtLeast(membership.role, role);
}

/**
 * Whether an active Member may revoke a pending invite: the person who sent
 * it, or any owner or admin.
 */
export function canRevokeInvite(
  viewer: { userId: UserId },
  membership: MembershipFacts | null,
  invite: { invitedByUserId: UserId },
): boolean {
  if (membership === null || !isActiveMember(viewer, membership.workspaceId, membership)) {
    return false;
  }
  return invite.invitedByUserId === viewer.userId || roleAtLeast(membership.role, "admin");
}
