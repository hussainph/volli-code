import { describe, expect, test } from "vite-plus/test";

import type { UserId, WorkspaceId } from "./ids";
import {
  DEFAULT_WORKSPACE_POLICY,
  MANAGE_GATES,
  canActOnSession,
  canManage,
  canSeeAttention,
  canSeeProject,
  canSeeSession,
  isActiveMember,
  type MembershipFacts,
} from "./visibility";

const ALICE = "11111111-1111-4111-8111-111111111111" as UserId;
const BOB = "22222222-2222-4222-8222-222222222222" as UserId;
const WS = "33333333-3333-4333-8333-333333333333" as WorkspaceId;
const OTHER_WS = "44444444-4444-4444-8444-444444444444" as WorkspaceId;

const alice = { userId: ALICE };
const bob = { userId: BOB };
const project = { workspaceId: WS };

function member(overrides: Partial<MembershipFacts> = {}): MembershipFacts {
  return { workspaceId: WS, userId: BOB, role: "member", status: "active", ...overrides };
}

describe("isActiveMember / canSeeProject", () => {
  test("an active Member of the project's current Workspace sees it", () => {
    expect(canSeeProject(bob, project, member())).toBe(true);
  });

  test("no membership, a suspended or departed Member, another Workspace or another person sees nothing", () => {
    expect(canSeeProject(bob, project, null)).toBe(false);
    expect(canSeeProject(bob, project, member({ status: "suspended" }))).toBe(false);
    expect(canSeeProject(bob, project, member({ status: "left" }))).toBe(false);
    expect(canSeeProject(bob, project, member({ workspaceId: OTHER_WS }))).toBe(false);
    expect(isActiveMember(alice, WS, member())).toBe(false);
  });
});

describe("canSeeSession", () => {
  const shared = { ownerUserId: ALICE, visibility: "shared" as const };
  const privateSession = { ownerUserId: ALICE, visibility: "private" as const };
  const aliceMember = member({ userId: ALICE });

  test("a shared Session is visible to every active Member", () => {
    expect(canSeeSession(bob, shared, project, member(), DEFAULT_WORKSPACE_POLICY)).toBe(true);
  });

  test("a private Session is visible to its owner only, unless the Workspace shares everything", () => {
    expect(
      canSeeSession(alice, privateSession, project, aliceMember, DEFAULT_WORKSPACE_POLICY),
    ).toBe(true);
    expect(canSeeSession(bob, privateSession, project, member(), DEFAULT_WORKSPACE_POLICY)).toBe(
      false,
    );
    expect(canSeeSession(bob, privateSession, project, member(), { shareAll: true })).toBe(true);
  });

  test("nobody outside the Workspace sees a Session, its owner included", () => {
    expect(canSeeSession(alice, privateSession, project, null, { shareAll: true })).toBe(false);
    expect(
      canSeeSession(alice, shared, project, member({ userId: ALICE, status: "left" }), {
        shareAll: true,
      }),
    ).toBe(false);
  });
});

describe("canActOnSession / canSeeAttention", () => {
  test("only the owner acts on a Session in 0.3", () => {
    expect(canActOnSession(alice, { ownerUserId: ALICE })).toBe(true);
    expect(canActOnSession(bob, { ownerUserId: ALICE })).toBe(false);
  });

  test("attention belongs to the one person it names", () => {
    expect(canSeeAttention(alice, { userId: ALICE })).toBe(true);
    expect(canSeeAttention(bob, { userId: ALICE })).toBe(false);
  });
});

describe("canManage", () => {
  test("owners and admins pass every gate", () => {
    for (const role of ["owner", "admin"] as const) {
      for (const gate of MANAGE_GATES) {
        expect(canManage(bob, WS, member({ role }), gate, { whoCanInvite: "admins" })).toBe(true);
      }
    }
  });

  test("a Member may invite only when the policy lets members invite", () => {
    expect(canManage(bob, WS, member(), "invite", { whoCanInvite: "members" })).toBe(true);
    expect(canManage(bob, WS, member(), "invite", { whoCanInvite: "admins" })).toBe(false);
    for (const gate of ["billing", "members", "policy", "settings"] as const) {
      expect(canManage(bob, WS, member(), gate, DEFAULT_WORKSPACE_POLICY)).toBe(false);
    }
  });

  test("an inactive owner manages nothing", () => {
    expect(
      canManage(
        bob,
        WS,
        member({ role: "owner", status: "suspended" }),
        "billing",
        DEFAULT_WORKSPACE_POLICY,
      ),
    ).toBe(false);
  });
});
