/**
 * `sessions` table repo (migration 003): row↔domain mapping and CRUD for the
 * durable session trace/resume-seed record, distinct from a session's live
 * in-memory PTY state (`TerminalEngine`/renderer `stores/sessions.ts`). Pure
 * persistence only — no `ticket_events` writes here. `session_started`/
 * `session_ended` events are recorded by the runtime layer that owns the PTY
 * lifecycle, alongside the calls to {@link insertSession}/{@link endSession}
 * below, not by this repo.
 */
import type Database from "better-sqlite3";
import type { HarnessId, SessionRecord } from "@volli/shared";
import { prepared } from "./prepared";

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

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ticketId: row.ticket_id,
    harnessId: row.harness_id as HarnessId,
    harnessSessionId: row.harness_session_id,
    title: row.title,
    cwd: row.cwd,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

/** Inserts a brand-new session row from an already-built {@link SessionRecord} (see `createSessionRecord`). */
export function insertSession(db: Database.Database, session: SessionRecord): void {
  prepared(
    db,
    `INSERT INTO sessions
       (id, project_id, ticket_id, harness_id, harness_session_id, title, cwd, created_at, ended_at)
     VALUES
       (@id, @projectId, @ticketId, @harnessId, @harnessSessionId, @title, @cwd, @createdAt, @endedAt)`,
  ).run({
    id: session.id,
    projectId: session.projectId,
    ticketId: session.ticketId,
    harnessId: session.harnessId,
    harnessSessionId: session.harnessSessionId,
    title: session.title,
    cwd: session.cwd,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
  });
}

/** Stamps `ended_at` — marks a session as no longer live. */
export function endSession(db: Database.Database, sessionId: string, endedAt: number): void {
  prepared(db, "UPDATE sessions SET ended_at = ? WHERE id = ?").run(endedAt, sessionId);
}

/** Fills in the harness's own resume/session UUID once the harness reports it (hooks/the volli CLI). */
export function setHarnessSessionId(
  db: Database.Database,
  sessionId: string,
  harnessSessionId: string,
): void {
  prepared(db, "UPDATE sessions SET harness_session_id = ? WHERE id = ?").run(
    harnessSessionId,
    sessionId,
  );
}

/** Every session in a project — both ticket-scoped and project-scoped scratch sessions — newest first. */
export function listSessions(db: Database.Database, projectId: string): SessionRecord[] {
  const rows = prepared<[string], SessionRow>(
    db,
    "SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC",
  ).all(projectId);
  return rows.map(mapSession);
}

/** A ticket's sessions, newest first — backs the right-rail linked-sessions list. */
export function listTicketSessions(db: Database.Database, ticketId: string): SessionRecord[] {
  const rows = prepared<[string], SessionRow>(
    db,
    "SELECT * FROM sessions WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC",
  ).all(ticketId);
  return rows.map(mapSession);
}
