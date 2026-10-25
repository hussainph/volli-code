import { describe, expect, test } from "vite-plus/test";

import type { UserId, WorkspaceId } from "./ids";
import {
  canInviteAs,
  canRevokeInvite,
  decideMemberChange,
  roleAtLeast,
  type MemberChange,
} from "./members";
import { MEMBER_ROLES, type MemberRole, type MembershipFacts } from "./visibility";

const ACTOR = "11111111-1111-4111-8111-111111111111" as UserId;
const TARGET = "22222222-2222-4222-8222-222222222222" as UserId;
const WS = "33333333-3333-4333-8333-333333333333" as WorkspaceId;
const OTHER_WS = "44444444-4444-4444-8444-444444444444" as WorkspaceId;

function facts(userId: UserId, overrides: Partial<MembershipFacts> = {}): MembershipFacts {
  return { workspaceId: WS, userId, role: "member", status: "active", ...overrides };
}

const as = (role: MemberRole) => facts(ACTOR, { role });
const target = (overrides: Partial<MembershipFacts> = {}) => facts(TARGET, overrides);

describe("roleAtLeast", () => {
  test("ranks member < admin < owner", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("admin", "owner")).toBe(false);
    expect(MEMBER_ROLES.every((role) => roleAtLeast(role, "member"))).toBe(true);
  });
});

describe("decideMemberChange", () => {
  const managed: MemberChange[] = [
    { kind: "set_role", role: "admin" },
    { kind: "suspend" },
    { kind: "unsuspend" },
    { kind: "remove" },
  ];

  test("a member manages nobody", () => {
    for (const change of managed) {
      expect(decideMemberChange(as("member"), target(), change, 2)).toBe("forbidden");
    }
  });

  test("an admin manages members and admins", () => {
    for (const change of managed) {
      expect(decideMemberChange(as("admin"), target(), change, 1)).toBeNull();
      expect(decideMemberChange(as("admin"), target({ role: "admin" }), change, 1)).toBeNull();
    }
    expect(
      decideMemberChange(
        as("admin"),
        target({ role: "admin" }),
        { kind: "set_role", role: "member" },
        1,
      ),
    ).toBeNull();
  });

  test("only an owner touches an owner, or grants the role", () => {
    for (const change of managed) {
      expect(decideMemberChange(as("admin"), target({ role: "owner" }), change, 2)).toBe(
        "forbidden",
      );
      expect(decideMemberChange(as("owner"), target({ role: "owner" }), change, 2)).toBeNull();
    }
    const promote: MemberChange = { kind: "set_role", role: "owner" };
    expect(decideMemberChange(as("admin"), target(), promote, 1)).toBe("forbidden");
    expect(decideMemberChange(as("owner"), target(), promote, 1)).toBeNull();
    // An admin cannot promote themselves either.
    expect(decideMemberChange(as("admin"), as("admin"), promote, 1)).toBe("forbidden");
  });

  test("the last active owner cannot be demoted, suspended, removed or leave", () => {
    const owner = as("owner");
    expect(decideMemberChange(owner, owner, { kind: "set_role", role: "admin" }, 1)).toBe(
      "last_owner",
    );
    expect(decideMemberChange(owner, owner, { kind: "leave" }, 1)).toBe("last_owner");
    expect(decideMemberChange(owner, target({ role: "owner" }), { kind: "suspend" }, 1)).toBe(
      "last_owner",
    );
    expect(decideMemberChange(owner, target({ role: "owner" }), { kind: "remove" }, 1)).toBe(
      "last_owner",
    );
    // With a second active owner each of them is fine.
    expect(decideMemberChange(owner, owner, { kind: "set_role", role: "member" }, 2)).toBeNull();
    expect(decideMemberChange(owner, owner, { kind: "leave" }, 2)).toBeNull();
    // Keeping the role, or a suspended owner, does not lose an active owner.
    expect(decideMemberChange(owner, owner, { kind: "set_role", role: "owner" }, 1)).toBeNull();
    expect(
      decideMemberChange(
        owner,
        target({ role: "owner", status: "suspended" }),
        { kind: "remove" },
        1,
      ),
    ).toBeNull();
    expect(
      decideMemberChange(
        owner,
        target({ role: "owner", status: "suspended" }),
        { kind: "unsuspend" },
        1,
      ),
    ).toBeNull();
  });

  test("nobody suspends or removes themselves", () => {
    for (const role of MEMBER_ROLES.filter((each) => each !== "member")) {
      expect(decideMemberChange(as(role), as(role), { kind: "suspend" }, 2)).toBe("self");
      expect(decideMemberChange(as(role), as(role), { kind: "remove" }, 2)).toBe("self");
    }
    expect(
      decideMemberChange(as("admin"), as("admin"), { kind: "set_role", role: "member" }, 1),
    ).toBeNull();
  });

  test("anyone leaves, but only themselves", () => {
    for (const role of MEMBER_ROLES) {
      expect(decideMemberChange(as(role), as(role), { kind: "leave" }, 2)).toBeNull();
      expect(decideMemberChange(as(role), target(), { kind: "leave" }, 2)).toBe("forbidden");
    }
  });

  test("a departed, absent or foreign target is not a Member", () => {
    for (const change of [...managed, { kind: "leave" } as const]) {
      expect(decideMemberChange(as("owner"), null, change, 1)).toBe("not_a_member");
      expect(decideMemberChange(as("owner"), target({ status: "left" }), change, 1)).toBe(
        "not_a_member",
      );
      expect(decideMemberChange(as("owner"), target({ workspaceId: OTHER_WS }), change, 1)).toBe(
        "not_a_member",
      );
    }
  });
});

describe("canInviteAs", () => {
  const viewer = { userId: ACTOR };
  const policy = {
    members: { whoCanInvite: "members" as const },
    admins: { whoCanInvite: "admins" as const },
  };

  test("grants at most the inviter's own role", () => {
    expect(canInviteAs(viewer, as("owner"), "owner", policy.admins)).toBe(true);
    expect(canInviteAs(viewer, as("admin"), "admin", policy.admins)).toBe(true);
    expect(canInviteAs(viewer, as("admin"), "owner", policy.admins)).toBe(false);
    expect(canInviteAs(viewer, as("member"), "member", policy.members)).toBe(true);
    expect(canInviteAs(viewer, as("member"), "admin", policy.members)).toBe(false);
  });

  test("whoCanInvite = admins stops members inviting", () => {
    expect(canInviteAs(viewer, as("member"), "member", policy.admins)).toBe(false);
  });

  test("needs the viewer's own active membership", () => {
    expect(canInviteAs(viewer, null, "member", policy.members)).toBe(false);
    expect(
      canInviteAs(viewer, facts(ACTOR, { status: "suspended" }), "member", policy.members),
    ).toBe(false);
    expect(canInviteAs(viewer, target(), "member", policy.members)).toBe(false);
  });
});

describe("canRevokeInvite", () => {
  const viewer = { userId: ACTOR };

  test("the inviter, or an owner or admin", () => {
    expect(canRevokeInvite(viewer, as("member"), { invitedByUserId: ACTOR })).toBe(true);
    expect(canRevokeInvite(viewer, as("member"), { invitedByUserId: TARGET })).toBe(false);
    expect(canRevokeInvite(viewer, as("admin"), { invitedByUserId: TARGET })).toBe(true);
    expect(canRevokeInvite(viewer, as("owner"), { invitedByUserId: TARGET })).toBe(true);
  });

  test("needs the viewer's own active membership", () => {
    expect(canRevokeInvite(viewer, null, { invitedByUserId: ACTOR })).toBe(false);
    expect(
      canRevokeInvite(viewer, facts(ACTOR, { status: "suspended" }), { invitedByUserId: ACTOR }),
    ).toBe(false);
  });
});
