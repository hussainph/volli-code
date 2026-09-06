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

/** Whether every column contains the same ticket ids in the same order. */
function sameBoardOrder(
  before: Record<TicketStatus, Ticket[]>,
  after: Record<TicketStatus, Ticket[]>,
): boolean {
  return TICKET_STATUSES.every(
    (status) =>
      before[status].length === after[status].length &&
      before[status].every((ticket, index) => ticket.id === after[status][index]?.id),
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
 * Moves several tickets as one contiguous group.
 *
 * Group order is canonical board order (status left-to-right, then each
 * column's manual order), not click order. `toIndex` addresses the destination
 * AFTER the selected tickets have been removed, which makes one final group
 * position unambiguous even when the selection spans or already occupies the
 * destination column. Unknown and duplicate ids are ignored. The same array
 * reference is returned when no known ticket moves or the resulting board
 * order is unchanged.
 */
export function moveTickets(
  tickets: readonly Ticket[],
  ticketIds: readonly string[],
  toStatus: TicketStatus,
  toIndex: number,
  now: number,
): Ticket[] {
  const selectedIds = new Set(ticketIds);
  if (selectedIds.size === 0) return tickets as Ticket[];

  const before = groupTicketsByStatus(tickets);
  const selected = TICKET_STATUSES.flatMap((status) =>
    before[status].filter((ticket) => selectedIds.has(ticket.id)),
  );
  if (selected.length === 0) return tickets as Ticket[];

  const after = {} as Record<TicketStatus, Ticket[]>;
  for (const status of TICKET_STATUSES) {
    after[status] = before[status].filter((ticket) => !selectedIds.has(ticket.id));
  }

  const destination = after[toStatus];
  const clampedIndex = Math.max(0, Math.min(toIndex, destination.length));
  after[toStatus] = [
    ...destination.slice(0, clampedIndex),
    ...selected.map((ticket) => Object.assign({}, ticket, { status: toStatus, updatedAt: now })),
    ...destination.slice(clampedIndex),
  ];

  // A drag that resolves back to the group's current slot should be a true
  // no-op: preserve the caller's array and every ticket's updatedAt/reference.
  if (sameBoardOrder(before, after)) return tickets as Ticket[];

  const result: Ticket[] = [];
  for (const status of TICKET_STATUSES) result.push(...reorder(after[status]));
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
