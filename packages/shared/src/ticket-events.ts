/**
 * The append-only ticket event log (`ticket_events` table, migration 001):
 * every mutation records one event in the same transaction as its row
 * write. `actor` is `"user"` for everything today; `"agent"`/`"automation"`
 * arrive with the volli CLI.
 */

import type { SessionLaunchKind, SessionPlacement } from "./session";
import type { HarnessId, TicketPriority, TicketStatus } from "./ticket";

export const TICKET_EVENT_KINDS = [
  "created",
  "status_changed",
  "priority_changed",
  "retitled",
  "body_edited",
  "labels_changed",
  // Lifecycle: leaving/returning to the board. Archiving is reversible and
  // retains everything (event log, transcripts, branch, PR — CONCEPT #16/#92);
  // the ticket's `status` is untouched, so no from/to is recorded. Hard delete
  // is the only destructive act and records nothing — the row and its events
  // vanish together in the FK cascade.
  "archived",
  "unarchived",
  // Sessions & comments (ticket-detail-mvp #18/#22): a comment's body lives
  // in `ticket_comments` (`ticket-comment.ts`) — this event only makes it
  // discoverable from the event log without duplicating it. Session events
  // are recorded from main on PTY boot/exit.
  "commented",
  "session_started",
  "session_ended",
  // Worktree identity (ticket-detail-mvp #14 vision anchor): settable now,
  // automated later — `from`/`to` snapshot the ticket's worktree identity
  // fields (`ticket.ts`) around the change.
  "worktree_changed",
] as const;

export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];

/**
 * A ticket's worktree identity, as snapshotted by `worktree_changed`. Mirrors
 * the `Ticket.worktreePath`/`branch`/`baseBranch` fields (`ticket.ts`).
 */
export interface WorktreeIdentity {
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
}

export type TicketEventPayload =
  | { kind: "created"; status: TicketStatus; title: string }
  | { kind: "status_changed"; from: TicketStatus; to: TicketStatus }
  | { kind: "priority_changed"; from: TicketPriority; to: TicketPriority }
  | { kind: "retitled"; from: string; to: string }
  | { kind: "body_edited" }
  | { kind: "labels_changed"; added: string[]; removed: string[] }
  | { kind: "archived" }
  | { kind: "unarchived" }
  | { kind: "commented"; commentId: string }
  | {
      kind: "session_started";
      sessionId: string;
      title: string;
      /** Optional for records written before migration 006. */
      launchKind?: SessionLaunchKind;
      /** Optional for records written before migration 006. */
      placement?: SessionPlacement;
      /** Present only when the session actually launched an agent harness. */
      harnessId?: HarnessId;
    }
  | { kind: "session_ended"; sessionId: string }
  | { kind: "worktree_changed"; from: WorktreeIdentity; to: WorktreeIdentity };

export interface TicketEvent {
  id: string;
  ticketId: string;
  actor: "user";
  /** Epoch milliseconds. */
  createdAt: number;
  payload: TicketEventPayload;
}
