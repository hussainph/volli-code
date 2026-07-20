/**
 * `ticket_events` repo: the append-only log every ticket mutation writes to
 * in the same transaction as its row change. `actor` is always `'user'`
 * today; `'agent'`/`'automation'` arrive with the volli CLI.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  TicketEvent,
  TicketEventActor,
  TicketEventActorContext,
  TicketEventActorKind,
  TicketEventPayload,
} from "@volli/shared";
import { prepared } from "./prepared";

interface TicketEventRow {
  id: string;
  ticket_id: string;
  kind: string;
  actor: string;
  payload: string;
  created_at: number;
}

function mapTicketEvent(row: TicketEventRow): TicketEvent {
  const parsedActor = parseActor(row.actor);
  return {
    id: row.id,
    ticketId: row.ticket_id,
    actor: parsedActor.actor,
    actorContext: parsedActor.context,
    createdAt: row.created_at,
    payload: JSON.parse(row.payload) as TicketEventPayload,
  };
}

function parseActor(actor: string): {
  actor: TicketEventActorKind;
  context: TicketEventActorContext | null;
} {
  if (actor === "user") return { actor: "user", context: null };
  try {
    const parsed = JSON.parse(actor) as Partial<TicketEventActor>;
    if (
      (parsed.kind === "session" || parsed.kind === "automation") &&
      typeof parsed.sessionId === "string" &&
      (typeof parsed.ticketId === "string" || parsed.ticketId === null)
    ) {
      return {
        actor: parsed.kind,
        context: { sessionId: parsed.sessionId, ticketId: parsed.ticketId },
      };
    }
  } catch {
    // Older rows may contain a plain actor token.
  }
  return actor === "automation" || actor === "session"
    ? { actor, context: null }
    : { actor: "user", context: null };
}

function serializeActor(actor: TicketEventActor): string {
  if (actor.kind === "user") return "user";
  // A context-less system automation stores as the bare token (like "user"), so
  // parseActor's plain-token branch round-trips it back to "automation".
  if (actor.kind === "automation" && !("sessionId" in actor)) return "automation";
  return JSON.stringify(actor);
}

/**
 * A ticket editing burst collapses into one `body_edited` Activity line
 * (ticket-detail-mvp decision #11): a coalesced touch is only folded into the
 * PRIOR touch within this window of it, not the burst's original start —
 * consecutive edits keep extending the window, so only a >5-minute gap in
 * editing starts a new line.
 */
const BODY_EDITED_COALESCE_WINDOW_MS = 5 * 60 * 1000;

/** The most recently recorded event for a ticket (by `created_at`, insertion-order tiebreak), or `undefined`. */
function latestTicketEvent(db: Database.Database, ticketId: string): TicketEventRow | undefined {
  return prepared<[string], TicketEventRow>(
    db,
    "SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(ticketId);
}

/**
 * Appends one `ticket_events` row; `kind` mirrors `payload.kind`. Exception:
 * a `body_edited` payload coalesces into the ticket's latest event instead of
 * appending when that latest event is itself `body_edited` and less than
 * {@link BODY_EDITED_COALESCE_WINDOW_MS} old — only that row's `created_at`
 * is touched to `now`, so an editing burst leaves one Activity line instead
 * of one per autosave tick.
 */
export function recordTicketEvent(
  db: Database.Database,
  ticketId: string,
  payload: TicketEventPayload,
  now: number,
  actor: TicketEventActor = { kind: "user" },
): void {
  const storedActor = serializeActor(actor);
  if (payload.kind === "body_edited") {
    const latest = latestTicketEvent(db, ticketId);
    if (
      latest &&
      latest.kind === "body_edited" &&
      latest.actor === storedActor &&
      now - latest.created_at < BODY_EDITED_COALESCE_WINDOW_MS
    ) {
      prepared(db, "UPDATE ticket_events SET created_at = ? WHERE id = ?").run(now, latest.id);
      return;
    }
  }
  prepared(
    db,
    `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), ticketId, payload.kind, storedActor, JSON.stringify(payload), now);
}

/**
 * A ticket's full event history, chronological (`created_at` ascending,
 * insertion-order/`rowid` tiebreak for events sharing a timestamp) — backs
 * the Activity feed (`api.tickets.events`).
 */
export function listTicketEvents(db: Database.Database, ticketId: string): TicketEvent[] {
  const rows = prepared<[string], TicketEventRow>(
    db,
    "SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC",
  ).all(ticketId);
  return rows.map(mapTicketEvent);
}
