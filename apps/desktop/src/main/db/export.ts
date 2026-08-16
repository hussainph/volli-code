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

/** Any value SQLite's `json_valid` columns can carry after parsing. */
export type ExportJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ExportJsonValue[]
  | { readonly [key: string]: ExportJsonValue };

export interface ExportProject {
  id: string;
  name: string;
  path: string;
  ticketPrefix: string;
  baseBranch: string | null;
  /**
   * The monotonic ticket-number counter (migration 005). NOT derivable from
   * the exported tickets — its whole reason to exist is that `MAX(ticket_number) + 1`
   * rolls back after a hard-delete — so an export without it would hand out a
   * display id, and a worktree branch, that a deleted ticket already used.
   */
  nextTicketNumber: number;
  /** The command run in a fresh ticket worktree (migration 008), or `null` when the project sets none. */
  setupCommand: string | null;
  /**
   * The per-project theme override (migration 013), one field per surface plus
   * the auto-tint seed; `null` means that surface inherits the global theme.
   * Carried as four flat fields, mirroring the four columns — the GLOBAL theme
   * rides `app_state`, so without these an export/import round trip would drop
   * exactly half of a user's theming.
   */
  themeAppSlug: string | null;
  themeTerminalName: string | null;
  themeEditorId: string | null;
  themeSeed: string | null;
  /**
   * The per-project canvas (migration 014) as its STORED JSON string, unparsed,
   * and the appearance beside it; `null` on either means that half inherits the
   * global choice.
   *
   * Unparsed on purpose, matching {@link ExportAppState} (where the GLOBAL
   * canvas lives, under the `theme` key) rather than {@link ExportTicketEvent}.
   * Two reasons, and the second is the one that decides it: the two halves of a
   * user's theming should read the same way in the document, and a hand-edited
   * row that is no longer valid JSON must not take the whole export down with
   * it — `JSON.parse` here would throw at the one moment a user is trying to
   * rescue their data.
   */
  themeCanvas: string | null;
  themeAppearance: string | null;
  /** Per-project skills auto-disclosure consent (migration 020), as the row's 0/1. */
  skillsAutoDisclosure: number;
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
  title: string | null;
  createdAt: number;
}

export interface ExportSessionAttachment {
  id: string;
  sessionId: string;
  adapterId: string;
  venueId: string;
  venueKind: string;
  continuity: string;
  nativeId: string | null;
  /** Parsed adapter-native metadata. */
  nativeDetail: ExportJsonValue;
  observedKind: string;
  /** Parsed structured attachment failure. */
  failure: ExportJsonValue;
  createdSequence: number;
}

export interface ExportSessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  occurredAt: number;
  recordedAt: number;
  /** Parsed structured audit provenance. */
  provenance: unknown;
  attachmentId: string | null;
  commandId: string | null;
  /** Parsed immutable Session fact. */
  payload: unknown;
}

export interface ExportSessionCommand {
  id: string;
  sessionId: string;
  createdAt: number;
  /** Parsed explicit intent. */
  intent: unknown;
  /** Parsed frozen delivery route, or `null` for Session-level intent. */
  route: ExportJsonValue;
}

export interface ExportSessionCommandReceipt {
  id: string;
  sessionId: string;
  commandId: string;
  sequence: number;
  recordedAt: number;
  /** Parsed durable receipt. */
  receipt: unknown;
  receiptEventId: string | null;
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
  sessionAttachments: ExportSessionAttachment[];
  sessionEvents: ExportSessionEvent[];
  sessionCommands: ExportSessionCommand[];
  sessionCommandReceipts: ExportSessionCommandReceipt[];
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
  next_ticket_number: number;
  setup_command: string | null;
  theme_app_slug: string | null;
  theme_terminal_name: string | null;
  theme_editor_id: string | null;
  theme_seed: string | null;
  theme_canvas: string | null;
  theme_appearance: string | null;
  skills_auto_disclosure: number;
  color_index: number;
  sort_order: number;
  row_version: number;
  created_at: number;
  updated_at: number;
}

/**
 * Every live `projects` column — the flat row, not the app's `Project` model, so
 * a column added by a migration is carried whether or not the model happens to
 * surface it. The tests hold this against `PRAGMA table_info`, because a column
 * dropped here is invisible at every layer above.
 *
 * `runtime_preferences` is the one exception, and it is not a column this
 * document forgot. Migration 019 added it for the Runtime Catalog, which went
 * with the singular Pi runtime; nothing has written it since and nothing can
 * read a record back out of it. The column stays because migrations are
 * append-only, but exporting it would put a value in a user's rescue document
 * that no build will ever restore.
 */
function exportProjects(db: Database.Database): ExportProject[] {
  const rows = prepared<[], ProjectRow>(db, "SELECT * FROM projects ORDER BY id").all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    path: row.path,
    ticketPrefix: row.ticket_prefix,
    baseBranch: row.base_branch,
    nextTicketNumber: row.next_ticket_number,
    setupCommand: row.setup_command,
    themeAppSlug: row.theme_app_slug,
    themeTerminalName: row.theme_terminal_name,
    themeEditorId: row.theme_editor_id,
    themeSeed: row.theme_seed,
    themeCanvas: row.theme_canvas,
    themeAppearance: row.theme_appearance,
    skillsAutoDisclosure: row.skills_auto_disclosure,
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
  title: string | null;
  created_at: number;
}

function exportSessions(db: Database.Database): ExportSession[] {
  const rows = prepared<[], SessionRow>(
    db,
    `SELECT id, project_id, ticket_id, title, created_at
       FROM sessions ORDER BY id COLLATE BINARY`,
  ).all();
  return rows.map((session) => ({
    id: session.id,
    projectId: session.project_id,
    ticketId: session.ticket_id,
    title: session.title,
    createdAt: session.created_at,
  }));
}

interface SessionAttachmentRow {
  id: string;
  session_id: string;
  adapter_id: string;
  venue_id: string;
  venue_kind: string;
  continuity: string;
  native_id: string | null;
  native_detail: string | null;
  observed_kind: string;
  failure: string | null;
  created_sequence: number;
}

function exportSessionAttachments(db: Database.Database): ExportSessionAttachment[] {
  const rows = prepared<[], SessionAttachmentRow>(
    db,
    `SELECT id, session_id, adapter_id, venue_id, venue_kind, continuity, native_id,
            native_detail, observed_kind, failure, created_sequence
       FROM session_attachments
      ORDER BY session_id COLLATE BINARY, created_sequence, id COLLATE BINARY`,
  ).all();
  return rows.map((attachment) => ({
    id: attachment.id,
    sessionId: attachment.session_id,
    adapterId: attachment.adapter_id,
    venueId: attachment.venue_id,
    venueKind: attachment.venue_kind,
    continuity: attachment.continuity,
    nativeId: attachment.native_id,
    nativeDetail:
      attachment.native_detail === null
        ? null
        : (JSON.parse(attachment.native_detail) as ExportJsonValue),
    observedKind: attachment.observed_kind,
    failure:
      attachment.failure === null ? null : (JSON.parse(attachment.failure) as ExportJsonValue),
    createdSequence: attachment.created_sequence,
  }));
}

interface SessionEventRow {
  id: string;
  session_id: string;
  sequence: number;
  occurred_at: number;
  recorded_at: number;
  provenance: string;
  attachment_id: string | null;
  command_id: string | null;
  payload: string;
}

function exportSessionEvents(db: Database.Database): ExportSessionEvent[] {
  const rows = prepared<[], SessionEventRow>(
    db,
    `SELECT id, session_id, sequence, occurred_at, recorded_at, provenance,
            attachment_id, command_id, payload
       FROM session_events
      ORDER BY session_id COLLATE BINARY, sequence, id COLLATE BINARY`,
  ).all();
  return rows.map((event) => ({
    id: event.id,
    sessionId: event.session_id,
    sequence: event.sequence,
    occurredAt: event.occurred_at,
    recordedAt: event.recorded_at,
    provenance: JSON.parse(event.provenance) as unknown,
    attachmentId: event.attachment_id,
    commandId: event.command_id,
    payload: JSON.parse(event.payload) as unknown,
  }));
}

interface SessionCommandRow {
  id: string;
  session_id: string;
  created_at: number;
  intent: string;
  route: string | null;
}

function exportSessionCommands(db: Database.Database): ExportSessionCommand[] {
  const rows = prepared<[], SessionCommandRow>(
    db,
    `SELECT id, session_id, created_at, intent, route
       FROM session_commands
      ORDER BY session_id COLLATE BINARY, created_at, id COLLATE BINARY`,
  ).all();
  return rows.map((command) => ({
    id: command.id,
    sessionId: command.session_id,
    createdAt: command.created_at,
    intent: JSON.parse(command.intent) as unknown,
    route: command.route === null ? null : (JSON.parse(command.route) as ExportJsonValue),
  }));
}

interface SessionCommandReceiptRow {
  id: string;
  session_id: string;
  command_id: string;
  sequence: number;
  recorded_at: number;
  receipt: string;
  receipt_event_id: string | null;
}

function exportSessionCommandReceipts(db: Database.Database): ExportSessionCommandReceipt[] {
  const rows = prepared<[], SessionCommandReceiptRow>(
    db,
    `SELECT id, session_id, command_id, sequence, recorded_at, receipt, receipt_event_id
       FROM session_command_receipts
      ORDER BY session_id COLLATE BINARY, command_id COLLATE BINARY, sequence, id COLLATE BINARY`,
  ).all();
  return rows.map((receipt) => ({
    id: receipt.id,
    sessionId: receipt.session_id,
    commandId: receipt.command_id,
    sequence: receipt.sequence,
    recordedAt: receipt.recorded_at,
    receipt: JSON.parse(receipt.receipt) as unknown,
    receiptEventId: receipt.receipt_event_id,
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
    sessionAttachments: exportSessionAttachments(db),
    sessionEvents: exportSessionEvents(db),
    sessionCommands: exportSessionCommands(db),
    sessionCommandReceipts: exportSessionCommandReceipts(db),
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
