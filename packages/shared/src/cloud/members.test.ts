import { describe, expect, test } from "vite-plus/test";

import type { UserId, WorkspaceId } from "./ids";
import {
  canInviteAs,
  canReissueInvite,
  canRevokeInvite,
  decideInviteAcceptance,
  decideMemberChange,
  type InviteAcceptanceFacts,
  type InviteFacts,
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
  const members = { whoCanInvite: "members" as const };
  const admins = { whoCanInvite: "admins" as const };

  test("grants at most the inviter's own role", () => {
    expect(canInviteAs(viewer, WS, as("owner"), "owner", admins)).toBe(true);
    expect(canInviteAs(viewer, WS, as("admin"), "admin", admins)).toBe(true);
    expect(canInviteAs(viewer, WS, as("admin"), "owner", admins)).toBe(false);
    expect(canInviteAs(viewer, WS, as("member"), "member", members)).toBe(true);
    expect(canInviteAs(viewer, WS, as("member"), "admin", members)).toBe(false);
  });

  test("whoCanInvite = admins stops members inviting", () => {
    expect(canInviteAs(viewer, WS, as("member"), "member", admins)).toBe(false);
  });

  test("needs the viewer's own active membership of that Workspace", () => {
    expect(canInviteAs(viewer, WS, null, "member", members)).toBe(false);
    expect(canInviteAs(viewer, WS, facts(ACTOR, { status: "suspended" }), "member", members)).toBe(
      false,
    );
    expect(canInviteAs(viewer, WS, target(), "member", members)).toBe(false);
    expect(canInviteAs(viewer, OTHER_WS, as("owner"), "member", members)).toBe(false);
  });
});

describe("canRevokeInvite", () => {
  const viewer = { userId: ACTOR };
  const sentBy = (userId: UserId): InviteFacts => ({
    workspaceId: WS,
    invitedByUserId: userId,
    role: "member",
  });

  test("the sender, or an owner or admin", () => {
    expect(canRevokeInvite(viewer, as("member"), sentBy(ACTOR))).toBe(true);
    expect(canRevokeInvite(viewer, as("member"), sentBy(TARGET))).toBe(false);
    expect(canRevokeInvite(viewer, as("admin"), sentBy(TARGET))).toBe(true);
    expect(canRevokeInvite(viewer, as("owner"), sentBy(TARGET))).toBe(true);
  });

  test("needs the viewer's own active membership of the invite's Workspace", () => {
    expect(canRevokeInvite(viewer, null, sentBy(ACTOR))).toBe(false);
    expect(canRevokeInvite(viewer, facts(ACTOR, { status: "suspended" }), sentBy(ACTOR))).toBe(
      false,
    );
    expect(canRevokeInvite(viewer, as("owner"), { ...sentBy(TARGET), workspaceId: OTHER_WS })).toBe(
      false,
    );
  });
});

describe("canReissueInvite", () => {
  const viewer = { userId: ACTOR };
  const members = { whoCanInvite: "members" as const };
  const pending = (role: MemberRole, invitedByUserId: UserId = TARGET): InviteFacts => ({
    workspaceId: WS,
    invitedByUserId,
    role,
  });

  test("a member cannot take over someone else's invite", () => {
    expect(canReissueInvite(viewer, as("member"), pending("member"), "member", members)).toBe(
      false,
    );
    expect(
      canReissueInvite(viewer, as("member"), pending("member", ACTOR), "member", members),
    ).toBe(true);
  });

  test("nobody replaces an invite that grants more than they could", () => {
    expect(canReissueInvite(viewer, as("admin"), pending("owner"), "member", members)).toBe(false);
    expect(canReissueInvite(viewer, as("admin"), pending("admin"), "member", members)).toBe(true);
    expect(canReissueInvite(viewer, as("owner"), pending("owner"), "owner", members)).toBe(true);
  });

  test("the new role is still capped by the viewer's own", () => {
    expect(canReissueInvite(viewer, as("admin"), pending("member"), "owner", members)).toBe(false);
  });
});

describe("decideInviteAcceptance", () => {
  const base: InviteAcceptanceFacts = {
    state: "pending",
    acceptedByViewer: false,
    emailMismatch: false,
    viewerStatus: null,
    senderMayInvite: true,
  };
  const decide = (overrides: Partial<InviteAcceptanceFacts>) =>
    decideInviteAcceptance({ ...base, ...overrides });

  test("a pending invite joins a newcomer or a departed Member", () => {
    expect(decide({})).toBe("join");
    expect(decide({ viewerStatus: "left" })).toBe("join");
  });

  test("accepting your own accepted invite again is a no-op", () => {
    expect(decide({ state: "accepted", acceptedByViewer: true, viewerStatus: "active" })).toBe(
      "already_member",
    );
    expect(decide({ state: "accepted", acceptedByViewer: true, viewerStatus: "left" })).toBe(
      "accepted",
    );
    expect(decide({ state: "accepted" })).toBe("accepted");
  });

  test("a revoked or expired invite is refused, whoever asks", () => {
    expect(decide({ state: "revoked", viewerStatus: "active" })).toBe("revoked");
    expect(decide({ state: "expired" })).toBe("expired");
  });

  test("the address is checked before membership", () => {
    expect(decide({ emailMismatch: true, viewerStatus: "active" })).toBe("email_mismatch");
    expect(decide({ viewerStatus: "active" })).toBe("already_member");
    expect(decide({ viewerStatus: "suspended" })).toBe("suspended");
  });

  test("an invite dies with its sender's right to send it", () => {
    expect(decide({ senderMayInvite: false })).toBe("sender_cannot_invite");
    expect(decide({ senderMayInvite: false, viewerStatus: "active" })).toBe("already_member");
  });
});
