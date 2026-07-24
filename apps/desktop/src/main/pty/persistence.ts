import type Database from "better-sqlite3";
import { errorMessage } from "@volli/shared";
import type { SessionRecord } from "@volli/shared";
import { recordTicketEvent } from "../db/events-repo";
import { endSession, getSessionTicketId, insertSession } from "../db/sessions-repo";

/**
 * Persists a freshly-spawned session's durable trace: the `sessions` row and,
 * for a ticket-linked session, its `session_started` ticket event — in one
 * transaction so a partial write can never leave the row without its event.
 * THROWS on failure (an unknown-project FK, a closed db): the caller kills the
 * orphan pty and surfaces the error, so a failed persist never leaves an agent
 * running.
 */
export function persistSessionStart(
  db: Database.Database,
  record: SessionRecord,
  resume: { previousSessionId: string; harnessSessionId: string | null } | null,
  now: number,
): void {
  // A resume inherits the ended session's best-known resume seed, so a
  // follow-up interrupt/resume keeps a valid `--resume <id>` until the harness
  // re-`link`s a fresh one. Set before insert so it persists.
  if (resume !== null && resume.harnessSessionId !== null) {
    record.harnessSessionId = resume.harnessSessionId;
  }
  const persist = db.transaction(() => {
    insertSession(db, record);
    if (record.ticketId !== null) {
      recordTicketEvent(
        db,
        record.ticketId,
        {
          kind: "session_started",
          sessionId: record.id,
          title: record.title,
          launchKind: record.launchKind,
          placement: record.placement,
          ...(record.launchKind === "agent" ? { harnessId: record.harnessId } : {}),
        },
        now,
      );
      // A resume also links the new session to the one it picks up from.
      if (resume !== null) {
        recordTicketEvent(
          db,
          record.ticketId,
          {
            kind: "session_resumed",
            sessionId: record.id,
            previousSessionId: resume.previousSessionId,
          },
          now,
        );
      }
    }
  });
  persist();
}

/**
 * Closes out a session whose PTY has exited: stamps `ended_at`/`exit_code` on
 * the row and, for a still-linked ticket session, records `session_ended` — in
 * one transaction. NEVER throws: nothing about closing out the record may
 * prevent the caller's renderer exit notification or its own cleanup.
 */
export function closeOutSession(
  db: Database.Database,
  sessionId: string,
  endedAt: number,
  exitCode: number,
): void {
  try {
    const end = db.transaction(() => {
      endSession(db, sessionId, endedAt, exitCode);
      // Resolve the ticket link from the CURRENT row, never a stale in-memory
      // capture: `sessions.ticket_id` is ON DELETE SET NULL, so a ticket (or its
      // project) deleted while the session lived leaves this null. Recording
      // `session_ended` off a stale capture would then violate the ticket_events
      // FK, roll the whole transaction back, and strand the row as falsely-live.
      const ticketId = getSessionTicketId(db, sessionId);
      if (ticketId !== null) {
        recordTicketEvent(db, ticketId, { kind: "session_ended", sessionId }, endedAt);
      }
    });
    end();
  } catch (error) {
    // Nothing about closing out the record may prevent the renderer's exit
    // notification or the manager's own cleanup. Log it, then make a best-effort
    // bare endSession outside the transaction so the row isn't stranded as
    // falsely-live (endLiveSessions sweeps any residue on the next boot).
    console.error(`[volli] failed to close out session ${sessionId}: ${errorMessage(error)}`);
    try {
      endSession(db, sessionId, endedAt, exitCode);
    } catch {
      // Even the bare end failed (e.g. the db is gone) — leave it to the
      // boot-time endLiveSessions sweep.
    }
  }
}
