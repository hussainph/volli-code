/**
 * The purge of an aborted move (`projectImportPurge.ts`) and the move's
 * object uploads (`projectImports.presignPut`), against an in-memory S3
 * stand-in (`s3-standin.ts`) that checks every signature independently.
 *
 * - The table list: every schema table says whether a purge deletes it,
 *   every importer stream is deleted, and the plan reaches exactly the
 *   tables it claims through real indexes.
 * - A purge leaves every table as it was before the move began (bar the
 *   move's own record and audit rows), deletes the move's objects and nothing
 *   else, and frees the project id for another move.
 * - It never touches a committed project, a project that took the id, a row
 *   of another project, or a key outside the move's two prefixes.
 */

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  MIGRATION_IMPORT_STREAMS,
  legacyArchiveKey,
  migrationKey,
  newId,
  projectBlobKey,
  transcriptPackKey,
  userLegacyArchiveKey,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { TableNames } from "../functions/_generated/dataModel.js";
import { PROJECT_PURGE, PURGE_TABLES, type PurgeNode } from "../functions/lib/projectPurge";
import { OBJECTS_AFTER_ABORT_MS } from "../functions/projectImportPurge";
import schema from "../functions/schema";
import { code } from "./board-helpers";
import { createTicket } from "./board-helpers";
import {
  MANIFEST_SHA,
  MOVED,
  U,
  beginArgs,
  importAll,
  importWorld,
  type ImportWorld,
} from "./projectImport-fixtures";
import { S3StandIn } from "./s3-standin";
import { wire, writeSession } from "./sessionFixtures";

const TABLES = Object.keys(schema.tables) as TableNames[];
const SHA = "ab".repeat(32);

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 28, 12) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Every table's documents, by table, sorted by `_id`. */
async function snapshot(world: ImportWorld) {
  return world.t.run(async (ctx) => {
    const out: Partial<Record<TableNames, Record<string, unknown>[]>> = {};
    for (const table of TABLES) {
      const docs = (await ctx.db.query(table).collect()) as Record<string, unknown>[];
      out[table] = docs.toSorted((a, b) => String(a._id).localeCompare(String(b._id)));
    }
    return out as Record<TableNames, Record<string, unknown>[]>;
  });
}

/** Begins the move and imports every record. */
async function importEverything(world: ImportWorld) {
  await world.alice.as.mutation(api.projectImports.begin, beginArgs(world));
  const results = await importAll(world.alice.as, world.moveId, world.records);
  for (const [stream, result] of Object.entries(results)) {
    expect(result.conflicts, stream).toEqual([]);
    expect(result.rejected, stream).toEqual([]);
  }
}

const recordCount = (world: ImportWorld) =>
  MIGRATION_IMPORT_STREAMS.reduce((total, stream) => total + world.records[stream].length, 0);

function status(world: ImportWorld) {
  return world.alice.as.query(api.projectImports.status, { moveId: world.moveId });
}

function abort(world: ImportWorld) {
  return world.alice.as.mutation(api.projectImports.abort, { moveId: world.moveId });
}

async function runScheduled(world: ImportWorld) {
  await world.t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Keys under the moved project, the move's staging, and every neighbour a purge must leave. */
function seedObjects(store: S3StandIn, world: ImportWorld) {
  const mine = [
    projectBlobKey(MOVED.projectId, SHA),
    transcriptPackKey({
      projectId: MOVED.projectId,
      sessionId: MOVED.sessionId,
      firstSequence: 1,
      lastSequence: 9,
    }),
    legacyArchiveKey(MOVED.projectId, "automation-ledger"),
    migrationKey(world.moveId, "manifest.json"),
    migrationKey(world.moveId, "chunk-0001.ndjson.zst"),
  ];
  const others = [
    // The visible project next door, another move's staging, the importer's kept archive.
    projectBlobKey(world.visible.projectId, SHA),
    migrationKey(newId("project"), "manifest.json"),
    userLegacyArchiveKey(world.alice.userId, "app-state"),
    `v1/p/${MOVED.projectId}`,
    `v1/m/${world.moveId}`,
  ];
  store.seed(...mine, ...others);
  return { mine, others };
}

/** Expects every table that a purge deletes from to hold exactly what it held before the move. */
function expectRestored(
  before: Record<TableNames, Record<string, unknown>[]>,
  after: Record<TableNames, Record<string, unknown>[]>,
) {
  for (const table of TABLES) {
    const disposition = PURGE_TABLES[table];
    if (typeof disposition === "object") {
      // Kept: the purge deletes none of it (activity while shown may add rows).
      const ids = new Set(after[table].map((doc) => doc._id));
      for (const doc of before[table]) expect(ids.has(doc._id), table).toBe(true);
      continue;
    }
    if (table === "auditLog") {
      const added = after.auditLog.filter(
        (doc) => !before.auditLog.some((old) => old._id === doc._id),
      );
      expect(
        before.auditLog.every((doc) => after.auditLog.some((now) => now._id === doc._id)),
      ).toBe(true);
      // Only the backend's own record of the move.
      for (const doc of added) expect(String(doc.kind)).toMatch(/^project\.import/);
      continue;
    }
    expect(after[table], table).toEqual(before[table]);
  }
}

function walk(nodes: readonly PurgeNode[], visit: (node: PurgeNode) => void) {
  for (const node of nodes) {
    visit(node);
    walk(node.children ?? [], visit);
  }
}

describe("the table list", () => {
  test("every table in the schema says what a purge does with it", () => {
    expect(Object.keys(PURGE_TABLES).toSorted()).toEqual(TABLES.toSorted());
  });

  test("every importer stream is deleted, so a new stream cannot be forgotten", () => {
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      expect(typeof PURGE_TABLES[stream], stream).toBe("string");
    }
  });

  test("the plan reaches exactly the deleted tables, through real indexes", () => {
    const reached = new Set<string>();
    walk(PROJECT_PURGE, (node) => {
      reached.add(node.table);
      const indexes = (
        schema.tables[node.table] as unknown as {
          " indexes"(): { indexDescriptor: string; fields: string[] }[];
        }
      )[" indexes"]();
      const index = indexes.find((entry) => entry.indexDescriptor === node.index);
      expect(index, `${node.table}.${node.index}`).toBeDefined();
      expect(index!.fields[0], `${node.table}.${node.index}`).toBe(node.field);
    });
    const deleted = TABLES.filter((table) => PURGE_TABLES[table] === "deleted");
    expect([...reached].toSorted()).toEqual(deleted.toSorted());
    expect(TABLES.filter((table) => PURGE_TABLES[table] === "project")).toEqual(["projects"]);
  });
});

describe("a purge", () => {
  test("puts every table back as it was, deletes the move's objects only, and frees the id", async () => {
    const store = new S3StandIn().install();
    const world = await importWorld();
    const { mine, others } = seedObjects(store, world);
    const before = await snapshot(world);
    await importEverything(world);

    expect(await abort(world)).toEqual({ status: "aborting" });
    await runScheduled(world);

    expect(await status(world)).toMatchObject({
      status: "purged",
      purge: {
        phase: "objects",
        rows: recordCount(world),
        objects: mine.length,
        objectsSkipped: null,
        error: null,
      },
    });
    expectRestored(before, await snapshot(world));
    expect(store.keys()).toEqual(others.toSorted());
    // Only the move's two prefixes were ever listed, and only its keys deleted.
    const listed = new Set(
      store.log.filter((entry) => entry.method === "LIST").map((e) => e.prefix),
    );
    expect([...listed].toSorted()).toEqual(
      [`v1/m/${world.moveId}/`, `v1/p/${MOVED.projectId}/`].toSorted(),
    );
    expect(
      store.log
        .filter((entry) => entry.method === "DELETE")
        .map((entry) => entry.key)
        .toSorted(),
    ).toEqual(mine.toSorted());

    // The project can be moved again, all the way to shown.
    const again = { ...world, moveId: globalThis.crypto.randomUUID() };
    await importEverything(again);
    await world.alice.as.mutation(api.projectImports.commit, {
      moveId: again.moveId,
      manifestSha256: MANIFEST_SHA,
    });
    await expect(
      world.bob.as.query(api.projects.get, { projectId: MOVED.projectId }),
    ).resolves.toMatchObject({ id: MOVED.projectId });
  });

  test("a move rolled back after its commit takes what was written while it was shown", async () => {
    new S3StandIn().install();
    const world = await importWorld();
    const before = await snapshot(world);
    await importEverything(world);
    await world.alice.as.mutation(api.projectImports.commit, {
      moveId: world.moveId,
      manifestSha256: MANIFEST_SHA,
    });
    // A teammate's ticket, a comment, and a Session the runner writes (folded).
    const created = await createTicket(world.bob.as, MOVED.projectId, { title: "after" });
    await world.bob.as.mutation(api.board.createComment, {
      commandId: newId("command"),
      ticketId: MOVED.ticketId,
      commentId: newId("comment"),
      body: "while shown",
    });
    const runner = world.t.withIdentity({
      subject: `runner:${world.runnerId}`,
      issuer: "https://runners.volli.app",
      gen: 1,
    });
    const written = await writeSession({ projectId: MOVED.projectId, ticketId: MOVED.ticketId });
    await runner.mutation(api.sessions.accept, {
      sessionId: written.sessionId,
      generation: 1,
      events: written.events.map(wire),
    });
    await runScheduled(world);
    const shown = await snapshot(world);
    expect(shown.sessionStates.length).toBeGreaterThan(before.sessionStates.length);
    expect(created).toBeDefined();

    await world.alice.as.mutation(api.projectImports.uncommit, {
      moveId: world.moveId,
      confirmChanged: true,
    });
    await abort(world);
    await runScheduled(world);

    expect(await status(world)).toMatchObject({ status: "purged" });
    expectRestored(before, await snapshot(world));
  });

  test("waits for every upload URL the move was given to expire before it empties the prefixes", async () => {
    const store = new S3StandIn().install();
    const world = await importWorld();
    await importEverything(world);
    const bytes = new TextEncoder().encode("late bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = projectBlobKey(MOVED.projectId, sha256);
    const { request } = await world.alice.as.action(api.projectImports.presignPut, {
      moveId: world.moveId,
      key,
      bytes: bytes.length,
      sha256,
    });

    await abort(world);
    // The rows go at once; the objects phase waits.
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(1);
      await world.t.finishInProgressScheduledFunctions();
    }
    expect(await status(world)).toMatchObject({
      status: "aborting",
      purge: { phase: "objects", rows: recordCount(world) },
    });
    // A URL signed before the abort still works until it expires.
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(await store.upload(request, bytes)).toBe(200);
    expect(store.objects.has(key)).toBe(true);

    vi.advanceTimersByTime(OBJECTS_AFTER_ABORT_MS);
    await runScheduled(world);
    expect(await status(world)).toMatchObject({ status: "purged" });
    expect(store.objects.has(key)).toBe(false);
  });

  test("works in bounded transactions and pages", async () => {
    const store = new S3StandIn().install();
    const world = await importWorld();
    await importEverything(world);
    // 600 more events in the moved Session, and more objects than one list page holds.
    await world.t.run(async (ctx) => {
      const event = await ctx.db
        .query("sessionEvents")
        .withIndex("by_session_sequence", (q) => q.eq("sessionId", MOVED.sessionId))
        .first();
      const { _id, _creationTime, ...doc } = event!;
      for (let i = 0; i < 600; i += 1) {
        await ctx.db.insert("sessionEvents", {
          ...doc,
          sequence: 1_000 + i,
          eventId: `extra-${i}`,
        });
      }
    });
    const keys = Array.from({ length: 2_345 }, (_, i) =>
      transcriptPackKey({
        projectId: MOVED.projectId,
        sessionId: MOVED.sessionId,
        firstSequence: i,
        lastSequence: i,
      }),
    );
    store.seed(...keys);

    await abort(world);
    await runScheduled(world);

    expect(await status(world)).toMatchObject({
      status: "purged",
      purge: { rows: recordCount(world) + 600, objects: keys.length },
    });
    expect(store.keys()).toEqual([]);
    const steps = await world.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.name === "projectImportPurge:step",
      ),
    );
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(store.log.filter((entry) => entry.method === "LIST").length).toBeGreaterThanOrEqual(3);
  });

  test("on a deployment with no object store, deletes the rows and says it left the objects", async () => {
    const world = await importWorld();
    await importEverything(world);
    await abort(world);
    await runScheduled(world);
    expect(await status(world)).toMatchObject({
      status: "purged",
      purge: { objects: 0, objectsSkipped: "storage_unconfigured" },
    });
    const audit = await world.t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_target", (q) =>
          q.eq("targetKind", "project").eq("targetId", MOVED.projectId),
        )
        .collect(),
    );
    expect(audit.map((row) => row.kind)).toEqual([
      "project.import_aborted",
      "project.import_purged",
    ]);
  });

  test("a store that fails leaves the move aborting; resume and abort start it again", async () => {
    const store = new S3StandIn().install();
    const world = await importWorld();
    const { mine } = seedObjects(store, world);
    await importEverything(world);
    store.failDeletesWith = 503;
    await abort(world);
    await runScheduled(world);
    expect(await status(world)).toMatchObject({
      status: "aborting",
      purge: { phase: "objects", error: "object_store_failed:delete:503" },
    });
    // Still held: another move of the project waits.
    await expect(
      world.alice.as.mutation(
        api.projectImports.begin,
        beginArgs(world, { moveId: newId("project") }),
      ),
    ).rejects.toThrow(code("import_in_progress"));

    store.failDeletesWith = null;
    expect(await world.t.mutation(internal.projectImportPurge.resume, {})).toEqual({
      restarted: 1,
    });
    await runScheduled(world);
    expect(await status(world)).toMatchObject({ status: "purged" });
    for (const key of mine) expect(store.objects.has(key)).toBe(false);
  });

  test("abort called again restarts a failed purge at once", async () => {
    const store = new S3StandIn().install();
    const world = await importWorld();
    seedObjects(store, world);
    await importEverything(world);
    store.failDeletesWith = 500;
    await abort(world);
    await runScheduled(world);
    expect((await status(world)).status).toBe("aborting");
    store.failDeletesWith = null;
    expect(await abort(world)).toEqual({ status: "aborting" });
    await runScheduled(world);
    expect(await abort(world)).toEqual({ status: "purged" });
  });
});

describe("what a purge never touches", () => {
  test("a committed move: no link deletes a row or an object", async () => {
    const store = new S3StandIn().install();
    const world = await importWorld();
    seedObjects(store, world);
    await importEverything(world);
    await world.alice.as.mutation(api.projectImports.commit, {
      moveId: world.moveId,
      manifestSha256: MANIFEST_SHA,
    });
    const before = await snapshot(world);
    const keys = store.keys();

    await world.t.mutation(internal.projectImportPurge.step, { moveId: world.moveId });
    await world.t.action(internal.projectImportPurge.objects, { moveId: world.moveId });
    await world.t.mutation(internal.projectImportPurge.finish, {
      moveId: world.moveId,
      skipped: null,
    });
    await world.t.mutation(internal.projectImportPurge.resume, {});
    await runScheduled(world);

    expect(await snapshot(world)).toEqual(before);
    expect(store.keys()).toEqual(keys);
    expect(store.log).toEqual([]);
    expect((await status(world)).status).toBe("committed");
  });

  test("a project that took the id: its rows and its objects stay, the staging goes", async () => {
    const store = new S3StandIn().install();
    const world = await importWorld();
    await world.alice.as.mutation(api.projectImports.begin, beginArgs(world));
    // Before the move's project row arrived, a visible project took the id.
    await world.t.run(async (ctx) => {
      const visible = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", world.visible.projectId))
        .unique();
      const { _id, _creationTime, ...doc } = visible!;
      await ctx.db.insert("projects", { ...doc, id: MOVED.projectId, ticketPrefix: "ZZ" });
      await ctx.db.insert("projectCounters", {
        projectId: MOVED.projectId,
        nextTicketNumber: 1,
        boardSeq: 0,
      });
    });
    await createTicket(world.bob.as, MOVED.projectId, { title: "theirs" });
    const blob = projectBlobKey(MOVED.projectId, SHA);
    const staging = migrationKey(world.moveId, "manifest.json");
    store.seed(blob, staging);
    const before = await snapshot(world);

    await abort(world);
    await runScheduled(world);

    expect(await status(world)).toMatchObject({
      status: "purged",
      purge: { rows: 0, objects: 1, objectsSkipped: "project_id_taken" },
    });
    expectRestored(before, await snapshot(world));
    expect(store.keys()).toEqual([blob]);
    expect(store.log.some((entry) => entry.prefix === `v1/p/${MOVED.projectId}/`)).toBe(false);
  });

  test("a row reached through the moved project that names another project stops it", async () => {
    const store = new S3StandIn().install();
    const world = await importWorld();
    const { mine } = seedObjects(store, world);
    await importEverything(world);
    const foreignId = newId("workingCopy");
    await world.t.run(async (ctx) => {
      const copy = await ctx.db
        .query("workingCopies")
        .withIndex("by_ticket_runner_repo", (q) => q.eq("ticketId", MOVED.ticketId))
        .first();
      const { _id, _creationTime, ...doc } = copy!;
      await ctx.db.insert("workingCopies", {
        ...doc,
        id: foreignId,
        projectId: world.visible.projectId,
      });
    });

    await abort(world);
    await runScheduled(world);

    expect(await status(world)).toMatchObject({
      status: "aborting",
      purge: { phase: "rows", error: "stopped:foreign_row:workingCopies" },
    });
    const foreign = await world.t.run((ctx) =>
      ctx.db
        .query("workingCopies")
        .withIndex("by_uuid", (q) => q.eq("id", foreignId))
        .unique(),
    );
    expect(foreign).not.toBeNull();
    // No object was touched, and the cron leaves a stop for a person.
    for (const key of mine) expect(store.objects.has(key)).toBe(true);
    expect(await world.t.mutation(internal.projectImportPurge.resume, {})).toEqual({
      restarted: 0,
    });
  });

  test("a listed key outside the prefix stops it before any delete of that page", async () => {
    const store = new S3StandIn().install();
    const world = await importWorld();
    const { mine, others } = seedObjects(store, world);
    store.extraListed.push(others[0]!);
    await importEverything(world);

    await abort(world);
    await runScheduled(world);

    expect(await status(world)).toMatchObject({
      status: "aborting",
      purge: { phase: "objects", error: "stopped:foreign_key" },
    });
    expect(store.log.some((entry) => entry.method === "DELETE")).toBe(false);
    for (const key of [...mine, ...others]) expect(store.objects.has(key)).toBe(true);
  });
});

async function openMove() {
  const world = await importWorld();
  await world.alice.as.mutation(api.projectImports.begin, beginArgs(world));
  return world;
}

describe("presignPut", () => {
  const body = new TextEncoder().encode("blob bytes");
  const bodySha = createHash("sha256").update(body).digest("hex");

  test("signs one write-once PUT of exact bytes to the move's own key", async () => {
    const store = new S3StandIn().install();
    const world = await openMove();
    const key = projectBlobKey(MOVED.projectId, bodySha);
    const { request } = await world.alice.as.action(api.projectImports.presignPut, {
      moveId: world.moveId,
      key,
      bytes: body.length,
      sha256: bodySha,
    });
    expect(request.headers).toMatchObject({
      "content-length": String(body.length),
      "if-none-match": "*",
    });
    expect(await store.upload(request, new TextEncoder().encode("other byte"))).toBe(400);
    expect(await store.upload(request, body)).toBe(200);
    // Write-once: the same key again is refused by the store.
    expect(await store.upload(request, body)).toBe(412);
    expect(store.objects.get(key)).toEqual(body);
  });

  test("takes every key family a move writes", async () => {
    new S3StandIn().install();
    const world = await openMove();
    const session = `v1/p/${MOVED.projectId}/s/${MOVED.sessionId}`;
    for (const key of [
      projectBlobKey(MOVED.projectId, bodySha),
      legacyArchiveKey(MOVED.projectId, "automation-ledger"),
      userLegacyArchiveKey(world.alice.userId, "app-state"),
      migrationKey(world.moveId, "manifest.json"),
      `${session}/tx/000000000001-000000000009.pack.zst`,
      `${session}/ev/000000000001-000000000009.ndjson.zst`,
      `${session}/a/${SHA}.json.zst`,
      `${session}/e/000000000042.json.zst`,
      `${session}/pi/runtime-pi:0d1e8f6a/${U(30)}/000000000000000.jsonl.zst`,
    ]) {
      await expect(
        world.alice.as.action(api.projectImports.presignPut, {
          moveId: world.moveId,
          key,
          bytes: 1,
          sha256: bodySha,
        }),
        key,
      ).resolves.toMatchObject({ request: { method: "PUT" } });
    }
  });

  test("refuses any other key, size or digest", async () => {
    new S3StandIn().install();
    const world = await openMove();
    const put = (key: string, extra: { bytes?: number; sha256?: string } = {}) =>
      world.alice.as.query(internal.projectImports.authorizeObjectPut, {
        moveId: world.moveId,
        key,
        bytes: extra.bytes ?? 1,
        sha256: extra.sha256 ?? bodySha,
      });
    const session = `v1/p/${MOVED.projectId}/s/${MOVED.sessionId}`;
    for (const key of [
      // Another project's, another move's, another person's, the Workspace's.
      projectBlobKey(world.visible.projectId, bodySha),
      migrationKey(newId("project"), "manifest.json"),
      userLegacyArchiveKey(world.bob.userId, "app-state"),
      `v1/w/${world.workspaceId}/b/${bodySha}`,
      // A blob not at its own digest; layouts a move does not write; malformed parts.
      projectBlobKey(MOVED.projectId, SHA),
      `v1/p/${MOVED.projectId}/env/${U(31)}.log.zst`,
      `v1/p/${MOVED.projectId}/cfg/${U(31)}/1.tar.zst`,
      `v1/p/${MOVED.projectId}/`,
      `v1/p/${MOVED.projectId}/legacy/Bad Name.ndjson.zst`,
      `v1/u/${world.alice.userId}/b/${bodySha}`,
      `v1/m/${world.moveId}/nested/part`,
      `v1/m/${world.moveId}/../escape`,
      `${session}/tx/1-9.pack.zst`,
      `${session}/tx/000000000009-000000000001.pack.zst`,
      `${session}/ev/000000000001-000000000009.json`,
      `${session}/a/short.json.zst`,
      `${session}/e/42.json.zst`,
      `${session}/pi/a/b/c/000000000000000.jsonl.zst`,
      `${session}/x/whatever`,
      `v1/p/${MOVED.projectId}/s/not-a-uuid/e/000000000042.json.zst`,
      `v1/p/${MOVED.projectId}/b/${bodySha.toUpperCase()}`,
      "",
    ]) {
      await expect(put(key), key).rejects.toThrow(code("invalid_key"));
    }
    const blob = projectBlobKey(MOVED.projectId, bodySha);
    await expect(put(blob, { bytes: 0 })).rejects.toThrow(code("invalid_argument"));
    await expect(put(blob, { bytes: 1.5 })).rejects.toThrow(code("invalid_argument"));
    await expect(
      put(`${session}/e/000000000042.json.zst`, { bytes: 64 * 1024 * 1024 + 1 }),
    ).rejects.toThrow(code("invalid_argument"));
    await expect(put(blob, { sha256: "AB".repeat(32) })).rejects.toThrow(code("invalid_argument"));
    await expect(put(blob, { bytes: 64 * 1024 * 1024 + 1 })).resolves.toEqual({ key: blob });
  });

  test("only for the importer, only while the move is open, only with a store", async () => {
    const world = await openMove();
    const args = {
      moveId: world.moveId,
      key: projectBlobKey(MOVED.projectId, bodySha),
      bytes: body.length,
      sha256: bodySha,
    };
    await expect(world.alice.as.action(api.projectImports.presignPut, args)).rejects.toThrow(
      code("storage_unconfigured"),
    );
    new S3StandIn().install();
    await expect(world.bob.as.action(api.projectImports.presignPut, args)).rejects.toThrow(
      code("not_found"),
    );
    await abort(world);
    await expect(world.alice.as.action(api.projectImports.presignPut, args)).rejects.toThrow(
      code("import_closed"),
    );
  });
});
