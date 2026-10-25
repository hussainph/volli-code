/**
 * The SQLite → Volli Cloud migration's backend side: internal functions the
 * importer calls with the deployment's admin key, never a client.
 *
 * - {@link begin} checks (or, for a dry run, creates) the person, Workspace
 *   and runner an import lands under.
 * - {@link importRows} writes one batch of one export stream. Each record is
 *   mapped by `migrationDocument` from `@volli/shared/cloud` (the same
 *   function the verifier applies on its side), then looked up by its key: a
 *   new row is inserted, an existing row with the same digest is left alone,
 *   and an existing row with a different digest is reported as a conflict
 *   and never overwritten. A re-run is therefore idempotent.
 * - {@link readPage} pages one table back out, and {@link readSessionEvents}
 *   reads one Session's events by index, both scoped to the target, for the
 *   verifier's counts and digests.
 *
 * Every row an import writes must belong to a project of the target
 * Workspace; an id that already exists elsewhere is a conflict, the "already
 * migrated" case (§6.10.5). Reports name fields and codes, never values: a
 * migration report must be safe to paste.
 */

import type { GenericDatabaseReader } from "convex/server";
import { ConvexError, v } from "convex/values";

import {
  DEFAULT_WORKSPACE_POLICY,
  MIGRATION_IMPORT_STREAMS,
  MigrationRowError,
  isUuid,
  migrationDocument,
  newId,
  migrationRowDigest,
  type MigrationImportStream,
  type MigrationTarget,
} from "@volli/shared/cloud";

import type { DataModel } from "./_generated/dataModel.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { literals, nullable } from "./lib/validators";

type Reader = GenericDatabaseReader<DataModel>;
type Row = Record<string, unknown>;

const targetValidator = v.object({
  userId: v.string(),
  workspaceId: v.string(),
  runnerId: v.string(),
});
const streamValidator = literals(MIGRATION_IMPORT_STREAMS);

type Key = { index: string; fields: readonly string[]; alsoMatch?: readonly string[] };

/**
 * How each stream's rows are found again: the index to read and the fields
 * that identify one row (the index's leading fields, then any checked after
 * the read). Keys follow each table's "unique by mutation" rule.
 */
const KEYS: Readonly<Record<MigrationImportStream, Key>> = {
  projects: { index: "by_uuid", fields: ["id"] },
  projectCounters: { index: "by_project", fields: ["projectId"] },
  projectRepos: { index: "by_uuid", fields: ["id"] },
  projectEnvironment: { index: "by_project", fields: ["projectId"] },
  configEntries: { index: "by_uuid", fields: ["id"] },
  memberProjectPrefs: { index: "by_user_project", fields: ["userId", "projectId"] },
  projectCheckouts: { index: "by_runner_repo", fields: ["runnerId", "projectRepoId"] },
  labels: { index: "by_uuid", fields: ["id"] },
  tickets: { index: "by_uuid", fields: ["id"] },
  ticketBodies: { index: "by_ticket", fields: ["ticketId"] },
  boardEvents: { index: "by_uuid", fields: ["id"] },
  ticketComments: { index: "by_uuid", fields: ["id"] },
  ticketSignals: { index: "by_uuid", fields: ["id"] },
  blobs: { index: "by_project_sha", fields: ["projectId", "sha256"] },
  blobLinks: { index: "by_uuid", fields: ["id"] },
  automations: { index: "by_uuid", fields: ["id"] },
  automationRuns: { index: "by_uuid", fields: ["id"] },
  automationArmings: {
    index: "by_automation",
    fields: ["automationId"],
    alsoMatch: ["projectId", "status"],
  },
  automationColumnOrder: { index: "by_project_status", fields: ["projectId", "status"] },
  runnerJobs: { index: "by_uuid", fields: ["id"] },
  sessions: { index: "by_uuid", fields: ["id"] },
  sessionEvents: { index: "by_session_sequence", fields: ["sessionId", "sequence"] },
  eventArchives: { index: "by_uuid", fields: ["id"] },
  sessionIntake: { index: "by_session", fields: ["sessionId"] },
  delegations: { index: "by_child", fields: ["childSessionId"] },
  sessionGrants: { index: "by_session_verb", fields: ["sessionId", "verb"], alsoMatch: ["scope"] },
  delegationExtensions: { index: "by_parent_call", fields: ["parentSessionId", "toolCallId"] },
  workingCopies: { index: "by_uuid", fields: ["id"] },
  readMarkers: { index: "by_user_session", fields: ["userId", "sessionId"] },
  auditLog: { index: "by_uuid", fields: ["id"] },
};

/** Codes an import reports per row. */
type RowFailure = { index: number; code: string; detail: string };

function migrationError(
  code: string,
  message: string,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

function withoutSystemFields(doc: Row): Row {
  const { _id: _ignoredId, _creationTime: _ignoredTime, ...rest } = doc;
  return rest;
}

/**
 * Keys besides the import key that a table holds unique: a ticket's number in
 * its project, a board event's place in its project's order, an archive's
 * first sequence in its Session.
 */
const UNIQUE: Readonly<Partial<Record<MigrationImportStream, Key>>> = {
  tickets: { index: "by_project_number", fields: ["projectId", "number"] },
  boardEvents: { index: "by_project_seq", fields: ["projectId", "seq"] },
  eventArchives: { index: "by_session_first", fields: ["sessionId", "firstSequence"] },
};

/** A stored row matching `doc` on `key`, if any. */
async function findExisting(
  db: Reader,
  stream: MigrationImportStream,
  key: Key,
  doc: Row,
): Promise<Row | null> {
  // The index names and fields are the table's own (`test/migration.test.ts`
  // imports a record of every stream through them); the dynamic table name is
  // why the query is untyped here.
  const rows = (await (db.query(stream) as any)
    .withIndex(key.index, (q: any) =>
      key.fields.reduce((range: any, field) => range.eq(field, doc[field]), q),
    )
    .take(64)) as Row[];
  return (
    rows.find((row) => (key.alsoMatch ?? []).every((field) => row[field] === doc[field])) ?? null
  );
}

/** Which project a row of `stream` belongs to, read through its owner when it names none itself. */
class ProjectScope {
  private readonly projects = new Map<string, string | null>();
  private readonly sessions = new Map<string, string | null>();
  private readonly tickets = new Map<string, string | null>();

  constructor(
    private readonly db: Reader,
    private readonly target: MigrationTarget,
  ) {}

  /** Whether `projectId` is a live project of the target Workspace. */
  async inTarget(projectId: string | null): Promise<boolean> {
    if (projectId === null) return false;
    if (!this.projects.has(projectId)) {
      const project = await this.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", projectId))
        .unique();
      this.projects.set(projectId, project?.workspaceId ?? null);
    }
    return this.projects.get(projectId) === this.target.workspaceId;
  }

  private async sessionProject(sessionId: unknown): Promise<string | null> {
    if (typeof sessionId !== "string") return null;
    if (!this.sessions.has(sessionId)) {
      const session = await this.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", sessionId))
        .unique();
      this.sessions.set(sessionId, session?.projectId ?? null);
    }
    return this.sessions.get(sessionId) ?? null;
  }

  private async ticketProject(ticketId: unknown): Promise<string | null> {
    if (typeof ticketId !== "string") return null;
    if (!this.tickets.has(ticketId)) {
      const ticket = await this.db
        .query("tickets")
        .withIndex("by_uuid", (q) => q.eq("id", ticketId))
        .unique();
      this.tickets.set(ticketId, ticket?.projectId ?? null);
    }
    return this.tickets.get(ticketId) ?? null;
  }

  /** The owning project of a row (a project's own id for `projects`). */
  async of(stream: MigrationImportStream, doc: Row): Promise<string | null> {
    switch (stream) {
      case "projects":
        return doc.id as string;
      case "ticketBodies":
        return this.ticketProject(doc.ticketId);
      case "sessionEvents":
      case "eventArchives":
      case "sessionIntake":
      case "sessionGrants":
      case "readMarkers":
        return this.sessionProject(doc.sessionId);
      case "delegations":
        return this.sessionProject(doc.childSessionId);
      case "delegationExtensions":
        return this.sessionProject(doc.parentSessionId);
      case "auditLog":
        return null;
      default:
        return typeof doc.projectId === "string" ? doc.projectId : null;
    }
  }

  /** Whether a row belongs to the target: its project is the target's, its Workspace (projects, audit) or its person (personal settings). */
  async owns(stream: MigrationImportStream, doc: Row): Promise<boolean> {
    if (stream === "auditLog" || stream === "projects") {
      return doc.workspaceId === this.target.workspaceId;
    }
    // A personal setting belongs to the person, not to a project.
    if (stream === "configEntries" && doc.level === "personal") {
      return doc.userId === this.target.userId && doc.projectId === null;
    }
    return this.inTarget(await this.of(stream, doc));
  }
}

async function requireTarget(db: Reader, target: MigrationTarget): Promise<void> {
  for (const [field, value] of Object.entries(target)) {
    if (!isUuid(value)) throw migrationError("invalid_target", `${field} is not a canonical UUID`);
  }
  const user = await db
    .query("users")
    .withIndex("by_uuid", (q) => q.eq("id", target.userId))
    .unique();
  if (user === null || user.status !== "active") {
    throw migrationError("invalid_target", "the migrating person has no active account");
  }
  const workspace = await db
    .query("workspaces")
    .withIndex("by_uuid", (q) => q.eq("id", target.workspaceId))
    .unique();
  if (workspace === null || workspace.deletedAt !== null) {
    throw migrationError("invalid_target", "the target Workspace does not exist");
  }
  const member = await db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", target.workspaceId).eq("userId", target.userId),
    )
    .unique();
  if (member === null || member.status !== "active" || member.role === "member") {
    throw migrationError(
      "invalid_target",
      "the migrating person does not manage the target Workspace",
    );
  }
  const runner = await db
    .query("runners")
    .withIndex("by_uuid", (q) => q.eq("id", target.runnerId))
    .unique();
  if (runner === null || runner.ownerUserId !== target.userId || runner.revokedAt !== null) {
    throw migrationError("invalid_target", "the target runner is not the migrating person's");
  }
}

/**
 * Checks the import target. With `createMissing` (a dry run against a fresh
 * deployment) it first creates whichever of the person, their Workspace and
 * this Mac's runner row is absent, with the ids given. A real migration runs
 * after sign-in, Workspace creation and runner linking, which own those rows,
 * and passes `createMissing: false`.
 */
export const begin = internalMutation({
  args: {
    target: targetValidator,
    createMissing: v.boolean(),
    displayName: v.string(),
    runnerName: v.string(),
  },
  handler: async (ctx, { target, createMissing, displayName, runnerName }) => {
    const created: string[] = [];
    if (createMissing) {
      // Only a test deployment (one that trusts the test issuer) may mint
      // people, Workspaces and runners this way.
      if (!process.env.VOLLI_TEST_JWKS) {
        throw migrationError("not_a_test_deployment", "createMissing is for test deployments only");
      }
      for (const [field, value] of Object.entries(target)) {
        if (!isUuid(value))
          throw migrationError("invalid_target", `${field} is not a canonical UUID`);
      }
      const now = Date.now();
      const db = ctx.db;
      if (
        (await db
          .query("users")
          .withIndex("by_uuid", (q) => q.eq("id", target.userId))
          .unique()) === null
      ) {
        await db.insert("users", {
          id: target.userId,
          primaryEmail: null,
          emailVerified: false,
          displayName,
          avatarKey: null,
          status: "active",
          deletionRequestedAt: null,
          purgeAfter: null,
          trialSeededWorkspaceId: null,
          createdAt: now,
          lastSeenAt: now,
        });
        created.push("user");
      }
      if (
        (await db
          .query("workspaces")
          .withIndex("by_uuid", (q) => q.eq("id", target.workspaceId))
          .unique()) === null
      ) {
        await db.insert("workspaces", {
          id: target.workspaceId,
          name: displayName,
          slug: `migration-${target.workspaceId}`,
          iconKey: null,
          createdByUserId: target.userId,
          planKey: "free",
          activeMemberCount: 1,
          createdAt: now,
          deletedAt: null,
          purgeAfter: null,
        });
        await db.insert("workspacePolicies", {
          workspaceId: target.workspaceId,
          ...DEFAULT_WORKSPACE_POLICY,
          revision: 0,
          updatedByUserId: target.userId,
          updatedAt: now,
        });
        await db.insert("workspaceMembers", {
          id: newId("member"),
          workspaceId: target.workspaceId,
          userId: target.userId,
          role: "owner",
          status: "active",
          billingTier: "free",
          joinedAt: now,
          suspendedAt: null,
          leftAt: null,
          invitedByUserId: null,
        });
        created.push("workspace");
      }
      if (
        (await db
          .query("runners")
          .withIndex("by_uuid", (q) => q.eq("id", target.runnerId))
          .unique()) === null
      ) {
        await db.insert("runners", {
          id: target.runnerId,
          ownerUserId: target.userId,
          kind: "mac",
          name: runnerName,
          status: "offline",
          statusReason: null,
          statusChangedAt: now,
          version: "migration",
          platform: { os: "darwin", distro: null, kernel: null, arch: "unknown", glibc: null },
          capabilities: {},
          installMode: "app",
          linkedVia: "desktop",
          linkedAt: now,
          autoUpdate: { enabled: false, channel: "stable", pinnedVersion: null },
          update: null,
          revokedAt: null,
          createdAt: now,
        });
        created.push("runner");
      }
    }
    await requireTarget(ctx.db, target);
    return { created };
  },
});

/** What one batch did, row by row. */
type ImportRowsResult = {
  inserted: number;
  unchanged: number;
  conflicts: RowFailure[];
  rejected: RowFailure[];
};

/**
 * The part of a schema-validation message that is safe to report: the
 * top-level field. The value, and path segments below the field (the value's
 * own keys), never leave.
 */
function schemaDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const field = /Path: \.([A-Za-z0-9_]+)/.exec(message)?.[1];
  return field === undefined ? "the schema refused the document" : `the schema refused ${field}`;
}

/** Writes one batch of `stream`. Rows are independent: one refusal does not stop the rest. */
export const importRows = internalMutation({
  args: { target: targetValidator, stream: streamValidator, rows: v.array(v.any()) },
  handler: async (ctx, { target, stream, rows }): Promise<ImportRowsResult> => {
    await requireTarget(ctx.db, target);
    const scope = new ProjectScope(ctx.db, target);
    const importedAt = Date.now();
    const result: ImportRowsResult = { inserted: 0, unchanged: 0, conflicts: [], rejected: [] };
    for (const [index, record] of rows.entries()) {
      let doc: Row;
      try {
        doc = migrationDocument(stream, record, target, importedAt);
      } catch (error) {
        if (!(error instanceof MigrationRowError)) throw error;
        result.rejected.push({ index, code: error.code, detail: error.message });
        continue;
      }
      const existing = await findExisting(ctx.db, stream, KEYS[stream], doc);
      if (existing !== null) {
        // Another Workspace's row with this key came from another copy of the
        // profile: refused as already migrated, however alike it is.
        if (!(await scope.owns(stream, withoutSystemFields(existing)))) {
          result.conflicts.push({
            index,
            code: "already_migrated",
            detail: "another Workspace holds this row",
          });
          continue;
        }
        const same =
          migrationRowDigest(stream, withoutSystemFields(existing)) ===
          migrationRowDigest(stream, doc);
        if (same) result.unchanged += 1;
        else
          result.conflicts.push({
            index,
            code: "conflict",
            detail: "a different row has this key",
          });
        continue;
      }
      if (!(await scope.owns(stream, doc))) {
        result.rejected.push({
          index,
          code: "outside_target",
          detail: "its project is not in the target Workspace",
        });
        continue;
      }
      const unique = UNIQUE[stream];
      if (unique !== undefined && (await findExisting(ctx.db, stream, unique, doc)) !== null) {
        result.rejected.push({
          index,
          code: "duplicate_key",
          detail: `another row has this ${unique.fields.join(" and ")}`,
        });
        continue;
      }
      if (stream === "sessionEvents") {
        const sameId = await ctx.db
          .query("sessionEvents")
          .withIndex("by_session_event", (q) =>
            q.eq("sessionId", doc.sessionId as string).eq("eventId", doc.eventId as string),
          )
          .first();
        if (sameId !== null) {
          result.conflicts.push({
            index,
            code: "conflict",
            detail: "the event id is already at another sequence",
          });
          continue;
        }
      }
      try {
        await ctx.db.insert(stream, doc as never);
        result.inserted += 1;
      } catch (error) {
        result.rejected.push({ index, code: "schema", detail: schemaDetail(error) });
      }
    }
    return result;
  },
});

/**
 * One page of `stream`'s table, without Convex's own fields, limited to rows
 * of the target Workspace. A page may hold fewer rows than asked for (rows of
 * other Workspaces are skipped, and `maximumBytesRead` bounds large rows).
 */
export const readPage = internalQuery({
  args: {
    target: targetValidator,
    stream: streamValidator,
    cursor: nullable(v.string()),
    numItems: v.number(),
    maximumBytesRead: v.optional(v.number()),
  },
  handler: async (ctx, { target, stream, cursor, numItems, maximumBytesRead }) => {
    const page = await (ctx.db.query(stream) as any).paginate({
      cursor,
      numItems,
      ...(maximumBytesRead === undefined ? {} : { maximumBytesRead }),
    });
    const scope = new ProjectScope(ctx.db, target);
    const rows: Row[] = [];
    for (const doc of page.page as Row[]) {
      const row = withoutSystemFields(doc);
      if (await scope.owns(stream, row)) rows.push(row);
    }
    return { rows, continueCursor: page.continueCursor as string, isDone: page.isDone as boolean };
  },
});

/**
 * One Session's events after `afterSequence`, in sequence order, through the
 * `(sessionId, sequence)` index. The verifier reads `sessionEvents` this way:
 * a ranged read stays cheap however large the table grows, where paging the
 * whole table does not.
 */
export const readSessionEvents = internalQuery({
  args: {
    target: targetValidator,
    sessionId: v.string(),
    afterSequence: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { target, sessionId, afterSequence, limit }) => {
    const scope = new ProjectScope(ctx.db, target);
    if (!(await scope.owns("sessionIntake", { sessionId }))) return { rows: [] as Row[] };
    const docs = await ctx.db
      .query("sessionEvents")
      .withIndex("by_session_sequence", (q) =>
        q.eq("sessionId", sessionId).gt("sequence", afterSequence),
      )
      .take(limit);
    return { rows: docs.map((doc) => withoutSystemFields(doc as Row)) };
  },
});
