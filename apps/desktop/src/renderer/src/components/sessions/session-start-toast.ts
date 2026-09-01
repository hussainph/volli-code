/**
 * Pure model for the `session started` toast (VC-13 decision 2). A start that
 * lands over the agent socket must never navigate or steal focus — main pushes
 * a `volli:session-started` notice, the renderer shows a sonner toast naming
 * the actor and ticket, and the toast's action is the ONLY door into the new
 * session's chat tab. This module only shapes the announcement; the
 * subscription + sonner call live in `main.tsx` (bootstrap glue), matching
 * `interrupt-toast.ts`.
 */
import type { SessionStartedNotice } from "../../../../ipc/contract";

export interface SessionStartToastModel {
  message: string;
  /** Where the toast's "Open session" action goes. Always present — main resolved the ticket. */
  target: { projectId: string; ticketId: string; sessionId: string };
}

/**
 * The actor phrase is door-derived provenance, worded exactly as the event log
 * attributes it: the human is "You", a driving session is named by its own
 * ticket when main could resolve one, and automation is automation.
 *
 * Exhaustive over the actor kinds rather than defaulting to "You" (VC-163).
 * `unauthenticated` cannot reach this toast today — the two remaining
 * `session.start` doors produce a Session or the person at the keyboard — but
 * the type permits it, and a default branch would have announced a caller Volli
 * could not identify as the person reading the toast. That is the whole of what
 * VC-92 §6 ruled dead, and it costs one branch to keep it dead here too.
 */
function actorPhrase(notice: SessionStartedNotice): string {
  switch (notice.actor) {
    case "session":
      return notice.actorTicket === null ? "An agent session" : `${notice.actorTicket}'s session`;
    case "automation":
      return "Automation";
    case "unauthenticated":
      return "An unauthenticated caller";
    case "user":
      return "You";
  }
}

/** Shapes one `volli:session-started` push into its toast. */
export function sessionStartToastModel(notice: SessionStartedNotice): SessionStartToastModel {
  return {
    message: `${actorPhrase(notice)} started a session on ${notice.ticketDisplayId}`,
    target: {
      projectId: notice.projectId,
      ticketId: notice.ticketId,
      sessionId: notice.sessionId,
    },
  };
}
