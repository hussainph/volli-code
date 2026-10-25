import { convexTest } from "convex-test";
import type { GenericMutationCtx } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { newId } from "@volli/shared/cloud";

import { ACCOUNT_DELETION_GRACE_MS } from "../functions/accounts";
import { api } from "../functions/_generated/api";
import type { DataModel } from "../functions/_generated/dataModel.js";
import { requireViewer } from "../functions/lib/auth";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

type Ctx = GenericMutationCtx<DataModel>;

const ISSUER = "https://issuer.test";
const identity = (subject: string) => ({ subject, issuer: ISSUER, name: subject });

function setup() {
  return convexTest(schema, modules);
}

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

async function signIn(t: ReturnType<typeof setup>, subject: string): Promise<string> {
  return (await t.withIdentity(identity(subject)).mutation(api.accounts.ensureViewer, {})).userId;
}

async function seedWorkspace(ctx: Ctx): Promise<string> {
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
    deletedAt: null,
    purgeAfter: null,
  });
  return id;
}

async function seedMember(
  ctx: Ctx,
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member",
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

afterEach(() => {
  vi.useRealTimers();
});

describe("accounts.ensureViewer", () => {
  test("answers the account's status with the new user", async () => {
    const t = setup();
    const first = await t.withIdentity(identity("dana")).mutation(api.accounts.ensureViewer, {});
    expect(first).toMatchObject({
      displayName: "dana",
      status: "active",
      purgeAfter: null,
      created: true,
    });
    await expect(t.withIdentity(identity("dana")).query(api.accounts.viewer, {})).resolves.toEqual({
      userId: first.userId,
      displayName: "dana",
      primaryEmail: null,
      status: "active",
      purgeAfter: null,
    });
  });
});

describe("accounts.requestDeletion", () => {
  test("schedules the deletion 30 days out, records it, and revokes signed-in devices", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = setup();
    const userId = await signIn(t, "erin");
    await t.run(async (ctx) => {
      await ctx.db.insert("clientSessions", {
        userId,
        providerSessionId: "session_1",
        clientKind: "desktop",
        label: "Erin's Mac",
        lastSeenAt: 0,
        revokedAt: null,
      });
    });

    vi.setSystemTime(2_000_000);
    const pending = await t
      .withIdentity(identity("erin"))
      .mutation(api.accounts.requestDeletion, {});
    expect(pending).toMatchObject({ userId, status: "deletion_pending" });
    // The clock the mutation read (convex-test may tick it).
    const at = pending.purgeAfter! - ACCOUNT_DELETION_GRACE_MS;
    expect(at).toBeGreaterThanOrEqual(2_000_000);

    const rows = await t.run(async (ctx) => ({
      requests: await ctx.db.query("deletionRequests").collect(),
      devices: await ctx.db.query("clientSessions").collect(),
      audit: await ctx.db.query("auditLog").collect(),
    }));
    expect(rows.requests).toEqual([
      expect.objectContaining({
        targetKind: "user",
        targetId: userId,
        requestedBy: { kind: "person", userId, via: "desktop" },
        requestedAt: at,
        purgeAfter: at + ACCOUNT_DELETION_GRACE_MS,
        status: "pending",
      }),
    ]);
    expect(rows.devices.map((device) => device.revokedAt)).toEqual([at]);
    expect(rows.audit).toEqual([
      expect.objectContaining({ kind: "account.deletion_requested", targetId: userId }),
    ]);

    // Idempotent: a repeat answers the pending request and writes nothing new.
    await expect(
      t.withIdentity(identity("erin")).mutation(api.accounts.requestDeletion, {}),
    ).resolves.toEqual(pending);
    expect(await t.run((ctx) => ctx.db.query("deletionRequests").collect())).toHaveLength(1);
  });

  test("a pending account is signed out of everything but showing and restoring it", async () => {
    const t = setup();
    await signIn(t, "fay");
    await t.withIdentity(identity("fay")).mutation(api.accounts.requestDeletion, {});

    await expect(
      t.withIdentity(identity("fay")).query((ctx) => requireViewer(ctx)),
    ).rejects.toThrow(code("account_deletion_pending"));
    await expect(
      t.withIdentity(identity("fay")).mutation(api.accounts.ensureViewer, {}),
    ).resolves.toMatchObject({ status: "deletion_pending", created: false });
    await expect(
      t.withIdentity(identity("fay")).query(api.accounts.viewer, {}),
    ).resolves.toMatchObject({ status: "deletion_pending" });
  });

  test("refuses while the person is the only owner of a workspace others still use", async () => {
    const t = setup();
    const owner = await signIn(t, "gus");
    const teammate = await signIn(t, "hal");
    const workspaceId = await t.run(async (ctx) => {
      const id = await seedWorkspace(ctx);
      await seedMember(ctx, id, owner, "owner");
      await seedMember(ctx, id, teammate, "member");
      return id;
    });
    await expect(
      t.withIdentity(identity("gus")).mutation(api.accounts.requestDeletion, {}),
    ).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "sole_owner", workspaceIds: [workspaceId] }),
      }),
    );

    // A second owner lifts the block.
    await t.run(async (ctx) => {
      const member = (await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", workspaceId).eq("userId", teammate),
        )
        .unique())!;
      await ctx.db.patch(member._id, { role: "owner" });
    });
    await expect(
      t.withIdentity(identity("gus")).mutation(api.accounts.requestDeletion, {}),
    ).resolves.toMatchObject({ status: "deletion_pending" });
  });

  test("a co-owner whose own deletion is pending does not count as the owner left behind", async () => {
    const t = setup();
    const first = await signIn(t, "mo");
    const second = await signIn(t, "nia");
    const teammate = await signIn(t, "oz");
    const workspaceId = await t.run(async (ctx) => {
      const id = await seedWorkspace(ctx);
      await seedMember(ctx, id, first, "owner");
      await seedMember(ctx, id, second, "owner");
      await seedMember(ctx, id, teammate, "member");
      return id;
    });
    await expect(
      t.withIdentity(identity("mo")).mutation(api.accounts.requestDeletion, {}),
    ).resolves.toMatchObject({ status: "deletion_pending" });
    await expect(
      t.withIdentity(identity("nia")).mutation(api.accounts.requestDeletion, {}),
    ).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "sole_owner", workspaceIds: [workspaceId] }),
      }),
    );
  });

  test("records the client the person asked through", async () => {
    const t = setup();
    const userId = await signIn(t, "pip");
    await t.withIdentity(identity("pip")).mutation(api.accounts.requestDeletion, { via: "web" });
    const rows = await t.run(async (ctx) => ({
      request: (await ctx.db.query("deletionRequests").first())!,
      audit: await ctx.db.query("auditLog").collect(),
    }));
    expect(rows.request.requestedBy).toEqual({ kind: "person", userId, via: "web" });
    expect(rows.audit.map((entry) => entry.actor)).toEqual([
      { kind: "person", userId, via: "web" },
    ]);
  });

  test("can be requested again after a restore", async () => {
    const t = setup();
    await signIn(t, "quin");
    const as = t.withIdentity(identity("quin"));
    await as.mutation(api.accounts.requestDeletion, {});
    await as.mutation(api.accounts.cancelDeletion, {});
    await expect(as.mutation(api.accounts.requestDeletion, {})).resolves.toMatchObject({
      status: "deletion_pending",
    });
    const statuses = await t.run(async (ctx) =>
      (await ctx.db.query("deletionRequests").collect()).map((request) => request.status),
    );
    expect(statuses).toEqual(["cancelled", "pending"]);
  });

  test("a workspace with no other active Member does not block", async () => {
    const t = setup();
    const owner = await signIn(t, "ivy");
    const former = await signIn(t, "jon");
    await t.run(async (ctx) => {
      const solo = await seedWorkspace(ctx);
      await seedMember(ctx, solo, owner, "owner");
      const departed = await seedWorkspace(ctx);
      await seedMember(ctx, departed, owner, "owner");
      await seedMember(ctx, departed, former, "member", "left");
    });
    await expect(
      t.withIdentity(identity("ivy")).mutation(api.accounts.requestDeletion, {}),
    ).resolves.toMatchObject({ status: "deletion_pending" });
  });

  test("refuses an identity that has not signed in yet", async () => {
    const t = setup();
    await expect(
      t.withIdentity(identity("nobody")).mutation(api.accounts.requestDeletion, {}),
    ).rejects.toThrow(code("no_viewer"));
    await expect(t.mutation(api.accounts.requestDeletion, {})).rejects.toThrow(
      code("unauthenticated"),
    );
  });
});

describe("accounts.cancelDeletion", () => {
  test("restores the account inside the window and cancels the request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = setup();
    const userId = await signIn(t, "kim");
    await t.withIdentity(identity("kim")).mutation(api.accounts.requestDeletion, {});
    vi.setSystemTime(1_000_000 + ACCOUNT_DELETION_GRACE_MS - 60_000);

    await expect(
      t.withIdentity(identity("kim")).mutation(api.accounts.cancelDeletion, {}),
    ).resolves.toEqual({
      userId,
      displayName: "kim",
      primaryEmail: null,
      status: "active",
      purgeAfter: null,
    });
    const rows = await t.run(async (ctx) => ({
      requests: await ctx.db.query("deletionRequests").collect(),
      audit: await ctx.db.query("auditLog").collect(),
    }));
    expect(rows.requests.map((request) => request.status)).toEqual(["cancelled"]);
    expect(rows.audit.map((entry) => entry.kind)).toEqual([
      "account.deletion_requested",
      "account.deletion_cancelled",
    ]);
    await expect(
      t.withIdentity(identity("kim")).query((ctx) => requireViewer(ctx)),
    ).resolves.toMatchObject({ userId });
  });

  test("answers an active account as it is, and refuses one whose window has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = setup();
    const userId = await signIn(t, "lee");
    // Idempotent: a repeated Restore is not an error.
    await expect(
      t.withIdentity(identity("lee")).mutation(api.accounts.cancelDeletion, {}),
    ).resolves.toMatchObject({ userId, status: "active" });
    expect(await t.run((ctx) => ctx.db.query("auditLog").collect())).toEqual([]);

    await t.withIdentity(identity("lee")).mutation(api.accounts.requestDeletion, {});
    vi.setSystemTime(1_000_000 + ACCOUNT_DELETION_GRACE_MS + 60_000);
    await expect(
      t.withIdentity(identity("lee")).mutation(api.accounts.cancelDeletion, {}),
    ).rejects.toThrow(code("purge_started"));
  });
});
