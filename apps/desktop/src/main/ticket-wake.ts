/**
 * The ticket wake bus (VC-85 slice C): main's one post-commit stream of
 * Ticket Events.
 *
 * Both mutation doors converge on the command layer (`ticket-commands.ts`),
 * but until this module nothing in main could OBSERVE a committed ticket fact:
 * `broadcastDataChanged` reaches BrowserWindows only, and only from the socket
 * door. The await tool (`ticket.await`, slice D) needs an in-process wake, so
 * this is the canonical seam: every door that commits a ticket mutation calls
 * {@link emitTicketWake} AFTER its transaction commits, and anything in main
 * that cares subscribes.
 *
 * ## Post-commit, never inside
 *
 * An emit inside a transaction would wake a listener on a fact SQLite may yet
 * roll back — a wake for an event that never happened. Callers emit after the
 * command function returns, which is after `db.transaction(...)()` committed.
 * The bus itself cannot enforce that ordering; the call sites carry it, and
 * their tests pin it. {@link withTicketWake} is the shape that makes doing it
 * wrong awkward, which is why every door uses it.
 *
 * ## Listeners cannot break a door
 *
 * A mutation's caller has already been answered by the time the wake fans out,
 * so a throwing listener must not unwind a door that committed honest work.
 * Errors are reported and swallowed — the same isolation every broadcast
 * fan-out in this process practises.
 *
 * ## The event, not a hint
 *
 * `broadcastDataChanged` tells a window "something about this ticket changed,
 * re-read it", which is right for a UI about to re-render and wrong for a
 * waiter that must decide whether THIS is the event it was parked on. So the
 * bus carries the durable {@link TicketEvent} itself. It stays additive: the
 * renderer fan-out is untouched, because a UI refresh and an agent wake are
 * different needs that only look alike today.
 */

import type Database from "better-sqlite3";
import type { TicketEvent } from "@volli/shared";

import { listTicketEventsAfter, ticketEventCursor } from "./db/events-repo";
import { getTicketRow } from "./db/tickets-repo";

/** One committed planner fact, with the project scope every subscriber filters on. */
export interface TicketWake {
  event: TicketEvent;
  projectId: string;
}

export type TicketWakeListener = (wake: TicketWake) => void;

const listeners = new Set<TicketWakeListener>();

/** Subscribe to every post-commit Ticket Event; returns unsubscribe. */
export function subscribeTicketWake(listener: TicketWakeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fan one committed Ticket Event out to every subscriber, in subscription
 * order. Call it only after the transaction that recorded the event committed.
 */
export function emitTicketWake(
  wake: TicketWake,
  reportFailure: (error: unknown) => void = (error) => console.error(error),
): void {
  // A snapshot, not the live Set: the listener a wake settles is the listener
  // that unsubscribes on it, and every waiter does exactly that.
  const settled = [...listeners];
  for (const listener of settled) {
    try {
      listener(wake);
    } catch (error) {
      reportFailure(error);
    }
  }
}

/**
 * A mutation's place in one ticket's event log, taken BEFORE the write.
 *
 * How a door announces what it committed without every write path having to
 * hand back the events it wrote. `ticket_events.rowid` only ever increases, so
 * "this ticket's rows above the mark" is exactly the set this mutation added —
 * including the several a single command can write (a ticket update that also
 * changes priority and labels writes three).
 *
 * A brand-new ticket has no mark to take, and 0 is the honest answer: every row
 * it has is a row the create just wrote.
 */
export function markTicketWake(db: Database.Database, ticketId: string): number {
  return ticketEventCursor(db, ticketId);
}

/**
 * Announce whatever a just-committed mutation appended above `mark`, in the
 * order it was written.
 *
 * Silent when nothing was appended, which is the common and correct case for a
 * no-op: a same-column move writes no event, so it wakes nobody. It is also
 * silent for a coalesced `body_edited` (see `recordTicketEvent`), which touches
 * an existing row's timestamp rather than appending — an editing burst is not a
 * fact anybody waits for, and inventing a wake per autosave tick would be the
 * polling cost arriving again as wakes.
 */
export function emitTicketWakesSince(db: Database.Database, ticketId: string, mark: number): void {
  const events = listTicketEventsAfter(db, ticketId, mark);
  if (events.length === 0) return;
  // Read once for the whole batch: every event here belongs to one ticket, so
  // its project cannot differ between them. A ticket deleted between the write
  // and this call has nothing to attribute, and nobody may be woken for it.
  const row = getTicketRow(db, ticketId);
  if (!row) return;
  for (const event of events) emitTicketWake({ event, projectId: row.project_id });
}

/**
 * Run one ticket mutation and announce what it committed.
 *
 * The shape every door uses: it takes the mark, runs the write, and emits after
 * the write returns — including when the write throws, which is deliberate. A
 * command that fails part way can still have committed an earlier transaction
 * (the move that succeeded before its interrupt failed), and a waiter must be
 * told about a fact that is durably in the log regardless of what the caller
 * was told.
 */
export function withTicketWake<T>(db: Database.Database, ticketId: string, write: () => T): T {
  const mark = markTicketWake(db, ticketId);
  try {
    return write();
  } finally {
    emitTicketWakesSince(db, ticketId, mark);
  }
}
