/**
 * The person-authorized project import (`projectImports.*`): who may import,
 * the per-stream accumulators, commit's refusal on any mismatch, the
 * `already_migrated` and `import_in_progress` cases, uncommit and abort, and
 * the importer's read-back. That an importing project is hidden from every
 * public function is `projectImports.hidden.test.ts`.
 */

import { describe, expect, test } from "vite-plus/test";

// The shared mapping's own fixture: one export record per stream.
import { MIGRATION_FIXTURE_RECORDS } from "../../packages/shared/src/cloud/migration-import.fixture";

import {
  MIGRATION_IMPORT_STREAMS,
  MigrationDigest,
  migrationRowDigest,
  newId,
  type MigrationImportStream,
} from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { seedTestRunner } from "../functions/lib/testWorld";
import { code, createTicket, seedWorkspace } from "./board-helpers";
import { wire, writeSession } from "./sessionFixtures";
import {
  MANIFEST_SHA,
  MOVED,
  U,
  beginArgs,
  expectedFor,
  importAll,
  importWorld,
  importedWorld,
  moveRecords,
  type ImportWorld,
  type Records,
} from "./projectImport-fixtures";

async function begin(world: ImportWorld, overrides: Record<string, unknown> = {}) {
  return world.alice.as.mutation(api.projectImports.begin, beginArgs(world, overrides));
}

function commit(world: ImportWorld, manifestSha256 = MANIFEST_SHA) {
  return world.alice.as.mutation(api.projectImports.commit, {
    moveId: world.moveId,
    manifestSha256,
  });
}

function importRows(world: ImportWorld, stream: MigrationImportStream, rows: unknown[]) {
  return world.alice.as.mutation(api.projectImports.importRows, {
    moveId: world.moveId,
    stream,
    rows,
  });
}

/** Begins the move and imports every stream before `last`. */
async function upTo(world: ImportWorld, last: MigrationImportStream) {
  await begin(world);
  for (const stream of MIGRATION_IMPORT_STREAMS) {
    if (stream === last) return;
    await importRows(world, stream, world.records[stream]);
  }
}

async function setRole(world: ImportWorld, userId: string, role: "owner" | "admin" | "member") {
  await world.t.run(async (ctx) => {
    const member = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", world.workspaceId).eq("userId", userId),
      )
      .unique();
    await ctx.db.patch(member!._id, { role });
  });
}

function getProject(world: ImportWorld, as = world.alice.as) {
  return as.query(api.projects.get, { projectId: MOVED.projectId });
}

describe("a move, start to finish", () => {
  test("rows land hidden, the accumulators reach the manifest, and commit shows the project", async () => {
    const world = await importWorld();
    expect(await begin(world)).toEqual({ moveId: world.moveId, status: "reserved" });
    const results = await importAll(world.alice.as, world.moveId, world.records);
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      expect(results[stream], stream).toMatchObject({
        inserted: world.records[stream].length,
        unchanged: 0,
        conflicts: [],
        rejected: [],
      });
    }

    const status = await world.alice.as.query(api.projectImports.status, { moveId: world.moveId });
    expect(status.status).toBe("importing");
    for (const stream of status.streams) {
      expect(stream.count, stream.stream).toBe(stream.expectedCount);
      expect(stream.digest, stream.stream).toBe(stream.expectedDigest);
    }

    // Hidden from its own importer and from every other Member until the commit.
    await expect(getProject(world)).rejects.toThrow(code("not_found"));
    await expect(getProject(world, world.bob.as)).rejects.toThrow(code("not_found"));
    const listed = await world.alice.as.query(api.projects.list, {
      workspaceId: world.workspaceId,
    });
    expect(listed.map((project) => project.id)).not.toContain(MOVED.projectId);

    expect(await commit(world)).toEqual({ status: "committed" });
    expect(await getProject(world)).toMatchObject({ id: MOVED.projectId, moveState: null });
    expect(await getProject(world, world.bob.as)).toMatchObject({ name: "zz-hidden-project" });
    const ticket = await world.bob.as.query(api.board.getTicket, { ticketId: MOVED.ticketId });
    expect(ticket).toMatchObject({ body: "zz-hidden-body" });
    // Idempotent.
    expect(await commit(world)).toEqual({ status: "committed" });
    const audit = await world.t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_target", (q) =>
          q.eq("targetKind", "project").eq("targetId", MOVED.projectId),
        )
        .collect(),
    );
    expect(audit.map((row) => row.kind)).toEqual(["project.imported"]);
  });

  test("begin is idempotent by move id; other arguments under the same id conflict", async () => {
    const world = await importWorld();
    await begin(world);
    expect(await begin(world)).toEqual({ moveId: world.moveId, status: "reserved" });
    await expect(begin(world, { manifestSha256: "d".repeat(64) })).rejects.toThrow(
      code("move_conflict"),
    );
    const changed = world.expected.map((entry) =>
      entry.stream === "tickets" ? { ...entry, count: entry.count + 1 } : entry,
    );
    await expect(begin(world, { expected: changed })).rejects.toThrow(code("move_conflict"));
  });

  test("begin checks the manifest's promise", async () => {
    const world = await importWorld();
    const without = world.expected.filter((entry) => entry.stream !== "tickets");
    await expect(begin(world, { expected: without })).rejects.toThrow(code("invalid_argument"));
    await expect(
      begin(world, { expected: [...world.expected, world.expected[0]] }),
    ).rejects.toThrow(code("invalid_argument"));
    await expect(
      begin(world, {
        expected: world.expected.map((entry) => ({ ...entry, digest: "XYZ" })),
      }),
    ).rejects.toThrow(code("invalid_argument"));
    await expect(
      begin(world, {
        expected: world.expected.map((entry) =>
          entry.stream === "projects" ? { ...entry, count: 2 } : entry,
        ),
      }),
    ).rejects.toThrow(code("invalid_argument"));
    await expect(
      begin(world, {
        expected: [...world.expected, { stream: "users", count: 0, digest: "0".repeat(32) }],
      }),
    ).rejects.toThrow(code("invalid_argument"));
    await expect(begin(world, { manifestSha256: "nope" })).rejects.toThrow(
      code("invalid_argument"),
    );
    await expect(begin(world, { projectId: "P" })).rejects.toThrow(code("invalid_argument"));
  });
});

describe("accumulators", () => {
  test("are exact under re-sent, duplicated and re-ordered batches", async () => {
    const world = await importWorld();
    // More than one row per stream where the stream allows it.
    const records = moveRecords();
    records.ticketComments.push(
      { ...records.ticketComments[0]!, id: U(30), body: "second" },
      { ...records.ticketComments[0]!, id: U(31), body: "third" },
    );
    records.boardEvents.push({ ...records.boardEvents[0]!, id: U(32), seq: 2 });
    const expected = expectedFor(records, world.target);
    await begin(world, { expected });

    // Every stream twice: first reversed and split, then whole, with a duplicate inside a batch.
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      const rows = records[stream].toReversed();
      if (rows.length === 0) continue;
      const first = await importRows(world, stream, rows.slice(0, 1));
      expect(first.rejected, stream).toEqual([]);
      const again = await importRows(world, stream, [...rows, rows[0]]);
      expect(again, stream).toMatchObject({
        inserted: rows.length - 1,
        unchanged: 2,
        conflicts: [],
        rejected: [],
      });
    }
    // And the whole export once more: nothing changes.
    const resent = await importAll(world.alice.as, world.moveId, records);
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      expect(resent[stream]!.inserted, stream).toBe(0);
    }

    const status = await world.alice.as.query(api.projectImports.status, { moveId: world.moveId });
    expect(status.streams.map(({ stream, count, digest }) => ({ stream, count, digest }))).toEqual(
      expected,
    );
    expect(await commit(world)).toEqual({ status: "committed" });
  });

  test("report each batch's accumulator, adding only inserted rows", async () => {
    const world = await importWorld();
    await begin(world);
    for (const stream of MIGRATION_IMPORT_STREAMS.slice(0, 9)) {
      await importRows(world, stream, world.records[stream]);
    }
    const ticket = world.records.ticketComments[0]!;
    const once = await importRows(world, "ticketComments", [ticket]);
    const digest = new MigrationDigest();
    const stored = await world.t.run((ctx) =>
      ctx.db
        .query("ticketComments")
        .withIndex("by_uuid", (q) => q.eq("id", MOVED.commentId))
        .unique(),
    );
    const { _id, _creationTime, ...row } = stored!;
    digest.add(migrationRowDigest("ticketComments", row));
    expect(once.accumulated).toEqual({ count: 1, digest: digest.value });
    const twice = await importRows(world, "ticketComments", [ticket]);
    expect(twice).toMatchObject({ inserted: 0, unchanged: 1, accumulated: once.accumulated });
  });
});

describe("commit refuses on any mismatch", () => {
  async function partlyImported(mutate: (records: Records) => void) {
    const world = await importWorld();
    await begin(world);
    const sent = moveRecords();
    mutate(sent);
    await importAll(world.alice.as, world.moveId, sent);
    return world;
  }

  async function expectRefused(world: ImportWorld, streams: unknown) {
    await expect(commit(world)).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "verification_failed", streams }),
      }),
    );
    // Still hidden, still importing.
    await expect(getProject(world)).rejects.toThrow(code("not_found"));
    const status = await world.alice.as.query(api.projectImports.status, { moveId: world.moveId });
    expect(status.status).toBe("importing");
  }

  test("a row that never arrived", async () => {
    const world = await partlyImported((records) => {
      records.ticketComments = [];
    });
    await expectRefused(world, [
      { stream: "ticketComments", expectedCount: 1, count: 0, digestMatches: false },
    ]);
  });

  test("a row whose content differs from the manifest's", async () => {
    const world = await partlyImported((records) => {
      records.ticketBodies[0]!.body = "edited on the way";
    });
    await expectRefused(world, [
      { stream: "ticketBodies", expectedCount: 1, count: 1, digestMatches: false },
    ]);
  });

  test("a row the manifest did not promise", async () => {
    const world = await partlyImported((records) => {
      records.labels.push({ ...records.labels[0]!, id: U(40), name: "Extra", nameKey: "extra" });
    });
    await expectRefused(world, [
      { stream: "labels", expectedCount: 1, count: 2, digestMatches: false },
    ]);
  });

  test("another manifest", async () => {
    const world = await importedWorld();
    await expect(commit(world, "e".repeat(64))).rejects.toThrow(code("manifest_mismatch"));
    await expect(getProject(world)).rejects.toThrow(code("not_found"));
  });

  test("a move that never imported its project", async () => {
    const world = await importWorld();
    const empty = world.expected.map((entry) => ({ ...entry }));
    await begin(world, { expected: empty });
    await expect(commit(world)).rejects.toThrow(code("verification_failed"));
  });
});

describe("already migrated", () => {
  test("a project id another Workspace holds", async () => {
    const world = await importWorld();
    const other = await seedWorkspace(world.t, [{ userId: world.bob.userId }]);
    await world.t.run(async (ctx) => {
      await ctx.db.insert("projects", {
        id: MOVED.projectId,
        workspaceId: other,
        name: "Elsewhere",
        description: "",
        iconKey: null,
        colorIndex: 0,
        ticketPrefix: "EL",
        origin: "migrated",
        shipBehaviour: "commit",
        customShipPrompt: null,
        coAuthorDefault: true,
        countsTowardCap: false,
        createdByUserId: world.bob.userId,
        createdAt: 0,
        updatedAt: 0,
        archivedAt: null,
        deletedAt: null,
        purgeAfter: null,
      });
    });
    await expect(begin(world)).rejects.toThrow(code("already_migrated"));
  });

  test("a project already moved here", async () => {
    const world = await importedWorld();
    await commit(world);
    await expect(begin(world, { moveId: newId("project") })).rejects.toThrow(
      code("already_migrated"),
    );
  });

  test("a row whose key another Workspace holds is a conflict, never overwritten", async () => {
    const world = await importWorld();
    const otherWorkspace = await seedWorkspace(world.t, [{ userId: world.bob.userId }]);
    const otherProject = newId("project");
    await world.t.run(async (ctx) => {
      await ctx.db.insert("projects", {
        id: otherProject,
        workspaceId: otherWorkspace,
        name: "Elsewhere",
        description: "",
        iconKey: null,
        colorIndex: 0,
        ticketPrefix: "EL",
        origin: "migrated",
        shipBehaviour: "commit",
        customShipPrompt: null,
        coAuthorDefault: true,
        countsTowardCap: false,
        createdByUserId: world.bob.userId,
        createdAt: 0,
        updatedAt: 0,
        archivedAt: null,
        deletedAt: null,
        purgeAfter: null,
      });
      await ctx.db.insert("labels", {
        id: U(4),
        projectId: otherProject,
        name: "Theirs",
        nameKey: "theirs",
        color: null,
        mergedIntoId: null,
        mergedAt: null,
        mergedBy: null,
        createdAt: 0,
        updatedAt: 0,
      });
    });
    await begin(world);
    const results = await importAll(world.alice.as, world.moveId, world.records);
    expect(results.labels).toMatchObject({
      inserted: 0,
      conflicts: [
        { index: 0, code: "already_migrated", detail: "another Workspace holds this row" },
      ],
    });
    const label = await world.t.run((ctx) =>
      ctx.db
        .query("labels")
        .withIndex("by_uuid", (q) => q.eq("id", U(4)))
        .unique(),
    );
    expect(label).toMatchObject({ projectId: otherProject, name: "Theirs" });
    await expect(commit(world)).rejects.toThrow(code("verification_failed"));
  });

  test("a project another move holds is in progress", async () => {
    const world = await importWorld();
    await begin(world);
    await expect(begin(world, { moveId: newId("project") })).rejects.toThrow(
      code("import_in_progress"),
    );
    await world.alice.as.mutation(api.projectImports.abort, { moveId: world.moveId });
    // Until the purge (MOVE-3) takes the aborted move to `purged`.
    await expect(begin(world, { moveId: newId("project") })).rejects.toThrow(
      code("import_in_progress"),
    );
  });
});

describe("authorization", () => {
  test("another person cannot see or drive the move", async () => {
    const world = await importedWorld();
    await setRole(world, world.bob.userId, "admin");
    const moveId = world.moveId;
    const as = world.bob.as;
    await expect(as.query(api.projectImports.status, { moveId })).rejects.toThrow(
      code("not_found"),
    );
    await expect(
      as.mutation(api.projectImports.importRows, { moveId, stream: "labels", rows: [] }),
    ).rejects.toThrow(code("not_found"));
    await expect(
      as.mutation(api.projectImports.commit, { moveId, manifestSha256: MANIFEST_SHA }),
    ).rejects.toThrow(code("not_found"));
    await expect(as.mutation(api.projectImports.uncommit, { moveId })).rejects.toThrow(
      code("not_found"),
    );
    await expect(as.mutation(api.projectImports.abort, { moveId })).rejects.toThrow(
      code("not_found"),
    );
    await expect(
      as.query(api.projectImports.readRows, {
        moveId,
        stream: "tickets",
        cursor: null,
        numItems: 10,
      }),
    ).rejects.toThrow(code("not_found"));
    // Nor take its move id over.
    const bobsRunner = await world.t.run((ctx) =>
      seedTestRunner(ctx, world.bob.userId, "bobs-mac"),
    );
    await expect(
      as.mutation(api.projectImports.begin, beginArgs(world, { runnerId: bobsRunner })),
    ).rejects.toThrow(code("move_conflict"));
  });

  test("a Member who does not manage the Workspace cannot import into it", async () => {
    const world = await importWorld();
    const bobsRunner = await world.t.run((ctx) =>
      seedTestRunner(ctx, world.bob.userId, "bobs-mac"),
    );
    await expect(
      world.bob.as.mutation(api.projectImports.begin, beginArgs(world, { runnerId: bobsRunner })),
    ).rejects.toThrow(code("forbidden"));
  });

  test("an importer who stops managing the Workspace stops importing", async () => {
    const world = await importWorld();
    await begin(world);
    await setRole(world, world.alice.userId, "member");
    await expect(importRows(world, "projects", world.records.projects)).rejects.toThrow(
      code("forbidden"),
    );
    await expect(commit(world)).rejects.toThrow(code("forbidden"));
  });

  test("a revoked preview cannot begin, import or commit", async () => {
    const world = await importWorld();
    await begin(world);
    await importRows(world, "projects", world.records.projects);
    await world.t.run(async (ctx) => {
      const grant = await ctx.db
        .query("previewAccess")
        .withIndex("by_kind_key", (q) => q.eq("kind", "user").eq("key", world.alice.userId))
        .unique();
      await ctx.db.patch(grant!._id, { revokedAt: Date.now() });
    });
    const refused = expect.objectContaining({
      data: expect.objectContaining({ code: expect.stringMatching(/^preview_/) }),
    });
    await expect(begin(world, { moveId: newId("project") })).rejects.toThrow(refused);
    await expect(
      importRows(world, "projectCounters", world.records.projectCounters),
    ).rejects.toThrow(refused);
    await expect(commit(world)).rejects.toThrow(refused);
    await expect(
      world.alice.as.query(api.projectImports.status, { moveId: world.moveId }),
    ).rejects.toThrow(refused);
  });

  test("a Workspace the importer is not a Member of", async () => {
    const world = await importWorld();
    const elsewhere = await seedWorkspace(world.t, [{ userId: world.bob.userId }]);
    await expect(begin(world, { workspaceId: elsewhere })).rejects.toThrow(code("not_a_member"));
  });

  test("rows that name another Workspace, person or runner are refused", async () => {
    const world = await importWorld();
    const elsewhere = await seedWorkspace(world.t, [{ userId: world.alice.userId }]);
    await begin(world);
    // The project row itself, aimed at another Workspace.
    const misplaced = await importRows(world, "projects", [
      { ...world.records.projects[0]!, workspaceId: elsewhere },
    ]);
    expect(misplaced.rejected).toEqual([expect.objectContaining({ code: "outside_project" })]);
    await importRows(world, "projects", world.records.projects);
    for (const stream of MIGRATION_IMPORT_STREAMS.slice(1, 9)) {
      await importRows(world, stream, world.records[stream]);
    }
    const comment = world.records.ticketComments[0]!;
    const forged = await importRows(world, "ticketComments", [
      { ...comment, author: { kind: "person", userId: world.bob.userId } },
      {
        ...comment,
        id: U(50),
        author: { kind: "agent", userId: world.bob.userId, sessionId: U(20) },
      },
    ]);
    expect(forged.rejected).toEqual([
      expect.objectContaining({
        code: "foreign_identity",
        detail: expect.stringMatching(/^author\.userId/),
      }),
      expect.objectContaining({ code: "foreign_identity" }),
    ]);
    const bobsRunner = await world.t.run((ctx) =>
      seedTestRunner(ctx, world.bob.userId, "bobs-mac"),
    );
    const placed = await importRows(world, "tickets", [
      { ...world.records.tickets[0]!, id: U(51), number: 2, placeRunnerId: bobsRunner },
    ]);
    expect(placed.rejected).toEqual([
      expect.objectContaining({
        code: "foreign_identity",
        detail: expect.stringMatching(/^placeRunnerId/),
      }),
    ]);
  });

  test("a runner that is not the importer's", async () => {
    const world = await importWorld();
    const bobsRunner = await world.t.run((ctx) =>
      seedTestRunner(ctx, world.bob.userId, "bobs-mac"),
    );
    await expect(begin(world, { runnerId: bobsRunner })).rejects.toThrow(
      code("runner_unavailable"),
    );
    await begin(world);
    await world.t.run(async (ctx) => {
      const runner = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", world.runnerId))
        .unique();
      await ctx.db.patch(runner!._id, { revokedAt: Date.now(), status: "revoked" });
    });
    await expect(importRows(world, "projects", world.records.projects)).rejects.toThrow(
      code("runner_unavailable"),
    );
  });

  test("a runner or an agent is not a person", async () => {
    const world = await importWorld();
    const runner = world.t.withIdentity({
      subject: `runner:${world.runnerId}`,
      issuer: "https://runners.volli.app",
      gen: 1,
    });
    await expect(runner.mutation(api.projectImports.begin, beginArgs(world))).rejects.toThrow(
      code("not_a_person"),
    );
    await expect(runner.query(api.projectImports.status, { moveId: world.moveId })).rejects.toThrow(
      code("not_a_person"),
    );
  });
});

describe("row rules", () => {
  test("nothing lands before the project row", async () => {
    const world = await importWorld();
    await begin(world);
    const early = await importRows(world, "tickets", world.records.tickets);
    expect(early).toMatchObject({
      inserted: 0,
      rejected: [expect.objectContaining({ code: "outside_project" })],
    });
  });

  test("a row of another project, or pointing into one, is refused", async () => {
    const world = await importWorld();
    await upTo(world, "labels");
    const theirs = await importRows(world, "labels", [
      { ...world.records.labels[0]!, projectId: world.visible.projectId },
    ]);
    expect(theirs.rejected).toEqual([expect.objectContaining({ code: "outside_project" })]);
    await importRows(world, "labels", world.records.labels);
    // A comment on the visible project's ticket, filed under the moved project.
    for (const stream of ["tickets", "ticketBodies", "boardEvents"] as const) {
      await importRows(world, stream, world.records[stream]);
    }
    const planted = await importRows(world, "ticketComments", [
      { ...world.records.ticketComments[0]!, ticketId: world.visible.ticketId },
    ]);
    expect(planted.rejected).toEqual([
      expect.objectContaining({
        code: "outside_project",
        detail: expect.stringMatching(/^ticketId/),
      }),
    ]);
  });

  test("personal settings are not a project's", async () => {
    const world = await importWorld();
    await upTo(world, "configEntries");
    const personal = await importRows(world, "configEntries", [
      {
        ...world.records.configEntries[0]!,
        level: "personal",
        userId: "$local-user",
        projectId: null,
      },
    ]);
    expect(personal.rejected).toEqual([expect.objectContaining({ code: "outside_project" })]);
  });

  test("a Session's visibility is the one its role decides", async () => {
    const world = await importWorld();
    await upTo(world, "sessions");
    const widened = await importRows(world, "sessions", [
      {
        ...world.records.sessions[0]!,
        role: "project",
        visibility: "shared",
        visibilityReason: "ticket",
      },
    ]);
    expect(widened.rejected).toEqual([expect.objectContaining({ code: "invalid_visibility" })]);
    await importRows(world, "sessions", world.records.sessions.slice(0, 1));
    const child = world.records.sessions[1]!;
    const narrowed = await importRows(world, "sessions", [{ ...child, visibility: "private" }]);
    expect(narrowed.rejected).toEqual([expect.objectContaining({ code: "invalid_visibility" })]);
  });

  test("a delegation's parent may be the importer's own Session in another project", async () => {
    const world = await importedWorld({ parentSessionId: (visible) => visible });
    expect(await commit(world)).toEqual({ status: "committed" });
  });

  test("but not someone else's", async () => {
    const world = await importWorld();
    const { sessionId: bobsSession } = await world.t.run(async (ctx) => {
      const id = newId("session");
      await ctx.db.insert("sessions", {
        id,
        projectId: world.visible.projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        ownerUserId: world.bob.userId,
        origin: { kind: "user" },
        title: null,
        visibility: "private",
        visibilityReason: "adhoc",
        sharedAt: null,
        status: "open",
        turnActive: false,
        lastTurnOutcome: null,
        signal: null,
        stopped: null,
        needsUser: false,
        attentionCount: 0,
        placeRunnerId: world.runnerId,
        model: null,
        usageTotals: {},
        createdAt: 0,
        lastActivityAt: 0,
        deletedAt: null,
        purgeAfter: null,
      });
      return { sessionId: id };
    });
    await upTo(world, "sessions");
    const records = moveRecords({ parentSessionId: bobsSession });
    const result = await importRows(world, "sessions", records.sessions);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        index: 1,
        code: "outside_project",
        detail: expect.stringMatching(/^parentSessionId/),
      }),
    ]);
  });
});

describe("uncommit and abort", () => {
  test("uncommit hides a committed project; abort then closes the move", async () => {
    const world = await importedWorld();
    await commit(world);
    expect(
      await world.alice.as.mutation(api.projectImports.uncommit, { moveId: world.moveId }),
    ).toEqual({ status: "importing" });
    await expect(getProject(world, world.bob.as)).rejects.toThrow(code("not_found"));
    // Idempotent.
    expect(
      await world.alice.as.mutation(api.projectImports.uncommit, { moveId: world.moveId }),
    ).toEqual({ status: "importing" });
    expect(
      await world.alice.as.mutation(api.projectImports.abort, { moveId: world.moveId }),
    ).toEqual({ status: "aborting" });
    expect(
      await world.alice.as.mutation(api.projectImports.abort, { moveId: world.moveId }),
    ).toEqual({ status: "aborting" });
    await expect(importRows(world, "labels", world.records.labels)).rejects.toThrow(
      code("import_closed"),
    );
    await expect(commit(world)).rejects.toThrow(code("import_closed"));
    await expect(
      world.alice.as.mutation(api.projectImports.uncommit, { moveId: world.moveId }),
    ).rejects.toThrow(code("import_closed"));
    // Still hidden: the purge (MOVE-3) removes it.
    await expect(getProject(world)).rejects.toThrow(code("not_found"));
  });

  test("uncommit refuses when the project changed since the commit, unless confirmed", async () => {
    const world = await importedWorld();
    await commit(world);
    await createTicket(world.bob.as, MOVED.projectId, { title: "after the move" });
    await expect(
      world.alice.as.mutation(api.projectImports.uncommit, { moveId: world.moveId }),
    ).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "changed_since_commit", boardChanges: 1 }),
      }),
    );
    await expect(getProject(world, world.bob.as)).resolves.toMatchObject({ id: MOVED.projectId });
    expect(
      await world.alice.as.mutation(api.projectImports.uncommit, {
        moveId: world.moveId,
        confirmChanged: true,
      }),
    ).toEqual({ status: "importing" });
    await expect(getProject(world, world.bob.as)).rejects.toThrow(code("not_found"));
  });

  test("a committed move is uncommitted before it is aborted", async () => {
    const world = await importedWorld();
    await commit(world);
    await expect(
      world.alice.as.mutation(api.projectImports.abort, { moveId: world.moveId }),
    ).rejects.toThrow(code("import_committed"));
  });
});

describe("a hidden project takes no runner writes", () => {
  test("a Session's facts, born or continued, wait for the commit", async () => {
    const world = await importedWorld();
    const runner = world.t.withIdentity({
      subject: `runner:${world.runnerId}`,
      issuer: "https://runners.volli.app",
      gen: 1,
    });
    const written = await writeSession({ projectId: MOVED.projectId, ticketId: MOVED.ticketId });
    const send = (events: typeof written.events) =>
      runner.mutation(api.sessions.accept, {
        sessionId: written.sessionId,
        generation: 1,
        events: events.map(wire),
      });
    const half = Math.ceil(written.events.length / 2);
    // Born into the hidden project: refused like a project that does not exist.
    await expect(send(written.events.slice(0, half))).rejects.toThrow(code("not_found"));
    await commit(world);
    await send(written.events.slice(0, half));
    await world.alice.as.mutation(api.projectImports.uncommit, {
      moveId: world.moveId,
      confirmChanged: true,
    });
    // Continued while hidden again: the same.
    await expect(send(written.events.slice(half))).rejects.toThrow(code("not_found"));
  });

  test("a staged command body of a hidden Session reads as unclaimed", async () => {
    const world = await importedWorld();
    const runner = world.t.withIdentity({
      subject: `runner:${world.runnerId}`,
      issuer: "https://runners.volli.app",
      gen: 1,
    });
    const read = (sessionId: string) =>
      runner.query(api.transcripts.commandArtifact, {
        sessionId,
        generation: 1,
        digest: `sha256:${"ab".repeat(32)}`,
      });
    await expect(read(MOVED.sessionId)).rejects.toThrow(code("not_claimed"));
    await expect(read(newId("session"))).rejects.toThrow(code("not_claimed"));
    await commit(world);
    await expect(read(MOVED.sessionId)).resolves.toBeNull();
  });

  test("a job queued while the project was shown waits, untouched, while it is hidden again", async () => {
    const world = await importedWorld();
    await commit(world);
    const jobId = newId("job");
    await world.t.run(async (ctx) => {
      await ctx.db.insert("runnerJobs", {
        id: jobId,
        runnerId: world.runnerId,
        kind: "automation.run",
        projectId: MOVED.projectId,
        sessionId: null,
        ticketId: MOVED.ticketId,
        workingCopyId: null,
        payload: { automationId: U(10) },
        priority: "normal",
        rank: 1,
        status: "queued",
        commandId: null,
        lease: null,
        receipt: null,
        result: null,
        createdBy: { kind: "person", userId: world.alice.userId },
        createdAt: 1,
        availableAt: 1,
        completedAt: null,
        expiresAt: null,
      } as never);
    });
    await world.alice.as.mutation(api.projectImports.uncommit, {
      moveId: world.moveId,
      confirmChanged: true,
    });
    const runner = world.t.withIdentity({
      subject: `runner:${world.runnerId}`,
      issuer: "https://runners.volli.app",
      gen: 1,
    });
    expect(await runner.query(api.runnerJobs.wake, {})).toMatchObject({ ready: 0 });
    expect(await runner.mutation(api.runnerJobs.claim, { bootId: newId("project") })).toEqual([]);
    const stored = () =>
      world.t.run((ctx) =>
        ctx.db
          .query("runnerJobs")
          .withIndex("by_uuid", (q) => q.eq("id", jobId))
          .unique(),
      );
    expect(await stored()).toMatchObject({ status: "queued", lease: null });
    expect(
      await runner.mutation(api.runnerJobs.renew, {
        jobId,
        bootId: newId("project"),
        attempt: 1,
      }),
    ).toEqual({ ok: false, reason: "gone" });
    await commit(world);
    expect(await runner.query(api.runnerJobs.wake, {})).toMatchObject({ ready: 1 });
    const claimed = await runner.mutation(api.runnerJobs.claim, { bootId: newId("project") });
    expect(claimed.map((claim) => claim.job.id)).toEqual([jobId]);
  });
});

describe("what a person's move does not take", () => {
  test("pending runner work: the manifest promises none and rows are refused", async () => {
    const world = await importWorld();
    const promised = world.expected.map((entry) =>
      entry.stream === "runnerJobs" ? { ...entry, count: 1 } : entry,
    );
    await expect(begin(world, { expected: promised })).rejects.toThrow(code("invalid_argument"));
    await upTo(world, "runnerJobs");
    const job = await importRows(world, "runnerJobs", [
      structuredClone(MIGRATION_FIXTURE_RECORDS.runnerJobs),
    ]);
    expect(job.rejected).toEqual([expect.objectContaining({ code: "not_moved" })]);
  });

  test("a GitHub repository or installation", async () => {
    const world = await importWorld();
    await upTo(world, "projectRepos");
    const linked = await importRows(world, "projectRepos", [
      { ...world.records.projectRepos[0]!, installationId: "12345" },
      { ...world.records.projectRepos[0]!, id: U(60), githubRepoId: "678" },
    ]);
    expect(linked.rejected).toEqual([
      expect.objectContaining({ code: "github_link" }),
      expect.objectContaining({ code: "github_link" }),
    ]);
  });

  test("an object key outside the moved project", async () => {
    const world = await importWorld();
    await upTo(world, "blobs");
    const blob = world.records.blobs[0]!;
    const elsewhere = await importRows(world, "blobs", [
      { ...blob, key: `v1/p/${world.visible.projectId}/b/${"ab".repeat(32)}` },
      { ...blob, key: "v1/m/anything" },
    ]);
    expect(elsewhere.rejected).toEqual([
      expect.objectContaining({ code: "invalid_key" }),
      expect.objectContaining({ code: "invalid_key" }),
    ]);
    for (const stream of MIGRATION_IMPORT_STREAMS.slice(
      MIGRATION_IMPORT_STREAMS.indexOf("blobs"),
      MIGRATION_IMPORT_STREAMS.indexOf("eventArchives"),
    )) {
      await importRows(world, stream, world.records[stream]);
    }
    const archive = await importRows(world, "eventArchives", [
      { ...world.records.eventArchives[0]!, key: "k" },
    ]);
    expect(archive.rejected).toEqual([expect.objectContaining({ code: "invalid_key" })]);
  });

  test("a comment or signal on no ticket", async () => {
    const world = await importWorld();
    await upTo(world, "ticketComments");
    const orphan = await importRows(world, "ticketComments", [
      { ...world.records.ticketComments[0]!, ticketId: U(70) },
    ]);
    expect(orphan.rejected).toEqual([expect.objectContaining({ code: "missing_reference" })]);
  });

  test("audit rows other than MCP operations", async () => {
    const world = await importWorld();
    await upTo(world, "auditLog");
    const forged = await importRows(world, "auditLog", [
      { ...world.records.auditLog[0]!, kind: "member.role_changed", targetKind: "member" },
    ]);
    expect(forged.rejected).toEqual([expect.objectContaining({ code: "not_moved" })]);
  });

  test("a batch larger than the bound", async () => {
    const world = await importWorld();
    await begin(world);
    await expect(
      importRows(
        world,
        "labels",
        Array.from({ length: 501 }, () => world.records.labels[0]),
      ),
    ).rejects.toThrow(code("invalid_argument"));
  });

  test("a reserved project id cannot be created by hand", async () => {
    const world = await importWorld();
    await begin(world);
    await expect(
      world.bob.as.mutation(api.projects.create, {
        commandId: newId("command"),
        workspaceId: world.workspaceId,
        projectId: MOVED.projectId,
        name: "Squatter",
        origin: "blank",
      }),
    ).rejects.toThrow(code("id_taken"));
  });
});

async function readAll(
  world: ImportWorld,
  stream: MigrationImportStream,
  parentId: string | null = null,
) {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: { rows: Record<string, unknown>[]; continueCursor: string; isDone: boolean } =
      await world.alice.as.query(api.projectImports.readRows, {
        moveId: world.moveId,
        stream,
        parentId,
        cursor,
        numItems: 1,
      });
    rows.push(...page.rows);
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
}

describe("read-back", () => {
  const PARENT: Partial<Record<MigrationImportStream, string>> = {
    ticketBodies: MOVED.ticketId,
    ticketComments: MOVED.ticketId,
    ticketSignals: MOVED.ticketId,
    sessionEvents: MOVED.sessionId,
    eventArchives: MOVED.sessionId,
    sessionIntake: MOVED.sessionId,
    sessionGrants: MOVED.sessionId,
    delegations: MOVED.childSessionId,
    delegationExtensions: MOVED.sessionId,
    readMarkers: MOVED.sessionId,
  };

  test("every stream reads back to the manifest's count and digest", async () => {
    const world = await importedWorld();
    for (const { stream, count, digest } of world.expected) {
      const name = stream as MigrationImportStream;
      const rows = await readAll(world, name, PARENT[name] ?? null);
      const read = new MigrationDigest();
      for (const row of rows) read.add(migrationRowDigest(name, row));
      expect({ stream, count: read.count, digest: read.value }).toEqual({ stream, count, digest });
    }
  });

  test("only before the project was ever shown", async () => {
    const world = await importedWorld();
    await commit(world);
    await expect(readAll(world, "sessions")).rejects.toThrow(code("import_closed"));
    await world.alice.as.mutation(api.projectImports.uncommit, { moveId: world.moveId });
    // Hidden again, but others may have written there while it was shown.
    await expect(readAll(world, "sessions")).rejects.toThrow(code("import_closed"));
  });

  test("a ticket or Session of another project is not in the move", async () => {
    const world = await importedWorld();
    await expect(readAll(world, "sessionEvents", world.visible.sessionId)).rejects.toThrow(
      code("not_found"),
    );
    await expect(readAll(world, "ticketComments", world.visible.ticketId)).rejects.toThrow(
      code("not_found"),
    );
    await expect(readAll(world, "ticketComments", null)).rejects.toThrow(code("not_found"));
  });
});
