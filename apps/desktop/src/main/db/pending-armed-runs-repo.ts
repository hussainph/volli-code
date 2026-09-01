/** Main-owned durable countdowns and retained expiry attempts (VC-226, VC-228). */
import type Database from "better-sqlite3";
import { isTicketStatus, type PendingArmedRun, type PendingArmedRunAttempt } from "@volli/shared";

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

interface PendingArmedRunAttemptRow extends PendingArmedRunRow {
  command_id: string;
  error: string;
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

function mapAttempt(row: PendingArmedRunAttemptRow): PendingArmedRunAttempt | null {
  const pending = mapPending(row);
  if (pending === null || row.command_id.length === 0 || row.error.length === 0) return null;
  return { pending, commandId: row.command_id, error: row.error };
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

/**
 * Atomically closes one countdown and retains the command id its Run will use.
 * A duplicate expiry callback loses the delete race and cannot mint an attempt.
 */
export function beginPendingArmedRunAttempt(
  db: Database.Database,
  id: string,
  commandId: string,
  fallbackError: string,
): PendingArmedRunAttempt | undefined {
  const transition = db.transaction((): PendingArmedRunAttempt | undefined => {
    const pending = getPendingArmedRun(db, id);
    if (pending === undefined) return undefined;

    prepared(
      db,
      `INSERT INTO automation_pending_armed_run_attempts
         (id, command_id, ticket_id, project_id, ticket_display_id, automation_id,
          automation_name, status, origin, opened_at, start_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pending.id,
      commandId,
      pending.ticketId,
      pending.projectId,
      pending.ticketDisplayId,
      pending.automationId,
      pending.automationName,
      pending.status,
      pending.origin,
      pending.openedAt,
      pending.startAt,
      fallbackError,
    );
    const deleted = prepared(db, "DELETE FROM automation_pending_armed_runs WHERE id = ?").run(id);
    if (deleted.changes !== 1) {
      throw new Error(`Pending armed Run ${id} disappeared during attempt transition`);
    }
    return { pending, commandId, error: fallbackError };
  });
  return transition();
}

/** Retained attempts are ordered by their original deadlines for deterministic priming. */
export function listPendingArmedRunAttempts(db: Database.Database): PendingArmedRunAttempt[] {
  const rows = prepared<[], PendingArmedRunAttemptRow>(
    db,
    "SELECT * FROM automation_pending_armed_run_attempts ORDER BY start_at, id",
  ).all();
  return rows.flatMap((row) => {
    const attempt = mapAttempt(row);
    return attempt === null ? [] : [attempt];
  });
}

/** One exact expired arrival and its retained Run command. */
export function getPendingArmedRunAttempt(
  db: Database.Database,
  id: string,
): PendingArmedRunAttempt | undefined {
  const row = prepared<[string], PendingArmedRunAttemptRow>(
    db,
    "SELECT * FROM automation_pending_armed_run_attempts WHERE id = ?",
  ).get(id);
  if (row === undefined) return undefined;
  return mapAttempt(row) ?? undefined;
}

/** Updates only diagnosis; the command id and Run identity are immutable through this repository. */
export function updatePendingArmedRunAttemptError(
  db: Database.Database,
  id: string,
  error: string,
): boolean {
  return (
    prepared(db, "UPDATE automation_pending_armed_run_attempts SET error = ? WHERE id = ?").run(
      error,
      id,
    ).changes > 0
  );
}

/** A typed Run answer makes this retained retry intent complete. */
export function deletePendingArmedRunAttempt(db: Database.Database, id: string): boolean {
  return (
    prepared(db, "DELETE FROM automation_pending_armed_run_attempts WHERE id = ?").run(id).changes >
    0
  );
}
