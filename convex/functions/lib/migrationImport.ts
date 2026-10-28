/**
 * The import core both migration doors share: the internal `migration.*`
 * functions the dry run calls with the admin key, and the person-authorized
 * `projectImports.*` a move to Volli Cloud calls with the person's sign-in.
 *
 * One batch of one export stream is written by {@link importBatch}: each
 * record is mapped by `migrationDocument` from `@volli/shared/cloud` (the
 * function the client applies on its side too), then looked up by its key:
 * a new row is inserted, an existing row with the same digest is left alone
 * (`unchanged`), and an existing row with a different digest, or one that
 * belongs somewhere else, is reported as a conflict and never overwritten. A
 * re-sent batch is therefore idempotent.
 *
 * What a door adds is an {@link ImportPolicy}: where a row must belong, any
 * further per-row checks, and what to do with each inserted document (the
 * person-authorized door stamps a project's `moveState` and adds every
 * inserted row's digest to its per-stream accumulator).
 *
 * Reports name fields and codes, never values: an import report must be
 * safe to paste.
 */

import type { GenericDatabaseReader } from "convex/server";

import {
  MigrationRowError,
  migrationDocument,
  migrationRowDigest,
  type MigrationImportStream,
  type MigrationTarget,
} from "@volli/shared/cloud";

import type { DataModel } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";

export type Reader = GenericDatabaseReader<DataModel>;
export type Row = Record<string, unknown>;

export type Key = { index: string; fields: readonly string[]; alsoMatch?: readonly string[] };

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

/** A refusal of one row, by its index in the batch. Code and detail never carry a value. */
export type RowFailure = { index: number; code: string; detail: string };

/** What one batch did, row by row. */
export type ImportRowsResult = {
  inserted: number;
  unchanged: number;
  conflicts: RowFailure[];
  rejected: RowFailure[];
};

export function withoutSystemFields(doc: Row): Row {
  const { _id: _ignoredId, _creationTime: _ignoredTime, ...rest } = doc;
  return rest;
}

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
export class ProjectScope {
  private readonly projects = new Map<string, Row | null>();
  private readonly sessions = new Map<string, string | null>();
  private readonly tickets = new Map<string, string | null>();

  constructor(private readonly db: Reader) {}

  /** The project row `projectId` names, or `null`. */
  async project(projectId: string | null): Promise<Row | null> {
    if (projectId === null) return null;
    if (!this.projects.has(projectId)) {
      const project = await this.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", projectId))
        .unique();
      this.projects.set(projectId, project);
    }
    return this.projects.get(projectId) ?? null;
  }

  /** The Workspace `projectId` is in, or `null` when there is no such project. */
  async workspaceOf(projectId: string | null): Promise<string | null> {
    const project = await this.project(projectId);
    return project === null ? null : (project.workspaceId as string);
  }

  /** The project a Session is in, or `null`. */
  async sessionProject(sessionId: unknown): Promise<string | null> {
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

  /** The project a ticket is in, or `null`. */
  async ticketProject(ticketId: unknown): Promise<string | null> {
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

  /**
   * The owning project of a row (a project's own id for `projects`). An
   * audit row names none; the person-authorized import reads the project its
   * `detail` names instead.
   */
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
}

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

/** What a door decides about the rows of one batch. */
export interface ImportPolicy {
  /** Whether a row (`stored`, or about to be inserted) belongs where this import writes. */
  owns(stream: MigrationImportStream, doc: Row, stored: boolean): Promise<boolean>;
  /** The conflict a stored row that this import does not own is reported as. */
  foreign(stream: MigrationImportStream, existing: Row): Promise<Omit<RowFailure, "index">>;
  /** The refusal of a new row this import does not own. */
  outside: Omit<RowFailure, "index">;
  /** Further checks on a new row this import owns: a refusal, or `null` to insert it. */
  check?(stream: MigrationImportStream, doc: Row): Promise<Omit<RowFailure, "index"> | null>;
  /** The document as inserted (fields only this door sets, never digested). */
  stamp?(stream: MigrationImportStream, doc: Row): Row;
  /** Called once per inserted row, with the row's digest. */
  inserted?(stream: MigrationImportStream, rowDigest: string): void;
}

/** Writes one batch of `stream`. Rows are independent: one refusal does not stop the rest. */
export async function importBatch(
  ctx: Pick<MutationCtx, "db">,
  input: { target: MigrationTarget; stream: MigrationImportStream; rows: readonly unknown[] },
  policy: ImportPolicy,
): Promise<ImportRowsResult> {
  const { target, stream, rows } = input;
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
      const stored = withoutSystemFields(existing);
      // A row with this key held somewhere else came from another copy of the
      // profile, or another project: refused, however alike it is.
      if (!(await policy.owns(stream, stored, true))) {
        result.conflicts.push({ index, ...(await policy.foreign(stream, stored)) });
        continue;
      }
      const same = migrationRowDigest(stream, stored) === migrationRowDigest(stream, doc);
      if (same) result.unchanged += 1;
      else
        result.conflicts.push({
          index,
          code: "conflict",
          detail: "a different row has this key",
        });
      continue;
    }
    if (!(await policy.owns(stream, doc, false))) {
      result.rejected.push({ index, ...policy.outside });
      continue;
    }
    const refusal = policy.check === undefined ? null : await policy.check(stream, doc);
    if (refusal !== null) {
      result.rejected.push({ index, ...refusal });
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
      await ctx.db.insert(stream, (policy.stamp?.(stream, doc) ?? doc) as never);
    } catch (error) {
      result.rejected.push({ index, code: "schema", detail: schemaDetail(error) });
      continue;
    }
    result.inserted += 1;
    policy.inserted?.(stream, migrationRowDigest(stream, doc));
  }
  return result;
}
