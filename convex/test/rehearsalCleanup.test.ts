import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { api, internal } from "../functions/_generated/api";
import { setup, signIn, code } from "./board-helpers";

afterEach(() => vi.unstubAllEnvs());

async function rehearsal() {
  const t = setup();
  const alice = await signIn(t, "alice");
  const workspaceId = randomUUID();
  await alice.as.mutation(api.workspaces.create, {
    workspaceId,
    name: `migration-rehearsal-${workspaceId}`,
  });
  return { t, alice, args: { workspaceId, userId: alice.userId } };
}

test("cleanup requires the deployment opt-in", async () => {
  const { t, alice, args } = await rehearsal();
  await expect(t.mutation(internal.migration.cleanupRehearsal, args)).rejects.toMatchObject(
    code("rehearsal_disabled"),
  );
  // The real HTTP boundary is covered by the backend suite. convex-test lets
  // internal refs through, so do not mistake its direct call for public access.
  expect(alice.userId).toBe(args.userId);
});

test("only the exact disposable Workspace/owner may be removed, and checkOnly never deletes", async () => {
  vi.stubEnv("VOLLI_MIGRATION_REHEARSAL", "enabled");
  const { t, alice, args } = await rehearsal();
  await expect(
    t.mutation(internal.migration.cleanupRehearsal, { ...args, userId: randomUUID() }),
  ).rejects.toMatchObject(code("not_rehearsal"));
  expect(
    await t.mutation(internal.migration.cleanupRehearsal, { ...args, checkOnly: true }),
  ).toEqual({ done: false });
  expect(
    await alice.as.query(api.workspaces.get, { workspaceId: args.workspaceId }),
  ).not.toBeNull();
  expect(await t.mutation(internal.migration.cleanupRehearsal, args)).toEqual({ done: true });
  expect(await t.mutation(internal.migration.cleanupRehearsal, args)).toEqual({ done: true });
  await t.run(async (ctx) => {
    expect(
      await ctx.db
        .query("workspacePolicies")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
        .collect(),
    ).toEqual([]);
    expect(
      await ctx.db
        .query("auditLog")
        .withIndex("by_workspace_at", (q) => q.eq("workspaceId", args.workspaceId))
        .collect(),
    ).toEqual([]);
  });
  const normal = await alice.as.mutation(api.workspaces.create, {
    workspaceId: randomUUID(),
    name: "Keep me",
  });
  await expect(
    t.mutation(internal.migration.cleanupRehearsal, { ...args, workspaceId: normal.workspaceId }),
  ).rejects.toMatchObject(code("not_rehearsal"));
});

test("an unpurged reservation blocks deletion; purged ids and stream tombstones stay reserved", async () => {
  vi.stubEnv("VOLLI_MIGRATION_REHEARSAL", "enabled");
  const { t, args } = await rehearsal();
  const moveId = randomUUID();
  const doc = await t.run(async (ctx) => {
    const id = await ctx.db.insert("projectImports", {
      id: moveId,
      projectId: randomUUID(),
      workspaceId: args.workspaceId,
      userId: args.userId,
      runnerId: randomUUID(),
      manifestSha256: "a".repeat(64),
      status: "reserved",
      createdAt: 1,
      updatedAt: 1,
      committedAt: null,
      committedBoardSeq: null,
      uncommittedAt: null,
      abortedAt: null,
    });
    await ctx.db.insert("projectImportStreams", {
      moveId,
      stream: "projects",
      expectedCount: 0,
      expectedDigest: "0".repeat(32),
      count: 0,
      digest: "0".repeat(32),
    });
    return id;
  });
  await expect(t.mutation(internal.migration.cleanupRehearsal, args)).rejects.toMatchObject(
    code("purge_incomplete"),
  );
  await t.run((ctx) => ctx.db.patch(doc, { status: "purged" }));
  expect(await t.mutation(internal.migration.cleanupRehearsal, args)).toEqual({ done: true });
  await t.run(async (ctx) => {
    expect(await ctx.db.get(doc)).toMatchObject({ status: "purged" });
    expect(
      await ctx.db
        .query("projectImportStreams")
        .withIndex("by_move_stream", (q) => q.eq("moveId", moveId))
        .collect(),
    ).toHaveLength(1);
    expect(
      await ctx.db
        .query("workspaces")
        .withIndex("by_uuid", (q) => q.eq("id", args.workspaceId))
        .unique(),
    ).toMatchObject({ deletedAt: expect.any(Number) });
  });
});

test("an extended Workspace or another member prevents cleanup", async () => {
  vi.stubEnv("VOLLI_MIGRATION_REHEARSAL", "enabled");
  const { t, args } = await rehearsal();
  const hold = await t.run((ctx) =>
    ctx.db.insert("legalHolds", {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      scope: {},
      createdBy: { kind: "person", userId: args.userId },
      createdAt: 1,
      releasedAt: null,
    }),
  );
  await expect(t.mutation(internal.migration.cleanupRehearsal, args)).rejects.toMatchObject(
    code("workspace_extended"),
  );
  await t.run(async (ctx) => {
    await ctx.db.delete(hold);
    const member = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId))
      .first();
    const { _id, _creationTime, ...row } = member!;
    await ctx.db.insert("workspaceMembers", { ...row, id: randomUUID(), userId: randomUUID() });
  });
  await expect(t.mutation(internal.migration.cleanupRehearsal, args)).rejects.toMatchObject(
    code("shared_workspace"),
  );
});

test("a live project prevents deletion", async () => {
  vi.stubEnv("VOLLI_MIGRATION_REHEARSAL", "enabled");
  const { t, alice, args } = await rehearsal();
  await alice.as.mutation(api.projects.create, {
    commandId: randomUUID(),
    projectId: randomUUID(),
    workspaceId: args.workspaceId,
    name: "Keep",
    ticketPrefix: "KP",
    origin: "blank",
  });
  await expect(t.mutation(internal.migration.cleanupRehearsal, args)).rejects.toMatchObject(
    code("projects_remain"),
  );
});
