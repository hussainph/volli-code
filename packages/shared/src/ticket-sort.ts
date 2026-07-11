/**
 * Column ordering for the board and list views: a single sort value (key +
 * direction) and the pure comparator that orders ONE status column's tickets.
 *
 * "manual" is the drag-reorder mode — it reads the `order` field the board's
 * drag ops maintain. The other keys are read-only projections over ticket
 * fields; picking one doesn't touch `order`, so switching back to "manual"
 * restores the hand-arranged sequence. Sorting is always per-column: the board
 * groups first, then orders within each column, and the list view mirrors that.
 */

import type { Ticket, TicketPriority } from "./ticket";

/** The orderings a column can be sorted by. "manual" = the drag-reorder order. */
export const TICKET_SORT_KEYS = ["manual", "priority", "created", "updated", "title"] as const;

export type TicketSortKey = (typeof TICKET_SORT_KEYS)[number];

export interface TicketSort {
  key: TicketSortKey;
  direction: "asc" | "desc";
}

/** The board's out-of-the-box ordering: hand-arranged, drag-reorderable. */
export const DEFAULT_TICKET_SORT: TicketSort = { key: "manual", direction: "asc" };

/** Human-readable label for each {@link TicketSortKey}. */
export const TICKET_SORT_LABELS: Record<TicketSortKey, string> = {
  manual: "Manual",
  priority: "Priority",
  created: "Created",
  updated: "Updated",
  title: "Title",
};

/**
 * The direction a key starts in the first time it's picked, chosen so the most
 * useful end is on top: highest priority, newest first, titles A→Z. "manual"
 * ignores direction (it's always `order` ascending) but carries "asc" for a
 * complete map. The UI seeds `{ key, direction: DEFAULT_SORT_DIRECTION[key] }`
 * on selection; the user can then flip it.
 */
export const DEFAULT_SORT_DIRECTION: Record<TicketSortKey, "asc" | "desc"> = {
  manual: "asc",
  priority: "desc",
  created: "desc",
  updated: "desc",
  title: "asc",
};

/** Low → medium → high as an ascending numeric rank for priority comparison. */
const PRIORITY_RANK: Record<TicketPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * The key's primary comparison in ascending form only. Ties (0) are left for
 * {@link sortTickets} to break by `ticketNumber` — kept out of here so the
 * tie-break never flips with `direction`.
 */
function primaryCompareAsc(a: Ticket, b: Ticket, key: TicketSortKey): number {
  switch (key) {
    case "manual":
      return a.order - b.order;
    case "priority":
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case "created":
      return a.createdAt - b.createdAt;
    case "updated":
      return a.updatedAt - b.updatedAt;
    case "title":
      // Case-insensitive so "apple" and "Apple" sort together; `sensitivity:
      // base` also folds accents, matching how a user reads the title.
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  }
}

/**
 * Sorts one column's tickets by `sort`, pure and non-mutating (`toSorted`).
 *
 * Ascending comparators: manual = `order`; priority = low < medium < high;
 * created = `createdAt`; updated = `updatedAt`; title = case-insensitive.
 * Non-manual keys flip under "desc". `direction` is IGNORED for manual — the
 * drag order is inherently one-directional (`order` ascending), matching
 * {@link groupTicketsByStatus}. Every tie falls back to `ticketNumber`
 * ascending regardless of direction, so the order is total and deterministic.
 */
export function sortTickets(column: readonly Ticket[], sort: TicketSort): Ticket[] {
  const factor = sort.key !== "manual" && sort.direction === "desc" ? -1 : 1;
  return column.toSorted((a, b) => {
    const primary = primaryCompareAsc(a, b, sort.key) * factor;
    if (primary !== 0) return primary;
    return a.ticketNumber - b.ticketNumber;
  });
}
