/**
 * `ticket_events` repo: the append-only log every ticket mutation writes to
 * in the same transaction as its row change.
 *
 * `actor` stores one of two shapes: a bare token (`user`, `automation`,
 * `unauthenticated`) for the kinds that carry no Session context, or JSON for
 * the ones that do. {@link parseActor} is tolerant on read because history
 * outlives the build that wrote it — but note the asymmetry it cannot avoid:
 * an unreadable token degrades to `user`, so every kind that must NOT be read
 * as the user has to be named in that branch explicitly.
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
  // `unauthenticated` joins the bare-token set (VC-163). It must be listed here
  // explicitly rather than fall through: the fallback below reads an
  // unrecognised token as `user`, which for THIS token would restore the exact
  // attribution the kind was added to replace.
  return actor === "automation" || actor === "session" || actor === "unauthenticated"
    ? { actor, context: null }
    : { actor: "user", context: null };
}

function serializeActor(actor: TicketEventActor): string {
  if (actor.kind === "user") return "user";
  // Two bare tokens beside "user", both round-tripped by parseActor's
  // plain-token branch: a context-less system automation, and an
  // unauthenticated caller, which has no context to carry by construction.
  if (actor.kind === "unauthenticated") return "unauthenticated";
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
 * Record that a Session started on this Ticket, at most once per Session
 * (VC-162).
 *
 * A Session starts exactly once, so this planner fact is about the Session
 * rather than about the act of asking for one — and asking can now happen
 * twice. A `session_start` tool call replayed by the provider re-enters the
 * whole start, where every OTHER durable write is keyed on the caller's
 * operation id and collapses: `session.create` and the kickoff `message.submit`
 * both deduplicate on their command id in the Session Engine. A ticket event
 * carries no such key, which would have left this the one write a replay
 * duplicated — one Session, one kickoff, and two "started" lines in the
 * Activity feed.
 *
 * So the fact itself is the key. Asking whether this exact Session already has
 * a `session_started` row is a question the ledger can always answer, needs
 * nothing threaded down from the caller, and is equally right for the two doors
 * that never replay (the renderer's optimistic `create`, the socket's `start`)
 * because for them it is simply never true.
 *
 * Atomic without a transaction: `better-sqlite3` is synchronous and main owns
 * the only writer, so no other JavaScript can interleave between the read and
 * the insert — there is no `await` between them to yield at.
 *
 * @returns whether this call is the one that wrote the row.
 */
export function recordSessionStartedOnce(
  db: Database.Database,
  input: { ticketId: string; sessionId: string; now: number; actor: TicketEventActor },
): boolean {
  // Keyed on kind and session id in SQL rather than folding the Ticket's whole
  // history in memory: a Ticket accumulates events for as long as it is worked,
  // and every Session start would have paid for all of them.
  const existing = prepared<[string, string], { found: number }>(
    db,
    `SELECT 1 AS found FROM ticket_events
      WHERE ticket_id = ?
        AND kind = 'session_started'
        AND json_extract(payload, '$.sessionId') = ?
      LIMIT 1`,
  ).get(input.ticketId, input.sessionId);
  if (existing !== undefined) return false;
  recordTicketEvent(
    db,
    input.ticketId,
    { kind: "session_started", sessionId: input.sessionId },
    input.now,
    input.actor,
  );
  return true;
}

/** One durable Ticket Event together with the opaque cursor after it. */
export interface SequencedTicketEvent {
  readonly event: TicketEvent;
  readonly cursor: string;
}

interface SequencedTicketEventRow extends TicketEventRow {
  sequence: number;
}

/**
 * Host-private cursor encoding. Callers copy this string; they never interpret
 * it. Keeping the storage sequence behind a versioned prefix lets a cloud host
 * use a different cursor while preserving the `ticket.await` contract.
 */
const TICKET_EVENT_CURSOR_PREFIX = "ticket-event-v1:";

export function encodeTicketEventCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Invalid Ticket Event sequence: ${String(sequence)}`);
  }
  return `${TICKET_EVENT_CURSOR_PREFIX}${sequence.toString(36)}`;
}

export function decodeTicketEventCursor(cursor: unknown): number | null {
  if (typeof cursor !== "string" || !cursor.startsWith(TICKET_EVENT_CURSOR_PREFIX)) return null;
  const encoded = cursor.slice(TICKET_EVENT_CURSOR_PREFIX.length);
  if (!/^(?:0|[1-9a-z][0-9a-z]*)$/.test(encoded)) return null;
  const sequence = Number.parseInt(encoded, 36);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

/** The database-wide high-water cursor at this instant. */
export function currentTicketEventCursor(db: Database.Database): string {
  // AUTOINCREMENT's own high-water mark, not MAX(rows): deleting the newest
  // event must not make a cursor move backwards.
  const row = prepared<[], { sequence: number }>(
    db,
    "SELECT seq AS sequence FROM sqlite_sequence WHERE name = 'ticket_event_sequence'",
  ).get();
  return encodeTicketEventCursor(row?.sequence ?? 0);
}

/**
 * Where one ticket's durable event sequence currently ends.
 *
 * This numeric mark stays inside main. `ticket-wake.ts` takes it before a
 * mutation so it can announce exactly what that transaction appended; the
 * public wait contract receives only {@link encodeTicketEventCursor}'s opaque
 * string.
 */
export function ticketEventCursor(db: Database.Database, ticketId: string): number {
  const row = prepared<[string], { sequence: number | null }>(
    db,
    "SELECT MAX(sequence) AS sequence FROM ticket_event_sequence WHERE ticket_id = ?",
  ).get(ticketId);
  return row?.sequence ?? 0;
}

/** One ticket's events appended after a local mutation mark, in commit order. */
export function listTicketEventsAfter(
  db: Database.Database,
  ticketId: string,
  sequence: number,
): SequencedTicketEvent[] {
  const rows = prepared<[string, number], SequencedTicketEventRow>(
    db,
    `SELECT e.*, ordered.sequence AS sequence
       FROM ticket_event_sequence ordered
       JOIN ticket_events e ON e.id = ordered.event_id
      WHERE ordered.ticket_id = ? AND ordered.sequence > ?
      ORDER BY ordered.sequence ASC`,
  ).all(ticketId, sequence);
  return rows.map((row) => ({
    event: mapTicketEvent(row),
    cursor: encodeTicketEventCursor(row.sequence),
  }));
}

/**
 * The first matching durable event after an opaque cursor, across a watched
 * set. One indexed query and `LIMIT 1`: a chained fleet wait never folds each
 * Ticket's history in memory.
 */
export function firstMatchingTicketEventAfter(
  db: Database.Database,
  ticketIds: readonly string[],
  eventKinds: readonly string[],
  cursor: string,
): SequencedTicketEvent | undefined {
  if (ticketIds.length === 0 || eventKinds.length === 0) return undefined;
  const sequence = decodeTicketEventCursor(cursor);
  if (sequence === null) return undefined;
  const row = prepared<[number, string, string], SequencedTicketEventRow>(
    db,
    `SELECT e.*, ordered.sequence AS sequence
       FROM ticket_event_sequence ordered
       JOIN ticket_events e ON e.id = ordered.event_id
      WHERE ordered.sequence > ?
        AND ordered.ticket_id IN (SELECT value FROM json_each(?))
        AND ordered.kind IN (SELECT value FROM json_each(?))
      ORDER BY ordered.sequence ASC
      LIMIT 1`,
  ).get(sequence, JSON.stringify(ticketIds), JSON.stringify(eventKinds));
  return row === undefined
    ? undefined
    : { event: mapTicketEvent(row), cursor: encodeTicketEventCursor(row.sequence) };
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

/** A bounded chronological tail for CLI reads; zero performs no query. */
export function listRecentTicketEvents(
  db: Database.Database,
  ticketId: string,
  limit: number,
): TicketEvent[] {
  if (limit === 0) return [];
  const rows = prepared<[string, number], TicketEventRow>(
    db,
    `SELECT * FROM ticket_events
      WHERE ticket_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
  ).all(ticketId, limit);
  return rows.toReversed().map(mapTicketEvent);
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
