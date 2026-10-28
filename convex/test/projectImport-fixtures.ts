/**
 * A world for the person-authorized import suites: Alice owns a Workspace
 * with a visible project (its ticket and a shared Session her runner claims),
 * Bob is a Member of it, and a local project's export (one record per
 * importer stream, from the shared mapping's own fixture) is ready to move in
 * under her sign-in.
 */

import {
  MIGRATION_IMPORT_STREAMS,
  MIGRATION_PLACEHOLDERS,
  MigrationDigest,
  migrationDocument,
  migrationRowDigest,
  type MigrationImportStream,
  type MigrationTarget,
} from "@volli/shared/cloud";

// The shared mapping's own fixture: one export record per stream.
import {
  MIGRATION_FIXTURE_RECORDS,
  fixtureUuid,
} from "../../packages/shared/src/cloud/migration-import.fixture";

import { api } from "../functions/_generated/api";
import { seedTestWorld } from "../functions/lib/testWorld";
import { seedSession, setup, signIn, type Client, type Tester } from "./board-helpers";

export const U = fixtureUuid;
const USER = MIGRATION_PLACEHOLDERS.userId;
const RUNNER = MIGRATION_PLACEHOLDERS.runnerId;
const WORKSPACE = MIGRATION_PLACEHOLDERS.workspaceId;

/** The moved project and the rows of it the suites name. */
export const MOVED = {
  projectId: U(1),
  ticketId: U(5),
  sessionId: U(20),
  childSessionId: U(22),
  commentId: U(7),
} as const;

/** Strings only the moved project holds: an answer naming one leaked it. */
export const HIDDEN_TEXT = [
  "zz-hidden-project",
  "zz-hidden-ticket",
  "zz-hidden-body",
  "zz-hidden-comment",
  "zz-hidden-session",
] as const;

export type Records = Record<MigrationImportStream, Record<string, unknown>[]>;

/**
 * One export of the moved project: the shared fixture's record per stream,
 * named so a leak is visible, plus a subagent (`U(22)`, the delegation's
 * child) whose parent is `parentSessionId` (the fixture's own Session by
 * default; another project's to test a cross-project delegation).
 */
export function moveRecords(options: { parentSessionId?: string } = {}): Records {
  const records = Object.fromEntries(
    MIGRATION_IMPORT_STREAMS.map((stream) => [
      stream,
      [structuredClone(MIGRATION_FIXTURE_RECORDS[stream])],
    ]),
  ) as Records;
  const parentSessionId = options.parentSessionId ?? MOVED.sessionId;
  records.projects[0]!.name = "zz-hidden-project";
  records.tickets[0]!.title = "zz-hidden-ticket";
  records.ticketBodies[0]!.body = "zz-hidden-body";
  records.ticketComments[0]!.body = "zz-hidden-comment";
  records.sessions[0]!.title = "zz-hidden-session";
  records.sessions.push({
    id: MOVED.childSessionId,
    projectId: MOVED.projectId,
    ticketId: null,
    role: "subagent",
    parentSessionId,
    ownerUserId: USER,
    title: "zz-hidden-session child",
    visibility: "shared",
    visibilityReason: "inherited",
    placeRunnerId: RUNNER,
    createdAt: 3,
    lastActivityAt: 4,
    lastSequence: 0,
    eventCount: 0,
  });
  records.delegations[0]!.parentSessionId = parentSessionId;
  // An MCP operation's audit row names its project in `detail`.
  records.auditLog[0] = {
    ...records.auditLog[0],
    workspaceId: WORKSPACE,
    detail: { projectId: MOVED.projectId, serverName: "zz-hidden-server" },
  };
  return records;
}

export type Expected = { stream: string; count: number; digest: string }[];

/** The manifest's promise for `records` under `target`: what the client computes. */
export function expectedFor(records: Records, target: MigrationTarget): Expected {
  return MIGRATION_IMPORT_STREAMS.map((stream) => {
    const digest = new MigrationDigest();
    for (const record of records[stream]) {
      digest.add(migrationRowDigest(stream, migrationDocument(stream, record, target, 0)));
    }
    return { stream, count: digest.count, digest: digest.value };
  });
}

export const MANIFEST_SHA = "c".repeat(64);

export async function importWorld(
  options: { parentSessionId?: (visibleSessionId: string) => string } = {},
) {
  const t = setup();
  const alice = await signIn(t, "alice");
  const bob = await signIn(t, "bob");
  const world = await t.run((ctx) =>
    seedTestWorld(ctx, { ownerUserId: alice.userId, memberUserIds: [bob.userId], runners: 1 }),
  );
  const runnerId = world.runnerIds[0]!;
  // A shared Session in the visible project, claimed by Alice's runner.
  const { sessionId: visibleSessionId } = await seedSession(
    t,
    { ticketId: world.ticketId, projectId: world.projectId },
    alice.userId,
  );
  await t.run(async (ctx) => {
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", visibleSessionId))
      .unique();
    await ctx.db.patch(intake!._id, { claim: { runnerId, generation: 1 } });
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", visibleSessionId))
      .unique();
    await ctx.db.patch(session!._id, { placeRunnerId: runnerId });
  });
  const target: MigrationTarget = {
    userId: alice.userId,
    workspaceId: world.workspaceId,
    runnerId,
  };
  const records = moveRecords({
    parentSessionId: options.parentSessionId?.(visibleSessionId),
  });
  const expected = expectedFor(records, target);
  const moveId = globalThis.crypto.randomUUID();
  return {
    t,
    alice,
    bob,
    target,
    runnerId,
    workspaceId: world.workspaceId,
    visible: { projectId: world.projectId, ticketId: world.ticketId, sessionId: visibleSessionId },
    records,
    expected,
    moveId,
  };
}

export type ImportWorld = Awaited<ReturnType<typeof importWorld>>;

export function beginArgs(world: ImportWorld, overrides: Record<string, unknown> = {}) {
  return {
    moveId: world.moveId,
    projectId: MOVED.projectId,
    workspaceId: world.workspaceId,
    runnerId: world.runnerId,
    manifestSha256: MANIFEST_SHA,
    expected: world.expected,
    ...overrides,
  };
}

/** Sends every stream's records, in importer order, one batch per stream. */
export async function importAll(
  as: Client,
  moveId: string,
  records: Records,
): Promise<Record<string, { inserted: number; conflicts: unknown[]; rejected: unknown[] }>> {
  const results: Record<string, { inserted: number; conflicts: unknown[]; rejected: unknown[] }> =
    {};
  for (const stream of MIGRATION_IMPORT_STREAMS) {
    results[stream] = await as.mutation(api.projectImports.importRows, {
      moveId,
      stream,
      rows: records[stream],
    });
  }
  return results;
}

/** A world with the move begun and every row imported, not committed. */
export async function importedWorld(
  options: Parameters<typeof importWorld>[0] = {},
): Promise<ImportWorld> {
  const world = await importWorld(options);
  await world.alice.as.mutation(api.projectImports.begin, beginArgs(world));
  const results = await importAll(world.alice.as, world.moveId, world.records);
  for (const [stream, result] of Object.entries(results)) {
    if (result.conflicts.length > 0 || result.rejected.length > 0) {
      throw new Error(`${stream}: ${JSON.stringify(result)}`);
    }
  }
  return world;
}

export type { Tester };
