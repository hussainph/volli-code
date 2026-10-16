/**
 * The spawn ledger's storage (VC-341): one insert when Volli starts a child on
 * a Session's behalf, one update when it sees that child exit, and one indexed
 * read when a sweep asks what is still open.
 *
 * Deliberately the cheapest thing that can be true. No polling, no periodic
 * reconciliation, no process table walked at spawn time: a row costs a single
 * prepared INSERT on a path that is already about to fork a process, which is
 * orders of magnitude more expensive than the row. What makes the absence of
 * reconciliation safe is that the READER never trusts a row on its own — a row
 * is only ever matched against a live process whose start time agrees with it,
 * so a row left open by a crash is inert rather than dangerous.
 *
 * Retention is by the same logic, with two horizons rather than one. An EXITED
 * row is bookkeeping about something that is over, and a week of it is plenty.
 * An OPEN row is evidence, and the evidence this feature exists for was three
 * to EIGHTEEN days old (VC-341's load audit) — pruning open rows at a week
 * would throw away exactly the rows that name the worst offenders, and a Board
 * Session's process, which no cwd sweep can see, would lose its only
 * attribution. So open rows are kept far longer
 * ({@link SPAWN_LEDGER_OPEN_RETENTION_MS}), and they mostly never reach that
 * horizon anyway: every scan closes the rows whose processes are gone, which
 * turns them into exited rows on the short clock.
 */
import type Database from "better-sqlite3";
import { isSpawnLedgerKind, type SpawnLedgerEntry, type SpawnLedgerSpawn } from "@volli/shared";

import { prepared } from "./prepared";

/** One stored row, as SQLite hands it back. */
export interface SpawnRow {
  id: string;
  session_id: string;
  ticket_id: string | null;
  project_id: string | null;
  kind: string;
  pid: number;
  pgid: number | null;
  started_at: number;
  cwd: string;
  command: string;
}

/** How long an EXITED row is kept after it stopped telling anyone anything. */
export const SPAWN_LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an OPEN row is kept: well past the 3–18 day window the orphans this
 * feature was filed about were found in, so evidence is never pruned inside it.
 */
export const SPAWN_LEDGER_OPEN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The command as the ledger keeps it: informational text for a person reading
 * the panel, bounded so a pathological one-line command cannot make the ledger
 * the largest table in the database.
 */
export const SPAWN_LEDGER_COMMAND_MAX = 2_000;

function boundedCommand(command: string): string {
  return command.length <= SPAWN_LEDGER_COMMAND_MAX
    ? command
    : `${command.slice(0, SPAWN_LEDGER_COMMAND_MAX)}…`;
}

/**
 * Fail closed on a hand-edited row: an unreadable row must never name a kill.
 *
 * Exported because the CHECK constraint blocks the bad `kind` from ever
 * reaching this through SQL, which is the point of having both — the schema
 * refuses the write and the mapper refuses the read. A rule with no reachable
 * caller is a rule nobody can test, so the test calls it directly.
 */
export function spawnLedgerEntryFrom(row: SpawnRow): SpawnLedgerEntry | null {
  if (!isSpawnLedgerKind(row.kind)) return null;
  if (!Number.isInteger(row.pid) || row.pid <= 0) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    ticketId: row.ticket_id,
    projectId: row.project_id,
    kind: row.kind,
    pid: row.pid,
    pgid: row.pgid,
    startedAt: row.started_at,
    cwd: row.cwd,
    command: row.command,
  };
}

/** Writes the row. The caller keeps the id and hands it back at exit. */
export function recordSpawn(db: Database.Database, id: string, spawn: SpawnLedgerSpawn): void {
  prepared<
    [
      string,
      string,
      string | null,
      string | null,
      string,
      number,
      number | null,
      number,
      string,
      string,
    ]
  >(
    db,
    `INSERT INTO spawned_processes
       (id, session_id, ticket_id, project_id, kind, pid, pgid, started_at, cwd, command)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    spawn.sessionId,
    spawn.ticketId,
    spawn.projectId,
    spawn.kind,
    spawn.pid,
    spawn.pgid,
    spawn.startedAt,
    spawn.cwd,
    boundedCommand(spawn.command),
  );
}

/** Marks the exit Volli observed. Idempotent: the first exit seen is the one kept. */
export function markSpawnExited(db: Database.Database, id: string, exitedAt: number): void {
  prepared<[number, string]>(
    db,
    "UPDATE spawned_processes SET exited_at = ? WHERE id = ? AND exited_at IS NULL",
  ).run(exitedAt, id);
}

/** Every row with no exit recorded, oldest first. */
export function listOpenSpawns(db: Database.Database): SpawnLedgerEntry[] {
  const rows = prepared<[], SpawnRow>(
    db,
    `SELECT id, session_id, ticket_id, project_id, kind, pid, pgid, started_at, cwd, command
       FROM spawned_processes
      WHERE exited_at IS NULL
      ORDER BY started_at ASC`,
  ).all();
  return rows.flatMap((row) => {
    const entry = spawnLedgerEntryFrom(row);
    return entry === null ? [] : [entry];
  });
}

/** Drops what no longer describes anything: old exits, and open rows past the far horizon. */
export function pruneSpawnLedger(
  db: Database.Database,
  now: number,
  retentionMs: number = SPAWN_LEDGER_RETENTION_MS,
  openRetentionMs: number = SPAWN_LEDGER_OPEN_RETENTION_MS,
): number {
  const result = prepared<[number, number]>(
    db,
    `DELETE FROM spawned_processes
      WHERE (exited_at IS NOT NULL AND exited_at < ?)
         OR (exited_at IS NULL AND started_at < ?)`,
  ).run(now - retentionMs, now - openRetentionMs);
  return result.changes;
}
