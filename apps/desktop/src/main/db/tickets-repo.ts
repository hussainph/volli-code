/**
 * `tickets` table repo: row↔domain mapping (snake_case → camelCase,
 * `uses_worktree` int→bool, `position`→domain `order`) plus the label-name
 * join. A ticket's `labels: string[]` are its label *names*, in insertion
 * order — read off `ticket_labels` ordered by that table's own `rowid`
 * (never explicitly stored; SQLite's implicit rowid IS the insertion
 * sequence for a table with no `WITHOUT ROWID` clause).
 */
import type Database from "better-sqlite3";
import {
  isTicketStatus,
  type ArchivedTicket,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";
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
  preferred_harness_id: string;
  position: number;
  row_version: number;
  created_at: number;
  updated_at: number;
  /** Epoch ms the ticket was archived, or `null` while it's live on the board (migration 002). */
  archived_at: number | null;
  /** First-class worktree identity (migration 003) — all three `null` until a worktree exists. */
  worktree_path: string | null;
  branch: string | null;
  base_branch: string | null;
}

/**
 * Whether `row.status` is one of the known {@link TicketStatus} values —
 * the guard every row→domain read path in this module runs before
 * `mapTicket` trusts the `as TicketStatus` cast. The migration-001 `CHECK`
 * constraint keeps this true for ordinary writes, but it doesn't cover a
 * future enum-rename migration that skips rewriting existing rows, or an
 * external writer (the planned `volli` CLI) hitting a stale schema. Without
 * this guard an unknown status reaches the renderer's `groupTicketsByStatus`,
 * which has no fallback bucket for it and throws on every board render —
 * so a row that fails this check is dropped rather than mapped, with one
 * `console.warn` identifying the ticket id and the bad status for
 * visibility at the dev level.
 */
function hasKnownStatus(row: TicketRow): boolean {
  if (isTicketStatus(row.status)) return true;
  console.warn(`[volli] dropping ticket ${row.id} with unknown status "${row.status}"`);
  return false;
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
    preferredHarnessId: row.preferred_harness_id as Ticket["preferredHarnessId"],
    order: row.position,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
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

/**
 * Label names for every LIVE or every ARCHIVED ticket in `projectId` (per
 * `scope`), insertion-ordered, grouped by ticket id. Scoped because the two
 * callers never want the other half: `listTicketsByProject` runs inside every
 * ticket-move transaction, and without the predicate it would drag every
 * archived ticket's label rows through the join just to discard them — a cost
 * that grows with the archive, on the hot path.
 */
function labelNamesByTicket(
  db: Database.Database,
  projectId: string,
  scope: "live" | "archived",
): Map<string, string[]> {
  const rows = prepared<[string], TicketLabelJoinRow>(
    db,
    `SELECT tl.ticket_id as ticket_id, l.name as name
       FROM ticket_labels tl
       JOIN tickets t ON t.id = tl.ticket_id
       JOIN labels l ON l.id = tl.label_id
       WHERE t.project_id = ? AND t.archived_at IS ${scope === "live" ? "NULL" : "NOT NULL"}
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
  const labelsByTicket = labelNamesByTicket(db, projectId, "live");
  return rows.filter(hasKnownStatus).map((row) => mapTicket(row, labelsByTicket.get(row.id) ?? []));
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
  return rows.filter(hasKnownStatus).map((row) => mapTicket(row, labelsByTicket.get(row.id) ?? []));
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
  // The WHERE clause guarantees `archived_at` is non-null — trusted via the
  // row type, unlike `status`, which still runs through `hasKnownStatus`
  // below rather than being cast blind.
  const rows = prepared<[string], TicketRow & { archived_at: number }>(
    db,
    "SELECT * FROM tickets WHERE project_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC",
  ).all(projectId);
  const labelsByTicket = labelNamesByTicket(db, projectId, "archived");
  return rows.filter(hasKnownStatus).map((row): ArchivedTicket => {
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
 * matches — and, deliberately, the same `undefined` when the row exists but
 * fails {@link hasKnownStatus}: mutation handlers already treat "no ticket"
 * as an `Unknown ticket` error surfaced to the renderer, so a corrupt row
 * rides that same path instead of a new failure mode.
 */
export function getTicket(db: Database.Database, ticketId: string): Ticket | undefined {
  const row = getTicketRow(db, ticketId);
  if (!row || !hasKnownStatus(row)) return undefined;
  return mapTicket(row, getTicketLabelNames(db, ticketId));
}

/** The raw row (no labels attached) — used internally to read current values before a mutation. */
export function getTicketRow(db: Database.Database, ticketId: string): TicketRow | undefined {
  return prepared<[string], TicketRow>(db, "SELECT * FROM tickets WHERE id = ?").get(ticketId);
}

/**
 * Every non-null `worktree_path` across ALL tickets — live AND archived. The
 * startup orphan sweep (worktree/sweep.ts) diffs this DB-known set against the
 * worktrees git actually has registered, so an archived ticket's retained
 * worktree is never mistaken for an orphan.
 */
export function listWorktreePaths(db: Database.Database): string[] {
  const rows = prepared<[], { worktree_path: string }>(
    db,
    "SELECT worktree_path FROM tickets WHERE worktree_path IS NOT NULL",
  ).all();
  return rows.map((row) => row.worktree_path);
}

/**
 * Allocates the next display ticket number for a project and durably bumps
 * `projects.next_ticket_number` (migration 005) in the same call — the
 * counter only ever moves forward, so once a number is handed out it can
 * never be handed out again, even after the ticket that used it is
 * hard-deleted from the archive (the bug this counter replaces: plain
 * `MAX(ticket_number) + 1` over the *remaining* rows let a delete free up
 * the highest number for reuse, colliding with the deleted ticket's
 * still-live worktree branch).
 *
 * Belt-and-braces: the allocated number is `MAX(counter, MAX(ticket_number) +
 * 1)`, not just the counter, so a stale or corrupt counter (e.g. a hand-built
 * fixture, or a row that predates this migration's backfill) can never
 * allocate a number that collides with a live ticket row — the live rows'
 * own max always wins if the counter somehow fell behind them.
 *
 * Self-contained in its own transaction so the read-then-write is atomic
 * even when called standalone; better-sqlite3 nests this as a SAVEPOINT when
 * invoked from inside the caller's own transaction (as `volli:ticket-create`
 * does), so it composes with the ticket INSERT it's paired with.
 */
export function nextTicketNumberForProject(db: Database.Database, projectId: string): number {
  const allocate = db.transaction((): number => {
    const project = prepared<[string], { next_ticket_number: number }>(
      db,
      "SELECT next_ticket_number FROM projects WHERE id = ?",
    ).get(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);

    const maxRow = prepared<[string], { max: number | null }>(
      db,
      "SELECT MAX(ticket_number) as max FROM tickets WHERE project_id = ?",
    ).get(projectId);
    const floor = (maxRow?.max ?? 0) + 1;
    const allocated = Math.max(project.next_ticket_number, floor);

    prepared(db, "UPDATE projects SET next_ticket_number = ? WHERE id = ?").run(
      allocated + 1,
      projectId,
    );
    return allocated;
  });
  return allocate();
}

/**
 * The append position for the next card in a column: one past the highest LIVE
 * position there (archived tickets hold no board slot). MAX+1, not COUNT —
 * archiving leaves gaps in a column's positions, so a count can land ON an
 * existing card's position (duplicate positions, card sorted mid-column);
 * MAX+1 is collision-proof no matter how gappy the column is.
 */
export function nextPositionInStatus(
  db: Database.Database,
  projectId: string,
  status: TicketStatus,
): number {
  const row = prepared<[string, string], { next: number }>(
    db,
    "SELECT COALESCE(MAX(position), -1) + 1 as next FROM tickets WHERE project_id = ? AND status = ? AND archived_at IS NULL",
  ).get(projectId, status);
  return row?.next ?? 0;
}

/** Inserts a brand-new ticket row (`row_version` starts at `1`); its labels start empty. */
export function insertTicket(db: Database.Database, ticket: Ticket): void {
  prepared(
    db,
    `INSERT INTO tickets
       (id, project_id, ticket_number, title, body, status, priority, uses_worktree, preferred_harness_id, position, worktree_path, branch, base_branch, row_version, created_at, updated_at)
     VALUES
       (@id, @projectId, @ticketNumber, @title, @body, @status, @priority, @usesWorktree, @preferredHarnessId, @position, @worktreePath, @branch, @baseBranch, 1, @createdAt, @updatedAt)`,
  ).run({
    id: ticket.id,
    projectId: ticket.projectId,
    ticketNumber: ticket.ticketNumber,
    title: ticket.title,
    body: ticket.body,
    status: ticket.status,
    priority: ticket.priority,
    usesWorktree: ticket.usesWorktree ? 1 : 0,
    preferredHarnessId: ticket.preferredHarnessId,
    position: ticket.order,
    worktreePath: ticket.worktreePath,
    branch: ticket.branch,
    baseBranch: ticket.baseBranch,
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
  /** First-class worktree identity (migration 003); `null` clears the field. */
  worktreePath?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  preferredHarnessId?: Ticket["preferredHarnessId"];
}

/**
 * Applies whichever of `title`/`body`/`worktreePath`/`branch`/`baseBranch` are
 * present (including explicit `null` for the worktree fields, distinct from
 * "not present"); bumps `row_version`. No-ops when nothing is set.
 */
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
  if (fields.worktreePath !== undefined) {
    sets.push("worktree_path = ?");
    params.push(fields.worktreePath);
  }
  if (fields.branch !== undefined) {
    sets.push("branch = ?");
    params.push(fields.branch);
  }
  if (fields.baseBranch !== undefined) {
    sets.push("base_branch = ?");
    params.push(fields.baseBranch);
  }
  if (fields.preferredHarnessId !== undefined) {
    sets.push("preferred_harness_id = ?");
    params.push(fields.preferredHarnessId);
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
 * {@link nextPositionInStatus}, so it can't collide with a card that took its
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
