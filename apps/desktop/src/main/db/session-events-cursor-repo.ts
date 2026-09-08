/**
 * `session_event_sequence` repo: the total order over Session Events, and the
 * opaque cursor `session_await` chains (VC-324 item 3).
 *
 * `events-repo.ts`'s cursor half, one ledger over. It is a separate file
 * rather than three more functions in the Session ledger for two reasons: the
 * ledger (`session-control/sqlite-ledger.ts`) is the Session Engine's storage
 * port and knows nothing about waiting, and this table is a host-private
 * materialization a future cloud event store would replace wholesale while
 * keeping the tool contract (docs/BOUNDARIES.md).
 *
 * ## Why the sequence exists at all
 *
 * `session_events` is `UNIQUE(session_id, sequence)`: the Session Engine
 * assigns that number per Session, so it orders one Session's history and says
 * nothing about the order two Sessions' facts were committed in. A wait over a
 * fleet asks exactly the question that ordering cannot answer — "the first
 * matching event after this point, across these handles" — so migration 042
 * adds an AUTOINCREMENT side table filled by an `AFTER INSERT` trigger, and
 * this module is the only reader of it.
 *
 * ## The cursor is ledger order, never a clock
 *
 * `occurred_at` is metadata: two commits can share a millisecond, and a
 * timestamp is what a source claimed rather than when Volli recorded it.
 * CONTEXT.md's Await entry states the rule; this module is where it is kept.
 */

import type Database from "better-sqlite3";
import {
  decodeSessionEventPayload,
  decodeSessionEventProvenance,
  type SessionEvent,
} from "@volli/shared";

import { prepared } from "./prepared";

/** One durable Session Event together with the opaque cursor after it. */
export interface SequencedSessionEvent {
  readonly event: SessionEvent;
  readonly cursor: string;
}

interface SequencedSessionEventRow {
  id: string;
  session_id: string;
  sequence: number;
  occurred_at: number;
  recorded_at: number;
  provenance: string;
  attachment_id: string | null;
  command_id: string | null;
  payload: string;
  ordered_sequence: number;
}

/**
 * Host-private cursor encoding. Callers copy this string; they never interpret
 * it. Keeping the storage sequence behind a versioned prefix lets a cloud host
 * use a different cursor while preserving the `session.await` contract — and
 * the prefix differs from the Ticket one so a cursor handed to the wrong tool
 * is refused rather than silently read as another ledger's position.
 */
const SESSION_EVENT_CURSOR_PREFIX = "session-event-v1:";

export function encodeSessionEventCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Invalid Session Event sequence: ${String(sequence)}`);
  }
  return `${SESSION_EVENT_CURSOR_PREFIX}${sequence.toString(36)}`;
}

export function decodeSessionEventCursor(cursor: unknown): number | null {
  if (typeof cursor !== "string" || !cursor.startsWith(SESSION_EVENT_CURSOR_PREFIX)) return null;
  const encoded = cursor.slice(SESSION_EVENT_CURSOR_PREFIX.length);
  if (!/^(?:0|[1-9a-z][0-9a-z]*)$/.test(encoded)) return null;
  const sequence = Number.parseInt(encoded, 36);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

/**
 * The database-wide high-water mark at this instant, as a number.
 *
 * AUTOINCREMENT's own mark rather than `MAX(sequence)`: deleting the newest
 * event — a Session delete cascades this whole table — must not make a cursor
 * move backwards and replay history as new. The numeric form stays inside
 * main; `session-wake.ts` marks its drain with it and the public wait contract
 * receives only {@link encodeSessionEventCursor}'s opaque string.
 */
export function currentSessionEventSequence(db: Database.Database): number {
  const row = prepared<[], { sequence: number }>(
    db,
    "SELECT seq AS sequence FROM sqlite_sequence WHERE name = 'session_event_sequence'",
  ).get();
  return row?.sequence ?? 0;
}

/** The database-wide high-water cursor at this instant, opaque. */
export function currentSessionEventCursor(db: Database.Database): string {
  return encodeSessionEventCursor(currentSessionEventSequence(db));
}

const SEQUENCED_COLUMNS = `e.id, e.session_id, e.sequence, e.occurred_at, e.recorded_at,
         e.provenance, e.attachment_id, e.command_id, e.payload,
         ordered.sequence AS ordered_sequence`;

/**
 * Every Session Event committed after a numeric mark, in ledger order.
 *
 * The wake bus's whole read: it takes a mark, lets a write commit, and asks
 * what appeared above it. Unbounded by design — a mark is taken before each
 * mutating engine call and the answer is the handful of events that one call
 * appended, never a history.
 */
export function listSessionEventsAfter(
  db: Database.Database,
  sequence: number,
): SequencedSessionEvent[] {
  const rows = prepared<[number], SequencedSessionEventRow>(
    db,
    `SELECT ${SEQUENCED_COLUMNS}
       FROM session_event_sequence ordered
       JOIN session_events e ON e.id = ordered.event_id
      WHERE ordered.sequence > ?
      ORDER BY ordered.sequence ASC`,
  ).all(sequence);
  return rows.map(mapSequenced);
}

/**
 * The first matching durable event after an opaque cursor, across a watched
 * set of Sessions. One indexed query and `LIMIT 1`: a chained fleet wait never
 * folds each Session's history in memory.
 *
 * An empty watch set or an empty kind set answers `undefined` rather than
 * building a query that can only match nothing — the caller has already been
 * refused by then, and this keeps the SQL honest.
 */
export function firstMatchingSessionEventAfter(
  db: Database.Database,
  sessionIds: readonly string[],
  eventKinds: readonly string[],
  cursor: string,
): SequencedSessionEvent | undefined {
  if (sessionIds.length === 0 || eventKinds.length === 0) return undefined;
  const sequence = decodeSessionEventCursor(cursor);
  if (sequence === null) return undefined;
  const row = prepared<[number, string, string], SequencedSessionEventRow>(
    db,
    `SELECT ${SEQUENCED_COLUMNS}
       FROM session_event_sequence ordered
       JOIN session_events e ON e.id = ordered.event_id
      WHERE ordered.sequence > ?
        AND ordered.session_id IN (SELECT value FROM json_each(?))
        AND ordered.kind IN (SELECT value FROM json_each(?))
      ORDER BY ordered.sequence ASC
      LIMIT 1`,
  ).get(sequence, JSON.stringify(sessionIds), JSON.stringify(eventKinds));
  return row === undefined ? undefined : mapSequenced(row);
}

/**
 * One row into the durable fact plus its cursor.
 *
 * Decoded through `@volli/shared`'s own codec rather than a second reader
 * written here: the payload union is exhaustive on write and tolerant on read
 * in exactly one place, and a repo that parsed the JSON itself would be a
 * second place for the two to disagree. A malformed field inside a known kind
 * still throws, which is the corruption case CLAUDE.md keeps loud.
 */
function mapSequenced(row: SequencedSessionEventRow): SequencedSessionEvent {
  const event: SessionEvent = {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    provenance: decodeSessionEventProvenance(
      JSON.parse(row.provenance),
      "session_events row.provenance",
    ),
    payload: decodeSessionEventPayload(JSON.parse(row.payload), "session_events row.payload"),
  };
  if (row.attachment_id !== null) event.attachmentId = row.attachment_id;
  if (row.command_id !== null) event.commandId = row.command_id;
  return { event, cursor: encodeSessionEventCursor(row.ordered_sequence) };
}
