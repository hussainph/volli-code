import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { newId, type UserId } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import type { DataModel } from "../functions/_generated/dataModel.js";
import {
  LAST_SEEN_RESOLUTION_MS,
  ensureViewer,
  findMembership,
  findPolicy,
  profileFromIdentity,
  requireManage,
  requireMember,
  requireProject,
  requireSessionActor,
  requireSessionVisible,
  requireViewer,
} from "../functions/lib/auth";
import schema from "../functions/schema";
import type { GenericMutationCtx } from "convex/server";

const modules = import.meta.glob("../functions/**/*.ts");

type Ctx = GenericMutationCtx<DataModel>;

const ALICE = {
  subject: "user:alice",
  issuer: "https://issuer.test",
  email: " Alice@Example.COM ",
  emailVerified: true,
  name: "Alice",
};
const BOB = { subject: "user:bob", issuer: "https://issuer.test" };
const CAROL = { subject: "user:carol", issuer: "https://issuer.test" };
const OUTSIDER = { subject: "user:outsider", issuer: "https://issuer.test" };

function setup() {
  return convexTest(schema, modules);
}

/** Signs `identity` in once and returns their user id. */
async function signIn(t: ReturnType<typeof setup>, identity: typeof BOB): Promise<UserId> {
  const result = await t.withIdentity(identity).mutation(api.accounts.ensureViewer, {});
  return result.userId as UserId;
}

async function seedWorkspace(ctx: Ctx, overrides: { deletedAt?: number | null } = {}) {
  const id = newId("workspace");
  await ctx.db.insert("workspaces", {
    id,
    name: "Acme",
    slug: `acme-${id.slice(0, 8)}`,
    iconKey: null,
    createdByUserId: newId("user"),
    planKey: "free",
    activeMemberCount: 0,
    createdAt: 0,
    deletedAt: overrides.deletedAt ?? null,
    purgeAfter: null,
  });
  return id;
}

async function seedMember(
  ctx: Ctx,
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
  status: "active" | "suspended" | "left" = "active",
) {
  await ctx.db.insert("workspaceMembers", {
    id: newId("member"),
    workspaceId,
    userId,
    role,
    status,
    billingTier: "free",
    joinedAt: 0,
    suspendedAt: null,
    leftAt: null,
    invitedByUserId: null,
  });
}

async function seedProject(ctx: Ctx, workspaceId: string, deletedAt: number | null = null) {
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
    deletedAt,
    purgeAfter: null,
  });
  return id;
}

async function seedSession(
  ctx: Ctx,
  projectId: string,
  ownerUserId: string,
  visibility: "shared" | "private",
  deletedAt: number | null = null,
) {
  const id = newId("session");
  await ctx.db.insert("sessions", {
    id,
    projectId,
    ticketId: null,
    role: visibility === "shared" ? "ticket" : "project",
    parentSessionId: null,
    ownerUserId,
    origin: { kind: "user" },
    title: null,
    visibility,
    visibilityReason: visibility === "shared" ? "ticket" : "adhoc",
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
    deletedAt,
    purgeAfter: null,
  });
  return id;
}

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("accounts.ensureViewer", () => {
  test("refuses an anonymous caller", async () => {
    const t = setup();
    await expect(t.mutation(api.accounts.ensureViewer, {})).rejects.toThrow(
      code("unauthenticated"),
    );
    await expect(t.query(api.accounts.viewer, {})).rejects.toThrow(code("unauthenticated"));
  });

  test("creates the user on first sign-in from the identity's claims, then returns the same one", async () => {
    const t = setup();
    const asAlice = t.withIdentity(ALICE);
    await expect(asAlice.query(api.accounts.viewer, {})).resolves.toBeNull();

    const first = await asAlice.mutation(api.accounts.ensureViewer, {});
    expect(first).toMatchObject({
      displayName: "Alice",
      primaryEmail: "alice@example.com",
      created: true,
    });
    expect(first.userId).toMatch(/^[0-9a-f-]{36}$/);

    const again = await asAlice.mutation(api.accounts.ensureViewer, {});
    expect(again).toEqual({ ...first, created: false });
    await expect(asAlice.query(api.accounts.viewer, {})).resolves.toEqual({
      userId: first.userId,
      displayName: "Alice",
      primaryEmail: "alice@example.com",
      previewAccess: "waitlisted",
      previewAgreementAccepted: false,
      status: "active",
      purgeAfter: null,
    });

    const rows = await t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      links: await ctx.db.query("authIdentities").collect(),
    }));
    expect(rows.users).toHaveLength(1);
    expect(rows.users[0]).toMatchObject({ emailVerified: true, status: "active" });
    expect(rows.links).toEqual([
      expect.objectContaining({
        userId: first.userId,
        issuer: ALICE.issuer,
        subject: ALICE.subject,
        tokenIdentifier: `${ALICE.issuer}|${ALICE.subject}`,
      }),
    ]);
  });

  test("gives each identity its own user", async () => {
    const t = setup();
    expect(await signIn(t, BOB)).not.toBe(await signIn(t, CAROL));
  });

  test("refreshes lastSeenAt at most once per resolution window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = setup();
    await signIn(t, BOB);
    const lastSeen = () => t.run(async (ctx) => (await ctx.db.query("users").first())!.lastSeenAt);
    vi.setSystemTime(1_000_000 + LAST_SEEN_RESOLUTION_MS - 1);
    await signIn(t, BOB);
    expect(await lastSeen()).toBe(1_000_000);
    vi.setSystemTime(1_000_000 + LAST_SEEN_RESOLUTION_MS);
    await signIn(t, BOB);
    expect(await lastSeen()).toBe(1_000_000 + LAST_SEEN_RESOLUTION_MS);
  });

  test("refuses a deleted account", async () => {
    const t = setup();
    await signIn(t, BOB);
    await t.run(async (ctx) => {
      const user = (await ctx.db.query("users").first())!;
      await ctx.db.patch(user._id, {
        status: "deleted",
        primaryEmail: null,
        displayName: "Deleted user",
      });
    });
    await expect(t.withIdentity(BOB).mutation(api.accounts.ensureViewer, {})).rejects.toThrow(
      code("account_deleted"),
    );
    await expect(t.withIdentity(BOB).query(api.accounts.viewer, {})).rejects.toThrow(
      code("account_deleted"),
    );
  });

  test("refuses, rather than duplicates, an identity linked to a missing user", async () => {
    const t = setup();
    await signIn(t, BOB);
    await t.run(async (ctx) => {
      await ctx.db.delete((await ctx.db.query("users").first())!._id);
    });
    await expect(t.withIdentity(BOB).mutation(api.accounts.ensureViewer, {})).rejects.toThrow(
      code("identity_conflict"),
    );
    expect(await t.run((ctx) => ctx.db.query("authIdentities").collect())).toHaveLength(1);
  });

  test("accepts a profile hook in place of the default claim mapping", async () => {
    const t = setup();
    const viewer = await t.withIdentity(BOB).mutation((ctx) =>
      ensureViewer(ctx, () => ({
        primaryEmail: "b@x.test",
        emailVerified: false,
        displayName: "B",
      })),
    );
    expect(viewer.user).toMatchObject({ primaryEmail: "b@x.test", displayName: "B" });
  });
});

describe("profileFromIdentity", () => {
  const base = { tokenIdentifier: "t", subject: "s", issuer: "i" };

  test("prefers the name, then the nickname, then the email's local part", () => {
    expect(profileFromIdentity({ ...base, name: " Ann ", email: "a@x.test" })).toEqual({
      primaryEmail: "a@x.test",
      emailVerified: false,
      displayName: "Ann",
    });
    expect(profileFromIdentity({ ...base, name: " ", nickname: "annie" }).displayName).toBe(
      "annie",
    );
    expect(profileFromIdentity({ ...base, email: "Ann.B@X.test" }).displayName).toBe("ann.b");
    expect(profileFromIdentity({ ...base, email: "@x.test" }).displayName).toBe("Volli user");
  });

  test("works without an email, and never claims an absent email verified", () => {
    expect(profileFromIdentity({ ...base, email: " ", emailVerified: true })).toEqual({
      primaryEmail: null,
      emailVerified: false,
      displayName: "Volli user",
    });
  });

  test("reads email_verified as a customJwt provider passes it through", () => {
    expect(
      profileFromIdentity({ ...base, email: "a@x.test", email_verified: true }).emailVerified,
    ).toBe(true);
    expect(
      profileFromIdentity({ ...base, email: "a@x.test", email_verified: "true" }).emailVerified,
    ).toBe(false);
  });
});

describe("membership checks", () => {
  test("requireViewer refuses an identity that never ran ensureViewer", async () => {
    const t = setup();
    await expect(t.withIdentity(BOB).query((ctx) => requireViewer(ctx))).rejects.toThrow(
      code("no_viewer"),
    );
  });

  test("requireMember admits active Members only", async () => {
    const t = setup();
    const bob = await signIn(t, BOB);
    const carol = await signIn(t, CAROL);
    const { live, gone } = await t.run(async (ctx) => {
      const liveId = await seedWorkspace(ctx);
      await seedMember(ctx, liveId, bob);
      await seedMember(ctx, liveId, carol, "admin", "suspended");
      const goneId = await seedWorkspace(ctx, { deletedAt: 5 });
      await seedMember(ctx, goneId, bob);
      return { live: liveId, gone: goneId };
    });

    const access = await t.withIdentity(BOB).query((ctx) => requireMember(ctx, live));
    expect(access.membership).toEqual({
      workspaceId: live,
      userId: bob,
      role: "member",
      status: "active",
    });
    await expect(t.withIdentity(CAROL).query((ctx) => requireMember(ctx, live))).rejects.toThrow(
      code("not_a_member"),
    );
    await expect(t.withIdentity(BOB).query((ctx) => requireMember(ctx, gone))).rejects.toThrow(
      code("not_found"),
    );
    await expect(
      t.withIdentity(BOB).query((ctx) => requireMember(ctx, newId("workspace"))),
    ).rejects.toThrow(code("not_found"));
  });

  test("requireManage follows roles and the invite policy", async () => {
    const t = setup();
    const bob = await signIn(t, BOB);
    const carol = await signIn(t, CAROL);
    const ws = await t.run(async (ctx) => {
      const workspaceId = await seedWorkspace(ctx);
      await seedMember(ctx, workspaceId, bob);
      await seedMember(ctx, workspaceId, carol, "admin");
      return workspaceId;
    });
    const asBob = t.withIdentity(BOB);
    await expect(asBob.query((ctx) => requireManage(ctx, ws, "invite"))).resolves.toBeTruthy();
    await expect(asBob.query((ctx) => requireManage(ctx, ws, "billing"))).rejects.toThrow(
      code("forbidden"),
    );
    await expect(
      t.withIdentity(CAROL).query((ctx) => requireManage(ctx, ws, "policy")),
    ).resolves.toBeTruthy();

    await t.run(async (ctx) => {
      await ctx.db.insert("workspacePolicies", {
        workspaceId: ws,
        shareAll: false,
        whoCanInvite: "admins",
        revision: 1,
        updatedByUserId: carol,
        updatedAt: 0,
      });
    });
    await expect(asBob.query((ctx) => requireManage(ctx, ws, "invite"))).rejects.toThrow(
      code("forbidden"),
    );
    await expect(t.query((ctx) => findPolicy(ctx, ws))).resolves.toEqual({
      shareAll: false,
      whoCanInvite: "admins",
    });
  });

  test("requireProject resolves membership through the project's CURRENT Workspace", async () => {
    const t = setup();
    const bob = await signIn(t, BOB);
    const { project, deleted, other } = await t.run(async (ctx) => {
      const home = await seedWorkspace(ctx);
      await seedMember(ctx, home, bob);
      return {
        project: await seedProject(ctx, home),
        deleted: await seedProject(ctx, home, 9),
        other: await seedWorkspace(ctx),
      };
    });
    const asBob = t.withIdentity(BOB);
    await expect(asBob.query((ctx) => requireProject(ctx, project))).resolves.toMatchObject({
      project: { id: project },
    });
    await expect(asBob.query((ctx) => requireProject(ctx, deleted))).rejects.toThrow(
      code("not_found"),
    );
    await expect(asBob.query((ctx) => requireProject(ctx, newId("project")))).rejects.toThrow(
      code("not_found"),
    );

    // A deleted Workspace hides its projects at once.
    const hidden = await t.run(async (ctx) => {
      const gone = await seedWorkspace(ctx, { deletedAt: 1 });
      await seedMember(ctx, gone, bob);
      return seedProject(ctx, gone);
    });
    await expect(asBob.query((ctx) => requireProject(ctx, hidden))).rejects.toThrow(
      code("not_found"),
    );

    // Move the project to a Workspace Bob is not in: he loses access at once.
    await t.run(async (ctx) => {
      const row = (await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", project))
        .unique())!;
      await ctx.db.patch(row._id, { workspaceId: other });
    });
    await expect(asBob.query((ctx) => requireProject(ctx, project))).rejects.toThrow(
      code("not_a_member"),
    );
    await expect(t.query((ctx) => findMembership(ctx, other, bob))).resolves.toBeNull();
  });

  test("Session visibility: owner, shared, shareAll; acting is owner-only", async () => {
    const t = setup();
    const bob = await signIn(t, BOB);
    const carol = await signIn(t, CAROL);
    const ids = await t.run(async (ctx) => {
      const ws = await seedWorkspace(ctx);
      await seedMember(ctx, ws, bob);
      await seedMember(ctx, ws, carol);
      const project = await seedProject(ctx, ws);
      return {
        ws,
        privateSession: await seedSession(ctx, project, bob, "private"),
        sharedSession: await seedSession(ctx, project, bob, "shared"),
        deletedSession: await seedSession(ctx, project, bob, "shared", 3),
      };
    });
    const asBob = t.withIdentity(BOB);
    const asCarol = t.withIdentity(CAROL);

    await expect(
      asBob.query((ctx) => requireSessionActor(ctx, ids.privateSession)),
    ).resolves.toMatchObject({ session: { id: ids.privateSession } });
    await expect(
      asCarol.query((ctx) => requireSessionVisible(ctx, ids.privateSession)),
    ).rejects.toThrow(code("not_found"));
    await expect(
      asCarol.query((ctx) => requireSessionVisible(ctx, ids.sharedSession)),
    ).resolves.toBeTruthy();
    await expect(
      asCarol.query((ctx) => requireSessionActor(ctx, ids.sharedSession)),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      asBob.query((ctx) => requireSessionVisible(ctx, ids.deletedSession)),
    ).rejects.toThrow(code("not_found"));
    await expect(
      asBob.query((ctx) => requireSessionVisible(ctx, newId("session"))),
    ).rejects.toThrow(code("not_found"));

    // Nobody can tell a real Session from a missing one without access to it.
    await expect(t.query((ctx) => requireSessionVisible(ctx, ids.sharedSession))).rejects.toThrow(
      code("unauthenticated"),
    );
    await signIn(t, OUTSIDER);
    await expect(
      t.withIdentity(OUTSIDER).query((ctx) => requireSessionVisible(ctx, ids.sharedSession)),
    ).rejects.toThrow(code("not_found"));

    await t.run(async (ctx) => {
      await ctx.db.insert("workspacePolicies", {
        workspaceId: ids.ws,
        shareAll: true,
        whoCanInvite: "members",
        revision: 1,
        updatedByUserId: bob,
        updatedAt: 0,
      });
    });
    await expect(
      asCarol.query((ctx) => requireSessionVisible(ctx, ids.privateSession)),
    ).resolves.toBeTruthy();
  });
});
