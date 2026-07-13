/**
 * `tickets` table repo: row↔domain mapping (snake_case → camelCase,
 * `uses_worktree` int→bool, `position`→domain `order`) plus the label-name
 * join. A ticket's `labels: string[]` are its label *names*, in insertion
 * order — read off `ticket_labels` ordered by that table's own `rowid`
 * (never explicitly stored; SQLite's implicit rowid IS the insertion
 * sequence for a table with no `WITHOUT ROWID` clause).
 */
import type Database from "better-sqlite3";
import type { ArchivedTicket, Ticket, TicketPriority, TicketStatus } from "@volli/shared";
import { prepared } from "./prepared";

export interface TicketRow {
  id: string;
  project_id: string;
  ticket_number: number;
  title: string;
  body: string;
  status: string;
  priority: string;
  uses_worktree: number;
  harness_id: string;
  position: number;
  row_version: number;
  created_at: number;
  updated_at: number;
  /** Epoch ms the ticket was archived, or `null` while it's live on the board (migration 002). */
  archived_at: number | null;
}

function mapTicket(row: TicketRow, labels: string[]): Ticket {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketNumber: row.ticket_number,
    title: row.title,
    body: row.body,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    labels,
    usesWorktree: row.uses_worktree !== 0,
    harnessId: row.harness_id,
    order: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface TicketLabelJoinRow {
  ticket_id: string;
  name: string;
}

/** Groups insertion-ordered `(ticket_id, name)` rows by ticket id. */
function groupLabelRows(rows: TicketLabelJoinRow[]): Map<string, string[]> {
  const byTicket = new Map<string, string[]>();
  for (const row of rows) {
    const names = byTicket.get(row.ticket_id);
    if (names) {
      names.push(row.name);
    } else {
      byTicket.set(row.ticket_id, [row.name]);
    }
  }
  return byTicket;
}

/** Label names for every ticket in `projectId`, insertion-ordered, grouped by ticket id. */
function labelNamesByTicket(db: Database.Database, projectId: string): Map<string, string[]> {
  const rows = prepared<[string], TicketLabelJoinRow>(
    db,
    `SELECT tl.ticket_id as ticket_id, l.name as name
       FROM ticket_labels tl
       JOIN tickets t ON t.id = tl.ticket_id
       JOIN labels l ON l.id = tl.label_id
       WHERE t.project_id = ?
       ORDER BY tl.rowid`,
  ).all(projectId);
  return groupLabelRows(rows);
}

/** One ticket's label names, insertion-ordered — used to diff `ticket.setLabels` requests. */
export function getTicketLabelNames(db: Database.Database, ticketId: string): string[] {
  const rows = prepared<[string], { name: string }>(
    db,
    `SELECT l.name as name FROM ticket_labels tl
       JOIN labels l ON l.id = tl.label_id
       WHERE tl.ticket_id = ?
       ORDER BY tl.rowid`,
  ).all(ticketId);
  return rows.map((row) => row.name);
}

/** Label names for every ticket across every project, insertion-ordered, grouped by ticket id. */
function labelNamesByTicketAll(db: Database.Database): Map<string, string[]> {
  const rows = prepared<[], TicketLabelJoinRow>(
    db,
    `SELECT tl.ticket_id as ticket_id, l.name as name
       FROM ticket_labels tl
       JOIN labels l ON l.id = tl.label_id
       ORDER BY tl.rowid`,
  ).all();
  return groupLabelRows(rows);
}

/**
 * Every LIVE ticket in a project, labels attached, ordered by column then
 * position. This is the "full authoritative list" every ticket mutation
 * IPC handler returns. Archived tickets (`archived_at IS NOT NULL`) are
 * excluded — they live in the Archive, read via {@link
 * listArchivedTicketsByProject}, never on the board.
 */
export function listTicketsByProject(db: Database.Database, projectId: string): Ticket[] {
  const rows = prepared<[string], TicketRow>(
    db,
    "SELECT * FROM tickets WHERE project_id = ? AND archived_at IS NULL ORDER BY status, position",
  ).all(projectId);
  const labelsByTicket = labelNamesByTicket(db, projectId);
  return rows.map((row) => mapTicket(row, labelsByTicket.get(row.id) ?? []));
}

/**
 * Every LIVE ticket across every project, labels attached — used only to build
 * the boot bootstrap payload. Fetches labels for every project in a single
 * query (rather than once per DISTINCT project) since this runs on the boot
 * path. Archived tickets never ride along in the boot payload; the Archive
 * view loads them on demand.
 */
export function listAllTickets(db: Database.Database): Ticket[] {
  const rows = prepared<[], TicketRow>(
    db,
    "SELECT * FROM tickets WHERE archived_at IS NULL ORDER BY project_id, status, position",
  ).all();
  const labelsByTicket = labelNamesByTicketAll(db);
  return rows.map((row) => mapTicket(row, labelsByTicket.get(row.id) ?? []));
}

/**
 * A project's archived tickets, newest-archived first, labels attached — the
 * cold-storage read behind the Archive view. Loaded on demand (an archived
 * ticket never enters the board store), so this is off the hot path; the
 * `tickets_archived` partial index (migration 002) still backs it.
 */
export function listArchivedTicketsByProject(
  db: Database.Database,
  projectId: string,
): ArchivedTicket[] {
  const rows = prepared<[string], TicketRow>(
    db,
    "SELECT * FROM tickets WHERE project_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC",
  ).all(projectId);
  const labelsByTicket = labelNamesByTicket(db, projectId);
  return rows
    .filter((row): row is TicketRow & { archived_at: number } => row.archived_at !== null)
    .map((row): ArchivedTicket => {
      // `mapTicket` returns a fresh object, so mutating it in place (rather than
      // spreading a copy per row) is safe and lint-clean.
      const ticket = mapTicket(row, labelsByTicket.get(row.id) ?? []);
      return Object.assign(ticket, { archivedAt: row.archived_at });
    });
}

/**
 * One ticket by id, labels attached — the single-row analog of
 * `listTicketsByProject`. Lets a mutation IPC handler return just the changed
 * ticket instead of re-reading the whole project list. `undefined` when no row
 * matches.
 */
export function getTicket(db: Database.Database, ticketId: string): Ticket | undefined {
  const row = getTicketRow(db, ticketId);
  if (!row) return undefined;
  return mapTicket(row, getTicketLabelNames(db, ticketId));
}

/** The raw row (no labels attached) — used internally to read current values before a mutation. */
export function getTicketRow(db: Database.Database, ticketId: string): TicketRow | undefined {
  return prepared<[string], TicketRow>(db, "SELECT * FROM tickets WHERE id = ?").get(ticketId);
}

export function nextTicketNumberForProject(db: Database.Database, projectId: string): number {
  const row = prepared<[string], { max: number | null }>(
    db,
    "SELECT MAX(ticket_number) as max FROM tickets WHERE project_id = ?",
  ).get(projectId);
  return (row?.max ?? 0) + 1;
}

/**
 * How many LIVE tickets sit in a column — i.e. the append position for the next
 * card there. Archived tickets are excluded (they hold no board slot), so both
 * a fresh create and an unarchive land at the true end of the live column.
 */
export function countTicketsInStatus(
  db: Database.Database,
  projectId: string,
  status: TicketStatus,
): number {
  const row = prepared<[string, string], { count: number }>(
    db,
    "SELECT COUNT(*) as count FROM tickets WHERE project_id = ? AND status = ? AND archived_at IS NULL",
  ).get(projectId, status);
  return row?.count ?? 0;
}

/** Inserts a brand-new ticket row (`row_version` starts at `1`); its labels start empty. */
export function insertTicket(db: Database.Database, ticket: Ticket): void {
  prepared(
    db,
    `INSERT INTO tickets
       (id, project_id, ticket_number, title, body, status, priority, uses_worktree, harness_id, position, row_version, created_at, updated_at)
     VALUES
       (@id, @projectId, @ticketNumber, @title, @body, @status, @priority, @usesWorktree, @harnessId, @position, 1, @createdAt, @updatedAt)`,
  ).run({
    id: ticket.id,
    projectId: ticket.projectId,
    ticketNumber: ticket.ticketNumber,
    title: ticket.title,
    body: ticket.body,
    status: ticket.status,
    priority: ticket.priority,
    usesWorktree: ticket.usesWorktree ? 1 : 0,
    harnessId: ticket.harnessId,
    position: ticket.order,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  });
}

/** Persists a ticket's `status`/`position` after a board move; bumps `row_version`. */
export function updateTicketPositionStatus(
  db: Database.Database,
  ticketId: string,
  status: TicketStatus,
  position: number,
  updatedAt: number,
): void {
  prepared(
    db,
    "UPDATE tickets SET status = ?, position = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?",
  ).run(status, position, updatedAt, ticketId);
}

export function updateTicketPriority(
  db: Database.Database,
  ticketId: string,
  priority: TicketPriority,
  updatedAt: number,
): void {
  prepared(
    db,
    "UPDATE tickets SET priority = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?",
  ).run(priority, updatedAt, ticketId);
}

export interface TicketFieldUpdate {
  title?: string;
  body?: string;
}

/** Applies whichever of `title`/`body` are present; bumps `row_version`. No-ops when neither is set. */
export function updateTicketFields(
  db: Database.Database,
  ticketId: string,
  fields: TicketFieldUpdate,
  updatedAt: number,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.title !== undefined) {
    sets.push("title = ?");
    params.push(fields.title);
  }
  if (fields.body !== undefined) {
    sets.push("body = ?");
    params.push(fields.body);
  }
  if (sets.length === 0) return;
  sets.push("row_version = row_version + 1", "updated_at = ?");
  params.push(updatedAt, ticketId);
  prepared(db, `UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

/** Bumps `row_version`/`updated_at` alone — used after a `ticket_labels` junction change. */
export function bumpTicketVersion(
  db: Database.Database,
  ticketId: string,
  updatedAt: number,
): void {
  prepared(db, "UPDATE tickets SET row_version = row_version + 1, updated_at = ? WHERE id = ?").run(
    updatedAt,
    ticketId,
  );
}

/**
 * Marks a ticket archived (stamps `archived_at`) — it leaves the board but the
 * row, its labels, and its event log all survive. `status` is untouched, so an
 * unarchive returns it to the same column. A no-op reflow of the gap it leaves
 * in that column is unnecessary: the board tolerates position gaps (a later
 * move normalizes them), exactly as it already does after a cross-column move.
 */
export function archiveTicket(db: Database.Database, ticketId: string, now: number): void {
  prepared(
    db,
    "UPDATE tickets SET archived_at = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?",
  ).run(now, now, ticketId);
}

/**
 * Returns an archived ticket to the board: clears `archived_at` and re-seats it
 * at `position` (the caller passes the live end-of-column slot from
 * {@link countTicketsInStatus}, so it can't collide with a card that took its
 * old spot while it was gone).
 */
export function unarchiveTicket(
  db: Database.Database,
  ticketId: string,
  position: number,
  now: number,
): void {
  prepared(
    db,
    "UPDATE tickets SET archived_at = NULL, position = ?, row_version = row_version + 1, updated_at = ? WHERE id = ?",
  ).run(position, now, ticketId);
}

/**
 * The only destructive act (CONCEPT #16/#92): hard-deletes a ticket. Its
 * `ticket_labels` and `ticket_events` rows go with it via the migration-001 FK
 * cascades. Callers gate this to archived tickets behind an explicit confirm.
 */
export function deleteTicket(db: Database.Database, ticketId: string): void {
  prepared(db, "DELETE FROM tickets WHERE id = ?").run(ticketId);
}
