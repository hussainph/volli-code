/**
 * `ticket_events` repo: the append-only log every ticket mutation writes to
 * in the same transaction as its row change. `actor` is always `'user'`
 * today; `'agent'`/`'automation'` arrive with the volli CLI.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { TicketEventPayload } from "@volli/shared";
import { prepared } from "./prepared";

/** Appends one `ticket_events` row; `kind` mirrors `payload.kind`. */
export function recordTicketEvent(
  db: Database.Database,
  ticketId: string,
  payload: TicketEventPayload,
  now: number,
): void {
  prepared(
    db,
    `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
     VALUES (?, ?, ?, 'user', ?, ?)`,
  ).run(randomUUID(), ticketId, payload.kind, JSON.stringify(payload), now);
}
