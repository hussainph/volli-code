/**
 * Pure drag-and-drop resolution for the board: maps dnd-kit's (active, over)
 * id pair onto a concrete `{ toStatus, toIndex }` for the shared `moveTicket`
 * op. Kept free of dnd-kit/React so the drop semantics stay unit-testable.
 *
 * Id scheme: card draggables use the ticket's opaque `id` (a UUID) verbatim —
 * NOT its display id ("VC-12"), which is presentation-only and resolved
 * separately (see `displayTicketId` in `@volli/shared`); column droppables —
 * a column body or its collapsed empty-column pill, never both mounted at
 * once — use `"column:<status>"`.
 */
import {
  groupTicketsByStatus,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

const COLUMN_ID_PREFIX = "column:";

/** The droppable id shared by a column's body and its collapsed pill. */
export function columnDroppableId(status: TicketStatus): string {
  return `${COLUMN_ID_PREFIX}${status}`;
}

/** The status encoded in a column droppable id, or null for any other id. */
export function parseColumnDroppableId(id: string): TicketStatus | null {
  if (!id.startsWith(COLUMN_ID_PREFIX)) return null;
  const status = id.slice(COLUMN_ID_PREFIX.length);
  const known = TICKET_STATUSES.find((candidate) => candidate === status);
  return known ?? null;
}

export interface DropTarget {
  toStatus: TicketStatus;
  toIndex: number;
}

/**
 * Resolves where the active ticket should land given what it is over.
 * Over a card: that card's own slot — combined with `moveTicket`'s
 * remove-then-insert semantics this reproduces `arrayMove` (dragging down
 * lands after the card, dragging up lands before it). Over a column
 * droppable: the end of that column (`moveTicket` clamps, so the raw column
 * length is safe even when the active ticket is already in it). Null when
 * either id is unknown.
 */
export function resolveDrop(
  tickets: readonly Ticket[],
  activeTicketId: string,
  overId: string,
): DropTarget | null {
  if (!tickets.some((ticket) => ticket.id === activeTicketId)) return null;

  const columnStatus = parseColumnDroppableId(overId);
  const groups = groupTicketsByStatus(tickets);
  if (columnStatus !== null) {
    return { toStatus: columnStatus, toIndex: groups[columnStatus].length };
  }

  const over = tickets.find((ticket) => ticket.id === overId);
  if (!over) return null;
  return {
    toStatus: over.status,
    toIndex: groups[over.status].findIndex((ticket) => ticket.id === overId),
  };
}

/** A ticket's current column and index — the final position committed on drop. */
export function ticketPosition(tickets: readonly Ticket[], ticketId: string): DropTarget | null {
  const ticket = tickets.find((candidate) => candidate.id === ticketId);
  if (!ticket) return null;
  const column = groupTicketsByStatus(tickets)[ticket.status];
  return {
    toStatus: ticket.status,
    toIndex: column.findIndex((candidate) => candidate.id === ticketId),
  };
}
