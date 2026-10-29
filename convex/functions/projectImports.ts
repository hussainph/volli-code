/**
 * A person-authorized import of one local project into a Workspace: the
 * backend half of "Move to Volli Cloud". The client (the move engine) calls
 * these with the person's own sign-in. Only {@link rescue}, the internal
 * deployment-operator recovery door, takes deployment-admin authority.
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
 * - {@link abort} marks the import `aborting` and starts the purge
 *   (`projectImportPurge.ts`): a scheduled chain that deletes its rows, then
 *   its objects (`v1/p/<projectId>/`, `v1/m/<moveId>/`), and ends `purged`.
 *   Until then the project stays hidden and cannot be moved again
 *   (`import_in_progress`); once purged it can.
 * - {@link presignPut} signs one write-once PUT of an object the move
 *   carries, to its final key under the project's prefix (or the move's own
 *   staging prefix), bound to its exact length and SHA-256.
 * - A moved Session's transcript packs and Pi log ranges are committed
 *   through the import's own doors, and every moved Session is folded after
 *   the commit (`projectImportHistory.ts`).
 * - {@link status} and {@link readRows} are the importer's own reads: the
 *   accumulators, and a project-scoped read-back (by project, ticket or
 *   Session index) for the client's verification. They read through the
 *   import, not through `projectAccess`, which hides the project, and only
 *   while nothing but the import has written there (before any commit), so
 *   they never show the importer what someone else wrote.
 *
 * Who may import: the person who began the move (or its operator-assigned
 * driver), while they are an owner or
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
  parseId,
  presignS3Request,
  projectBlobKey,
  sessionVisibilityAtCreation,
  sha256ChecksumHeader,
  type MigrationImportStream,
  type MigrationTarget,
  type PresignedS3Request,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel.js";
import {
  // `rescue` takes an argument named `action`.
  action as publicAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server.js";
import { audit } from "./lib/audit";
import {
  requireManage,
  requireProject,
  requireViewer,
  requireWorkspace,
  type Viewer,
} from "./lib/auth";
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
import { moveObjectKeyProblem, moveObjectMaxBytes } from "./lib/moveObjectKeys";
import { PRESIGN_EXPIRES_SECONDS, objectStoreConfig } from "./lib/objectStore";
import { literals, nullable } from "./lib/validators";
import { personActor } from "./lib/workspaces";
import { hasLivePreviewAccess } from "./lib/previewAccess";
import { purgeStalled, schedulePurge } from "./projectImportPurge";

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
  | "changed_since_commit"
  | "invalid_rescue_target"
  | "invalid_key"
  | "storage_unconfigured"
  | "stale_claim";

export function importError(
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
export const OPEN: ReadonlySet<ImportStatus> = new Set(["reserved", "importing"]);
/** Statuses that hold the project id: another move of it waits (or is refused). */
const HOLDING: ReadonlySet<ImportStatus> = new Set(["reserved", "importing", "aborting"]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The most rows one read-back page returns. */
const READ_BACK_MAX_ITEMS = 500;

/** The most rows one `importRows` batch takes (the client sends at most 200). */
const IMPORT_BATCH_MAX_ROWS = 500;

const streamValidator = literals(MIGRATION_IMPORT_STREAMS);

// ── who ──────────────────────────────────────────────────────────────────────

/** The authorized driver; old moves default to the person and runner they began with. */
export function driverOf(row: ImportRow) {
  return row.driver ?? { userId: row.userId, runnerId: row.runnerId };
}

/**
 * The importing person and their import: the caller must be its current
 * driver (anyone else reads `not_found`, so a move id says nothing), still
 * an owner or admin of its Workspace, with live preview access.
 */
export async function requireImporter(
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
  if (row === null || driverOf(row).userId !== viewer.userId) {
    throw new ConvexError({ code: "not_found", message: "That move does not exist." });
  }
  await requireManage(ctx, row.workspaceId, "settings");
  return { viewer, row };
}

/** The importer's runner, still theirs and not revoked. */
export async function requireOwnRunner(ctx: QueryCtx, userId: string, runnerId: string) {
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
    // Resume verification using the ORIGINAL mapping, not the new driver.
    importTarget: targetOf(row),
    driver: driverOf(row),
    manifestSha256: row.manifestSha256,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    committedAt: row.committedAt,
    abortedAt: row.abortedAt,
    purgedAt: row.purgedAt ?? null,
    // How far an aborted move's purge got: counts and a code, never content.
    purge:
      row.purge === undefined
        ? null
        : {
            phase: row.purge.phase,
            rows: row.purge.rows,
            objects: row.purge.objects,
            objectsSkipped: row.purge.objectsSkipped,
            error: row.purge.error?.code ?? null,
            restarts: row.purge.restarts,
          },
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
  // Older move clients archived all schedules and therefore promised no schedule stream.
  if (!byStream.has("automationSchedules")) {
    byStream.set("automationSchedules", {
      stream: "automationSchedules",
      count: 0,
      digest: new MigrationDigest().value,
    });
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
        driverOf(existing).userId === viewer.userId &&
        existing.projectId === args.projectId &&
        existing.workspaceId === args.workspaceId &&
        driverOf(existing).runnerId === args.runnerId &&
        existing.manifestSha256 === args.manifestSha256 &&
        (streams.length === expected.size ||
          (streams.length === expected.size - 1 &&
            !streams.some((stream) => stream.stream === "automationSchedules") &&
            expected.get("automationSchedules")!.count === 0)) &&
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
    const driver = driverOf(row);
    await requireOwnRunner(ctx, driver.userId, driver.runnerId);
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

/** Still-paused moved records for the result screen; re-arm uses the ordinary
 * receipt-backed automations.arm / armSchedule doors with this Mac's runner.
 * Receiving-task contract (VC-998, not yet wired here): its move-result bridge
 * must query api.projectImports.rearmList({moveId}) under the current account
 * after commit. Display columns/schedules with per-item Re-arm on this Mac:
 * api.automations.arm({commandId: UUID, projectId, status, automationId, runnerId})
 * or api.automations.armSchedule({commandId: UUID, automationId, runnerId}).
 * runnerId must be the live account-bound full MacRunner advertising automation.run,
 * never the registration-only import runner. Inert globals have no action. */
export const rearmList = query({
  args: { moveId: v.string() },
  handler: async (ctx, { moveId }) => {
    const { viewer, row } = await requireImporter(ctx, moveId);
    if (row.status !== "committed")
      throw importError("import_closed", "Finish importing before re-arming Automations.");
    await requireProject(ctx, row.projectId, viewer);
    const columns: Array<{
      automationId: string;
      name: string;
      status: Doc<"automationArmings">["status"];
    }> = [];
    const schedules: Array<{ automationId: string; name: string }> = [];
    const arms = await ctx.db
      .query("automationArmings")
      .withIndex("by_project_status", (q) => q.eq("projectId", row.projectId))
      .collect();
    const automations = await ctx.db
      .query("automations")
      .withIndex("by_project_name", (q) => q.eq("projectId", row.projectId))
      .collect();
    const byId = new Map(automations.map((automation) => [automation.id, automation]));
    for (const arm of arms) {
      const automation = byId.get(arm.automationId);
      if (
        automation !== undefined &&
        automation.deletedAt === null &&
        arm.pausedAt != null &&
        arm.pausedReason === "moved"
      ) {
        columns.push({ automationId: automation.id, name: automation.name, status: arm.status });
      }
    }
    for (const automation of automations) {
      if (automation.deletedAt !== null) continue;
      const schedule = await ctx.db
        .query("automationSchedules")
        .withIndex("by_automation", (q) => q.eq("automationId", automation.id))
        .unique();
      if (schedule?.pausedAt != null && schedule.pausedReason === "moved") {
        schedules.push({ automationId: automation.id, name: automation.name });
      }
    }
    // Global definitions are carried by the profile step, not project records.
    // They remain inert personal configuration, including entries from earlier
    // profile moves. Never return their Instructions or offer them a re-arm.
    const personal = await ctx.db
      .query("configEntries")
      .withIndex("by_scope_kind_name", (q) =>
        q.eq("scopeKey", `u:${viewer.userId}`).eq("kind", "automation"),
      )
      .collect();
    const inertGlobals = personal
      .filter(
        (entry) =>
          entry.level === "personal" &&
          entry.userId === viewer.userId &&
          entry.projectId === null &&
          entry.workspaceId === null,
      )
      .map(({ id, name }) => ({ id, name }));
    return { projectId: row.projectId, columns, schedules, inertGlobals };
  },
});

// ── commit, uncommit, abort ──────────────────────────────────────────────────

/**
 * Shows the imported project, in one transaction, only when every stream's
 * accumulator equals the manifest's promise (count and digest) and the
 * manifest is the one the move began with. Anything else refuses with
 * `verification_failed`, naming the streams (counts, never content), and
 * changes nothing. Idempotent: a committed move answers `committed` (and
 * restarts the first fold of any moved Session that stopped short).
 */
export const commit = mutation({
  args: { moveId: v.string(), manifestSha256: v.string() },
  handler: async (ctx, { moveId, manifestSha256 }) => {
    const { viewer, row } = await requireImporter(ctx, moveId);
    if (row.status === "committed") {
      // Sent again: any moved Session whose first fold stopped is folded again.
      await ctx.scheduler.runAfter(0, internal.projectImportHistory.foldMoved, {
        moveId: row.id,
        cursor: null,
      });
      return { status: row.status };
    }
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
    const present = new Set(streams.map((stream) => stream.stream));
    // An in-flight move begun by the previous backend has no schedule accumulator.
    const missing = MIGRATION_IMPORT_STREAMS.filter(
      (stream) => stream !== "automationSchedules" && !present.has(stream),
    );
    const expectedLength =
      MIGRATION_IMPORT_STREAMS.length - (present.has("automationSchedules") ? 0 : 1);
    if (streams.length !== expectedLength || missing.length > 0 || mismatched.length > 0) {
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
    // Every moved Session folds now that its project is shown (`projectImportHistory.ts`).
    await ctx.scheduler.runAfter(0, internal.projectImportHistory.foldMoved, {
      moveId: row.id,
      cursor: null,
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
 * import becomes `aborting`, takes no more rows, and its purge starts
 * (`projectImportPurge.ts`): every row it wrote (and anything the backend
 * derived there while it was shown), then its objects, ending `purged`. The
 * project stays hidden until it is gone.
 *
 * Idempotent. Called again while `aborting`, it restarts a purge that failed,
 * stopped or stalled; `status` shows how far it got.
 */
export const abort = mutation({
  args: { moveId: v.string() },
  handler: async (ctx, { moveId }) => {
    const { viewer, row } = await requireImporter(ctx, moveId);
    if (row.status === "purged") return { status: row.status };
    if (row.status === "aborting") {
      // A purge that failed, stopped or stalled starts again under a new run.
      if (row.purge?.error != null || purgeStalled(row, Date.now())) {
        await schedulePurge(ctx, row, "person");
      }
      return { status: row.status };
    }
    if (row.status === "committed") {
      throw importError("import_committed", "Roll the committed move back (uncommit) first.");
    }
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "aborting", updatedAt: now, abortedAt: now });
    await audit(ctx, {
      workspaceId: row.workspaceId,
      actor: personActor(viewer),
      kind: "project.import_aborted",
      targetKind: "project",
      targetId: row.projectId,
      at: now,
      detail: { moveId: row.id },
    });
    await schedulePurge(ctx, row, "person");
    return { status: "aborting" as ImportStatus };
  },
});

// ── operator rescue ──────────────────────────────────────────────────────────

/**
 * Deployment admins only (`convex run projectImports:rescue`). This is NOT a
 * Workspace-admin API. Abort a stranded move, or authorize a replacement
 * owner/admin and their runner to drive it. Committed moves must first be
 * uncommitted by their driver; an aborting move cannot be reassigned.
 *
 * Reassignment deliberately preserves userId/runnerId, every imported row,
 * and the manifest's digests. They describe the original export, not whoever
 * uploads it next. The operator is explicitly granting the replacement
 * access to the hidden import, including its original person's history.
 */
export const rescue = internalMutation({
  args: {
    moveId: v.string(),
    action: v.union(
      v.object({ kind: v.literal("abort") }),
      v.object({ kind: v.literal("reassign"), userId: v.string(), runnerId: v.string() }),
    ),
  },
  handler: async (ctx, { moveId, action }) => {
    const row = isUuid(moveId)
      ? await ctx.db
          .query("projectImports")
          .withIndex("by_uuid", (q) => q.eq("id", moveId))
          .unique()
      : null;
    if (row === null) {
      throw new ConvexError({ code: "not_found", message: "That move does not exist." });
    }
    await requireWorkspace(ctx, row.workspaceId);
    if (row.status === "committed") {
      throw importError("import_committed", "Only the move's driver can uncommit it first.");
    }
    if (row.status === "purged" || (action.kind === "reassign" && !OPEN.has(row.status))) {
      throw importError("import_closed", "This move is closed.");
    }

    const previousDriver = driverOf(row);
    const now = Date.now();
    if (action.kind === "abort") {
      await ctx.db.patch(row._id, {
        status: "aborting",
        updatedAt: now,
        abortedAt: row.abortedAt ?? now,
      });
      // The purge starts at once (`projectImportPurge.ts`), or restarts under a
      // new run when the move was already aborting.
      await schedulePurge(ctx, row, "person");
    } else {
      if (!isUuid(action.userId) || !isUuid(action.runnerId)) {
        throw importError(
          "invalid_argument",
          "The replacement person and runner need canonical UUIDs.",
        );
      }
      const user = await ctx.db
        .query("users")
        .withIndex("by_uuid", (q) => q.eq("id", action.userId))
        .unique();
      if (user === null || user.status !== "active" || !(await hasLivePreviewAccess(ctx, user))) {
        throw importError(
          "invalid_rescue_target",
          "The replacement must be an active owner/admin of this Workspace with live preview access.",
        );
      }
      await requireManage(ctx, row.workspaceId, "settings", {
        userId: parseId("user", user.id),
        user,
      });
      await requireOwnRunner(ctx, action.userId, action.runnerId);
      await ctx.db.patch(row._id, {
        driver: { userId: action.userId, runnerId: action.runnerId },
        updatedAt: now,
      });
    }
    await audit(ctx, {
      workspaceId: row.workspaceId,
      // Admin-key invocations have no person identity: never attribute the
      // operator's decision to the importer who lost access.
      actor: { kind: "volli", reason: "migration" },
      kind: action.kind === "abort" ? "project.import_rescue_aborted" : "project.import_reassigned",
      targetKind: "project",
      targetId: row.projectId,
      at: now,
      detail: {
        moveId: row.id,
        operatorAction: action.kind,
        previousStatus: row.status,
        previousDriver,
        ...(action.kind === "reassign"
          ? { driver: { userId: action.userId, runnerId: action.runnerId } }
          : {}),
      },
    });
    return { status: action.kind === "abort" ? ("aborting" as const) : row.status };
  },
});

// ── objects ──────────────────────────────────────────────────────────────────

/**
 * Checks one object PUT of an open move: its importer, the key (the move's
 * own, `moveObjectKeyProblem`), the length and the SHA-256.
 */
export const authorizeObjectPut = internalQuery({
  args: { moveId: v.string(), key: v.string(), bytes: v.number(), sha256: v.string() },
  handler: async (ctx, args): Promise<{ key: string }> => {
    const { row } = await requireImporter(ctx, args.moveId);
    if (!OPEN.has(row.status)) {
      throw importError("import_closed", "This move no longer takes objects.", {
        status: row.status,
      });
    }
    const driver = driverOf(row);
    await requireOwnRunner(ctx, driver.userId, driver.runnerId);
    if (!SHA256_HEX.test(args.sha256)) {
      throw importError("invalid_argument", "sha256 must be 64 lowercase hex digits.");
    }
    const problem = moveObjectKeyProblem(args.key, {
      moveId: row.id,
      projectId: row.projectId,
      sha256: args.sha256,
    });
    if (problem !== null) throw importError("invalid_key", problem);
    const max = moveObjectMaxBytes(args.key);
    if (!Number.isSafeInteger(args.bytes) || args.bytes < 1 || args.bytes > max) {
      throw importError("invalid_argument", `An object is 1 to ${max} bytes.`);
    }
    return { key: args.key };
  },
});

/**
 * A URL for one PUT of exactly `bytes` bytes hashing to `sha256`, to `key`,
 * valid for five minutes. The key must be one the move carries: under the
 * project's prefix (`v1/p/<projectId>/`: a blob at its own SHA-256, a
 * Session's history objects, a legacy archive) or the move's staging
 * (`v1/m/<moveId>/<part>`), the two prefixes a cancelled move's purge deletes.
 *
 * Write-once: the request carries `If-None-Match: *`, so the store refuses
 * (412) a key that already holds an object. A client resuming a move HEADs a
 * refused key and compares its checksum rather than writing it again.
 */
export const presignPut = publicAction({
  args: { moveId: v.string(), key: v.string(), bytes: v.number(), sha256: v.string() },
  handler: async (ctx, args): Promise<{ request: PresignedS3Request }> => {
    const { key } = await ctx.runQuery(internal.projectImports.authorizeObjectPut, args);
    const config = objectStoreConfig(process.env);
    if (config === null) {
      throw importError(
        "storage_unconfigured",
        "Object storage is not configured on this deployment.",
      );
    }
    const request = presignS3Request({
      ...config,
      method: "PUT",
      key,
      now: Date.now(),
      expiresSeconds: PRESIGN_EXPIRES_SECONDS,
      headers: {
        "content-length": String(args.bytes),
        "if-none-match": "*",
        "x-amz-checksum-sha256": sha256ChecksumHeader(args.sha256),
      },
    });
    return { request };
  },
});

/**
 * Checks one object read of an open move: its importer, and a key the move
 * itself writes (`moveObjectKeyProblem`; a blob's key names its own SHA-256).
 */
export const authorizeObjectRead = internalQuery({
  args: { moveId: v.string(), key: v.string() },
  handler: async (ctx, args): Promise<{ key: string }> => {
    const { row } = await requireImporter(ctx, args.moveId);
    if (!OPEN.has(row.status)) {
      throw importError("import_closed", "This move no longer reads its objects.", {
        status: row.status,
      });
    }
    const named = /\/b\/([0-9a-f]{64})$/.exec(args.key)?.[1] ?? "0".repeat(64);
    const problem = moveObjectKeyProblem(args.key, {
      moveId: row.id,
      projectId: row.projectId,
      sha256: named,
    });
    if (problem !== null) throw importError("invalid_key", problem);
    return { key: args.key };
  },
});

/**
 * A URL for one HEAD or GET of an object the move wrote, valid for five
 * minutes, while the move is open: how the client's verification reads back
 * what it uploaded (a HEAD asks for the stored SHA-256 checksum). Once the
 * project is shown, its objects are read through the window's own paths.
 */
export const presignRead = publicAction({
  args: { moveId: v.string(), key: v.string(), method: literals(["HEAD", "GET"] as const) },
  handler: async (ctx, args): Promise<{ request: PresignedS3Request }> => {
    const { key } = await ctx.runQuery(internal.projectImports.authorizeObjectRead, {
      moveId: args.moveId,
      key: args.key,
    });
    const config = objectStoreConfig(process.env);
    if (config === null) {
      throw importError(
        "storage_unconfigured",
        "Object storage is not configured on this deployment.",
      );
    }
    const request = presignS3Request({
      ...config,
      method: args.method,
      key,
      now: Date.now(),
      expiresSeconds: PRESIGN_EXPIRES_SECONDS,
      headers: args.method === "HEAD" ? { "x-amz-checksum-mode": "ENABLED" } : {},
    });
    return { request };
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
  automationSchedules: "project",
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
  db: Reader,
  row: ImportRow,
  stream: MigrationImportStream,
  parentId: string,
): {
  index: string;
  eq: Array<[string, unknown]>;
  keep?: (doc: Row) => boolean | Promise<boolean>;
} {
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
    case "automationSchedules": {
      const scope = new ProjectScope(db);
      return {
        index: "by_armer",
        eq: [["armedByUserId", row.userId]],
        keep: async (doc) => (await scope.automationProject(doc.automationId)) === projectId,
      };
    }
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
    const range = readRange(ctx.db, row, stream, parent);
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
    const rows: Row[] = [];
    for (const doc of (page.page as Row[]).map(withoutSystemFields)) {
      if (range.keep === undefined || (await range.keep(doc))) rows.push(doc);
    }
    return { rows, continueCursor: page.continueCursor as string, isDone: page.isDone as boolean };
  },
});
