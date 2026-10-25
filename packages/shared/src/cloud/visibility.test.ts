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
  canSeeUsage,
  boardEventSessionId,
  decideSessionShare,
  inheritedShare,
  isActiveMember,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  SESSION_VISIBILITIES,
  SESSION_VISIBILITY_REASONS,
  sessionAudience,
  sessionVisibilityAtCreation,
  type MemberRole,
  type MembershipFacts,
} from "./visibility";
import { SESSION_ROLES } from "../agent-runtime";
import type { BoardEventPayload } from "./board-events";

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

  test("attention belongs to the one person it names, while they are an active Member", () => {
    const aliceMember = member({ userId: ALICE });
    expect(canSeeAttention(alice, { userId: ALICE }, project, aliceMember)).toBe(true);
    expect(canSeeAttention(bob, { userId: ALICE }, project, member())).toBe(false);
    expect(
      canSeeAttention(alice, { userId: ALICE }, project, member({ userId: ALICE, status: "left" })),
    ).toBe(false);
    expect(canSeeAttention(alice, { userId: ALICE }, project, null)).toBe(false);
  });

  test("an item in no Workspace (a runner alert) is its person's alone, whatever their memberships", () => {
    expect(canSeeAttention(alice, { userId: ALICE }, null, null)).toBe(true);
    expect(
      canSeeAttention(alice, { userId: ALICE }, null, member({ userId: ALICE, status: "left" })),
    ).toBe(true);
    expect(canSeeAttention(bob, { userId: ALICE }, null, member({ role: "owner" }))).toBe(false);
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

// ── The A4 matrix ───────────────────────────────────────────────────────────
//
// Every combination of the viewer's role, the viewer's relation to the
// Session, the Session's visibility, the Workspace's `shareAll` policy and the
// state of the viewer's membership, checked against the rules as the product
// states them (not against the implementation's own expression):
//   - nobody who is not an active Member of the project's current Workspace
//     sees anything there;
//   - an active Member sees a shared Session, their own Session, and every
//     Session while `shareAll` is on;
//   - role never widens Session visibility.

/** The states a viewer's membership row can be in, as the predicates receive it. */
const MEMBERSHIP_STATES = [
  ...MEMBER_STATUSES,
  "none",
  "another_workspace",
  "another_persons_row",
] as const;
type MembershipState = (typeof MEMBERSHIP_STATES)[number];

function membershipIn(state: MembershipState, role: MemberRole): MembershipFacts | null {
  switch (state) {
    case "none":
      return null;
    case "another_workspace":
      return member({ role, workspaceId: OTHER_WS });
    case "another_persons_row":
      return member({ role, userId: ALICE });
    default:
      return member({ role, status: state });
  }
}

const RELATIONS = ["owner", "teammate"] as const;

describe("canSeeSession: role × relation × visibility × shareAll × membership", () => {
  const cases = MEMBER_ROLES.flatMap((role) =>
    RELATIONS.flatMap((relation) =>
      SESSION_VISIBILITIES.flatMap((visibility) =>
        [false, true].flatMap((shareAll) =>
          MEMBERSHIP_STATES.map((state) => ({ role, relation, visibility, shareAll, state })),
        ),
      ),
    ),
  );

  test("covers every combination", () => {
    expect(cases).toHaveLength(
      MEMBER_ROLES.length * RELATIONS.length * 2 * 2 * MEMBERSHIP_STATES.length,
    );
  });

  test.each(cases)("$role $relation · $visibility · shareAll=$shareAll · $state", (c) => {
    const session = { ownerUserId: c.relation === "owner" ? BOB : ALICE, visibility: c.visibility };
    const expected =
      c.state === "active" && (c.visibility === "shared" || c.relation === "owner" || c.shareAll);
    expect(
      canSeeSession(bob, session, project, membershipIn(c.state, c.role), {
        shareAll: c.shareAll,
      }),
    ).toBe(expected);
  });
});

describe("A3 owner defaults", () => {
  test("a departed or suspended owner's private Sessions are visible to nobody, unless shareAll is on", () => {
    const departed = { ownerUserId: ALICE, visibility: "private" as const };
    for (const status of ["left", "suspended"] as const) {
      // Alice herself no longer sees it in this Workspace.
      expect(
        canSeeSession(alice, departed, project, member({ userId: ALICE, status }), {
          shareAll: true,
        }),
      ).toBe(false);
    }
    for (const role of MEMBER_ROLES) {
      expect(
        canSeeSession(bob, departed, project, member({ role }), DEFAULT_WORKSPACE_POLICY),
      ).toBe(false);
      expect(canSeeSession(bob, departed, project, member({ role }), { shareAll: true })).toBe(
        true,
      );
    }
  });

  test("a teammate invited later reads shared (migrated) ticket Sessions, not ad-hoc ones", () => {
    const migratedTicket = {
      ownerUserId: ALICE,
      ...sessionVisibilityAtCreation({ role: "ticket" }, 9),
    };
    const migratedChat = {
      ownerUserId: ALICE,
      ...sessionVisibilityAtCreation({ role: "project" }, 9),
    };
    const newcomer = member({ role: "member" });
    expect(canSeeSession(bob, migratedTicket, project, newcomer, DEFAULT_WORKSPACE_POLICY)).toBe(
      true,
    );
    expect(canSeeSession(bob, migratedChat, project, newcomer, DEFAULT_WORKSPACE_POLICY)).toBe(
      false,
    );
  });

  test("members invite by default", () => {
    expect(DEFAULT_WORKSPACE_POLICY).toEqual({ shareAll: false, whoCanInvite: "members" });
    expect(canManage(bob, WS, member(), "invite", DEFAULT_WORKSPACE_POLICY)).toBe(true);
  });
});

describe("canSeeUsage: role × own/other row × membership", () => {
  const cases = MEMBER_ROLES.flatMap((role) =>
    (["own", "other"] as const).flatMap((row) =>
      MEMBERSHIP_STATES.map((state) => ({ role, row, state })),
    ),
  );

  test.each(cases)("$role · $row row · $state", (c) => {
    const usage = { workspaceId: WS, userId: c.row === "own" ? BOB : ALICE };
    const expected = c.state === "active" && (c.row === "own" || c.role !== "member");
    expect(canSeeUsage(bob, usage, membershipIn(c.state, c.role))).toBe(expected);
  });
});

describe("canSeeAttention: role × own/other item × shareAll-independence × membership", () => {
  const cases = MEMBER_ROLES.flatMap((role) =>
    (["own", "other"] as const).flatMap((item) =>
      MEMBERSHIP_STATES.map((state) => ({ role, item, state })),
    ),
  );

  test.each(cases)("$role · $item item · $state", (c) => {
    const item = { userId: c.item === "own" ? BOB : ALICE };
    const expected = c.state === "active" && c.item === "own";
    expect(canSeeAttention(bob, item, project, membershipIn(c.state, c.role))).toBe(expected);
  });
});

describe("sessionAudience", () => {
  test("shared reaches the Workspace by itself; private only through shareAll", () => {
    expect(sessionAudience({ visibility: "shared" }, { shareAll: false })).toEqual({
      kind: "workspace",
      via: "session",
    });
    expect(sessionAudience({ visibility: "shared" }, { shareAll: true })).toEqual({
      kind: "workspace",
      via: "session",
    });
    expect(sessionAudience({ visibility: "private" }, { shareAll: true })).toEqual({
      kind: "workspace",
      via: "policy",
    });
    expect(sessionAudience({ visibility: "private" }, { shareAll: false })).toEqual({
      kind: "owner",
    });
  });
});

describe("sessionVisibilityAtCreation", () => {
  test("ticket work is shared, ad-hoc and Board Sessions private, subagents inherit", () => {
    expect(sessionVisibilityAtCreation({ role: "ticket" }, 9)).toEqual({
      visibility: "shared",
      visibilityReason: "ticket",
      sharedAt: 9,
    });
    expect(sessionVisibilityAtCreation({ role: "project" }, 9)).toEqual({
      visibility: "private",
      visibilityReason: "adhoc",
      sharedAt: null,
    });
    for (const visibility of SESSION_VISIBILITIES) {
      expect(sessionVisibilityAtCreation({ role: "subagent", parent: { visibility } }, 9)).toEqual({
        visibility,
        visibilityReason: "inherited",
        sharedAt: visibility === "shared" ? 9 : null,
      });
    }
  });

  test("every reason it writes is a stored reason", () => {
    const written = [
      sessionVisibilityAtCreation({ role: "ticket" }, 9),
      sessionVisibilityAtCreation({ role: "project" }, 9),
      sessionVisibilityAtCreation({ role: "subagent", parent: { visibility: "private" } }, 9),
    ].map((facts) => facts.visibilityReason);
    for (const reason of written) expect(SESSION_VISIBILITY_REASONS).toContain(reason);
  });
});

describe("decideSessionShare / inheritedShare: the one-way flip", () => {
  test.each(
    RELATIONS.flatMap((relation) =>
      SESSION_VISIBILITIES.flatMap((visibility) =>
        SESSION_ROLES.map((role) => ({ relation, visibility, role })),
      ),
    ),
  )("$relation · $visibility · $role", ({ relation, visibility, role }) => {
    const session = { ownerUserId: relation === "owner" ? BOB : ALICE, visibility, role };
    const decision = decideSessionShare(bob, session, 42);
    if (relation !== "owner") {
      expect(decision).toEqual({ kind: "refused", code: "not_owner" });
    } else if (visibility === "shared") {
      expect(decision).toEqual({ kind: "already_shared" });
    } else if (role === "subagent") {
      expect(decision).toEqual({ kind: "refused", code: "subagent" });
    } else {
      expect(decision).toEqual({
        kind: "share",
        patch: { visibility: "shared", visibilityReason: "owner_shared", sharedAt: 42 },
      });
    }
  });

  test("no decision ever makes a Session private", () => {
    for (const relation of RELATIONS) {
      for (const visibility of SESSION_VISIBILITIES) {
        for (const role of SESSION_ROLES) {
          const decision = decideSessionShare(
            bob,
            { ownerUserId: relation === "owner" ? BOB : ALICE, visibility, role },
            1,
          );
          if (decision.kind === "share") expect(decision.patch.visibility).toBe("shared");
        }
      }
    }
  });

  test("a private subagent becomes shared with its ancestor; a shared one is left alone", () => {
    expect(inheritedShare({ visibility: "private" }, 7)).toEqual({
      visibility: "shared",
      visibilityReason: "inherited",
      sharedAt: 7,
    });
    expect(inheritedShare({ visibility: "shared" }, 7)).toBeNull();
  });
});

describe("boardEventSessionId", () => {
  const sessionId = "55555555-5555-4555-8555-555555555555";

  test("reads the Session a board event names", () => {
    const named: BoardEventPayload[] = [
      { kind: "session_started", sessionId: sessionId as never },
      { kind: "session_stopped", sessionId: sessionId as never, reason: null },
      {
        kind: "automation_run_started",
        automationId: "66666666-6666-4666-8666-666666666666" as never,
        runId: "run",
        sessionId: sessionId as never,
      },
    ];
    for (const payload of named) expect(boardEventSessionId(payload)).toBe(sessionId);
  });

  test("an event that names no Session, or a malformed one, is not gated by a Session", () => {
    expect(boardEventSessionId({ kind: "retitled", from: "a", to: "b" })).toBeNull();
    expect(boardEventSessionId({ kind: "session_started", sessionId: 7 })).toBeNull();
  });
});
