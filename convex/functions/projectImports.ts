/**
 * A person-authorized import of one local project into a Workspace: the
 * backend half of "Move to Volli Cloud". The client (the move engine) calls
 * these with the person's own sign-in; nothing here takes the admin key.
 *
 * - {@link begin} reserves the move (`projectImports` row, keyed by the
 *   client's move id) with the manifest's per-stream promise: a count and a
 *   `MigrationDigest` value for every importer stream.
 * - {@link importRows} writes one batch of one stream through the import core
 *   the internal dry run shares (`lib/migrationImport.ts`). The project row
 *   arrives first and is stored with `moveState: "importing"`, so
 *   `projectAccess` (and every read that enumerates projects) treats the
 *   project, and everything in it, as not found for everyone, its importer
 *   included. Each INSERTED row's digest is added to its stream's
 *   accumulator; a re-sent row answers `unchanged` and adds nothing, so the
 *   accumulators stay exact however batches are repeated or reordered.
 * - {@link commit} refuses unless every stream's accumulator equals the
 *   manifest's promise, then shows the project (`moveState: null`).
 *   {@link uncommit} hides it again (a roll back after commit), refusing
 *   when the project changed since the commit unless told to go ahead.
 * - {@link abort} marks the import `aborting`. Purging its rows and objects
 *   (taking it to `purged`) is a scheduled purge chain that is not built
 *   yet; until it is, an aborted import's rows stay, hidden, and the project
 *   cannot be moved again (`import_in_progress`).
 * - {@link status} and {@link readRows} are the importer's own reads: the
 *   accumulators, and a project-scoped read-back (by project, ticket or
 *   Session index) for the client's verification. They read through the
 *   import, not through `projectAccess`, which hides the project, and only
 *   while nothing but the import has written there (before any commit), so
 *   they never show the importer what someone else wrote.
 *
 * Who may import: the person who began the move, while they are an owner or
 * admin of the target Workspace with live preview access (rechecked on every
 * call), onto a runner of their own. Another person's move answers
 * `not_found`. Every imported row must belong to the project being moved, may
 * name no person but the importer, no runner but theirs and no Workspace but
 * the target, and may not point into another project (a delegation's parent
 * Session may: it can be one of the importer's own Sessions in the same
 * Workspace, moved before).
 */

import { ConvexError, v } from "convex/values";

import {
  MIGRATION_DIGEST_VALUE,
  MIGRATION_IMPORT_STREAMS,
  MigrationDigest,
  eventArchiveKey,
  isUuid,
  projectBlobKey,
  sessionVisibilityAtCreation,
  type MigrationImportStream,
  type MigrationTarget,
} from "@volli/shared/cloud";

import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { audit } from "./lib/audit";
import { requireManage, requireViewer, type Viewer } from "./lib/auth";
import {
  ProjectScope,
  importBatch,
  withoutSystemFields,
  type ImportPolicy,
  type ImportRowsResult,
  type Reader,
  type Row,
  type RowFailure,
} from "./lib/migrationImport";
import { literals, nullable } from "./lib/validators";
import { personActor } from "./lib/workspaces";

export type ProjectImportErrorCode =
  | "invalid_argument"
  | "already_migrated"
  | "import_in_progress"
  | "move_conflict"
  | "runner_unavailable"
  | "import_closed"
  | "import_committed"
  | "manifest_mismatch"
  | "verification_failed"
  | "changed_since_commit";

function importError(
  code: ProjectImportErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): ConvexError<{ code: ProjectImportErrorCode; message: string }> {
  return new ConvexError({ code, message, ...extra } as {
    code: ProjectImportErrorCode;
    message: string;
  });
}

type ImportRow = Doc<"projectImports">;
type ImportStatus = ImportRow["status"];

/** Statuses that still take rows. */
const OPEN: ReadonlySet<ImportStatus> = new Set(["reserved", "importing"]);
/** Statuses that hold the project id: another move of it waits (or is refused). */
const HOLDING: ReadonlySet<ImportStatus> = new Set(["reserved", "importing", "aborting"]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The most rows one read-back page returns. */
const READ_BACK_MAX_ITEMS = 500;

/** The most rows one `importRows` batch takes (the client sends at most 200). */
const IMPORT_BATCH_MAX_ROWS = 500;

const streamValidator = literals(MIGRATION_IMPORT_STREAMS);

// ── who ──────────────────────────────────────────────────────────────────────

/**
 * The importing person and their import: the caller must be the person who
 * began it (anyone else reads `not_found`, so a move id says nothing), still
 * an owner or admin of its Workspace, with live preview access.
 */
async function requireImporter(
  ctx: QueryCtx,
  moveId: string,
): Promise<{ viewer: Viewer; row: ImportRow }> {
  const viewer = await requireViewer(ctx);
  const row = isUuid(moveId)
    ? await ctx.db
        .query("projectImports")
        .withIndex("by_uuid", (q) => q.eq("id", moveId))
        .unique()
    : null;
  if (row === null || row.userId !== viewer.userId) {
    throw new ConvexError({ code: "not_found", message: "That move does not exist." });
  }
  await requireManage(ctx, row.workspaceId, "settings");
  return { viewer, row };
}

/** The importer's runner, still theirs and not revoked. */
async function requireOwnRunner(ctx: QueryCtx, userId: string, runnerId: string) {
  const runner = isUuid(runnerId)
    ? await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", runnerId))
        .unique()
    : null;
  if (
    runner === null ||
    runner.ownerUserId !== userId ||
    runner.revokedAt !== null ||
    runner.status === "revoked"
  ) {
    throw importError("runner_unavailable", "That runner is not one of yours.");
  }
  return runner;
}

function targetOf(row: ImportRow): MigrationTarget {
  return { userId: row.userId, workspaceId: row.workspaceId, runnerId: row.runnerId };
}

async function streamRows(db: Reader, moveId: string) {
  const rows = await db
    .query("projectImportStreams")
    .withIndex("by_move_stream", (q) => q.eq("moveId", moveId))
    .collect();
  const order = new Map<string, number>(MIGRATION_IMPORT_STREAMS.map((stream, i) => [stream, i]));
  return rows.toSorted((a, b) => (order.get(a.stream) ?? 0) - (order.get(b.stream) ?? 0));
}

/** What `status` answers: the import and every stream's promise and accumulator. Never content. */
async function describe(db: Reader, row: ImportRow) {
  return {
    moveId: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    runnerId: row.runnerId,
    manifestSha256: row.manifestSha256,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    committedAt: row.committedAt,
    abortedAt: row.abortedAt,
    streams: (await streamRows(db, row.id)).map((stream) => ({
      stream: stream.stream,
      expectedCount: stream.expectedCount,
      expectedDigest: stream.expectedDigest,
      count: stream.count,
      digest: stream.digest,
    })),
  };
}

// ── begin ────────────────────────────────────────────────────────────────────

const expectedValidator = v.array(
  v.object({ stream: v.string(), count: v.number(), digest: v.string() }),
);

type Expected = { stream: string; count: number; digest: string };

/** The manifest's promise, one entry per importer stream, or `invalid_argument`. */
function checkExpected(expected: readonly Expected[]): Map<MigrationImportStream, Expected> {
  const byStream = new Map<MigrationImportStream, Expected>();
  for (const entry of expected) {
    const stream = MIGRATION_IMPORT_STREAMS.find((name) => name === entry.stream);
    if (stream === undefined) {
      throw importError(
        "invalid_argument",
        "The manifest names a stream this backend does not import.",
      );
    }
    if (byStream.has(stream)) {
      throw importError("invalid_argument", "The manifest names a stream twice.");
    }
    if (!Number.isSafeInteger(entry.count) || entry.count < 0) {
      throw importError("invalid_argument", "A stream's count is not a whole number.");
    }
    if (!MIGRATION_DIGEST_VALUE.test(entry.digest)) {
      throw importError("invalid_argument", "A stream's digest is not 32 lowercase hex digits.");
    }
    byStream.set(stream, entry);
  }
  if (byStream.size !== MIGRATION_IMPORT_STREAMS.length) {
    throw importError("invalid_argument", "The manifest must name every importer stream.");
  }
  if (byStream.get("projects")!.count !== 1) {
    throw importError("invalid_argument", "A move carries exactly one project.");
  }
  if (byStream.get("runnerJobs")!.count !== 0) {
    throw importError("invalid_argument", "Pending runner work does not move.");
  }
  return byStream;
}

/**
 * Reserves a move: checks who and where, and records the manifest's promise
 * per stream. Idempotent by `moveId` (the same arguments answer the import's
 * status); a project already in Volli Cloud is `already_migrated`, one with
 * another move open is `import_in_progress`.
 */
export const begin = mutation({
  args: {
    moveId: v.string(),
    projectId: v.string(),
    workspaceId: v.string(),
    runnerId: v.string(),
    manifestSha256: v.string(),
    expected: expectedValidator,
  },
  handler: async (ctx, args) => {
    const { viewer } = await requireManage(ctx, args.workspaceId, "settings");
    if (!isUuid(args.moveId) || !isUuid(args.projectId)) {
      throw importError("invalid_argument", "A move and its project are named by canonical UUIDs.");
    }
    if (!SHA256_HEX.test(args.manifestSha256)) {
      throw importError("invalid_argument", "The manifest digest is not a sha256 hex string.");
    }
    const expected = checkExpected(args.expected);
    await requireOwnRunner(ctx, viewer.userId, args.runnerId);

    const existing = await ctx.db
      .query("projectImports")
      .withIndex("by_uuid", (q) => q.eq("id", args.moveId))
      .unique();
    if (existing !== null) {
      const streams = await streamRows(ctx.db, existing.id);
      const same =
        existing.userId === viewer.userId &&
        existing.projectId === args.projectId &&
        existing.workspaceId === args.workspaceId &&
        existing.runnerId === args.runnerId &&
        existing.manifestSha256 === args.manifestSha256 &&
        streams.length === expected.size &&
        streams.every((stream) => {
          const promised = expected.get(stream.stream as MigrationImportStream);
          return (
            promised !== undefined &&
            promised.count === stream.expectedCount &&
            promised.digest === stream.expectedDigest
          );
        });
      if (!same) throw importError("move_conflict", "That move id is already in use.");
      return { moveId: existing.id, status: existing.status };
    }

    const imports = await ctx.db
      .query("projectImports")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    if (imports.some((row) => HOLDING.has(row.status))) {
      throw importError("import_in_progress", "This project is already being moved.");
    }
    const project = await ctx.db
      .query("projects")
      .withIndex("by_uuid", (q) => q.eq("id", args.projectId))
      .unique();
    if (project !== null || imports.some((row) => row.status === "committed")) {
      throw importError("already_migrated", "This project is already in Volli Cloud.");
    }

    const now = Date.now();
    await ctx.db.insert("projectImports", {
      id: args.moveId,
      projectId: args.projectId,
      workspaceId: args.workspaceId,
      userId: viewer.userId,
      runnerId: args.runnerId,
      manifestSha256: args.manifestSha256,
      status: "reserved",
      createdAt: now,
      updatedAt: now,
      committedAt: null,
      committedBoardSeq: null,
      uncommittedAt: null,
      abortedAt: null,
    });
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      const promised = expected.get(stream)!;
      await ctx.db.insert("projectImportStreams", {
        moveId: args.moveId,
        stream,
        expectedCount: promised.count,
        expectedDigest: promised.digest,
        count: 0,
        digest: new MigrationDigest().value,
      });
    }
    return { moveId: args.moveId, status: "reserved" as ImportStatus };
  },
});

// ── importRows ───────────────────────────────────────────────────────────────

/** Fields whose values are content, not identity: never searched for ids. */
const CONTENT_FIELDS = new Set([
  "payload",
  "provenance",
  "definition",
  "detail",
  "triggerSpec",
  "themeCanvas",
  "pullRequests",
  "result",
  "receipt",
]);

/**
 * The first field naming a person other than the importer, a runner other
 * than theirs or a Workspace other than the target, or `null`. Looks at the
 * row's own fields and one level into its objects (Actors, claims, owners),
 * never into content: a local profile has one person, one runner and one
 * Workspace, so a row naming anyone else did not come from it.
 */
function foreignIdentity(doc: Row, target: MigrationTarget): string | null {
  const wrong = (key: string, value: unknown): boolean => {
    if (value === null || value === undefined) return false;
    if (key === "userId" || key === "onBehalfOf" || key.endsWith("UserId")) {
      return value !== target.userId;
    }
    if (key === "runnerId" || key.endsWith("RunnerId")) return value !== target.runnerId;
    if (key === "workspaceId") return value !== target.workspaceId;
    return false;
  };
  for (const [key, value] of Object.entries(doc)) {
    if (wrong(key, value)) return key;
    if (CONTENT_FIELDS.has(key) || value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) continue;
    for (const [inner, innerValue] of Object.entries(value as Row)) {
      if (wrong(inner, innerValue)) return `${key}.${inner}`;
    }
  }
  return null;
}

/** A refusal unless `key` is the key `expected` derives for the moved project. */
function objectKey(key: unknown, expected: () => string): Omit<RowFailure, "index"> | null {
  let derived: string | null;
  try {
    derived = expected();
  } catch {
    derived = null;
  }
  return derived !== null && key === derived
    ? null
    : { code: "invalid_key", detail: "key is not the moved project's key for this object" };
}

/** Row fields that name another row, and the table it is in. */
const REFERENCES = [
  ["ticketId", "tickets"],
  ["sessionId", "sessions"],
  ["childSessionId", "sessions"],
  ["parentSessionId", "sessions"],
  ["projectRepoId", "projectRepos"],
  ["automationId", "automations"],
  ["workingCopyId", "workingCopies"],
  ["mergedIntoId", "labels"],
] as const;
type ReferencedTable = (typeof REFERENCES)[number][1] | "ticketComments";

/**
 * The person-authorized import's rules for one import: where rows belong,
 * what they may name, and the accumulators the inserted rows feed.
 */
function personPolicy(db: Reader, row: ImportRow, accumulator: MigrationDigest): ImportPolicy {
  const target = targetOf(row);
  const scope = new ProjectScope(db);
  const projectOf = new Map<string, Row | null>();

  /** A referenced row's project and (Sessions) owner, or `null` when there is no such row. */
  const referenced = async (table: ReferencedTable, id: string): Promise<Row | null> => {
    const key = `${table}:${id}`;
    if (!projectOf.has(key)) {
      const found = (await (db.query(table) as any)
        .withIndex("by_uuid", (q: any) => q.eq("id", id))
        .unique()) as Row | null;
      projectOf.set(
        key,
        found === null ? null : { projectId: found.projectId, ownerUserId: found.ownerUserId },
      );
    }
    return projectOf.get(key) ?? null;
  };

  /** The project being moved, stored and still hidden under this import. */
  const hiddenProject = async (): Promise<boolean> => {
    const project = await scope.project(row.projectId);
    return (
      project !== null &&
      project.workspaceId === row.workspaceId &&
      project.moveState === "importing" &&
      project.deletedAt === null
    );
  };

  const owns = async (stream: MigrationImportStream, doc: Row, stored: boolean) => {
    if (stream === "projects") {
      // A stored project is this import's only while it is hidden under it.
      return (
        doc.id === row.projectId &&
        doc.workspaceId === row.workspaceId &&
        (!stored || doc.moveState === "importing")
      );
    }
    if (!(await hiddenProject())) return false;
    // Personal settings belong to the person, not to a project: not a move's.
    if (stream === "configEntries") {
      return doc.level === "project" && doc.projectId === row.projectId;
    }
    if (stream === "auditLog") {
      const detail = doc.detail as Row | null;
      return (
        doc.workspaceId === row.workspaceId &&
        detail !== null &&
        typeof detail === "object" &&
        detail.projectId === row.projectId
      );
    }
    return (await scope.of(stream, doc)) === row.projectId;
  };

  const references = async (doc: Row): Promise<string | null> => {
    const named: Array<[string, ReferencedTable, unknown]> = REFERENCES.map(([field, table]) => [
      field,
      table,
      doc[field],
    ]);
    if (Array.isArray(doc.labelIds)) {
      for (const id of doc.labelIds) named.push(["labelIds", "labels", id]);
    }
    const owner = doc.owner as Row | null | undefined;
    if (owner !== null && typeof owner === "object" && typeof owner.id === "string") {
      const table =
        owner.kind === "ticket"
          ? "tickets"
          : owner.kind === "comment"
            ? "ticketComments"
            : "sessions";
      named.push(["owner.id", table, owner.id]);
    }
    for (const [field, table, id] of named) {
      if (typeof id !== "string") continue;
      const found = await referenced(table, id);
      // A row this profile no longer has is not resolved here; it names nothing anyone sees.
      if (found === null || found.projectId === row.projectId) continue;
      // A delegation's parent may be one of the importer's own Sessions in
      // another project of the same Workspace (moved before this one).
      if (
        field === "parentSessionId" &&
        found.ownerUserId === row.userId &&
        (await scope.workspaceOf(found.projectId as string)) === row.workspaceId
      ) {
        continue;
      }
      return field;
    }
    return null;
  };

  /** What one stream's rows must also be when a person moves them, or `null`. */
  const streamRule = async (
    stream: MigrationImportStream,
    doc: Row,
  ): Promise<Omit<RowFailure, "index"> | null> => {
    switch (stream) {
      // Pending armed Runs are archived, not moved: nothing may fire later by surprise.
      case "runnerJobs":
        return { code: "not_moved", detail: "pending runner work does not move" };
      // A local project has no GitHub link; the App connects one later.
      case "projectRepos":
        return doc.githubRepoId === null && doc.installationId === null
          ? null
          : {
              code: "github_link",
              detail: "a moved repository names no GitHub repository or installation",
            };
      // Objects live under the moved project's own keys, nowhere else.
      case "blobs":
        return objectKey(doc.key, () => projectBlobKey(row.projectId, doc.sha256 as string));
      case "eventArchives":
        return objectKey(doc.key, () =>
          eventArchiveKey({
            projectId: row.projectId,
            sessionId: doc.sessionId as string,
            firstSequence: doc.firstSequence as number,
            lastSequence: doc.lastSequence as number,
          }),
        );
      // A local comment or signal always has its ticket (a cascading foreign key).
      case "ticketComments":
      case "ticketSignals":
        return (await referenced("tickets", doc.ticketId as string)) === null
          ? { code: "missing_reference", detail: "ticketId names no ticket of the moved project" }
          : null;
      // The only audit rows a local profile has are its MCP operations.
      case "auditLog":
        return typeof doc.kind === "string" &&
          doc.kind.startsWith("mcp_") &&
          doc.targetKind === "mcp_server"
          ? null
          : { code: "not_moved", detail: "only MCP operation audit rows move" };
      default:
        return null;
    }
  };

  const visibilityProblem = async (doc: Row): Promise<boolean> => {
    // Any other role is the schema's to refuse.
    if (doc.role === "ticket" || doc.role === "project") {
      const born = sessionVisibilityAtCreation(
        { role: doc.role as "ticket" | "project" },
        doc.createdAt as number,
      );
      return doc.visibility !== born.visibility || doc.visibilityReason !== born.visibilityReason;
    }
    if (doc.role !== "subagent") return false;
    if (doc.visibilityReason !== "inherited") return true;
    if (typeof doc.parentSessionId !== "string") return false;
    const parent = await db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", doc.parentSessionId as string))
      .unique();
    // A subagent follows its parent when the parent came along.
    return parent !== null && parent.projectId === row.projectId
      ? parent.visibility !== doc.visibility
      : false;
  };

  return {
    owns,
    async foreign(stream, existing) {
      const projectId =
        stream === "auditLog"
          ? (((existing.detail as Row | null)?.projectId as string | undefined) ?? null)
          : await scope.of(stream, existing);
      const workspaceId =
        stream === "auditLog" || stream === "projects"
          ? existing.workspaceId
          : await scope.workspaceOf(projectId);
      return workspaceId === row.workspaceId
        ? { code: "conflict", detail: "another project holds this row" }
        : { code: "already_migrated", detail: "another Workspace holds this row" };
    },
    outside: {
      code: "outside_project",
      detail: "it does not belong to the project this move imports",
    },
    async check(stream, doc): Promise<Omit<RowFailure, "index"> | null> {
      const refusal = await streamRule(stream, doc);
      if (refusal !== null) return refusal;
      const identity = foreignIdentity(doc, target);
      if (identity !== null) {
        return {
          code: "foreign_identity",
          detail: `${identity} names someone other than the importer, their runner or the target Workspace`,
        };
      }
      const reference = await references(doc);
      if (reference !== null) {
        return { code: "outside_project", detail: `${reference} names a row of another project` };
      }
      if (stream === "sessions" && (await visibilityProblem(doc))) {
        return {
          code: "invalid_visibility",
          detail: "visibility is not what the Session's role decides",
        };
      }
      return null;
    },
    stamp(stream, doc) {
      return stream === "projects" ? { ...doc, moveState: "importing" } : doc;
    },
    inserted(_stream, rowDigest) {
      accumulator.add(rowDigest);
    },
  };
}

/**
 * Writes one batch (≤ the client's 200 rows / 3 MiB) of one stream into the
 * hidden project, through the import core the dry run shares. Answers what
 * each row did, plus the stream's accumulator after the batch. Any
 * `conflict` or `rejected` row is a row that did not land: the client stops
 * the move.
 */
export const importRows = mutation({
  args: { moveId: v.string(), stream: streamValidator, rows: v.array(v.any()) },
  handler: async (
    ctx,
    { moveId, stream, rows },
  ): Promise<ImportRowsResult & { accumulated: { count: number; digest: string } }> => {
    const { row } = await requireImporter(ctx, moveId);
    if (!OPEN.has(row.status)) {
      throw importError("import_closed", "This move no longer takes rows.", { status: row.status });
    }
    if (rows.length > IMPORT_BATCH_MAX_ROWS) {
      throw importError("invalid_argument", `A batch holds at most ${IMPORT_BATCH_MAX_ROWS} rows.`);
    }
    await requireOwnRunner(ctx, row.userId, row.runnerId);
    const stored = await ctx.db
      .query("projectImportStreams")
      .withIndex("by_move_stream", (q) => q.eq("moveId", row.id).eq("stream", stream))
      .unique();
    if (stored === null) throw new Error(`Move ${row.id} has no ${stream} accumulator.`);
    // Only inserted rows are added, in this same transaction: a re-sent row
    // answers `unchanged` and adds nothing.
    const accumulator = MigrationDigest.resume(stored.count, stored.digest);
    const result = await importBatch(
      ctx,
      { target: targetOf(row), stream, rows },
      personPolicy(ctx.db, row, accumulator),
    );
    const accumulated = { count: accumulator.count, digest: accumulator.value };
    if (result.inserted > 0) {
      await ctx.db.patch(stored._id, accumulated);
      await ctx.db.patch(row._id, { status: "importing", updatedAt: Date.now() });
    }
    return { ...result, accumulated };
  },
});

// ── commit, uncommit, abort ──────────────────────────────────────────────────

/**
 * Shows the imported project, in one transaction, only when every stream's
 * accumulator equals the manifest's promise (count and digest) and the
 * manifest is the one the move began with. Anything else refuses with
 * `verification_failed`, naming the streams (counts, never content), and
 * changes nothing. Idempotent: a committed move answers `committed`.
 */
export const commit = mutation({
  args: { moveId: v.string(), manifestSha256: v.string() },
  handler: async (ctx, { moveId, manifestSha256 }) => {
    const { viewer, row } = await requireImporter(ctx, moveId);
    if (row.status === "committed") return { status: row.status };
    if (!OPEN.has(row.status)) {
      throw importError("import_closed", "This move was cancelled.", { status: row.status });
    }
    if (manifestSha256 !== row.manifestSha256) {
      throw importError("manifest_mismatch", "This is not the manifest the move began with.");
    }
    const streams = await streamRows(ctx.db, row.id);
    const mismatched = streams
      .filter(
        (stream) =>
          stream.count !== stream.expectedCount || stream.digest !== stream.expectedDigest,
      )
      .map((stream) => ({
        stream: stream.stream,
        expectedCount: stream.expectedCount,
        count: stream.count,
        digestMatches: stream.digest === stream.expectedDigest,
      }));
    if (streams.length !== MIGRATION_IMPORT_STREAMS.length || mismatched.length > 0) {
      throw importError(
        "verification_failed",
        "What arrived does not match the manifest; nothing was shown.",
        { streams: mismatched },
      );
    }
    const project = await ctx.db
      .query("projects")
      .withIndex("by_uuid", (q) => q.eq("id", row.projectId))
      .unique();
    if (
      project === null ||
      project.moveState !== "importing" ||
      project.workspaceId !== row.workspaceId ||
      project.deletedAt !== null
    ) {
      throw importError("verification_failed", "The imported project is missing.", {
        streams: [],
      });
    }
    const counter = await ctx.db
      .query("projectCounters")
      .withIndex("by_project", (q) => q.eq("projectId", row.projectId))
      .unique();
    const now = Date.now();
    await ctx.db.patch(project._id, { moveState: null });
    await ctx.db.patch(row._id, {
      status: "committed",
      updatedAt: now,
      committedAt: now,
      committedBoardSeq: counter?.boardSeq ?? 0,
    });
    await audit(ctx, {
      workspaceId: row.workspaceId,
      actor: personActor(viewer),
      kind: "project.imported",
      targetKind: "project",
      targetId: row.projectId,
      at: now,
      detail: {
        moveId: row.id,
        rows: streams.reduce((total, stream) => total + stream.count, 0),
      },
    });
    return { status: "committed" as ImportStatus };
  },
});

/**
 * Hides a committed project again, for a roll back (then {@link abort}).
 * Refuses with `changed_since_commit` when its board or any of its Sessions
 * moved since the commit, unless `confirmChanged`: those changes are lost
 * with the purge. Idempotent: a hidden move answers its status.
 */
export const uncommit = mutation({
  args: { moveId: v.string(), confirmChanged: v.optional(v.boolean()) },
  handler: async (ctx, { moveId, confirmChanged }) => {
    const { viewer, row } = await requireImporter(ctx, moveId);
    if (OPEN.has(row.status)) return { status: row.status };
    if (row.status !== "committed") {
      throw importError("import_closed", "This move was cancelled.", { status: row.status });
    }
    const project = await ctx.db
      .query("projects")
      .withIndex("by_uuid", (q) => q.eq("id", row.projectId))
      .unique();
    if (project === null || project.deletedAt !== null || project.workspaceId !== row.workspaceId) {
      throw importError("import_closed", "The project is no longer where this move put it.");
    }
    const counter = await ctx.db
      .query("projectCounters")
      .withIndex("by_project", (q) => q.eq("projectId", row.projectId))
      .unique();
    const boardChanges = (counter?.boardSeq ?? 0) - (row.committedBoardSeq ?? 0);
    const committedAt = row.committedAt ?? 0;
    const sessionActive =
      (await ctx.db
        .query("sessions")
        .withIndex("by_project_activity", (q) =>
          q.eq("projectId", row.projectId).gt("lastActivityAt", committedAt),
        )
        .first()) !== null;
    if ((boardChanges !== 0 || sessionActive) && confirmChanged !== true) {
      throw importError(
        "changed_since_commit",
        "The project changed in Volli Cloud since the move; rolling back loses those changes.",
        { boardChanges, sessionActive },
      );
    }
    const now = Date.now();
    await ctx.db.patch(project._id, { moveState: "importing" });
    await ctx.db.patch(row._id, {
      status: "importing",
      updatedAt: now,
      committedAt: null,
      committedBoardSeq: null,
      // Others may have written there while it was shown: no more read-back.
      uncommittedAt: now,
    });
    await audit(ctx, {
      workspaceId: row.workspaceId,
      actor: personActor(viewer),
      kind: "project.import_uncommitted",
      targetKind: "project",
      targetId: row.projectId,
      at: now,
      detail: { moveId: row.id, boardChanges, sessionActive },
    });
    return { status: "importing" as ImportStatus };
  },
});

/**
 * Cancels a move that is not committed (uncommit a committed one first): the
 * import becomes `aborting` and takes no more rows; its project stays hidden.
 *
 * The purge itself (every row the import wrote, by index, in bounded
 * batches, then the `v1/p/<projectId>/` and `v1/m/<moveId>/` objects, ending
 * `purged`) is a scheduled chain that is NOT built yet. Idempotent.
 */
export const abort = mutation({
  args: { moveId: v.string() },
  handler: async (ctx, { moveId }) => {
    const { row } = await requireImporter(ctx, moveId);
    if (row.status === "aborting" || row.status === "purged") return { status: row.status };
    if (row.status === "committed") {
      throw importError("import_committed", "Roll the committed move back (uncommit) first.");
    }
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "aborting", updatedAt: now, abortedAt: now });
    return { status: "aborting" as ImportStatus };
  },
});

// ── reads ────────────────────────────────────────────────────────────────────

/** The move and every stream's promise and accumulator, for its importer. */
export const status = query({
  args: { moveId: v.string() },
  handler: async (ctx, { moveId }) => {
    const { row } = await requireImporter(ctx, moveId);
    return describe(ctx.db, row);
  },
});

type Level = "project" | "ticket" | "session";

/** Where each stream's rows are read back from: the project, one ticket, or one Session. */
const LEVEL: Readonly<Record<MigrationImportStream, Level>> = {
  projects: "project",
  projectCounters: "project",
  projectRepos: "project",
  projectEnvironment: "project",
  configEntries: "project",
  memberProjectPrefs: "project",
  projectCheckouts: "project",
  labels: "project",
  tickets: "project",
  ticketBodies: "ticket",
  boardEvents: "project",
  ticketComments: "ticket",
  ticketSignals: "ticket",
  blobs: "project",
  blobLinks: "project",
  automations: "project",
  automationRuns: "project",
  automationArmings: "project",
  automationColumnOrder: "project",
  runnerJobs: "project",
  sessions: "project",
  sessionEvents: "session",
  eventArchives: "session",
  sessionIntake: "session",
  delegations: "session",
  sessionGrants: "session",
  delegationExtensions: "session",
  workingCopies: "project",
  readMarkers: "session",
  auditLog: "project",
};

/** The index range that holds a stream's rows for one project, ticket or Session. */
function readRange(
  row: ImportRow,
  stream: MigrationImportStream,
  parentId: string,
): { index: string; eq: Array<[string, unknown]>; keep?: (doc: Row) => boolean } {
  const projectId = row.projectId;
  switch (stream) {
    case "projects":
      return { index: "by_uuid", eq: [["id", projectId]] };
    case "configEntries":
      return { index: "by_scope_kind_name", eq: [["scopeKey", `p:${projectId}`]] };
    case "labels":
      return { index: "by_project_name_key", eq: [["projectId", projectId]] };
    case "tickets":
      return { index: "by_project_number", eq: [["projectId", projectId]] };
    case "boardEvents":
      return { index: "by_project_seq", eq: [["projectId", projectId]] };
    case "blobs":
      return { index: "by_project_sha", eq: [["projectId", projectId]] };
    case "blobLinks":
      return { index: "by_blob", eq: [["projectId", projectId]] };
    case "automations":
      return { index: "by_project_name", eq: [["projectId", projectId]] };
    case "automationArmings":
    case "automationColumnOrder":
      return { index: "by_project_status", eq: [["projectId", projectId]] };
    case "sessions":
      return { index: "by_project_activity", eq: [["projectId", projectId]] };
    // No project index: the runner's rows, kept when they are this project's.
    case "runnerJobs":
      return {
        index: "by_runner_ready",
        eq: [["runnerId", row.runnerId]],
        keep: (doc) => doc.projectId === projectId,
      };
    case "workingCopies":
      return {
        index: "by_runner",
        eq: [["runnerId", row.runnerId]],
        keep: (doc) => doc.projectId === projectId,
      };
    case "auditLog":
      return {
        index: "by_workspace_at",
        eq: [["workspaceId", row.workspaceId]],
        keep: (doc) => (doc.detail as Row | null)?.projectId === projectId,
      };
    case "projectCounters":
    case "projectRepos":
    case "projectEnvironment":
    case "memberProjectPrefs":
    case "projectCheckouts":
    case "automationRuns":
      return { index: "by_project", eq: [["projectId", projectId]] };
    case "ticketBodies":
    case "ticketComments":
      return { index: "by_ticket", eq: [["ticketId", parentId]] };
    case "ticketSignals":
      return { index: "by_ticket_kind", eq: [["ticketId", parentId]] };
    case "sessionEvents":
      return { index: "by_session_sequence", eq: [["sessionId", parentId]] };
    case "eventArchives":
      return { index: "by_session_first", eq: [["sessionId", parentId]] };
    case "sessionIntake":
      return { index: "by_session", eq: [["sessionId", parentId]] };
    case "sessionGrants":
      return { index: "by_session_verb", eq: [["sessionId", parentId]] };
    case "delegations":
      return { index: "by_child", eq: [["childSessionId", parentId]] };
    case "delegationExtensions":
      return { index: "by_parent_call", eq: [["parentSessionId", parentId]] };
    case "readMarkers":
      return {
        index: "by_user_session",
        eq: [
          ["userId", row.userId],
          ["sessionId", parentId],
        ],
      };
  }
}

/**
 * One page of one stream's rows in the moved project, without Convex's own
 * fields, for the client's count-and-digest verification. A project-level
 * stream is read by the project's index; a ticket's (`ticketBodies`,
 * `ticketComments`, `ticketSignals`) or a Session's (events, intake, grants,
 * delegations, extensions, archives, read markers) by `parentId`, which must
 * be a ticket or Session of the moved project. A page may hold fewer rows
 * than asked for (`runnerJobs`, `workingCopies` and `auditLog` are read
 * through the runner or Workspace and keep only this project's).
 */
export const readRows = query({
  args: {
    moveId: v.string(),
    stream: streamValidator,
    parentId: v.optional(nullable(v.string())),
    cursor: nullable(v.string()),
    numItems: v.number(),
    maximumBytesRead: v.optional(v.number()),
  },
  handler: async (ctx, { moveId, stream, parentId, cursor, numItems, maximumBytesRead }) => {
    const { row } = await requireImporter(ctx, moveId);
    // Only what the import alone wrote: once the project has been shown,
    // others may have written there (a private Session, say), which the
    // importer reads only through the public reads that check visibility.
    if (!OPEN.has(row.status) || row.uncommittedAt !== null) {
      throw importError("import_closed", "This move no longer reads back.", {
        status: row.status,
      });
    }
    const level = LEVEL[stream];
    let parent = "";
    if (level !== "project") {
      const scope = new ProjectScope(ctx.db);
      const owner =
        level === "ticket"
          ? await scope.ticketProject(parentId)
          : await scope.sessionProject(parentId);
      const session =
        level === "session" && owner === row.projectId
          ? await ctx.db
              .query("sessions")
              .withIndex("by_uuid", (q) => q.eq("id", parentId!))
              .unique()
          : null;
      if (owner !== row.projectId || (level === "session" && session?.ownerUserId !== row.userId)) {
        throw new ConvexError({ code: "not_found", message: `That ${level} is not in this move.` });
      }
      parent = parentId!;
    }
    const range = readRange(row, stream, parent);
    const items = Math.min(Math.max(Math.floor(numItems), 1), READ_BACK_MAX_ITEMS);
    const page = await (ctx.db.query(stream) as any)
      .withIndex(range.index, (q: any) =>
        range.eq.reduce((acc: any, [field, value]) => acc.eq(field, value), q),
      )
      .paginate({
        cursor,
        numItems: items,
        ...(maximumBytesRead === undefined ? {} : { maximumBytesRead }),
      });
    const rows = (page.page as Row[])
      .map(withoutSystemFields)
      .filter((doc) => range.keep?.(doc) ?? true);
    return { rows, continueCursor: page.continueCursor as string, isDone: page.isDone as boolean };
  },
});
