import { convexTest } from "convex-test";
import type { GenericMutationCtx } from "convex/server";
import { describe, expect, test } from "vite-plus/test";

import { newId, type SessionRole, type SessionVisibility } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { DataModel } from "../functions/_generated/dataModel.js";
import { requireSessionScope } from "../functions/lib/auth";
import {
  MAX_SHARED_DESCENDANTS,
  visibilityForNewSession,
  visibleBoardEvents,
} from "../functions/lib/visibility";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

// The schema's inline role list and the shared `SessionRole` must not drift.
type StoredRole = DataModel["sessions"]["document"]["role"];
const rolesAgree: [Exclude<StoredRole, SessionRole>, Exclude<SessionRole, StoredRole>] extends [
  never,
  never,
]
  ? true
  : never = true;
void rolesAgree;

function setup() {
  return convexTest(schema, modules);
}

type T = ReturnType<typeof setup>;
type Client = ReturnType<T["withIdentity"]>;
type Ctx = GenericMutationCtx<DataModel>;

const ISSUER = "https://issuer.test";

function person(name: string) {
  return {
    subject: `user:${name.toLowerCase()}`,
    issuer: ISSUER,
    name,
    email: `${name.toLowerCase()}@example.com`,
    emailVerified: true,
  };
}

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

async function signIn(t: T, name: string) {
  const identity = person(name);
  // VC-936: the preview admits only allowlisted accounts, by verified email.
  await t.mutation(internal.previewAccess.set, {
    kind: "email",
    value: identity.email,
    enabled: true,
  });
  const client = t.withIdentity(identity);
  const { userId } = await client.mutation(api.accounts.ensureViewer, {});
  return { client, userId };
}

async function addMember(
  inviter: Client,
  invitee: Client,
  workspaceId: string,
  role: "owner" | "admin" | "member",
) {
  const { token } = await inviter.mutation(api.invites.create, { workspaceId, email: null, role });
  await invitee.mutation(api.invites.acceptLink, { token });
}

async function seedProject(ctx: Ctx, workspaceId: string) {
  const id = newId("project");
  await ctx.db.insert("projects", {
    id,
    workspaceId,
    name: "Volli",
    description: "",
    iconKey: null,
    colorIndex: 0,
    ticketPrefix: "VC",
    origin: "github",
    shipBehaviour: "pr",
    customShipPrompt: null,
    coAuthorDefault: true,
    countsTowardCap: true,
    createdByUserId: newId("user"),
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    deletedAt: null,
    purgeAfter: null,
  });
  return id;
}

async function seedSession(
  ctx: Ctx,
  input: {
    projectId: string;
    ownerUserId: string;
    visibility: SessionVisibility;
    parentSessionId?: string;
    deletedAt?: number;
  },
) {
  const id = newId("session");
  const subagent = input.parentSessionId !== undefined;
  await ctx.db.insert("sessions", {
    id,
    projectId: input.projectId,
    ticketId: null,
    role: subagent ? "subagent" : input.visibility === "shared" ? "ticket" : "project",
    parentSessionId: input.parentSessionId ?? null,
    ownerUserId: input.ownerUserId,
    origin: { kind: "user" },
    title: null,
    visibility: input.visibility,
    visibilityReason: subagent ? "inherited" : input.visibility === "shared" ? "ticket" : "adhoc",
    sharedAt: null,
    status: "open",
    turnActive: false,
    lastTurnOutcome: null,
    signal: null,
    stopped: null,
    needsUser: false,
    attentionCount: 0,
    placeRunnerId: newId("runner"),
    model: null,
    usageTotals: {},
    createdAt: 0,
    lastActivityAt: 0,
    deletedAt: input.deletedAt ?? null,
    purgeAfter: null,
  });
  return id;
}

async function sessionRow(t: T, id: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", id))
      .unique(),
  );
}

/**
 * A team Workspace with someone in every position the matrix needs: the owner
 * (Alice), an admin (Bob), two members (Carol, Frank), a suspended member
 * (Dave), a departed member (Erin), a signed-in outsider (Olga) and an
 * anonymous caller. Carol (active) and Erin (departed) each own one private
 * and one shared Session.
 */
async function team(t: T) {
  const owner = await signIn(t, "Alice");
  const admin = await signIn(t, "Bob");
  const member = await signIn(t, "Carol");
  const teammate = await signIn(t, "Frank");
  const suspended = await signIn(t, "Dave");
  const left = await signIn(t, "Erin");
  const outsider = await signIn(t, "Olga");
  const workspaceId = newId("workspace");
  await owner.client.mutation(api.workspaces.create, { workspaceId, name: "Acme" });
  await addMember(owner.client, admin.client, workspaceId, "admin");
  for (const someone of [member, teammate, suspended, left]) {
    await addMember(owner.client, someone.client, workspaceId, "member");
  }
  await owner.client.mutation(api.members.suspend, { workspaceId, userId: suspended.userId });
  await owner.client.mutation(api.members.remove, { workspaceId, userId: left.userId });
  const seeded = await t.run(async (ctx) => {
    const projectId = await seedProject(ctx, workspaceId);
    const session = (ownerUserId: string, visibility: SessionVisibility) =>
      seedSession(ctx, { projectId, ownerUserId, visibility });
    return {
      projectId,
      sessions: {
        memberPrivate: await session(member.userId, "private"),
        memberShared: await session(member.userId, "shared"),
        departedPrivate: await session(left.userId, "private"),
        departedShared: await session(left.userId, "shared"),
      },
    };
  });
  return {
    workspaceId,
    ...seeded,
    people: { owner, admin, member, teammate, suspended, left, outsider },
    anonymous: t,
  };
}

type Team = Awaited<ReturnType<typeof team>>;
type Position = keyof Team["people"] | "anonymous";
type SessionKey = keyof Team["sessions"];

const POSITIONS: Position[] = [
  "owner",
  "admin",
  "member",
  "teammate",
  "suspended",
  "left",
  "outsider",
  "anonymous",
];
const SESSION_KEYS: SessionKey[] = [
  "memberPrivate",
  "memberShared",
  "departedPrivate",
  "departedShared",
];

function caller(world: Team, position: Position): Client | T {
  return position === "anonymous" ? world.anonymous : world.people[position].client;
}

/** The rule as the product states it, independent of how the code expresses it. */
function expectedVisible(position: Position, key: SessionKey, shareAll: boolean): boolean {
  const active = ["owner", "admin", "member", "teammate"].includes(position);
  if (!active) return false;
  const shared = key.endsWith("Shared");
  const ownsIt = position === "member" && key.startsWith("member");
  return shared || ownsIt || shareAll;
}

describe("sessionVisibility.get: position × Session × shareAll", () => {
  test("every combination reads as the rules say, and an invisible Session is not_found", async () => {
    const t = setup();
    const world = await team(t);
    for (const shareAll of [false, true, false]) {
      await world.people.owner.client.mutation(api.workspaces.setPolicy, {
        workspaceId: world.workspaceId,
        shareAll,
      });
      for (const position of POSITIONS) {
        for (const key of SESSION_KEYS) {
          const read = caller(world, position).query(api.sessionVisibility.get, {
            sessionId: world.sessions[key],
          });
          const label = `${position} · ${key} · shareAll=${shareAll}`;
          if (expectedVisible(position, key, shareAll)) {
            await expect(read, label).resolves.toMatchObject({ sessionId: world.sessions[key] });
          } else {
            await expect(read, label).rejects.toThrow(
              code(position === "anonymous" ? "unauthenticated" : "not_found"),
            );
          }
        }
      }
    }
  });

  test("audience follows the policy at read time and nothing is rewritten", async () => {
    const t = setup();
    const world = await team(t);
    const { owner, member } = world.people;
    const before = await sessionRow(t, world.sessions.memberPrivate);

    await expect(
      member.client.query(api.sessionVisibility.get, { sessionId: world.sessions.memberPrivate }),
    ).resolves.toEqual({
      sessionId: world.sessions.memberPrivate,
      visibility: "private",
      visibilityReason: "adhoc",
      sharedAt: null,
      audience: { kind: "owner" },
      canShare: true,
    });

    await owner.client.mutation(api.workspaces.setPolicy, {
      workspaceId: world.workspaceId,
      shareAll: true,
    });
    await expect(
      owner.client.query(api.sessionVisibility.get, { sessionId: world.sessions.memberPrivate }),
    ).resolves.toMatchObject({
      visibility: "private",
      audience: { kind: "workspace", via: "policy" },
      canShare: false,
    });
    await expect(
      owner.client.query(api.sessionVisibility.get, { sessionId: world.sessions.memberShared }),
    ).resolves.toMatchObject({ audience: { kind: "workspace", via: "session" } });

    await owner.client.mutation(api.workspaces.setPolicy, {
      workspaceId: world.workspaceId,
      shareAll: false,
    });
    expect(await sessionRow(t, world.sessions.memberPrivate)).toEqual(before);
  });

  test("a teammate who joins later reads earlier shared ticket work, not private chats", async () => {
    const t = setup();
    const world = await team(t);
    const newcomer = await signIn(t, "Nina");
    await addMember(world.people.owner.client, newcomer.client, world.workspaceId, "member");
    await expect(
      newcomer.client.query(api.sessionVisibility.get, { sessionId: world.sessions.memberShared }),
    ).resolves.toMatchObject({ visibility: "shared" });
    await expect(
      newcomer.client.query(api.sessionVisibility.get, { sessionId: world.sessions.memberPrivate }),
    ).rejects.toThrow(code("not_found"));
  });
});

describe("sessionVisibility.share: the one-way flip", () => {
  test("the owner shares a private Session and its private subagents; teammates then see them", async () => {
    const t = setup();
    const world = await team(t);
    const { member, teammate } = world.people;
    const tree = await t.run(async (ctx) => {
      const base = { projectId: world.projectId, ownerUserId: member.userId };
      const root = world.sessions.memberPrivate;
      const child = await seedSession(ctx, {
        ...base,
        visibility: "private",
        parentSessionId: root,
      });
      const sharedChild = await seedSession(ctx, {
        ...base,
        visibility: "shared",
        parentSessionId: root,
      });
      const grandchild = await seedSession(ctx, {
        ...base,
        visibility: "private",
        parentSessionId: child,
      });
      return { root, child, sharedChild, grandchild };
    });
    const sharedChildBefore = await sessionRow(t, tree.sharedChild);

    for (const id of [tree.root, tree.child, tree.grandchild]) {
      await expect(
        teammate.client.query(api.sessionVisibility.get, { sessionId: id }),
      ).rejects.toThrow(code("not_found"));
    }

    const state = await member.client.mutation(api.sessionVisibility.share, {
      sessionId: tree.root,
    });
    expect(state).toMatchObject({
      visibility: "shared",
      visibilityReason: "owner_shared",
      audience: { kind: "workspace", via: "session" },
      canShare: false,
    });
    expect(state.sharedAt).toEqual(expect.any(Number));

    for (const id of [tree.child, tree.grandchild]) {
      await expect(
        teammate.client.query(api.sessionVisibility.get, { sessionId: id }),
      ).resolves.toMatchObject({ visibility: "shared", visibilityReason: "inherited" });
    }
    // An already shared subagent keeps its own reason and time.
    expect(await sessionRow(t, tree.sharedChild)).toEqual(sharedChildBefore);

    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((row) => row.kind === "session.shared"),
    );
    expect(audits).toEqual([
      expect.objectContaining({
        workspaceId: world.workspaceId,
        actor: { kind: "person", userId: member.userId },
        targetKind: "session",
        targetId: tree.root,
        detail: { reason: "owner_shared", descendants: 2 },
      }),
    ]);

    // Sharing again is a no-op: same state, no second audit row.
    const again = await member.client.mutation(api.sessionVisibility.share, {
      sessionId: tree.root,
    });
    expect(again).toEqual(state);
    const auditCount = await t.run(
      async (ctx) =>
        (await ctx.db.query("auditLog").collect()).filter((row) => row.kind === "session.shared")
          .length,
    );
    expect(auditCount).toBe(1);
  });

  test("turning shareAll off after a share keeps the shared Session shared", async () => {
    const t = setup();
    const world = await team(t);
    const { owner, member, teammate } = world.people;
    await owner.client.mutation(api.workspaces.setPolicy, {
      workspaceId: world.workspaceId,
      shareAll: true,
    });
    await member.client.mutation(api.sessionVisibility.share, {
      sessionId: world.sessions.memberPrivate,
    });
    await owner.client.mutation(api.workspaces.setPolicy, {
      workspaceId: world.workspaceId,
      shareAll: false,
    });
    await expect(
      teammate.client.query(api.sessionVisibility.get, { sessionId: world.sessions.memberPrivate }),
    ).resolves.toMatchObject({ visibility: "shared", visibilityReason: "owner_shared" });
  });

  test("only the owner shares; anyone else learns nothing more than they could already see", async () => {
    const t = setup();
    const world = await team(t);
    const { owner, admin } = world.people;
    const share = (client: Client | T) =>
      client.mutation(api.sessionVisibility.share, { sessionId: world.sessions.memberPrivate });

    await expect(share(admin.client)).rejects.toThrow(code("not_found"));
    await expect(share(owner.client)).rejects.toThrow(code("not_found"));
    await expect(share(world.people.left.client)).rejects.toThrow(code("not_found"));
    await expect(share(world.people.outsider.client)).rejects.toThrow(code("not_found"));
    await expect(share(world.anonymous)).rejects.toThrow(code("unauthenticated"));

    // shareAll lets the admin see it, not share it.
    await owner.client.mutation(api.workspaces.setPolicy, {
      workspaceId: world.workspaceId,
      shareAll: true,
    });
    await expect(share(admin.client)).rejects.toThrow(code("forbidden"));
    // A departed owner cannot share their old private Session either.
    await expect(
      world.people.left.client.mutation(api.sessionVisibility.share, {
        sessionId: world.sessions.departedPrivate,
      }),
    ).rejects.toThrow(code("not_found"));
    expect((await sessionRow(t, world.sessions.memberPrivate))?.visibility).toBe("private");
  });

  test("a subagent is shared with its parent, never on its own", async () => {
    const t = setup();
    const world = await team(t);
    const { member } = world.people;
    const child = await t.run((ctx) =>
      seedSession(ctx, {
        projectId: world.projectId,
        ownerUserId: member.userId,
        visibility: "private",
        parentSessionId: world.sessions.memberPrivate,
      }),
    );
    await expect(
      member.client.query(api.sessionVisibility.get, { sessionId: child }),
    ).resolves.toMatchObject({ canShare: false });
    await expect(
      member.client.mutation(api.sessionVisibility.share, { sessionId: child }),
    ).rejects.toThrow(code("share_parent"));
    expect((await sessionRow(t, child))?.visibility).toBe("private");
  });

  test("a corrupt parent cycle among subagents does not loop", async () => {
    const t = setup();
    const world = await team(t);
    const { member } = world.people;
    const cycle = await t.run(async (ctx) => {
      const base = { projectId: world.projectId, ownerUserId: member.userId };
      const a = await seedSession(ctx, {
        ...base,
        visibility: "private",
        parentSessionId: world.sessions.memberPrivate,
      });
      const b = await seedSession(ctx, { ...base, visibility: "private", parentSessionId: a });
      // Point the root at its own grandchild: a cycle no write should make.
      const root = (await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", world.sessions.memberPrivate))
        .unique())!;
      await ctx.db.patch(root._id, { parentSessionId: b });
      return { a, b };
    });
    await member.client.mutation(api.sessionVisibility.share, {
      sessionId: world.sessions.memberPrivate,
    });
    for (const id of [cycle.a, cycle.b]) {
      expect((await sessionRow(t, id))?.visibility).toBe("shared");
    }
  });

  test("a subagent tree past the bound is refused whole", async () => {
    const t = setup();
    const world = await team(t);
    const { member } = world.people;
    await t.run(async (ctx) => {
      for (let i = 0; i <= MAX_SHARED_DESCENDANTS; i += 1) {
        await seedSession(ctx, {
          projectId: world.projectId,
          ownerUserId: member.userId,
          visibility: "private",
          parentSessionId: world.sessions.memberPrivate,
        });
      }
    });
    await expect(
      member.client.mutation(api.sessionVisibility.share, {
        sessionId: world.sessions.memberPrivate,
      }),
    ).rejects.toThrow(code("too_many_descendants"));
    expect((await sessionRow(t, world.sessions.memberPrivate))?.visibility).toBe("private");
  });
});

describe("visibilityForNewSession", () => {
  test("ticket work shared, ad-hoc private, subagents inherit from a parent in the project", async () => {
    const t = setup();
    const world = await team(t);
    const base = {
      projectId: world.projectId,
      ownerUserId: world.people.member.userId,
      createdAt: 77,
    };
    const derived = await t.run(async (ctx) => ({
      ticket: await visibilityForNewSession(ctx, {
        ...base,
        role: "ticket",
        parentSessionId: null,
      }),
      project: await visibilityForNewSession(ctx, {
        ...base,
        role: "project",
        parentSessionId: null,
      }),
      ofShared: await visibilityForNewSession(ctx, {
        ...base,
        role: "subagent",
        parentSessionId: world.sessions.memberShared,
      }),
      ofPrivate: await visibilityForNewSession(ctx, {
        ...base,
        role: "subagent",
        parentSessionId: world.sessions.memberPrivate,
      }),
    }));
    expect(derived).toEqual({
      ticket: { visibility: "shared", visibilityReason: "ticket", sharedAt: 77 },
      project: { visibility: "private", visibilityReason: "adhoc", sharedAt: null },
      ofShared: { visibility: "shared", visibilityReason: "inherited", sharedAt: 77 },
      ofPrivate: { visibility: "private", visibilityReason: "inherited", sharedAt: null },
    });
  });

  test("a subagent needs a live parent Session in the same project with the same owner", async () => {
    const t = setup();
    const world = await team(t);
    const owner = world.people.member.userId;
    const { elsewhere, deletedParent } = await t.run(async (ctx) => ({
      elsewhere: await seedProject(ctx, world.workspaceId),
      deletedParent: await seedSession(ctx, {
        projectId: world.projectId,
        ownerUserId: owner,
        visibility: "shared",
        deletedAt: 3,
      }),
    }));
    for (const input of [
      { projectId: world.projectId, ownerUserId: owner, parentSessionId: null },
      { projectId: world.projectId, ownerUserId: owner, parentSessionId: newId("session") },
      { projectId: elsewhere, ownerUserId: owner, parentSessionId: world.sessions.memberShared },
      { projectId: world.projectId, ownerUserId: owner, parentSessionId: deletedParent },
      {
        projectId: world.projectId,
        ownerUserId: world.people.teammate.userId,
        parentSessionId: world.sessions.memberShared,
      },
    ]) {
      await expect(
        t.run((ctx) => visibilityForNewSession(ctx, { ...input, role: "subagent", createdAt: 1 })),
      ).rejects.toThrow(code("parent_not_found"));
    }
  });
});

describe("requireSessionScope + visibleBoardEvents", () => {
  test("board events that name a Session follow that Session's visibility", async () => {
    const t = setup();
    const world = await team(t);
    const deleted = await t.run((ctx) =>
      seedSession(ctx, {
        projectId: world.projectId,
        ownerUserId: world.people.member.userId,
        visibility: "shared",
        deletedAt: 5,
      }),
    );
    const otherProjectSession = await t.run(async (ctx) =>
      seedSession(ctx, {
        projectId: await seedProject(ctx, world.workspaceId),
        ownerUserId: world.people.member.userId,
        visibility: "shared",
      }),
    );
    const events = [
      {
        projectId: world.projectId,
        id: "plain",
        payload: { kind: "retitled", from: "a", to: "b" },
      },
      {
        projectId: world.projectId,
        id: "private",
        payload: { kind: "session_started", sessionId: world.sessions.memberPrivate },
      },
      {
        projectId: world.projectId,
        id: "private-again",
        payload: { kind: "session_stopped", sessionId: world.sessions.memberPrivate, reason: null },
      },
      {
        projectId: world.projectId,
        id: "shared",
        payload: { kind: "session_started", sessionId: world.sessions.memberShared },
      },
      {
        projectId: world.projectId,
        id: "deleted",
        payload: { kind: "session_started", sessionId: deleted },
      },
      {
        projectId: world.projectId,
        id: "missing",
        payload: { kind: "session_started", sessionId: newId("session") },
      },
      {
        projectId: world.projectId,
        id: "elsewhere",
        payload: { kind: "session_started", sessionId: otherProjectSession },
      },
    ];
    const visibleTo = async (client: Client) =>
      (
        await client.query(async (ctx) =>
          visibleBoardEvents(ctx, await requireSessionScope(ctx, world.projectId), events),
        )
      ).map((event) => event.id);

    expect(await visibleTo(world.people.member.client)).toEqual([
      "plain",
      "private",
      "private-again",
      "shared",
    ]);
    expect(await visibleTo(world.people.admin.client)).toEqual(["plain", "shared"]);
    await expect(visibleTo(world.people.left.client)).rejects.toThrow(code("not_a_member"));

    await world.people.owner.client.mutation(api.workspaces.setPolicy, {
      workspaceId: world.workspaceId,
      shareAll: true,
    });
    expect(await visibleTo(world.people.teammate.client)).toEqual([
      "plain",
      "private",
      "private-again",
      "shared",
    ]);
  });
});

describe("board.ticketEvents", () => {
  test("a ticket's history leaves out events about Sessions the viewer cannot see", async () => {
    const t = setup();
    const world = await team(t);
    const { owner, member, teammate } = world.people;
    const projectId = newId("project");
    await owner.client.mutation(api.projects.create, {
      commandId: newId("command"),
      workspaceId: world.workspaceId,
      projectId,
      name: "Board",
      origin: "github",
    });
    const ticketId = newId("ticket");
    await member.client.mutation(api.board.createTicket, {
      commandId: newId("command"),
      projectId,
      ticketId,
      status: "todo",
      title: "Visible work",
    });
    const sessions = await t.run(async (ctx) => {
      const base = { projectId, ownerUserId: member.userId };
      const privateChat = await seedSession(ctx, { ...base, visibility: "private" });
      const privateHelper = await seedSession(ctx, {
        ...base,
        visibility: "private",
        parentSessionId: privateChat,
      });
      const ticketWork = await seedSession(ctx, { ...base, visibility: "shared" });
      for (const [seq, sessionId] of [
        [100, privateHelper],
        [101, ticketWork],
      ] as const) {
        await ctx.db.insert("boardEvents", {
          id: newId("boardEvent"),
          projectId,
          ticketId,
          seq,
          kind: "session_started",
          actor: { kind: "person", userId: member.userId },
          occurredAt: seq,
          payload: { kind: "session_started", sessionId },
        });
      }
      return { privateHelper, ticketWork };
    });
    const sessionsIn = async (client: Client) =>
      (await client.query(api.board.ticketEvents, { ticketId }))
        .filter((event) => event.kind === "session_started")
        .map((event) => (event.payload as { sessionId: string }).sessionId);

    expect(await sessionsIn(member.client)).toEqual([sessions.privateHelper, sessions.ticketWork]);
    expect(await sessionsIn(teammate.client)).toEqual([sessions.ticketWork]);
    // Everything else on the ticket is everyone's.
    const kinds = (await teammate.client.query(api.board.ticketEvents, { ticketId })).map(
      (event) => event.kind,
    );
    expect(kinds).toContain("created");
  });
});
