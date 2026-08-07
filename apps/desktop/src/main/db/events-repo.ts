/**
 * `ticket_events` repo: the append-only log every ticket mutation writes to
 * in the same transaction as its row change. `actor` is always `'user'`
 * today; `'agent'`/`'automation'` arrive with the volli CLI.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  isTicketStatus,
  type TicketEvent,
  type TicketEventActor,
  type TicketEventActorContext,
  type TicketEventActorKind,
  type TicketEventPayload,
  type TicketStatusEntry,
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

interface TicketStatusEntryRow {
  ticket_id: string;
  status: string;
  entered_at: number;
}

/**
 * When each of a project's non-archived tickets entered its CURRENT status —
 * one batched read backing the sidebar (`volli:ticket-status-entries`).
 * `enteredAt` is the `created_at` of the ticket's newest `status_changed`
 * event (a same-column reorder writes no event, so this is stable across
 * reorders), falling back to the ticket's own `created_at` when it has never
 * changed status (born into its current column). One query — the per-ticket
 * "latest status_changed" lookup is a windowed rank inside the SQL, not a
 * per-ticket round trip from JS.
 */
export function listTicketStatusEntries(
  db: Database.Database,
  projectId: string,
): TicketStatusEntry[] {
  const rows = prepared<[string], TicketStatusEntryRow>(
    db,
    `WITH project_tickets AS (
       SELECT id, status, created_at FROM tickets
        WHERE project_id = ? AND archived_at IS NULL
     ), latest_status_change AS (
       SELECT e.ticket_id AS ticket_id,
              e.created_at AS created_at,
              ROW_NUMBER() OVER (
                PARTITION BY e.ticket_id ORDER BY e.created_at DESC, e.rowid DESC
              ) AS rn
         FROM ticket_events e
         JOIN project_tickets pt ON pt.id = e.ticket_id
        WHERE e.kind = 'status_changed'
     )
     SELECT pt.id AS ticket_id,
            pt.status AS status,
            COALESCE(ls.created_at, pt.created_at) AS entered_at
       FROM project_tickets pt
       LEFT JOIN latest_status_change ls ON ls.ticket_id = pt.id AND ls.rn = 1
      ORDER BY pt.id COLLATE BINARY ASC`,
  ).all(projectId);
  const entries: TicketStatusEntry[] = [];
  for (const row of rows) {
    if (!isTicketStatus(row.status)) {
      console.warn(`[volli] dropping ticket ${row.ticket_id} with unknown status "${row.status}"`);
      continue;
    }
    entries.push({
      ticketId: row.ticket_id,
      status: row.status,
      enteredAt: row.entered_at,
    });
  }
  return entries;
}
