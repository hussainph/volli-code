/**
 * Full-database JSON export: one versioned document covering every table in
 * the current schema (`migrations.ts` is the authoritative table list) —
 * user-facing data-export trust, a debug/inspection tool, and a manual
 * backup story alongside the migration backups. Export only: there is
 * deliberately no import/restore path here.
 *
 * `buildExportDocument` is pure given its inputs (the db handle plus the
 * caller-supplied `appVersion`/`now`) so it stays fully unit-testable
 * against a real migrated db (see `test-helpers.ts`) without touching
 * Electron globals — `schemaVersion` is read straight off the db's own
 * `PRAGMA user_version`, which is itself a deterministic function of the db
 * handle. Row order within every table is a stable, data-derived sort (never
 * insertion/rowid order), so two exports of an unchanged db are
 * byte-identical apart from `exportedAt`.
 */
import type Database from "better-sqlite3";
import { displayTicketId } from "@volli/shared";
import { prepared } from "./prepared";

/** Top-level format marker — lets a future importer/reader recognize the document before touching its shape. */
export const EXPORT_FORMAT = "volli-export";

export interface ExportProject {
  id: string;
  name: string;
  path: string;
  ticketPrefix: string;
  baseBranch: string | null;
  colorIndex: number;
  sortOrder: number;
  rowVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface ExportTicket {
  id: string;
  /** Human-readable presentation id (`ticketPrefix-ticketNumber`, e.g. "VC-12"), reused from `displayTicketId`. */
  displayId: string;
  projectId: string;
  ticketNumber: number;
  title: string;
  body: string;
  status: string;
  priority: string;
  preferredHarnessId: string;
  usesWorktree: boolean;
  position: number;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  /** Epoch ms the ticket was archived, or `null` while it's live on the board. */
  archivedAt: number | null;
  rowVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface ExportLabel {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  rowVersion: number;
  createdAt: number;
  updatedAt: number;
}

/** One `ticket_labels` junction row — the table carries no other columns. */
export interface ExportTicketLabel {
  ticketId: string;
  labelId: string;
}

export interface ExportTicketEvent {
  id: string;
  ticketId: string;
  kind: string;
  actor: string;
  /** Parsed JSON (stored as a TEXT column) — kept structured for a meaningful diff/inspection. */
  payload: unknown;
  createdAt: number;
}

export interface ExportSession {
  id: string;
  projectId: string;
  /** `null` for a project-scoped scratch session. */
  ticketId: string | null;
  harnessId: string;
  harnessSessionId: string | null;
  title: string;
  cwd: string;
  createdAt: number;
  endedAt: number | null;
}

export interface ExportTicketComment {
  id: string;
  ticketId: string;
  sessionId: string | null;
  actor: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** One `app_state` row. `value` is kept as its stored opaque JSON string, unparsed — same stance as `app-state-repo.ts`. */
export interface ExportAppState {
  key: string;
  value: string;
  updatedAt: number;
}

export interface ExportDocument {
  format: typeof EXPORT_FORMAT;
  schemaVersion: number;
  appVersion: string;
  /** ISO 8601 timestamp — the one field that legitimately differs between two exports of an unchanged db. */
  exportedAt: string;
  projects: ExportProject[];
  tickets: ExportTicket[];
  labels: ExportLabel[];
  ticketLabels: ExportTicketLabel[];
  ticketEvents: ExportTicketEvent[];
  sessions: ExportSession[];
  ticketComments: ExportTicketComment[];
  appState: ExportAppState[];
}

export interface BuildExportDocumentOptions {
  /** The running app's version (`app.getVersion()` in main; a fixed string in tests) — read by the caller, not here. */
  appVersion: string;
  /** Epoch milliseconds, stamped onto `exportedAt` — supplied by the caller so this stays deterministic. */
  now: number;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  ticket_prefix: string;
  base_branch: string | null;
  color_index: number;
  sort_order: number;
  row_version: number;
  created_at: number;
  updated_at: number;
}

function exportProjects(db: Database.Database): ExportProject[] {
  const rows = prepared<[], ProjectRow>(db, "SELECT * FROM projects ORDER BY id").all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    path: row.path,
    ticketPrefix: row.ticket_prefix,
    baseBranch: row.base_branch,
    colorIndex: row.color_index,
    sortOrder: row.sort_order,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

interface TicketRow {
  id: string;
  project_id: string;
  ticket_number: number;
  title: string;
  body: string;
  status: string;
  priority: string;
  preferred_harness_id: string;
  uses_worktree: number;
  position: number;
  worktree_path: string | null;
  branch: string | null;
  base_branch: string | null;
  archived_at: number | null;
  row_version: number;
  created_at: number;
  updated_at: number;
}

/**
 * Every ticket in the db — live AND archived, across every project — unlike
 * `listAllTickets` (board-boot-only, live tickets alone). `ticketPrefixById`
 * resolves each row's `displayId`; a ticket whose project is somehow missing
 * (should not happen under the FK, but this reads a possibly-hand-built test
 * db) falls back to the raw project id as its "prefix" rather than throwing.
 */
function exportTickets(
  db: Database.Database,
  ticketPrefixById: ReadonlyMap<string, string>,
): ExportTicket[] {
  const rows = prepared<[], TicketRow>(db, "SELECT * FROM tickets ORDER BY id").all();
  return rows.map((row) => {
    const prefix = ticketPrefixById.get(row.project_id) ?? row.project_id;
    return {
      id: row.id,
      displayId: displayTicketId(prefix, row.ticket_number),
      projectId: row.project_id,
      ticketNumber: row.ticket_number,
      title: row.title,
      body: row.body,
      status: row.status,
      priority: row.priority,
      preferredHarnessId: row.preferred_harness_id,
      usesWorktree: row.uses_worktree !== 0,
      position: row.position,
      worktreePath: row.worktree_path,
      branch: row.branch,
      baseBranch: row.base_branch,
      archivedAt: row.archived_at,
      rowVersion: row.row_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

interface LabelRow {
  id: string;
  project_id: string;
  name: string;
  color: string | null;
  row_version: number;
  created_at: number;
  updated_at: number;
}

function exportLabels(db: Database.Database): ExportLabel[] {
  const rows = prepared<[], LabelRow>(db, "SELECT * FROM labels ORDER BY id").all();
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    color: row.color,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

interface TicketLabelRow {
  ticket_id: string;
  label_id: string;
}

function exportTicketLabels(db: Database.Database): ExportTicketLabel[] {
  const rows = prepared<[], TicketLabelRow>(
    db,
    "SELECT * FROM ticket_labels ORDER BY ticket_id, label_id",
  ).all();
  return rows.map((row) => ({ ticketId: row.ticket_id, labelId: row.label_id }));
}

interface TicketEventRow {
  id: string;
  ticket_id: string;
  kind: string;
  actor: string;
  payload: string;
  created_at: number;
}

function exportTicketEvents(db: Database.Database): ExportTicketEvent[] {
  const rows = prepared<[], TicketEventRow>(db, "SELECT * FROM ticket_events ORDER BY id").all();
  return rows.map((row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    kind: row.kind,
    actor: row.actor,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  }));
}

interface SessionRow {
  id: string;
  project_id: string;
  ticket_id: string | null;
  harness_id: string;
  harness_session_id: string | null;
  title: string;
  cwd: string;
  created_at: number;
  ended_at: number | null;
}

function exportSessions(db: Database.Database): ExportSession[] {
  const rows = prepared<[], SessionRow>(db, "SELECT * FROM sessions ORDER BY id").all();
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    harnessId: row.harness_id,
    harnessSessionId: row.harness_session_id,
    title: row.title,
    cwd: row.cwd,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  }));
}

interface TicketCommentRow {
  id: string;
  ticket_id: string;
  session_id: string | null;
  actor: string;
  body: string;
  created_at: number;
  updated_at: number;
}

function exportTicketComments(db: Database.Database): ExportTicketComment[] {
  const rows = prepared<[], TicketCommentRow>(
    db,
    "SELECT * FROM ticket_comments ORDER BY id",
  ).all();
  return rows.map((row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    sessionId: row.session_id,
    actor: row.actor,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

interface AppStateRow {
  key: string;
  value: string;
  updated_at: number;
}

function exportAppState(db: Database.Database): ExportAppState[] {
  const rows = prepared<[], AppStateRow>(db, "SELECT * FROM app_state ORDER BY key").all();
  return rows.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
}

/**
 * Builds the full export document. `schemaVersion` comes straight off the
 * db's `PRAGMA user_version` (a deterministic function of the handle, so it
 * needs no separate parameter); `appVersion`/`now` are read by the caller
 * (`app.getVersion()`/`Date.now()` in main) and passed in here so this stays
 * a pure, easily-testable function of its arguments.
 */
export function buildExportDocument(
  db: Database.Database,
  options: BuildExportDocumentOptions,
): ExportDocument {
  const schemaVersion = db.pragma("user_version", { simple: true }) as number;
  const projects = exportProjects(db);
  const ticketPrefixById = new Map(projects.map((project) => [project.id, project.ticketPrefix]));
  return {
    format: EXPORT_FORMAT,
    schemaVersion,
    appVersion: options.appVersion,
    exportedAt: new Date(options.now).toISOString(),
    projects,
    tickets: exportTickets(db, ticketPrefixById),
    labels: exportLabels(db),
    ticketLabels: exportTicketLabels(db),
    ticketEvents: exportTicketEvents(db),
    sessions: exportSessions(db),
    ticketComments: exportTicketComments(db),
    appState: exportAppState(db),
  };
}

/** Serializes an {@link ExportDocument} the way the export file is written: 2-space indent, trailing newline. */
export function serializeExportDocument(document: ExportDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** `YYYY-MM-DD` in the caller's local time zone — the save dialog's default filename stem. */
function isoDateStamp(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The save dialog's default filename, e.g. `volli-export-2026-07-15.json`. */
export function defaultExportFilename(now: Date): string {
  return `volli-export-${isoDateStamp(now)}.json`;
}
