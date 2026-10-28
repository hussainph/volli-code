/** Deployment-operator rescue, never a Workspace owner/admin's public API. */
import { describe, expect, test } from "vite-plus/test";

import { MIGRATION_IMPORT_STREAMS, MigrationDigest, migrationRowDigest } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { seedTestRunner } from "../functions/lib/testWorld";
import { code, seedWorkspace } from "./board-helpers";
import {
  MANIFEST_SHA,
  MOVED,
  beginArgs,
  importAll,
  importWorld,
  importedWorld,
  type ImportWorld,
} from "./projectImport-fixtures";
import { PUBLIC, registered } from "./public-functions";

async function storedMove(w: ImportWorld) {
  return w.t.run((ctx) =>
    ctx.db
      .query("projectImports")
      .withIndex("by_uuid", (q) => q.eq("id", w.moveId))
      .unique(),
  );
}

async function audits(w: ImportWorld) {
  return w.t.run((ctx) =>
    ctx.db
      .query("auditLog")
      .withIndex("by_target", (q) => q.eq("targetKind", "project").eq("targetId", MOVED.projectId))
      .collect(),
  );
}

async function patchMember(
  w: ImportWorld,
  userId: string,
  fields: { role?: "owner" | "admin" | "member"; status?: "active" | "suspended" | "left" },
) {
  await w.t.run(async (ctx) => {
    const member = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", w.workspaceId).eq("userId", userId),
      )
      .unique();
    await ctx.db.patch(member!._id, fields);
  });
}

async function replacement(w: ImportWorld, role: "owner" | "admin" = "admin") {
  await patchMember(w, w.bob.userId, { role });
  const runnerId = await w.t.run((ctx) => seedTestRunner(ctx, w.bob.userId, "rescue-runner"));
  return { kind: "reassign" as const, userId: w.bob.userId, runnerId };
}

function rescue(
  w: ImportWorld,
  action: { kind: "abort" } | { kind: "reassign"; userId: string; runnerId: string },
) {
  return w.t.mutation(internal.projectImports.rescue, { moveId: w.moveId, action });
}

async function patchUser(w: ImportWorld, userId: string, status: "deletion_pending" | "deleted") {
  await w.t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_uuid", (q) => q.eq("id", userId))
      .unique();
    await ctx.db.patch(user!._id, { status });
  });
}

async function loseAccess(w: ImportWorld, reason: string) {
  switch (reason) {
    case "demoted":
      return patchMember(w, w.alice.userId, { role: "member" });
    case "removed":
      return w.t.run(async (ctx) => {
        const member = await ctx.db
          .query("workspaceMembers")
          .withIndex("by_workspace_user", (q) =>
            q.eq("workspaceId", w.workspaceId).eq("userId", w.alice.userId),
          )
          .unique();
        await ctx.db.delete(member!._id);
      });
    case "preview revoked":
      return w.t.mutation(internal.previewAccess.set, {
        kind: "user",
        value: w.alice.userId,
        enabled: false,
      });
    case "account deleted":
      return patchUser(w, w.alice.userId, "deleted");
    default:
      throw new Error(reason);
  }
}

const LOSS_REASONS = ["demoted", "removed", "preview revoked", "account deleted"];

describe("operator rescue", () => {
  test("is registered only as internal and absent from the anonymous/person public sweeps", () => {
    const fn = registered.find(({ path }) => path === "projectImports:rescue")?.fn;
    expect(fn).toHaveProperty("isMutation", true);
    expect(fn).toHaveProperty("isInternal", true);
    expect(PUBLIC.some(({ path }) => path === "projectImports:rescue")).toBe(false);
  });

  test.each(LOSS_REASONS)(
    "abort works after importer is %s, stays hidden and audits the operator",
    async (reason) => {
      const w = await importedWorld();
      await loseAccess(w, reason);
      await expect(
        w.alice.as.mutation(api.projectImports.abort, { moveId: w.moveId }),
      ).rejects.toThrow();
      await expect(rescue(w, { kind: "abort" })).resolves.toEqual({ status: "aborting" });
      const row = await storedMove(w);
      expect(row).toMatchObject({
        status: "aborting",
        userId: w.alice.userId,
        runnerId: w.runnerId,
        abortedAt: expect.any(Number),
      });
      const project = await w.t.run((ctx) =>
        ctx.db
          .query("projects")
          .withIndex("by_uuid", (q) => q.eq("id", MOVED.projectId))
          .unique(),
      );
      expect(project?.moveState).toBe("importing");
      await expect(
        w.bob.as.query(api.projects.get, { projectId: MOVED.projectId }),
      ).rejects.toThrow(code("not_found"));
      expect(await audits(w)).toMatchObject([
        {
          actor: { kind: "volli", reason: "migration" },
          kind: "project.import_rescue_aborted",
          workspaceId: w.workspaceId,
          targetId: MOVED.projectId,
          detail: {
            moveId: w.moveId,
            operatorAction: "abort",
            previousDriver: { userId: w.alice.userId, runnerId: w.runnerId },
          },
        },
      ]);
      await rescue(w, { kind: "abort" });
      expect((await storedMove(w))?.abortedAt).toBe(row?.abortedAt);
    },
  );

  test("abort can cancel a reservation before the project row exists", async () => {
    const w = await importWorld();
    await w.alice.as.mutation(api.projectImports.begin, beginArgs(w));
    await expect(rescue(w, { kind: "abort" })).resolves.toEqual({ status: "aborting" });
  });

  test.each(LOSS_REASONS)(
    "reassignment after importer is %s fences them and preserves a partial import exactly",
    async (reason) => {
      const w = await importWorld();
      await w.alice.as.mutation(api.projectImports.begin, beginArgs(w));
      // Import almost everything first: rows with original identity mapping and
      // private Session history must still read back and replay after rescue.
      for (const stream of MIGRATION_IMPORT_STREAMS) {
        if (stream !== "readMarkers") {
          const result = await w.alice.as.mutation(api.projectImports.importRows, {
            moveId: w.moveId,
            stream,
            rows: w.records[stream],
          });
          expect(result.rejected, stream).toEqual([]);
        }
      }
      const before = await w.alice.as.query(api.projectImports.status, { moveId: w.moveId });
      const action = await replacement(w);
      await loseAccess(w, reason);
      await expect(rescue(w, action)).resolves.toEqual({ status: "importing" });
      const after = await w.bob.as.query(api.projectImports.status, { moveId: w.moveId });
      expect(after.streams).toEqual(before.streams);
      expect(after.importTarget).toEqual(w.target);
      expect(after.driver).toEqual({ userId: action.userId, runnerId: action.runnerId });
      // A resumed engine may replay begin with its own driver runner; this
      // must not replace the original mapping or manifest promise.
      await expect(
        w.bob.as.mutation(
          api.projectImports.begin,
          beginArgs(w, {
            runnerId: action.runnerId,
          }),
        ),
      ).resolves.toEqual({ moveId: w.moveId, status: "importing" });
      await expect(
        w.alice.as.query(api.projectImports.status, { moveId: w.moveId }),
      ).rejects.toThrow();
      // Restore old access: reassignment, not just the lapse, fences the old driver.
      if (reason === "demoted") {
        await patchMember(w, w.alice.userId, { role: "owner" });
        await expect(
          w.alice.as.query(api.projectImports.status, { moveId: w.moveId }),
        ).rejects.toThrow(code("not_found"));
        await expect(w.alice.as.mutation(api.projectImports.begin, beginArgs(w))).rejects.toThrow(
          code("move_conflict"),
        );
      }
      for (const result of Object.values(await importAll(w.bob.as, w.moveId, w.records))) {
        expect(result.conflicts).toEqual([]);
        expect(result.rejected).toEqual([]);
      }
      for (const [stream, parentId] of [
        ["workingCopies", null],
        ["readMarkers", MOVED.sessionId],
        ["sessionEvents", MOVED.sessionId],
      ] as const) {
        const page = await w.bob.as.query(api.projectImports.readRows, {
          moveId: w.moveId,
          stream,
          parentId,
          cursor: null,
          numItems: 100,
        });
        const digest = new MigrationDigest();
        for (const row of page.rows) digest.add(migrationRowDigest(stream, row));
        const expected = w.expected.find((entry) => entry.stream === stream)!;
        expect({ count: digest.count, digest: digest.value }, stream).toEqual({
          count: expected.count,
          digest: expected.digest,
        });
      }
      const audit = (await audits(w))[0]!;
      expect(audit).toMatchObject({
        kind: "project.import_reassigned",
        actor: { kind: "volli", reason: "migration" },
        detail: {
          moveId: w.moveId,
          operatorAction: "reassign",
          driver: { userId: action.userId, runnerId: action.runnerId },
        },
      });
      await expect(
        w.bob.as.mutation(api.projectImports.commit, {
          moveId: w.moveId,
          manifestSha256: MANIFEST_SHA,
        }),
      ).resolves.toEqual({ status: "committed" });
    },
  );

  test("an owner can take a reserved move and is rechecked for preview, membership and own runner on use", async () => {
    const w = await importWorld();
    await w.alice.as.mutation(api.projectImports.begin, beginArgs(w));
    const action = await replacement(w, "owner");
    await rescue(w, action);
    await patchMember(w, w.bob.userId, { role: "member" });
    await expect(w.bob.as.query(api.projectImports.status, { moveId: w.moveId })).rejects.toThrow(
      code("forbidden"),
    );
    await patchMember(w, w.bob.userId, { role: "owner" });
    await w.t.mutation(internal.previewAccess.set, {
      kind: "user",
      value: w.bob.userId,
      enabled: false,
    });
    await expect(w.bob.as.query(api.projectImports.status, { moveId: w.moveId })).rejects.toThrow(
      code("preview_waitlisted"),
    );
    await w.t.mutation(internal.previewAccess.set, {
      kind: "user",
      value: w.bob.userId,
      enabled: true,
    });
    await w.t.run(async (ctx) => {
      const runner = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", action.runnerId))
        .unique();
      await ctx.db.patch(runner!._id, { revokedAt: Date.now(), status: "revoked" });
    });
    await expect(
      w.bob.as.mutation(api.projectImports.importRows, {
        moveId: w.moveId,
        stream: "projects",
        rows: w.records.projects,
      }),
    ).rejects.toThrow(code("runner_unavailable"));
  });

  test.each(["abort", "reassign"] as const)(
    "%s refuses committed moves without a write",
    async (kind) => {
      const w = await importedWorld();
      const action = kind === "abort" ? { kind } : await replacement(w);
      await w.alice.as.mutation(api.projectImports.commit, {
        moveId: w.moveId,
        manifestSha256: MANIFEST_SHA,
      });
      const before = await storedMove(w);
      const auditBefore = await audits(w);
      await expect(rescue(w, action)).rejects.toThrow(code("import_committed"));
      expect(await storedMove(w)).toEqual(before);
      expect(await audits(w)).toEqual(auditBefore);
    },
  );

  test.each(["missing", "deleted"])("refuses a %s Workspace for either action", async (state) => {
    const w = await importedWorld();
    const action = await replacement(w);
    await w.t.run(async (ctx) => {
      const workspace = await ctx.db
        .query("workspaces")
        .withIndex("by_uuid", (q) => q.eq("id", w.workspaceId))
        .unique();
      if (state === "missing") await ctx.db.delete(workspace!._id);
      else await ctx.db.patch(workspace!._id, { deletedAt: Date.now() });
    });
    const before = await storedMove(w);
    for (const request of [{ kind: "abort" } as const, action]) {
      await expect(rescue(w, request)).rejects.toThrow(code("not_found"));
    }
    expect(await storedMove(w)).toEqual(before);
    expect(await audits(w)).toEqual([]);
  });

  test("unknown and malformed move ids are not found; cancelled/purged moves cannot be reassigned", async () => {
    const w = await importedWorld();
    for (const moveId of ["not-a-uuid", crypto.randomUUID()]) {
      await expect(
        w.t.mutation(internal.projectImports.rescue, { moveId, action: { kind: "abort" } }),
      ).rejects.toThrow(code("not_found"));
    }
    const action = await replacement(w);
    await rescue(w, { kind: "abort" });
    await expect(rescue(w, action)).rejects.toThrow(code("import_closed"));
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("projectImports")
        .withIndex("by_uuid", (q) => q.eq("id", w.moveId))
        .unique();
      await ctx.db.patch(row!._id, { status: "purged" });
    });
    await expect(rescue(w, action)).rejects.toThrow(code("import_closed"));
    await expect(rescue(w, { kind: "abort" })).rejects.toThrow(code("import_closed"));
  });

  test.each([
    "member",
    "suspended",
    "left",
    "not a member",
    "deleted",
    "deletion pending",
    "preview revoked",
    "agreement missing",
    "unknown user",
    "foreign runner",
    "revoked runner",
    "missing runner",
    "malformed user",
    "malformed runner",
  ])("refuses replacement: %s", async (problem) => {
    const w = await importedWorld();
    const action = await replacement(w);
    let refusal = "invalid_rescue_target";
    switch (problem) {
      case "member":
        await patchMember(w, w.bob.userId, { role: "member" });
        refusal = "forbidden";
        break;
      case "suspended":
        await patchMember(w, w.bob.userId, { status: "suspended" });
        refusal = "not_a_member";
        break;
      case "left":
        await patchMember(w, w.bob.userId, { status: "left" });
        refusal = "not_a_member";
        break;
      case "not a member": {
        const elsewhere = await seedWorkspace(w.t, [{ userId: w.bob.userId }]);
        await w.t.run(async (ctx) => {
          const member = await ctx.db
            .query("workspaceMembers")
            .withIndex("by_workspace_user", (q) =>
              q.eq("workspaceId", w.workspaceId).eq("userId", w.bob.userId),
            )
            .unique();
          await ctx.db.patch(member!._id, { workspaceId: elsewhere });
        });
        refusal = "not_a_member";
        break;
      }
      case "deleted":
        await patchUser(w, w.bob.userId, "deleted");
        break;
      case "deletion pending":
        await patchUser(w, w.bob.userId, "deletion_pending");
        break;
      case "preview revoked":
        await w.t.mutation(internal.previewAccess.set, {
          kind: "user",
          value: w.bob.userId,
          enabled: false,
        });
        break;
      case "agreement missing":
        await w.t.run(async (ctx) => {
          const user = await ctx.db
            .query("users")
            .withIndex("by_uuid", (q) => q.eq("id", w.bob.userId))
            .unique();
          await ctx.db.patch(user!._id, { previewAgreementVersion: undefined });
        });
        break;
      case "unknown user":
        action.userId = crypto.randomUUID();
        break;
      case "foreign runner":
        action.runnerId = w.runnerId;
        refusal = "runner_unavailable";
        break;
      case "revoked runner":
        await w.t.run(async (ctx) => {
          const runner = await ctx.db
            .query("runners")
            .withIndex("by_uuid", (q) => q.eq("id", action.runnerId))
            .unique();
          await ctx.db.patch(runner!._id, { revokedAt: Date.now() });
        });
        refusal = "runner_unavailable";
        break;
      case "missing runner":
        action.runnerId = crypto.randomUUID();
        refusal = "runner_unavailable";
        break;
      case "malformed user":
        action.userId = "bad";
        refusal = "invalid_argument";
        break;
      case "malformed runner":
        action.runnerId = "bad";
        refusal = "invalid_argument";
        break;
    }
    const before = await storedMove(w);
    await expect(rescue(w, action)).rejects.toThrow(code(refusal));
    expect(await storedMove(w)).toEqual(before);
    expect(await audits(w)).toEqual([]);
  });
});
