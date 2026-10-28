/** Presentation of accepted membership and Session facts; never changes the runner's fold. */
import {
  canActOnSession,
  decideSessionShare,
  sessionAudience,
  type MemberStatus,
  type SessionVisibility,
  type UserId,
} from "@volli/shared/cloud";
import type { SessionRole } from "@volli/shared";

export interface Person {
  readonly userId: string;
  readonly displayName: string;
  readonly status: MemberStatus;
}

export interface TeamSession {
  readonly ownerUserId: string;
  readonly visibility: SessionVisibility;
  readonly role: SessionRole;
  readonly turnActive: boolean;
}

export interface Directory {
  readonly viewerUserId: string | null;
  readonly people: readonly Person[];
}

export function personName(directory: Directory, userId: string): string {
  return directory.people.find((person) => person.userId === userId)?.displayName || "Unknown";
}

export function personLabel(directory: Directory, userId: string): string {
  return directory.viewerUserId === userId ? "You" : personName(directory, userId);
}

export function teamSessionModel(
  directory: Directory,
  session: TeamSession | null,
  shareAll: boolean | null,
) {
  if (session === null) return null;
  const ownerName = personName(directory, session.ownerUserId);
  const viewer = { userId: directory.viewerUserId as UserId };
  const facts = { ...session, ownerUserId: session.ownerUserId as UserId };
  const canAct = directory.viewerUserId !== null && canActOnSession(viewer, facts);
  const audience = sessionAudience(session, { shareAll: shareAll === true });
  const audienceUnknown = session.visibility === "private" && shareAll === null;
  const departed = directory.people.some(
    (person) => person.userId === session.ownerUserId && person.status === "left",
  );
  return {
    ownerName,
    initials: ownerName
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase(),
    canAct,
    canShare:
      directory.viewerUserId !== null && decideSessionShare(viewer, facts, 0).kind === "share",
    visibilityLabel: audienceUnknown
      ? "Loading audience…"
      : audience.kind === "owner"
        ? "Private"
        : audience.via === "policy"
          ? "Visible to the workspace (admin setting)"
          : "Shared with workspace",
    private: !audienceUnknown && audience.kind === "owner",
    ended: departed && session.turnActive ? `Ended · ${ownerName} left` : null,
  };
}
