/** Main-owned durable projection for armed-column countdowns (VC-226). */
import type Database from "better-sqlite3";
import { isTicketStatus, type PendingArmedRun } from "@volli/shared";

import { prepared } from "./prepared";

interface PendingArmedRunRow {
  ticket_id: string;
  id: string;
  project_id: string;
  ticket_display_id: string;
  automation_id: string;
  automation_name: string;
  status: string;
  origin: string;
  opened_at: number;
  start_at: number;
}

/** Fail closed on a future or hand-edited row: an unreadable countdown must never fire. */
function mapPending(row: PendingArmedRunRow): PendingArmedRun | null {
  if (!isTicketStatus(row.status)) return null;
  if (row.origin !== "armed" && row.origin !== "chosen") return null;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    projectId: row.project_id,
    ticketDisplayId: row.ticket_display_id,
    automationId: row.automation_id,
    automationName: row.automation_name,
    status: row.status,
    origin: row.origin,
    openedAt: row.opened_at,
    startAt: row.start_at,
  };
}

/** Every countdown main still owes, oldest deadline first. */
export function listPendingArmedRuns(db: Database.Database): PendingArmedRun[] {
  const rows = prepared<[], PendingArmedRunRow>(
    db,
    "SELECT * FROM automation_pending_armed_runs ORDER BY start_at, id",
  ).all();
  return rows.flatMap((row) => {
    const pending = mapPending(row);
    return pending === null ? [] : [pending];
  });
}

/** One exact arrival, or undefined when it was replaced/cancelled/already settled. */
export function getPendingArmedRun(db: Database.Database, id: string): PendingArmedRun | undefined {
  const row = prepared<[string], PendingArmedRunRow>(
    db,
    "SELECT * FROM automation_pending_armed_runs WHERE id = ?",
  ).get(id);
  if (row === undefined) return undefined;
  return mapPending(row) ?? undefined;
}

/**
 * Stores one countdown, atomically replacing any older arrival for its Ticket.
 * The unique arrival id still distinguishes a late Cancel for the old row.
 */
export function putPendingArmedRun(db: Database.Database, pending: PendingArmedRun): void {
  prepared(
    db,
    `INSERT INTO automation_pending_armed_runs
       (ticket_id, id, project_id, ticket_display_id, automation_id, automation_name,
        status, origin, opened_at, start_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (ticket_id) DO UPDATE SET
       id = excluded.id,
       project_id = excluded.project_id,
       ticket_display_id = excluded.ticket_display_id,
       automation_id = excluded.automation_id,
       automation_name = excluded.automation_name,
       status = excluded.status,
       origin = excluded.origin,
       opened_at = excluded.opened_at,
       start_at = excluded.start_at`,
  ).run(
    pending.ticketId,
    pending.id,
    pending.projectId,
    pending.ticketDisplayId,
    pending.automationId,
    pending.automationName,
    pending.status,
    pending.origin,
    pending.openedAt,
    pending.startAt,
  );
}

/** Clears whichever arrival the Ticket held, including when its new column is unarmed. */
export function deletePendingArmedRunForTicket(db: Database.Database, ticketId: string): boolean {
  return (
    prepared(db, "DELETE FROM automation_pending_armed_runs WHERE ticket_id = ?").run(ticketId)
      .changes > 0
  );
}

/** Clears only this exact move; a stale Cancel cannot delete its replacement. */
export function deletePendingArmedRun(db: Database.Database, id: string): boolean {
  return prepared(db, "DELETE FROM automation_pending_armed_runs WHERE id = ?").run(id).changes > 0;
}
