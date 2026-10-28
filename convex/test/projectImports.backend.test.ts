/**
 * A person-authorized move against the real pinned backend, over the real
 * client transport: begin, every stream (re-sent once), the project hidden
 * from its importer and a Member until commit, a commit refused while a row
 * is missing, then the commit, and a project-scoped read-back that recomputes
 * every stream's count and digest.
 */
import { randomUUID } from "node:crypto";

import { expect, test } from "vite-plus/test";

import {
  MIGRATION_IMPORT_STREAMS,
  MigrationDigest,
  migrationRowDigest,
  type MigrationImportStream,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
import { enrollBackendPreview } from "./preview-fixtures";
import { MANIFEST_SHA, MOVED, expectedFor, moveRecords } from "./projectImport-fixtures";

const backend = connectBackend();

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

test("a move lands hidden, commits only when complete, and reads back to its manifest", async () => {
  const alice = backend.client(`user:${randomUUID()}`);
  const bob = backend.client(`user:${randomUUID()}`);
  const { userId } = await alice.mutation(api.accounts.ensureViewer, {});
  const { userId: bobId } = await bob.mutation(api.accounts.ensureViewer, {});
  await enrollBackendPreview(backend, alice, userId);
  await enrollBackendPreview(backend, bob, bobId);
  const world = await backend.admin(internal.testSeed.seedWorld, {
    ownerUserId: userId,
    memberUserIds: [bobId],
    runners: 1,
  });
  const runnerId = world.runnerIds[0]!;
  // The shared backend outlives this test: the moved project's ids are fresh.
  const records = moveRecords();
  const fresh = new Map<string, string>();
  const text = JSON.stringify(records).replace(
    /00000000-0000-4000-8000-0000000000[0-9]{2}/g,
    (id) => fresh.get(id) ?? (fresh.set(id, randomUUID()), fresh.get(id)!),
  );
  const moved = JSON.parse(text) as typeof records;
  const projectId = fresh.get(MOVED.projectId)!;
  const target = { userId, workspaceId: world.workspaceId, runnerId };
  const expected = expectedFor(moved, target);
  const moveId = randomUUID();

  await alice.mutation(api.projectImports.begin, {
    moveId,
    projectId,
    workspaceId: world.workspaceId,
    runnerId,
    manifestSha256: MANIFEST_SHA,
    expected,
  });
  for (const pass of [1, 2]) {
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      // The first pass holds the comment back.
      const rows = pass === 1 && stream === "ticketComments" ? [] : moved[stream];
      const result = await alice.mutation(api.projectImports.importRows, { moveId, stream, rows });
      expect(result.conflicts, stream).toEqual([]);
      expect(result.rejected, stream).toEqual([]);
    }
    if (pass === 1) {
      await expect(
        alice.mutation(api.projectImports.commit, { moveId, manifestSha256: MANIFEST_SHA }),
      ).rejects.toMatchObject({ data: { code: "verification_failed" } });
      for (const person of [alice, bob]) {
        await expect(person.query(api.projects.get, { projectId })).rejects.toMatchObject({
          data: { code: "not_found" },
        });
        const listed = await person.query(api.projects.list, { workspaceId: world.workspaceId });
        expect(listed.map((project) => project.id)).not.toContain(projectId);
      }
    }
  }

  await expect(
    alice.mutation(api.projectImports.commit, { moveId, manifestSha256: MANIFEST_SHA }),
  ).resolves.toEqual({ status: "committed" });
  await expect(bob.query(api.projects.get, { projectId })).resolves.toMatchObject({
    id: projectId,
    name: "zz-hidden-project",
  });

  for (const { stream, count, digest } of expected) {
    const name = stream as MigrationImportStream;
    const parent = PARENT[name];
    const read = new MigrationDigest();
    let cursor: string | null = null;
    for (;;) {
      const page: { rows: Record<string, unknown>[]; continueCursor: string; isDone: boolean } =
        await alice.query(api.projectImports.readRows, {
          moveId,
          stream: name,
          parentId: parent === undefined ? null : fresh.get(parent)!,
          cursor,
          numItems: 2,
        });
      for (const row of page.rows) read.add(migrationRowDigest(name, row));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect({ stream, count: read.count, digest: read.value }).toEqual({ stream, count, digest });
  }
}, 120_000);
