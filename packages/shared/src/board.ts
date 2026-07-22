/**
 * Board-level operations over a flat ticket list: grouping into columns and
 * the moves (drag, priority change, removal) that keep `order` dense and
 * contiguous (`0..n-1`) within every affected column.
 */

import { TICKET_STATUSES } from "./ticket";
import type { Ticket, TicketPriority, TicketStatus } from "./ticket";

/** Sorts a single column by `order` ascending, tie-broken by `ticketNumber` ascending. */
function sortColumn(tickets: Ticket[]): Ticket[] {
  return [...tickets].toSorted((a, b) => a.order - b.order || a.ticketNumber - b.ticketNumber);
}

/**
 * Groups tickets by status. Every status is present, in {@link TICKET_STATUSES}
 * order, with empty columns represented as empty arrays. Each column is sorted
 * by `order` ascending, ties broken by `ticketNumber` ascending.
 */
export function groupTicketsByStatus(tickets: readonly Ticket[]): Record<TicketStatus, Ticket[]> {
  const groups: Record<TicketStatus, Ticket[]> = {
    backlog: [],
    todo: [],
    doing: [],
    needs_review: [],
    done: [],
  };
  for (const ticket of tickets) {
    groups[ticket.status].push(ticket);
  }
  for (const status of TICKET_STATUSES) {
    groups[status] = sortColumn(groups[status]);
  }
  return groups;
}

/** Rebuilds dense `order` values (`0..n-1`) for an already-sorted column. */
function reorder(column: Ticket[]): Ticket[] {
  return column.map((ticket, index) =>
    ticket.order === index ? ticket : { ...ticket, order: index },
  );
}

/**
 * Moves a ticket to `toStatus` at `toIndex` (clamped to the destination
 * column's bounds), rebalancing `order` in both the source and destination
 * columns. Returns the same array reference (safe to use as a no-op guard)
 * when `ticketId` is unknown or the resulting position is unchanged.
 */
export function moveTicket(
  tickets: readonly Ticket[],
  ticketId: string,
  toStatus: TicketStatus,
  toIndex: number,
  now: number,
): Ticket[] {
  const moved = tickets.find((ticket) => ticket.id === ticketId);
  if (!moved) return tickets as Ticket[];

  const groups = groupTicketsByStatus(tickets);
  const destinationWithoutMoved = groups[toStatus].filter((ticket) => ticket.id !== ticketId);
  const clampedIndex = Math.max(0, Math.min(toIndex, destinationWithoutMoved.length));

  const currentIndex = groups[moved.status].findIndex((ticket) => ticket.id === ticketId);
  const isNoOp = moved.status === toStatus && currentIndex === clampedIndex;
  if (isNoOp) return tickets as Ticket[];

  const movedTicket: Ticket = { ...moved, status: toStatus, updatedAt: now };
  const destination = [
    ...destinationWithoutMoved.slice(0, clampedIndex),
    movedTicket,
    ...destinationWithoutMoved.slice(clampedIndex),
  ];

  const rebalancedDestination = reorder(destination);
  const rebalancedSource =
    moved.status === toStatus
      ? rebalancedDestination
      : reorder(groups[moved.status].filter((ticket) => ticket.id !== ticketId));

  const result: Ticket[] = [];
  for (const status of TICKET_STATUSES) {
    if (status === toStatus) {
      result.push(...rebalancedDestination);
    } else if (status === moved.status) {
      result.push(...rebalancedSource);
    } else {
      result.push(...groups[status]);
    }
  }
  return result;
}

/**
 * Sets a ticket's priority. Returns the same array reference when the id is
 * unknown or the priority is unchanged; otherwise a new array with the
 * ticket's `priority` and `updatedAt` updated.
 */
export function setTicketPriority(
  tickets: readonly Ticket[],
  ticketId: string,
  priority: TicketPriority,
  now: number,
): Ticket[] {
  const target = tickets.find((ticket) => ticket.id === ticketId);
  if (!target) return tickets as Ticket[];
  if (target.priority === priority) return tickets as Ticket[];

  return tickets.map((ticket) =>
    ticket.id === ticketId ? { ...ticket, priority, updatedAt: now } : ticket,
  );
}
