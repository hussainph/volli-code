/**
 * The append-only ticket event log (`ticket_events` table, migration 001):
 * every mutation records one event in the same transaction as its row
 * write. `actor` is `"user"` for everything today; `"agent"`/`"automation"`
 * arrive with the volli CLI.
 */

import type { TicketPriority, TicketStatus } from "./ticket";

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
] as const;

export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];

export type TicketEventPayload =
  | { kind: "created"; status: TicketStatus; title: string }
  | { kind: "status_changed"; from: TicketStatus; to: TicketStatus }
  | { kind: "priority_changed"; from: TicketPriority; to: TicketPriority }
  | { kind: "retitled"; from: string; to: string }
  | { kind: "body_edited" }
  | { kind: "labels_changed"; added: string[]; removed: string[] }
  | { kind: "archived" }
  | { kind: "unarchived" };

export interface TicketEvent {
  id: string;
  ticketId: string;
  actor: "user";
  /** Epoch milliseconds. */
  createdAt: number;
  payload: TicketEventPayload;
}
