/**
 * What a board client needs beside the shared rules to run them for an
 * optimistic update (VC-889): the map from stored rows to rule facts (the
 * backend's documents and a client's roster rows are the same rows), the
 * neighbours a drop names, the gap the backend will read around them, and
 * patched copies of the rows a decision changed.
 *
 * The backend's answer always replaces what a client computes here; the
 * point of computing it the same way is that, with no concurrent change, the
 * answer is identical and replaces nothing on screen (`board-optimistic.parity.test.ts`).
 */
import type { BoardLabel, BoardTicket, TicketChange } from "./board-rules";
import type { CheckoutMode } from "./board-events";
import type { LabelId, ProjectId, RunnerId, TicketId, UserId } from "./ids";
import { comparePositions } from "./positions";
import type { TicketStatus } from "../ticket";

/** A stored ticket, as a document or a roster row: the fields the rules read. */
export interface BoardTicketRow {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  readonly title: string;
  readonly status: BoardTicket["status"];
  readonly priority: BoardTicket["priority"];
  readonly position: string;
  readonly labelIds: readonly string[];
  readonly assigneeUserId: string | null;
  readonly checkoutMode: string;
  readonly preferredHarnessId: string;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly retentionKeep: boolean;
  readonly placeRunnerId: string | null;
  readonly archivedAt: number | null;
}

/** A stored label, aliases included: the fields the rules read. */
export interface BoardLabelRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly nameKey: string;
  readonly color: string | null;
  readonly mergedIntoId: string | null;
}

/** A stored ticket as the rules' facts. */
export function boardTicketFromRow(row: BoardTicketRow): BoardTicket {
  return {
    id: row.id as TicketId,
    projectId: row.projectId as ProjectId,
    number: row.number,
    title: row.title,
    status: row.status,
    priority: row.priority,
    position: row.position,
    labelIds: [...row.labelIds] as LabelId[],
    assigneeUserId: row.assigneeUserId as UserId | null,
    checkoutMode: row.checkoutMode as CheckoutMode,
    preferredHarnessId: row.preferredHarnessId,
    branch: row.branch,
    baseBranch: row.baseBranch,
    retentionKeep: row.retentionKeep,
    placeRunnerId: row.placeRunnerId as RunnerId | null,
    archivedAt: row.archivedAt,
  };
}

/** A stored label as the rules' facts. */
export function boardLabelFromRow(row: BoardLabelRow): BoardLabel {
  return {
    id: row.id as LabelId,
    projectId: row.projectId as ProjectId,
    name: row.name,
    nameKey: row.nameKey,
    color: row.color,
    mergedIntoId: row.mergedIntoId as LabelId | null,
  };
}

/** A column's live tickets in board order (position, then number). */
function columnOf<T extends Pick<BoardTicket, "status" | "position" | "number" | "archivedAt">>(
  tickets: readonly T[],
  status: TicketStatus,
): T[] {
  return tickets
    .filter((ticket) => ticket.status === status && ticket.archivedAt === null)
    .toSorted((a, b) => comparePositions(a.position, b.position) || a.number - b.number);
}

/**
 * The neighbours a drop names, from the board's drop index: `toIndex`
 * addresses the destination column with the moving tickets taken out (as
 * the local board's `moveTickets` defines it), so the group lands after
 * `rest[toIndex - 1]` and before `rest[toIndex]`. An empty column names
 * neither: a column-only move.
 */
export function dropNeighbours(
  tickets: readonly Pick<BoardTicket, "id" | "status" | "position" | "number" | "archivedAt">[],
  toStatus: TicketStatus,
  movingIds: readonly string[],
  toIndex: number,
): { afterTicketId: TicketId | null; beforeTicketId: TicketId | null } {
  const moving = new Set(movingIds);
  const rest = columnOf(tickets, toStatus).filter((ticket) => !moving.has(ticket.id));
  const at = Math.max(0, Math.min(Math.trunc(toIndex), rest.length));
  return {
    afterTicketId: (rest[at - 1]?.id ?? null) as TicketId | null,
    beforeTicketId: (rest[at]?.id ?? null) as TicketId | null,
  };
}

/**
 * The gap a move lands in, as the backend reads it inside its write: right
 * after the named `after` ticket, else right before the named `before`. A
 * named neighbour that is not usable (gone from the board, in another
 * column, or one of the moving tickets) is ignored; with neither usable the
 * group goes to the column's end, or its start when only a ticket to land
 * before was named. Never one of the moving tickets.
 */
export function resolveMoveGap(
  tickets: readonly BoardTicket[],
  command: {
    readonly toStatus: TicketStatus;
    readonly afterTicketId?: string | null;
    readonly beforeTicketId?: string | null;
  },
  moving: ReadonlySet<string>,
): { after: BoardTicket | null; before: BoardTicket | null } {
  const column = columnOf(tickets, command.toStatus).filter((ticket) => !moving.has(ticket.id));
  const usable = (id: string | null) =>
    id === null ? null : (column.find((ticket) => ticket.id === id) ?? null);
  const afterId = command.afterTicketId ?? null;
  const beforeId = command.beforeTicketId ?? null;
  const after = usable(afterId);
  if (after !== null) {
    const next = column.find((ticket) => comparePositions(ticket.position, after.position) > 0);
    return { after, before: next ?? null };
  }
  const before = usable(beforeId);
  if (before !== null) {
    const previous = column.findLast(
      (ticket) => comparePositions(ticket.position, before.position) < 0,
    );
    return { after: previous ?? null, before };
  }
  if (afterId === null && beforeId !== null) return { after: null, before: column[0] ?? null };
  return { after: column.at(-1) ?? null, before: null };
}

/**
 * The rows with each decided change applied, as new objects: a row no change
 * names is the same object, and no row is ever mutated (an optimistic update
 * must never touch the objects its store holds).
 */
export function applyTicketChanges<Row extends { readonly id: string }>(
  rows: readonly Row[],
  changes: readonly TicketChange[],
): Row[] {
  const patches = new Map<string, TicketChange["patch"]>();
  for (const { ticketId, patch } of changes) {
    patches.set(ticketId, { ...patches.get(ticketId), ...patch });
  }
  return rows.map((row) => {
    const patch = patches.get(row.id);
    return patch === undefined ? row : { ...row, ...patch };
  });
}
