/**
 * Every source the migration exporter reads, and how each row becomes Volli
 * Cloud records.
 *
 * A source is one ordered query over the snapshot plus a per-row mapper that
 * emits zero or more records into named streams. Two rules make the whole
 * export resumable and reproducible:
 *
 * - **Every query orders by a unique key.** The snapshot never changes, so
 *   the n-th row of a source is the same row on every run, and a resumed
 *   export skips exactly the rows it already wrote (`exporter.ts`).
 * - **A mapper reads only its row and the lookups prepared before the query
 *   runs.** better-sqlite3 holds the connection while a statement iterates,
 *   so nothing may query in the middle; and a mapper that depended on rows
 *   seen earlier in the same pass could not be resumed in the middle.
 *
 * Order follows the importer's, so a person reading the
 * manifest sees the projects before their tickets.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type Database from "better-sqlite3";
import {
  MIGRATION_PLACEHOLDERS,
  type Actor,
  type AuditLogRecord,
  type AutomationArmingRecord,
  type AutomationColumnOrderRecord,
  type AutomationRecord,
  type AutomationRunJobRecord,
  type AutomationRunRecord,
  type AutomationScheduleCursorRecord,
  type BlobLinkRecord,
  type BlobRecord,
  type BoardEventRecord,
  type ConfigEntryRecord,
  type DelegationExtensionRecord,
  type DelegationRecord,
  type JsonValue,
  type LabelRecord,
  type LegacyRowRecord,
  type McpCatalogCacheRecord,
  type MemberProjectPrefsRecord,
  type ProjectCheckoutPathRecord,
  type ProjectCheckoutRecord,
  type ProjectCounterRecord,
  type ProjectEnvironmentRecord,
  type ProjectRecord,
  type ProjectRepoRecord,
  type ReadMarkerRecord,
  type SessionEventRecord,
  type SessionGrantRecord,
  type SessionRecord,
  type TicketBodyRecord,
  type TicketCommentRecord,
  type TicketRecord,
  type TicketSignalRecord,
  type WorkingCopyPathRecord,
  type WorkingCopyRecord,
} from "./records";
import {
  configEntryId,
  lastPathSegment,
  parseColumnActor,
  parseJsonColumn,
  parseLocalActor,
  primaryRepoId,
  pullRequestNumber,
  sequentialPositionKey,
  toActor,
  workingCopyId,
  type ActorContext,
} from "./transform";

const USER = MIGRATION_PLACEHOLDERS.userId;
const RUNNER = MIGRATION_PLACEHOLDERS.runnerId;
const WORKSPACE = MIGRATION_PLACEHOLDERS.workspaceId;

/** Where a stream's records go. */
export type StreamDestination = "convex" | "runner" | "legacy";

/** Every stream, the record type it carries, and where it goes. */
export interface StreamRecords {
  projects: ProjectRecord;
  projectCounters: ProjectCounterRecord;
  projectRepos: ProjectRepoRecord;
  projectEnvironment: ProjectEnvironmentRecord;
  memberProjectPrefs: MemberProjectPrefsRecord;
  projectCheckouts: ProjectCheckoutRecord;
  configEntries: ConfigEntryRecord;
  labels: LabelRecord;
  tickets: TicketRecord;
  ticketBodies: TicketBodyRecord;
  workingCopies: WorkingCopyRecord;
  boardEvents: BoardEventRecord;
  ticketComments: TicketCommentRecord;
  ticketSignals: TicketSignalRecord;
  blobs: BlobRecord;
  blobLinks: BlobLinkRecord;
  sessions: SessionRecord;
  sessionEvents: SessionEventRecord;
  readMarkers: ReadMarkerRecord;
  delegations: DelegationRecord;
  sessionGrants: SessionGrantRecord;
  delegationExtensions: DelegationExtensionRecord;
  automations: AutomationRecord;
  automationRuns: AutomationRunRecord;
  automationArmings: AutomationArmingRecord;
  automationColumnOrder: AutomationColumnOrderRecord;
  automationScheduleCursors: AutomationScheduleCursorRecord;
  runnerJobs: AutomationRunJobRecord;
  auditLog: AuditLogRecord;
  projectCheckoutPaths: ProjectCheckoutPathRecord;
  workingCopyPaths: WorkingCopyPathRecord;
  mcpCatalogCache: McpCatalogCacheRecord;
  legacyRows: LegacyRowRecord;
}
export type StreamName = keyof StreamRecords;

export const STREAM_DESTINATIONS: Readonly<Record<StreamName, StreamDestination>> = {
  projects: "convex",
  projectCounters: "convex",
  projectRepos: "convex",
  projectEnvironment: "convex",
  memberProjectPrefs: "convex",
  projectCheckouts: "convex",
  configEntries: "convex",
  labels: "convex",
  tickets: "convex",
  ticketBodies: "convex",
  workingCopies: "convex",
  boardEvents: "convex",
  ticketComments: "convex",
  ticketSignals: "convex",
  blobs: "convex",
  blobLinks: "convex",
  sessions: "convex",
  sessionEvents: "convex",
  readMarkers: "convex",
  delegations: "convex",
  sessionGrants: "convex",
  delegationExtensions: "convex",
  automations: "convex",
  automationRuns: "convex",
  automationArmings: "convex",
  automationColumnOrder: "convex",
  automationScheduleCursors: "convex",
  runnerJobs: "convex",
  auditLog: "convex",
  projectCheckoutPaths: "runner",
  workingCopyPaths: "runner",
  mcpCatalogCache: "runner",
  legacyRows: "legacy",
};

/** Writes one record into a stream. */
export type Emit = <S extends StreamName>(stream: S, record: StreamRecords[S]) => void;

/** A source row could not be mapped: the snapshot holds a fact this build cannot carry. */
export class SourceCorruptError extends Error {
  override readonly name = "SourceCorruptError";
}

/** Lookups every source may read, built once from the snapshot. */
export interface ExportLookups extends ActorContext {
  /** When the snapshot was taken; stamped as `reportedAt` on runner reports. */
  readonly snapshotAt: number;
  readonly projects: ReadonlyMap<
    string,
    { baseBranch: string | null; ticketPrefix: string; path: string }
  >;
  /** Each ticket's worktree path, for the tickets that have one. */
  readonly worktrees: ReadonlyMap<string, string>;
  readonly sessions: ReadonlyMap<
    string,
    { role: string; parentSessionId: string | null; ticketId: string | null }
  >;
  /** This machine's home directory, redacted from git output. */
  readonly homeDir: string;
  /** Whether an absolute path exists on this machine. */
  pathExists(path: string): boolean;
}

/** One source: an ordered query and the mapping of each of its rows. */
export interface ExportSource {
  readonly id: string;
  /** The tables this source reads (`tables.ts` holds them against the schema). */
  readonly tables: readonly string[];
  /** The streams it may write. */
  readonly streams: readonly StreamName[];
  /** The ordered query. Must order by a unique key. */
  readonly sql: string;
  /** Builds per-source lookups before the query runs; may query freely. */
  prepare(db: Database.Database, lookups: ExportLookups): unknown;
  map(row: unknown, prepared: unknown, lookups: ExportLookups, emit: Emit): void;
}

function source<Row, Prepared = undefined>(definition: {
  id: string;
  tables: readonly string[];
  streams: readonly StreamName[];
  sql: string;
  prepare?: (db: Database.Database, lookups: ExportLookups) => Prepared;
  map: (row: Row, prepared: Prepared, lookups: ExportLookups, emit: Emit) => void;
}): ExportSource {
  return {
    id: definition.id,
    tables: definition.tables,
    streams: definition.streams,
    sql: definition.sql,
    prepare: (db, lookups) =>
      definition.prepare === undefined ? undefined : definition.prepare(db, lookups),
    map: (row, prepared, lookups, emit) =>
      definition.map(row as Row, prepared as Prepared, lookups, emit),
  };
}

/** Builds the lookups every source shares. Reads only. */
export function buildLookups(
  db: Database.Database,
  options: { snapshotAt: number; pathExists?: (path: string) => boolean; homeDir?: string },
): ExportLookups {
  const projects = new Map(
    (
      db.prepare("SELECT id, base_branch, ticket_prefix, path FROM projects").all() as Array<{
        id: string;
        base_branch: string | null;
        ticket_prefix: string;
        path: string;
      }>
    ).map((row) => [
      row.id,
      { baseBranch: row.base_branch, ticketPrefix: row.ticket_prefix, path: row.path },
    ]),
  );
  const worktrees = new Map(
    (
      db
        .prepare("SELECT id, worktree_path FROM tickets WHERE worktree_path IS NOT NULL")
        .all() as Array<{ id: string; worktree_path: string }>
    ).map((row) => [row.id, row.worktree_path]),
  );
  const sessions = new Map(
    (
      db.prepare("SELECT id, role, parent_session_id, ticket_id FROM sessions").all() as Array<{
        id: string;
        role: string;
        parent_session_id: string | null;
        ticket_id: string | null;
      }>
    ).map((row) => [
      row.id,
      { role: row.role, parentSessionId: row.parent_session_id, ticketId: row.ticket_id },
    ]),
  );
  const runs = new Map(
    (
      db
        .prepare("SELECT id, automation_id, session_id FROM automation_runs ORDER BY id")
        .all() as Array<{ id: string; automation_id: string | null; session_id: string }>
    ).map((row) => [row.session_id, { automationId: row.automation_id, runId: row.id }]),
  );
  return {
    snapshotAt: options.snapshotAt,
    projects,
    worktrees,
    sessions,
    homeDir: options.homeDir ?? homedir(),
    automationRunOf: (sessionId) => runs.get(sessionId),
    pathExists: options.pathExists ?? existsSync,
  };
}

function actorOf(local: ReturnType<typeof parseLocalActor>, lookups: ExportLookups, kind?: string) {
  return toActor(local, { automationRunOf: lookups.automationRunOf, eventKind: kind });
}

const PERSON: Actor = { kind: "person", userId: USER };

/** Parses a column the schema promises is JSON; anything else is corruption. */
function strictJson(text: string, where: string): JsonValue {
  const value = parseJsonColumn(text);
  if (value === undefined) throw new SourceCorruptError(`${where} is not valid JSON`);
  return value;
}

/**
 * The project of a ticket-owned row. Its ticket's foreign key cascades, so a
 * row whose ticket is gone is corruption, and it stops the export rather than
 * vanishing from it.
 */
function ownerProject(projectId: string | null, what: string): string {
  if (projectId === null) throw new SourceCorruptError(`${what} names a missing ticket`);
  return projectId;
}

/** Parses a free-text JSON column, keeping the raw text when it does not parse. */
function lenientJson(text: string | null): JsonValue {
  if (text === null) return null;
  const value = parseJsonColumn(text);
  return value === undefined ? text : value;
}

// ---- projects ---------------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  ticket_prefix: string;
  color_index: number;
  created_at: number;
  updated_at: number;
  next_ticket_number: number;
  base_branch: string | null;
  setup_command: string | null;
  theme_canvas: string | null;
  theme_appearance: string | null;
  skill_modes: string | null;
  session_harness: string | null;
  session_model: string | null;
  authority_policy: string | null;
  decision_model: string | null;
  removed_at: number | null;
  rail_rank: number;
  max_ticket_number: number | null;
  board_events: number;
}

/** Project columns that become project-level config entries, as `[column, kind]`. */
const PROJECT_CONFIG_COLUMNS = [
  ["skill_modes", "skill"],
  ["session_model", "model_default"],
  ["session_harness", "harness"],
  ["decision_model", "decision_model"],
  ["authority_policy", "authority_policy"],
] as const satisfies ReadonlyArray<readonly [keyof ProjectRow, string]>;

const projectsSource = source<ProjectRow>({
  id: "projects",
  tables: ["projects", "tickets", "ticket_events"],
  streams: [
    "projects",
    "projectCounters",
    "projectRepos",
    "projectEnvironment",
    "memberProjectPrefs",
    "configEntries",
    "projectCheckouts",
    "projectCheckoutPaths",
  ],
  sql: `SELECT p.*,
               ROW_NUMBER() OVER (ORDER BY p.sort_order, p.created_at, p.id) - 1 AS rail_rank,
               (SELECT MAX(t.ticket_number) FROM tickets t WHERE t.project_id = p.id)
                 AS max_ticket_number,
               (SELECT COUNT(*) FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
                 WHERE t.project_id = p.id AND json_valid(e.payload)) AS board_events
          FROM projects p
         ORDER BY p.id`,
  map(row, _prepared, lookups, emit) {
    const repoId = primaryRepoId(row.id);
    const dirName = lastPathSegment(row.path);
    emit("projects", {
      id: row.id,
      workspaceId: WORKSPACE,
      name: row.name,
      colorIndex: row.color_index,
      ticketPrefix: row.ticket_prefix,
      origin: "migrated",
      countsTowardCap: false,
      createdByUserId: USER,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: null,
      removedAt: row.removed_at,
    });
    emit("projectCounters", {
      projectId: row.id,
      nextTicketNumber: Math.max(row.next_ticket_number, (row.max_ticket_number ?? 0) + 1),
      boardSeq: row.board_events,
    });
    emit("projectRepos", {
      id: repoId,
      projectId: row.id,
      role: "primary",
      position: sequentialPositionKey(0),
      provider: "none",
      githubRepoId: null,
      installationId: null,
      owner: null,
      name: dirName,
      baseBranch: row.base_branch,
      defaultBranchCache: null,
      dirName,
    });
    emit("projectEnvironment", {
      projectId: row.id,
      storedSetup: row.setup_command,
      storedResume: null,
      storedSetupMode: "legacy_command",
      revision: 1,
    });
    const canvas = row.theme_canvas === null ? undefined : parseJsonColumn(row.theme_canvas);
    emit("memberProjectPrefs", {
      userId: USER,
      projectId: row.id,
      commitEmail: null,
      coAuthor: null,
      railPosition: sequentialPositionKey(row.rail_rank),
      ...(canvas === undefined ? {} : { themeCanvas: canvas }),
      ...(row.theme_appearance === null ? {} : { themeAppearance: row.theme_appearance }),
    });
    for (const [column, kind] of PROJECT_CONFIG_COLUMNS) {
      const text = row[column];
      if (typeof text !== "string") continue;
      emit("configEntries", {
        id: configEntryId(`project:${row.id}`, kind, "default"),
        level: "project",
        userId: null,
        workspaceId: null,
        projectId: row.id,
        kind,
        name: "default",
        state: "on",
        definition: lenientJson(text),
        revision: 1,
        updatedBy: PERSON,
        updatedAt: row.updated_at,
      });
    }
    emit("projectCheckouts", {
      runnerId: RUNNER,
      projectId: row.id,
      projectRepoId: repoId,
      kind: "main",
      headBranch: null,
      reportedAt: lookups.snapshotAt,
    });
    emit("projectCheckoutPaths", {
      projectRepoId: repoId,
      projectId: row.id,
      absPath: row.path,
      kind: "main",
    });
  },
});

// ---- labels -----------------------------------------------------------------

interface LabelRow {
  id: string;
  project_id: string;
  name: string;
  color: string | null;
  created_at: number;
  updated_at: number;
  merged_into_id: string | null;
  merged_at: number | null;
  merged_by: string | null;
}

const labelsSource = source<LabelRow>({
  id: "labels",
  tables: ["labels"],
  streams: ["labels"],
  sql: "SELECT * FROM labels ORDER BY id",
  map(row, _prepared, lookups, emit) {
    emit("labels", {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      nameKey: row.name.toLowerCase(),
      color: row.color,
      mergedIntoId: row.merged_into_id,
      mergedAt: row.merged_at,
      mergedBy: row.merged_by === null ? null : actorOf(parseLocalActor(row.merged_by), lookups),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  },
});

// ---- tickets ----------------------------------------------------------------

interface TicketRow {
  id: string;
  project_id: string;
  ticket_number: number;
  title: string;
  body: string;
  status: string;
  priority: string;
  uses_worktree: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  worktree_path: string | null;
  branch: string | null;
  base_branch: string | null;
  preferred_harness_id: string;
  pr_url: string | null;
  retention_keep: number;
  column_rank: number;
}

interface TicketLookups {
  labelIds: Map<string, string[]>;
  createdBy: Map<string, string>;
  merges: Map<string, { url: string | null; at: number }>;
}

/** The durable local order of ticket events (VC-512), as an ORDER BY over `e` and `s`. */
const TICKET_EVENT_ORDER = "s.sequence IS NULL, s.sequence, e.created_at, e.id";

const ticketsSource = source<TicketRow, TicketLookups>({
  id: "tickets",
  tables: ["tickets", "ticket_labels", "ticket_events", "ticket_event_sequence"],
  streams: ["tickets", "ticketBodies", "workingCopies", "workingCopyPaths"],
  sql: `SELECT t.*,
               ROW_NUMBER() OVER (
                 PARTITION BY t.project_id, t.status ORDER BY t.position, t.created_at, t.id
               ) - 1 AS column_rank
          FROM tickets t
         ORDER BY t.id`,
  prepare(db) {
    const labelIds = new Map<string, string[]>();
    // `rowid` is the display order (`tickets-repo.ts`); VACUUM INTO keeps it.
    for (const row of db
      .prepare("SELECT ticket_id, label_id FROM ticket_labels ORDER BY rowid")
      .iterate() as Iterable<{ ticket_id: string; label_id: string }>) {
      const list = labelIds.get(row.ticket_id) ?? [];
      list.push(row.label_id);
      labelIds.set(row.ticket_id, list);
    }
    const createdBy = new Map<string, string>();
    const merges = new Map<string, { url: string | null; at: number }>();
    for (const row of db
      .prepare(
        `SELECT e.ticket_id, e.kind, e.actor, e.payload, e.created_at
           FROM ticket_events e
           LEFT JOIN ticket_event_sequence s ON s.event_id = e.id
          WHERE e.kind IN ('created', 'pr_merged')
          ORDER BY ${TICKET_EVENT_ORDER}`,
      )
      .iterate() as Iterable<{
      ticket_id: string;
      kind: string;
      actor: string;
      payload: string;
      created_at: number;
    }>) {
      if (row.kind === "created") {
        if (!createdBy.has(row.ticket_id)) createdBy.set(row.ticket_id, row.actor);
      } else {
        const payload = parseJsonColumn(row.payload);
        const url =
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          typeof (payload as Record<string, JsonValue>).url === "string"
            ? ((payload as Record<string, JsonValue>).url as string)
            : null;
        merges.set(row.ticket_id, { url, at: row.created_at });
      }
    }
    return { labelIds, createdBy, merges };
  },
  map(row, prepared, lookups, emit) {
    const repoId = primaryRepoId(row.project_id);
    const project = lookups.projects.get(row.project_id);
    if (project === undefined) {
      throw new SourceCorruptError(`ticket ${row.id} names missing project ${row.project_id}`);
    }
    const projectBase = project.baseBranch;
    const createdActor = prepared.createdBy.get(row.id);
    const merge = prepared.merges.get(row.id);
    const merged = merge !== undefined && (merge.url === null || merge.url === row.pr_url);
    const worktreeOnDisk = row.worktree_path !== null && lookups.pathExists(row.worktree_path);
    emit("tickets", {
      id: row.id,
      projectId: row.project_id,
      number: row.ticket_number,
      title: row.title,
      status: row.status,
      priority: row.priority,
      position: sequentialPositionKey(row.column_rank),
      labelIds: prepared.labelIds.get(row.id) ?? [],
      assigneeUserId: null,
      checkoutMode: row.uses_worktree === 0 ? "main_checkout" : "worktree",
      preferredHarnessId: row.preferred_harness_id,
      branch: row.branch,
      baseBranch: row.base_branch === projectBase ? null : row.base_branch,
      pullRequests:
        row.pr_url === null
          ? []
          : [
              {
                projectRepoId: repoId,
                url: row.pr_url,
                number: pullRequestNumber(row.pr_url),
                state: merged ? "merged" : "open",
                mergedAt: merged ? merge.at : null,
              },
            ],
      retentionKeep: row.retention_keep !== 0,
      placeRunnerId: worktreeOnDisk ? RUNNER : null,
      createdBy:
        createdActor === undefined
          ? PERSON
          : actorOf(parseLocalActor(createdActor), lookups, "created"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    });
    emit("ticketBodies", {
      ticketId: row.id,
      body: row.body,
      revision: 1,
      updatedBy: PERSON,
      updatedAt: row.updated_at,
    });
    if (row.worktree_path !== null) {
      const id = workingCopyId(row.id);
      emit("workingCopies", {
        id,
        ticketId: row.id,
        projectId: row.project_id,
        runnerId: RUNNER,
        projectRepoId: repoId,
        kind: "worktree",
        state: worktreeOnDisk ? "ready" : "reclaimed",
        branch: row.branch,
        baseBranch: row.base_branch,
        reportedAt: lookups.snapshotAt,
        createdAt: row.created_at,
      });
      emit("workingCopyPaths", {
        workingCopyId: id,
        ticketId: row.id,
        projectRepoId: repoId,
        absPath: row.worktree_path,
      });
    }
  },
});

// ---- board events -----------------------------------------------------------

interface TicketEventRow {
  id: string;
  ticket_id: string;
  kind: string;
  actor: string;
  payload: string;
  created_at: number;
  project_id: string | null;
  seq: number;
}

/** Worktree event kinds that name the Working copy they happened to. */
const WORKING_COPY_EVENT_KINDS = new Set([
  "worktree_failed",
  "worktree_committed",
  "worktree_reclaimed",
  "worktree_trimmed",
]);

/** `worktree_changed`'s identity snapshot with its absolute path replaced. */
function redactWorktreeIdentity(identity: JsonValue): JsonValue {
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    return identity;
  }
  const { worktreePath, ...rest } = identity as Record<string, JsonValue>;
  return {
    ...rest,
    worktree:
      typeof worktreePath === "string"
        ? { runnerId: RUNNER, basename: lastPathSegment(worktreePath) }
        : null,
  };
}

/** Replaces every occurrence of each path with its stand-in, longest path first. */
function redactPaths(text: string, paths: ReadonlyArray<readonly [string, string]>): string {
  let result = text;
  // A one-character "path" (a home of `/`) would replace every slash.
  const real = paths.filter(([path]) => path.length > 1);
  for (const [path, standIn] of real.toSorted((a, b) => b[0].length - a[0].length)) {
    result = result.replaceAll(path, standIn);
  }
  return result;
}

/**
 * A board event payload with every machine path taken out: `worktree_changed`
 * keeps the worktree's runner and basename, and git output in `stderr` has the
 * worktree, the project checkout and the home directory replaced. Worktree
 * events also name the runner and, when the ticket has one, its Working copy.
 */
function cloudBoardPayload(
  kind: string,
  ticketId: string,
  projectId: string,
  payload: JsonValue,
  lookups: ExportLookups,
): JsonValue {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, JsonValue>;
  if (kind === "worktree_changed") {
    return {
      ...record,
      from: redactWorktreeIdentity(record.from ?? null),
      to: redactWorktreeIdentity(record.to ?? null),
    };
  }
  if (!WORKING_COPY_EVENT_KINDS.has(kind)) return payload;
  const worktree = lookups.worktrees.get(ticketId);
  const project = lookups.projects.get(projectId)!;
  return {
    ...record,
    ...(typeof record.stderr === "string"
      ? {
          stderr: redactPaths(record.stderr, [
            ...(worktree === undefined ? [] : [[worktree, "<worktree>"] as const]),
            [project.path, "<project>"],
            [lookups.homeDir, "~"],
          ]),
        }
      : {}),
    runnerId: RUNNER,
    ...(worktree === undefined ? {} : { workingCopyId: workingCopyId(ticketId) }),
  };
}

const boardEventsSource = source<TicketEventRow>({
  id: "boardEvents",
  tables: ["ticket_events", "ticket_event_sequence", "tickets"],
  streams: ["boardEvents"],
  sql: `SELECT e.id, e.ticket_id, e.kind, e.actor, e.payload, e.created_at, t.project_id,
               ROW_NUMBER() OVER (PARTITION BY t.project_id ORDER BY ${TICKET_EVENT_ORDER}) AS seq
          FROM ticket_events e
          LEFT JOIN tickets t ON t.id = e.ticket_id
          LEFT JOIN ticket_event_sequence s ON s.event_id = e.id
         WHERE json_valid(e.payload)
         ORDER BY t.project_id, seq`,
  map(row, _prepared, lookups, emit) {
    const projectId = ownerProject(row.project_id, `ticket event ${row.id}`);
    const payload = strictJson(row.payload, `ticket event ${row.id}`);
    emit("boardEvents", {
      id: row.id,
      projectId,
      ticketId: row.ticket_id,
      seq: row.seq,
      kind: row.kind,
      actor: actorOf(parseLocalActor(row.actor), lookups, row.kind),
      occurredAt: row.created_at,
      payload: cloudBoardPayload(row.kind, row.ticket_id, projectId, payload, lookups),
    });
  },
});

/** Ticket events whose payload is not JSON: kept, never ported as rows. */
const unparseableTicketEventsSource = source<Omit<TicketEventRow, "seq">>({
  id: "unparseableTicketEvents",
  tables: ["ticket_events", "tickets"],
  streams: ["legacyRows"],
  sql: `SELECT e.id, e.ticket_id, e.kind, e.actor, e.payload, e.created_at, t.project_id
          FROM ticket_events e
          LEFT JOIN tickets t ON t.id = e.ticket_id
         WHERE NOT json_valid(e.payload)
         ORDER BY e.id`,
  map(row, _prepared, _lookups, emit) {
    emit("legacyRows", {
      table: "ticket_events",
      projectId: ownerProject(row.project_id, `ticket event ${row.id}`),
      reason: "payload is not JSON",
      row: {
        id: row.id,
        ticket_id: row.ticket_id,
        kind: row.kind,
        actor: row.actor,
        payload: row.payload,
        created_at: row.created_at,
      },
    });
  },
});

// ---- comments and signals ---------------------------------------------------

interface CommentRow {
  id: string;
  ticket_id: string;
  session_id: string | null;
  actor: string;
  body: string;
  created_at: number;
  updated_at: number;
  project_id: string | null;
}

const commentsSource = source<CommentRow>({
  id: "ticketComments",
  tables: ["ticket_comments", "tickets"],
  streams: ["ticketComments"],
  sql: `SELECT c.*, t.project_id FROM ticket_comments c
          LEFT JOIN tickets t ON t.id = c.ticket_id
         ORDER BY c.id`,
  map(row, _prepared, lookups, emit) {
    emit("ticketComments", {
      id: row.id,
      ticketId: row.ticket_id,
      projectId: ownerProject(row.project_id, `comment ${row.id}`),
      sessionId: row.session_id,
      author: actorOf(parseColumnActor(row.actor, row.session_id), lookups),
      body: row.body,
      createdAt: row.created_at,
      editedAt: row.updated_at === row.created_at ? null : row.updated_at,
      deletedAt: null,
    });
  },
});

interface SignalRow {
  id: string;
  ticket_id: string;
  session_id: string | null;
  actor: string;
  kind: string;
  verdict: string;
  detail: string | null;
  created_at: number;
  project_id: string | null;
}

const signalsSource = source<SignalRow>({
  id: "ticketSignals",
  tables: ["ticket_signals", "tickets"],
  streams: ["ticketSignals"],
  sql: `SELECT g.*, t.project_id FROM ticket_signals g
          LEFT JOIN tickets t ON t.id = g.ticket_id
         ORDER BY g.id`,
  map(row, _prepared, lookups, emit) {
    emit("ticketSignals", {
      id: row.id,
      ticketId: row.ticket_id,
      projectId: ownerProject(row.project_id, `signal ${row.id}`),
      sessionId: row.session_id,
      actor: actorOf(parseColumnActor(row.actor, row.session_id), lookups),
      kind: row.kind,
      verdict: row.verdict,
      detail: row.detail,
      createdAt: row.created_at,
    });
  },
});

// ---- blobs ------------------------------------------------------------------

interface BlobRow {
  hash: string;
  mime: string;
  size_bytes: number;
  original_name: string;
  width: number | null;
  height: number | null;
  created_at: number;
  project_id: string;
}

/** The project that owns each link: its ticket's, or its Session's. */
const BLOB_LINK_OWNERS = `SELECT l.*, COALESCE(t.project_id, s.project_id) AS project_id
                            FROM blob_links l
                            LEFT JOIN tickets t ON t.id = l.ticket_id
                            LEFT JOIN sessions s ON s.id = l.session_id`;

/** One row per project that links a blob (dedup is per project). Unlinked blobs stay. */
const blobsSource = source<BlobRow>({
  id: "blobs",
  tables: ["blobs", "blob_links", "tickets", "sessions"],
  streams: ["blobs"],
  sql: `SELECT b.*, owners.project_id
          FROM blobs b
          JOIN (SELECT DISTINCT blob_hash, project_id FROM (${BLOB_LINK_OWNERS})
                 WHERE project_id IS NOT NULL) owners
            ON owners.blob_hash = b.hash
         ORDER BY owners.project_id, b.hash`,
  map(row, _prepared, _lookups, emit) {
    emit("blobs", {
      projectId: row.project_id,
      sha256: row.hash,
      mime: row.mime,
      sizeBytes: row.size_bytes,
      originalName: row.original_name,
      width: row.width,
      height: row.height,
      key: `v1/p/${row.project_id}/b/${row.hash}`,
      uploadedBy: PERSON,
      createdAt: row.created_at,
    });
  },
});

interface BlobLinkRow {
  id: string;
  blob_hash: string;
  ticket_id: string | null;
  session_id: string | null;
  label: string;
  created_at: number;
  project_id: string | null;
}

const blobLinksSource = source<BlobLinkRow>({
  id: "blobLinks",
  tables: ["blob_links", "tickets", "sessions"],
  streams: ["blobLinks"],
  sql: `${BLOB_LINK_OWNERS} ORDER BY l.id`,
  map(row, _prepared, _lookups, emit) {
    // The schema's CHECK gives every link exactly one owner, and its foreign
    // keys cascade, so an ownerless link is corruption rather than history.
    if (row.project_id === null) {
      throw new SourceCorruptError(`blob link ${row.id} has no owning ticket or Session`);
    }
    emit("blobLinks", {
      id: row.id,
      projectId: row.project_id,
      sha256: row.blob_hash,
      owner:
        row.ticket_id === null
          ? { kind: "session", id: row.session_id! }
          : { kind: "ticket", id: row.ticket_id },
      label: row.label,
      createdAt: row.created_at,
    });
  },
});

// ---- Sessions ---------------------------------------------------------------

interface SessionRow {
  id: string;
  project_id: string;
  ticket_id: string | null;
  title: string | null;
  created_at: number;
  role: string;
  parent_session_id: string | null;
  last_recorded: number | null;
  last_sequence: number | null;
  event_count: number | null;
}

/**
 * A ticket Session is shared, a Board Session or ad-hoc chat is private, and a
 * subagent inherits its root's visibility. A subagent whose chain cannot be
 * followed to a root (a deleted parent, a cycle) falls back on its own ticket:
 * ticket work is shared, anything else private, so an unreadable chain never
 * widens who can see a chat.
 */
function sessionVisibility(
  sessionId: string,
  sessions: ExportLookups["sessions"],
): { visibility: "shared" | "private"; visibilityReason: "ticket" | "adhoc" | "inherited" } {
  const self = sessions.get(sessionId)!;
  if (self.role !== "subagent") {
    return self.role === "project"
      ? { visibility: "private", visibilityReason: "adhoc" }
      : { visibility: "shared", visibilityReason: "ticket" };
  }
  const seen = new Set<string>([sessionId]);
  let current = self;
  while (current.role === "subagent") {
    const parentId = current.parentSessionId;
    const parent = parentId === null ? undefined : sessions.get(parentId);
    if (parentId === null || parent === undefined || seen.has(parentId)) {
      return {
        visibility: self.ticketId === null ? "private" : "shared",
        visibilityReason: "inherited",
      };
    }
    seen.add(parentId);
    current = parent;
  }
  return {
    visibility: current.role === "project" ? "private" : "shared",
    visibilityReason: "inherited",
  };
}

const sessionsSource = source<SessionRow>({
  id: "sessions",
  tables: ["sessions", "session_events"],
  streams: ["sessions"],
  sql: `SELECT s.*, agg.last_recorded, agg.last_sequence, agg.event_count
          FROM sessions s
          LEFT JOIN (
            SELECT session_id, MAX(recorded_at) AS last_recorded, MAX(sequence) AS last_sequence,
                   COUNT(*) AS event_count
              FROM session_events GROUP BY session_id
          ) agg ON agg.session_id = s.id
         ORDER BY s.id`,
  map(row, _prepared, lookups, emit) {
    emit("sessions", {
      id: row.id,
      projectId: row.project_id,
      ticketId: row.ticket_id,
      role: row.role,
      parentSessionId: row.parent_session_id,
      ownerUserId: USER,
      title: row.title,
      ...sessionVisibility(row.id, lookups.sessions),
      placeRunnerId: RUNNER,
      createdAt: row.created_at,
      lastActivityAt: Math.max(row.created_at, row.last_recorded ?? row.created_at),
      lastSequence: row.last_sequence ?? 0,
      eventCount: row.event_count ?? 0,
    });
  },
});

interface SessionEventRow {
  id: string;
  session_id: string;
  sequence: number;
  occurred_at: number;
  recorded_at: number;
  provenance_id: number;
  provenance: string | null;
  attachment_id: string | null;
  command_id: string | null;
  payload: string;
}

const sessionEventsSource = source<SessionEventRow>({
  id: "sessionEvents",
  tables: ["session_events", "session_provenances"],
  streams: ["sessionEvents"],
  sql: `SELECT e.id, e.session_id, e.sequence, e.occurred_at, e.recorded_at, e.provenance_id,
               p.provenance, e.attachment_id, e.command_id, e.payload
          FROM session_events e
          LEFT JOIN session_provenances p ON p.id = e.provenance_id
         ORDER BY e.session_id, e.sequence, e.id`,
  map(row, _prepared, _lookups, emit) {
    // A Session's history must arrive whole and contiguous, so a fact
    // that cannot be carried stops the export rather than leaving a gap.
    if (row.provenance === null) {
      throw new SourceCorruptError(
        `Session event ${row.id} names missing provenance ${row.provenance_id}`,
      );
    }
    emit("sessionEvents", {
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      provenance: strictJson(row.provenance, `provenance ${row.provenance_id}`),
      attachmentId: row.attachment_id,
      commandId: row.command_id,
      payload: strictJson(row.payload, `Session event ${row.id}`),
    });
  },
});

const readMarkersSource = source<{ session_id: string; unread_since: number | null }>({
  id: "readMarkers",
  tables: ["session_read_receipts"],
  streams: ["readMarkers"],
  sql: "SELECT session_id, unread_since FROM session_read_receipts ORDER BY session_id",
  map(row, _prepared, _lookups, emit) {
    emit("readMarkers", {
      userId: USER,
      sessionId: row.session_id,
      unreadSince: row.unread_since,
      readThroughSequence: null,
    });
  },
});

interface DelegationRow {
  session_id: string;
  ticket_id: string | null;
  parent_session_id: string;
  depth: number;
  tool_call_id: string | null;
  create_command_id: string | null;
  claimed_at: number | null;
}

/**
 * Delegated Sessions (depth ≥ 1), merged with the claim that minted each
 * one. A root row (no parent) restates `sessions.ticket_id` and is not a
 * delegation, so it is not carried.
 */
const delegationsSource = source<DelegationRow>({
  id: "delegations",
  tables: ["session_delegations", "session_delegation_claims"],
  streams: ["delegations"],
  sql: `SELECT d.session_id, d.ticket_id, d.parent_session_id, d.depth,
               c.tool_call_id, c.create_command_id, c.created_at AS claimed_at
          FROM session_delegations d
          LEFT JOIN session_delegation_claims c ON c.child_session_id = d.session_id
         WHERE d.parent_session_id IS NOT NULL
         ORDER BY d.session_id`,
  map(row, _prepared, _lookups, emit) {
    emit("delegations", {
      childSessionId: row.session_id,
      parentSessionId: row.parent_session_id,
      ticketId: row.ticket_id,
      depth: row.depth,
      toolCallId: row.tool_call_id,
      createCommandId: row.create_command_id,
      createdAt: row.claimed_at,
    });
  },
});

interface ClaimRow {
  parent_session_id: string;
  tool_call_id: string;
  ticket_id: string;
  create_command_id: string;
  created_at: number;
  project_id: string | null;
}

/** A fan-out slot claimed whose child never minted: no delegation, kept as history. */
const unmintedClaimsSource = source<ClaimRow>({
  id: "unmintedDelegationClaims",
  tables: ["session_delegation_claims", "sessions"],
  streams: ["legacyRows"],
  sql: `SELECT c.parent_session_id, c.tool_call_id, c.ticket_id, c.create_command_id,
               c.created_at, s.project_id
          FROM session_delegation_claims c
          LEFT JOIN sessions s ON s.id = c.parent_session_id
         WHERE c.child_session_id IS NULL
         ORDER BY c.parent_session_id, c.tool_call_id`,
  map(row, _prepared, _lookups, emit) {
    const { project_id: projectId, ...rest } = row;
    emit("legacyRows", {
      table: "session_delegation_claims",
      projectId,
      reason: "claimed fan-out slot whose child Session was never created",
      row: rest,
    });
  },
});

const grantsSource = source<{
  session_id: string;
  verb: string;
  scope: string;
  max_depth: number;
  max_children: number;
}>({
  id: "sessionGrants",
  tables: ["session_verb_grants"],
  streams: ["sessionGrants"],
  sql: "SELECT * FROM session_verb_grants ORDER BY session_id, verb",
  map(row, _prepared, _lookups, emit) {
    emit("sessionGrants", {
      sessionId: row.session_id,
      verb: row.verb,
      scope: row.scope,
      maxDepth: row.max_depth,
      maxChildren: row.max_children,
    });
  },
});

const extensionsSource = source<{
  parent_session_id: string;
  tool_call_id: string;
  created_at: number;
}>({
  id: "delegationExtensions",
  tables: ["session_delegation_extensions"],
  streams: ["delegationExtensions"],
  sql: "SELECT * FROM session_delegation_extensions ORDER BY parent_session_id, tool_call_id",
  map(row, _prepared, _lookups, emit) {
    emit("delegationExtensions", {
      parentSessionId: row.parent_session_id,
      toolCallId: row.tool_call_id,
      approvedByUserId: USER,
      createdAt: row.created_at,
    });
  },
});

// ---- Automations ------------------------------------------------------------

interface AutomationRow {
  id: string;
  project_id: string | null;
  name: string;
  instructions: string;
  runtime: string | null;
  created_at: number;
  updated_at: number;
  trigger_spec: string | null;
}

const automationsSource = source<AutomationRow>({
  id: "automations",
  tables: ["automations"],
  streams: ["automations", "configEntries"],
  sql: "SELECT * FROM automations ORDER BY id",
  map(row, _prepared, _lookups, emit) {
    const runtime = lenientJson(row.runtime);
    const triggerSpec = lenientJson(row.trigger_spec);
    if (row.project_id === null) {
      // An unbound Automation is personal until it is bound.
      emit("configEntries", {
        id: row.id,
        level: "personal",
        userId: USER,
        workspaceId: null,
        projectId: null,
        kind: "automation",
        name: row.name,
        state: "on",
        definition: { name: row.name, instructions: row.instructions, runtime, triggerSpec },
        revision: 1,
        updatedBy: PERSON,
        updatedAt: row.updated_at,
      });
      return;
    }
    emit("automations", {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      instructions: row.instructions,
      runtime,
      triggerSpec,
      createdBy: PERSON,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: null,
    });
  },
});

interface AutomationRunRow {
  id: string;
  automation_id: string | null;
  automation_name: string | null;
  ticket_id: string | null;
  session_id: string;
  provider_id: string;
  model_id: string;
  reasoning_level: string;
  created_at: number;
  attendance: string | null;
  project_id: string | null;
}

/**
 * What started a Run, where local history can say: an Unbound Run is one-time
 * work a person started by hand, and only a schedule targets the project
 * rather than a ticket. A ticket Run may have been a column arrival or a
 * by-hand Run, and nothing local records which.
 */
function runTrigger(row: AutomationRunRow): AutomationRunRecord["trigger"] {
  if (row.automation_id === null) return "manual";
  if (row.ticket_id === null) return "schedule";
  return "unknown";
}

const automationRunsSource = source<AutomationRunRow>({
  id: "automationRuns",
  tables: ["automation_runs", "sessions"],
  streams: ["automationRuns"],
  sql: `SELECT r.*, s.project_id FROM automation_runs r
          LEFT JOIN sessions s ON s.id = r.session_id
         ORDER BY r.id`,
  map(row, _prepared, _lookups, emit) {
    // `automation_runs.session_id` cascades from `sessions`, so a Run always
    // has its Session's project.
    if (row.project_id === null) {
      throw new SourceCorruptError(`Automation Run ${row.id} names a missing Session`);
    }
    emit("automationRuns", {
      id: row.id,
      automationId: row.automation_id,
      automationName: row.automation_name,
      projectId: row.project_id,
      ticketId: row.ticket_id,
      sessionId: row.session_id,
      trigger: runTrigger(row),
      status: "started",
      missedCount: null,
      dueAt: null,
      model: {
        providerId: row.provider_id,
        modelId: row.model_id,
        reasoningLevel: row.reasoning_level,
      },
      attendance: row.attendance,
      armedByUserId: USER,
      runnerId: RUNNER,
      createdAt: row.created_at,
    });
  },
});

interface SkippedRow {
  id: string;
  automation_id: string;
  automation_name: string;
  project_id: string;
  due_at: number;
  missed_count: number;
  reason: string;
  recorded_at: number;
}

const skippedSource = source<SkippedRow>({
  id: "automationSkippedOccurrences",
  tables: ["automation_skipped_occurrences"],
  streams: ["automationRuns"],
  sql: "SELECT * FROM automation_skipped_occurrences ORDER BY id",
  map(row, _prepared, _lookups, emit) {
    emit("automationRuns", {
      id: row.id,
      automationId: row.automation_id,
      automationName: row.automation_name,
      projectId: row.project_id,
      ticketId: null,
      sessionId: null,
      trigger: "schedule",
      status: "skipped",
      skipReason: lenientJson(row.reason),
      missedCount: row.missed_count,
      dueAt: row.due_at,
      attendance: null,
      armedByUserId: USER,
      runnerId: RUNNER,
      createdAt: row.recorded_at,
    });
  },
});

interface PendingRunRow {
  id: string;
  ticket_id: string;
  project_id: string;
  ticket_display_id: string;
  automation_id: string;
  automation_name: string;
  status: string;
  origin: string;
  opened_at: number;
  start_at: number;
}

interface FailedAttemptRow extends PendingRunRow {
  command_id: string;
  error: string;
}

/** A failed arrival attempt: a failed Run, its error kept for the Retry. */
const failedAttemptsSource = source<FailedAttemptRow>({
  id: "automationPendingArmedRunAttempts",
  tables: ["automation_pending_armed_run_attempts"],
  streams: ["automationRuns"],
  sql: "SELECT * FROM automation_pending_armed_run_attempts ORDER BY id",
  map(row, _prepared, _lookups, emit) {
    emit("automationRuns", {
      id: row.id,
      automationId: row.automation_id,
      automationName: row.automation_name,
      projectId: row.project_id,
      ticketId: row.ticket_id,
      sessionId: null,
      trigger: "arrival",
      status: "failed",
      missedCount: null,
      dueAt: row.start_at,
      error: row.error,
      retryCommandId: row.command_id,
      attendance: null,
      armedByUserId: USER,
      runnerId: RUNNER,
      createdAt: row.opened_at,
    });
  },
});

/** An arrival still counting down at cutover becomes the job that fires it. */
const pendingRunsSource = source<PendingRunRow>({
  id: "automationPendingArmedRuns",
  tables: ["automation_pending_armed_runs"],
  streams: ["runnerJobs"],
  sql: "SELECT * FROM automation_pending_armed_runs ORDER BY ticket_id",
  map(row, _prepared, _lookups, emit) {
    emit("runnerJobs", {
      id: row.id,
      runnerId: RUNNER,
      kind: "automation.run",
      projectId: row.project_id,
      sessionId: null,
      ticketId: row.ticket_id,
      workingCopyId: null,
      payload: {
        automationId: row.automation_id,
        automationName: row.automation_name,
        ticketDisplayId: row.ticket_display_id,
        status: row.status,
        origin: row.origin,
      },
      priority: "normal",
      createdBy: PERSON,
      createdAt: row.opened_at,
      availableAt: row.start_at,
    });
  },
});

const armingsSource = source<{
  project_id: string;
  status: string;
  automation_id: string;
  armed_at: number;
}>({
  id: "automationColumnArming",
  tables: ["automation_column_arming"],
  streams: ["automationArmings"],
  sql: "SELECT * FROM automation_column_arming ORDER BY project_id, status",
  map(row, _prepared, _lookups, emit) {
    emit("automationArmings", {
      projectId: row.project_id,
      status: row.status,
      automationId: row.automation_id,
      armedByUserId: USER,
      runnerId: RUNNER,
      armedAt: row.armed_at,
    });
  },
});

const columnOrderSource = source<{
  project_id: string;
  status: string;
  ranked_ids: string;
  ordered_at: number;
}>({
  id: "automationColumnOrder",
  tables: ["automation_column_order"],
  streams: ["automationColumnOrder"],
  sql: "SELECT * FROM automation_column_order ORDER BY project_id, status",
  map(row, _prepared, _lookups, emit) {
    emit("automationColumnOrder", {
      projectId: row.project_id,
      status: row.status,
      rankedIds: lenientJson(row.ranked_ids),
      orderedAt: row.ordered_at,
    });
  },
});

interface LedgerRow {
  table_name: string;
  id: string;
  project_id: string | null;
  row_json: string;
}

/**
 * The Automation command/event/receipt ledger: not ported as rows, copied once
 * into the project's legacy archive. The project is read out of the
 * Run plan where the command names one.
 */
const automationLedgerSource = source<LedgerRow>({
  id: "automationLedger",
  tables: ["automation_commands", "automation_events", "automation_command_receipts"],
  streams: ["legacyRows"],
  sql: `WITH command_projects AS (
          SELECT id, COALESCE(json_extract(intent, '$.plan.projectId'),
                              json_extract(intent, '$.projectId')) AS project_id
            FROM automation_commands WHERE json_valid(intent)
        )
        SELECT 'automation_commands' AS table_name, c.id, p.project_id,
               json_object('id', c.id, 'intent', c.intent, 'created_at', c.created_at) AS row_json
          FROM automation_commands c LEFT JOIN command_projects p ON p.id = c.id
        UNION ALL
        SELECT 'automation_events', e.id, p.project_id,
               json_object('id', e.id, 'command_id', e.command_id, 'kind', e.kind,
                           'payload', e.payload, 'created_at', e.created_at)
          FROM automation_events e LEFT JOIN command_projects p ON p.id = e.command_id
        UNION ALL
        SELECT 'automation_command_receipts', r.id, p.project_id,
               json_object('id', r.id, 'command_id', r.command_id, 'status', r.status,
                           'result', r.result, 'recorded_at', r.recorded_at)
          FROM automation_command_receipts r LEFT JOIN command_projects p ON p.id = r.command_id
        ORDER BY 1, 2`,
  map(row, _prepared, _lookups, emit) {
    emit("legacyRows", {
      table: row.table_name,
      projectId: typeof row.project_id === "string" ? row.project_id : null,
      reason: "the local Automation ledger is archived, not ported as rows",
      row: strictJson(row.row_json, `${row.table_name} ${row.id}`) as Record<string, JsonValue>,
    });
  },
});

// ---- MCP --------------------------------------------------------------------

interface McpServerRow {
  id: string;
  project_id: string;
  name: string;
  enabled: number;
  transport: string;
  catalog: string;
  stale: number;
  error: string | null;
  refreshed_at: number | null;
  updated_at: number;
  source: string | null;
  registry_type: string | null;
  version: string | null;
  digest: string | null;
}

/**
 * A project's MCP servers become project config entries. Transport
 * settings carry credential REFERENCES, never a value (VC-470); the values stay
 * in this Mac's credential file and are re-entered. The tool
 * catalog is a runner-local cache, since stdio servers run on the runner.
 */
const mcpServersSource = source<McpServerRow>({
  id: "mcpServers",
  tables: ["mcp_servers"],
  streams: ["configEntries", "mcpCatalogCache"],
  sql: "SELECT * FROM mcp_servers ORDER BY id",
  map(row, _prepared, _lookups, emit) {
    emit("configEntries", {
      id: row.id,
      level: "project",
      userId: null,
      workspaceId: null,
      projectId: row.project_id,
      kind: "mcp_server",
      name: row.name,
      state: row.enabled === 0 ? "off" : "on",
      definition: {
        transport: lenientJson(row.transport),
        source: row.source,
        registryType: row.registry_type,
        version: row.version,
        digest: row.digest,
      },
      revision: 1,
      updatedBy: PERSON,
      updatedAt: row.updated_at,
    });
    emit("mcpCatalogCache", {
      configEntryId: row.id,
      projectId: row.project_id,
      catalog: lenientJson(row.catalog),
      stale: row.stale !== 0,
      error: row.error,
      refreshedAt: row.refreshed_at,
    });
  },
});

interface McpOperationRow {
  id: string;
  project_id: string;
  server_id: string;
  server_name: string;
  operation: string;
  outcome: string;
  summary: string;
  detail: string | null;
  source: string | null;
  registry_type: string | null;
  version: string | null;
  digest: string | null;
  session_id: string | null;
  ticket_id: string | null;
  created_at: number;
}

const mcpOperationsSource = source<McpOperationRow>({
  id: "mcpOperations",
  tables: ["mcp_operations"],
  streams: ["auditLog"],
  sql: "SELECT * FROM mcp_operations ORDER BY id",
  map(row, _prepared, _lookups, emit) {
    emit("auditLog", {
      id: row.id,
      workspaceId: WORKSPACE,
      actor:
        row.session_id === null
          ? PERSON
          : {
              kind: "agent",
              userId: USER,
              sessionId: row.session_id,
              ...(row.ticket_id === null ? {} : { ticketId: row.ticket_id }),
            },
      kind: `mcp_${row.operation}`,
      targetKind: "mcp_server",
      targetId: row.server_id,
      at: row.created_at,
      detail: {
        projectId: row.project_id,
        serverName: row.server_name,
        outcome: row.outcome,
        summary: row.summary,
        detail: row.detail,
        source: row.source,
        registryType: row.registry_type,
        version: row.version,
        digest: row.digest,
      },
    });
  },
});

// ---- settings ---------------------------------------------------------------

/**
 * The `app_state` keys that become personal config entries, as
 * `key → [kind, name]`. Every other key stays on this machine: client layout,
 * runner policy, or retired (`volli:runtime-preferences:*` among them; nothing
 * reads it).
 */
export const PERSONAL_SETTING_KEYS: Readonly<Record<string, readonly [string, string]>> = {
  "volli:model-access-defaults": ["model_default", "defaults"],
  "volli:model-access-default": ["model_default", "default"],
  "volli:model-access-hidden-models": ["model_default", "hidden-models"],
  "volli:decision-model": ["decision_model", "default"],
  "volli:compaction-policy": ["compaction_policy", "default"],
  "volli:code-mode-policy": ["code_mode_policy", "default"],
};
const settingsSource = source<{ key: string; value: string; updated_at: number }>({
  id: "personalSettings",
  tables: ["app_state"],
  streams: ["configEntries"],
  sql: `SELECT key, value, updated_at FROM app_state
         WHERE key IN (${Object.keys(PERSONAL_SETTING_KEYS)
           .map((key) => `'${key}'`)
           .join(", ")})
         ORDER BY key`,
  map(row, _prepared, _lookups, emit) {
    const [kind, name] = PERSONAL_SETTING_KEYS[row.key]!;
    emit("configEntries", {
      id: configEntryId("personal", kind, name),
      level: "personal",
      userId: USER,
      workspaceId: null,
      projectId: null,
      kind,
      name,
      state: "on",
      definition: lenientJson(row.value),
      revision: 1,
      updatedBy: PERSON,
      updatedAt: row.updated_at,
    });
  },
});

/**
 * The scheduler's per-Automation cursors (one `app_state` row, keyed by
 * Automation id). An entry this build cannot read is dropped, as
 * `schedule-cursor.ts` drops it: a missing cursor only restarts that one
 * schedule's clock.
 */
const scheduleCursorsSource = source<{ value: string }>({
  id: "automationScheduleCursors",
  tables: ["app_state"],
  streams: ["automationScheduleCursors"],
  sql: "SELECT value FROM app_state WHERE key = 'volli:automation-schedule-cursors' ORDER BY key",
  map(row, _prepared, _lookups, emit) {
    const parsed = parseJsonColumn(row.value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [automationId, at] of Object.entries(parsed)) {
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      emit("automationScheduleCursors", {
        automationId,
        evaluatedThrough: at,
        armedByUserId: USER,
        runnerId: RUNNER,
      });
    }
  },
});

/** Every source, in the order the export runs them. */
export const EXPORT_SOURCES: readonly ExportSource[] = [
  projectsSource,
  labelsSource,
  ticketsSource,
  boardEventsSource,
  unparseableTicketEventsSource,
  commentsSource,
  signalsSource,
  blobsSource,
  blobLinksSource,
  automationsSource,
  automationRunsSource,
  skippedSource,
  failedAttemptsSource,
  pendingRunsSource,
  armingsSource,
  columnOrderSource,
  scheduleCursorsSource,
  sessionsSource,
  sessionEventsSource,
  readMarkersSource,
  delegationsSource,
  unmintedClaimsSource,
  grantsSource,
  extensionsSource,
  mcpServersSource,
  mcpOperationsSource,
  settingsSource,
  automationLedgerSource,
];
