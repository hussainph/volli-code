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
 * matching event after this point, across these handles" — so migration 044
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
import {
  createSequenceCursorCodec,
  currentSqliteSequence,
  firstMatchingSequencedRow,
} from "./sequence-cursor";

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
const SESSION_EVENT_CURSOR = createSequenceCursorCodec(
  SESSION_EVENT_CURSOR_PREFIX,
  "Session Event",
);

export const encodeSessionEventCursor = SESSION_EVENT_CURSOR.encode;
export const decodeSessionEventCursor = SESSION_EVENT_CURSOR.decode;

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
  return currentSqliteSequence(db, "session_event_sequence");
}

/** The database-wide high-water cursor at this instant, opaque. */
export function currentSessionEventCursor(db: Database.Database): string {
  return encodeSessionEventCursor(currentSessionEventSequence(db));
}

/** The cursor immediately before this Session's first durable Event. */
export function cursorBeforeSessionEvents(
  db: Database.Database,
  sessionId: string,
): string | undefined {
  const row = prepared<[string], { sequence: number | null }>(
    db,
    "SELECT MIN(sequence) AS sequence FROM session_event_sequence WHERE session_id = ?",
  ).get(sessionId);
  return row?.sequence === null || row?.sequence === undefined
    ? undefined
    : encodeSessionEventCursor(Math.max(0, row.sequence - 1));
}

/** The cursor immediately before the first Event recorded for one Command. */
export function cursorBeforeSessionCommand(
  db: Database.Database,
  sessionId: string,
  commandId: string,
): string | undefined {
  const row = prepared<[string, string], { sequence: number | null }>(
    db,
    `SELECT MIN(ordered.sequence) AS sequence
       FROM session_event_sequence ordered
       JOIN session_events event ON event.id = ordered.event_id
      WHERE ordered.session_id = ? AND event.command_id = ?`,
  ).get(sessionId, commandId);
  return row?.sequence === null || row?.sequence === undefined
    ? undefined
    : encodeSessionEventCursor(Math.max(0, row.sequence - 1));
}

const SEQUENCED_COLUMNS = `e.id, e.session_id, e.sequence, e.occurred_at, e.recorded_at,
         (SELECT provenance FROM session_provenances WHERE id = e.provenance_id) AS provenance,
         e.attachment_id, e.command_id, e.payload, ordered.sequence AS ordered_sequence`;

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
  const sequence = decodeSessionEventCursor(cursor);
  if (sequence === null) return undefined;
  const row = firstMatchingSequencedRow<SequencedSessionEventRow>(
    db,
    {
      select: SEQUENCED_COLUMNS,
      sequenceTable: "session_event_sequence",
      eventTable: "session_events",
      ownerColumn: "session_id",
    },
    sessionIds,
    eventKinds,
    sequence,
  );
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
