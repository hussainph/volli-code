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
 * their tests pin it.
 *
 * ## Listeners cannot break a door
 *
 * A mutation's caller has already been answered by the time the wake fans out,
 * so a throwing listener must not unwind a door that committed honest work.
 * Errors are reported and swallowed — the same isolation every broadcast
 * fan-out in this process practises.
 */

import type { TicketEvent } from "@volli/shared";

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
  for (const listener of [...listeners]) {
    try {
      listener(wake);
    } catch (error) {
      reportFailure(error);
    }
  }
}
