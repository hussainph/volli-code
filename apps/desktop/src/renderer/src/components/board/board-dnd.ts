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

/** Multi-ticket payload advertised through dnd-kit's `active.data`. */
export interface TicketDragData {
  kind: "tickets";
  projectId: string;
  ticketIds: readonly string[];
}

/** Runtime guard for future board-adjacent drop targets (automation studio, etc.). */
export function isTicketDragData(value: unknown): value is TicketDragData {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TicketDragData>;
  return (
    candidate.kind === "tickets" &&
    typeof candidate.projectId === "string" &&
    Array.isArray(candidate.ticketIds) &&
    candidate.ticketIds.length > 0 &&
    candidate.ticketIds.every((id) => typeof id === "string")
  );
}

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
 * Resolves a selected ticket group's destination slot after the selected cards
 * have been removed. Over a non-selected card, moving down lands after it and
 * moving up/across lands before it — the same directional rule as one-card
 * `moveTicket`, generalized for a group. The active card determines direction,
 * so a defensive mixed-column payload cannot be pulled past its target by a
 * different selected card already in that column. Over a column, the group
 * appends. A selected card is not a useful target for its own group and resolves
 * null.
 */
export function resolveGroupDrop(
  tickets: readonly Ticket[],
  selectedTicketIds: readonly string[],
  activeTicketId: string,
  overId: string,
): DropTarget | null {
  const knownTicketIds = new Set(tickets.map((ticket) => ticket.id));
  const selected = new Set(selectedTicketIds.filter((id) => knownTicketIds.has(id)));
  if (selected.size === 0 || selected.has(overId)) return null;

  const groups = groupTicketsByStatus(tickets);
  const columnStatus = parseColumnDroppableId(overId);
  if (columnStatus !== null) {
    return {
      toStatus: columnStatus,
      toIndex: groups[columnStatus].filter((ticket) => !selected.has(ticket.id)).length,
    };
  }

  const over = tickets.find((ticket) => ticket.id === overId);
  const active = tickets.find((ticket) => ticket.id === activeTicketId);
  if (!over || !active || !selected.has(active.id)) return null;
  const column = groups[over.status];
  const overIndex = column.findIndex((ticket) => ticket.id === overId);
  const selectedBefore = column
    .slice(0, overIndex)
    .filter((ticket) => selected.has(ticket.id)).length;
  const activeIndex = groups[active.status].findIndex((ticket) => ticket.id === active.id);
  const movingDown = active.status === over.status && activeIndex < overIndex;
  return {
    toStatus: over.status,
    toIndex: overIndex - selectedBefore + (movingDown ? 1 : 0),
  };
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
