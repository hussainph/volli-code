import type Database from "better-sqlite3";
import type { SessionEngine } from "@volli/session-engine";
import type { SessionProjection } from "@volli/shared";
import { recordSessionResumedOnce } from "../db/events-repo";
import { prepared } from "../db/prepared";

interface ResumptionPorts {
  publish(input: { projectId: string; ticketId: string }): void;
  report(error: unknown): void;
}

/** Best-effort observer: a failed history write must not block other observers. */
export function observeSessionResumptions(
  db: Database.Database,
  projection: SessionProjection,
  ports: ResumptionPorts,
): void {
  try {
    if (recordSessionResumedOnce(db, projection)) {
      ports.publish({
        projectId: projection.session.projectId,
        ticketId: projection.session.ticketId!,
      });
    }
  } catch (error) {
    ports.report(error);
  }
}

/** Repair a quit before the coalesced activity observer, without folding every Session. */
export async function catchUpSessionResumptions(
  db: Database.Database,
  engine: Pick<SessionEngine, "getSession">,
  ports: ResumptionPorts,
): Promise<void> {
  try {
    // Both EXISTS seeks use session_event_sequence_match (session_id, kind,
    // sequence). Only Ticket Sessions with a start after a stop need folding.
    const candidates = prepared<[], { id: string }>(
      db,
      `
      SELECT s.id FROM sessions s
       WHERE s.role = 'ticket' AND s.ticket_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM session_event_sequence stopped
            WHERE stopped.session_id = s.id AND stopped.kind = 'session.stopped'
              AND EXISTS (
                SELECT 1 FROM session_event_sequence started
                 WHERE started.session_id = s.id AND started.kind = 'turn.started'
                   AND started.sequence > stopped.sequence
              )
         )
    `,
    ).all();
    for (const { id } of candidates) {
      try {
        const projection = await engine.getSession({ sessionId: id });
        if (projection !== null) observeSessionResumptions(db, projection, ports);
      } catch (error) {
        ports.report(error);
      }
    }
  } catch (error) {
    ports.report(error);
  }
}
