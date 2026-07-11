/**
 * Board search/filter: a single filter value combining a free-text search
 * with facets (priority, tags, harness). Facets are ANDed together; values
 * within a facet are ORed (an empty facet matches everything).
 */

import type { Ticket, TicketPriority } from "./ticket";

export interface TicketFilter {
  /** Trimmed, case-insensitive substring match on title OR id. */
  search: string;
  /** Empty means "all priorities". */
  priorities: readonly TicketPriority[];
  /** Empty means "all tags"; multiple tags match within the facet with OR. */
  tags: readonly string[];
  /** Empty means "all harnesses". */
  harnessIds: readonly string[];
}

/** The filter that matches every ticket and does nothing. */
export const EMPTY_TICKET_FILTER: TicketFilter = {
  search: "",
  priorities: [],
  tags: [],
  harnessIds: [],
};

/** Whether `filter` narrows the ticket list at all. */
export function isFilterActive(filter: TicketFilter): boolean {
  return (
    filter.search.trim() !== "" ||
    filter.priorities.length > 0 ||
    filter.tags.length > 0 ||
    filter.harnessIds.length > 0
  );
}

function matchesSearch(ticket: Ticket, search: string): boolean {
  const term = search.trim().toLowerCase();
  if (term === "") return true;
  return ticket.title.toLowerCase().includes(term) || ticket.id.toLowerCase().includes(term);
}

function matchesPriority(ticket: Ticket, priorities: readonly TicketPriority[]): boolean {
  if (priorities.length === 0) return true;
  return priorities.includes(ticket.priority);
}

function matchesTags(ticket: Ticket, tags: readonly string[]): boolean {
  if (tags.length === 0) return true;
  return ticket.tags.some((tag) => tags.includes(tag));
}

function matchesHarness(ticket: Ticket, harnessIds: readonly string[]): boolean {
  if (harnessIds.length === 0) return true;
  return harnessIds.includes(ticket.harnessId);
}

/** Whether `ticket` satisfies every facet of `filter` (facets AND together). */
export function matchesFilter(ticket: Ticket, filter: TicketFilter): boolean {
  return (
    matchesSearch(ticket, filter.search) &&
    matchesPriority(ticket, filter.priorities) &&
    matchesTags(ticket, filter.tags) &&
    matchesHarness(ticket, filter.harnessIds)
  );
}

/**
 * Filters `tickets` by `filter`. Returns the same array reference when the
 * filter is inactive; otherwise a new array of the matching tickets.
 */
export function filterTickets(tickets: readonly Ticket[], filter: TicketFilter): Ticket[] {
  if (!isFilterActive(filter)) return tickets as Ticket[];
  return tickets.filter((ticket) => matchesFilter(ticket, filter));
}

/** Every distinct tag across `tickets`, unique and sorted ascending. */
export function distinctTags(tickets: readonly Ticket[]): string[] {
  const tags = new Set<string>();
  for (const ticket of tickets) {
    for (const tag of ticket.tags) {
      tags.add(tag);
    }
  }
  return [...tags].toSorted();
}
