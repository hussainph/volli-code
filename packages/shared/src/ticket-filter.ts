/**
 * Board search/filter: a single filter value combining a free-text search
 * with facets (priority, labels, harness). Facets are ANDed together; values
 * within a facet are ORed (an empty facet matches everything).
 */

import { displayTicketId } from "./ticket";
import type { Ticket, TicketPriority } from "./ticket";

export interface TicketFilter {
  /** Trimmed, case-insensitive substring match on title OR display id (`ticketPrefix-ticketNumber`). */
  search: string;
  /** Empty means "all priorities". */
  priorities: readonly TicketPriority[];
  /** Empty means "all labels"; multiple labels match within the facet with OR. */
  labels: readonly string[];
  /** Empty means "all harnesses". */
  harnessIds: readonly string[];
}

/** The filter that matches every ticket and does nothing. */
export const EMPTY_TICKET_FILTER: TicketFilter = {
  search: "",
  priorities: [],
  labels: [],
  harnessIds: [],
};

/** Whether `filter` narrows the ticket list at all. */
export function isFilterActive(filter: TicketFilter): boolean {
  return (
    filter.search.trim() !== "" ||
    filter.priorities.length > 0 ||
    filter.labels.length > 0 ||
    filter.harnessIds.length > 0
  );
}

/**
 * `ticketPrefix` is the owning project's ticket prefix — the search matches
 * against the ticket's *display* id (`displayTicketId(ticketPrefix,
 * ticket.ticketNumber)`, e.g. `"VC-12"`), never its opaque `Ticket.id` UUID.
 */
function matchesSearch(ticket: Ticket, search: string, ticketPrefix: string): boolean {
  const term = search.trim().toLowerCase();
  if (term === "") return true;
  return (
    ticket.title.toLowerCase().includes(term) ||
    displayTicketId(ticketPrefix, ticket.ticketNumber).toLowerCase().includes(term)
  );
}

function matchesPriority(ticket: Ticket, priorities: readonly TicketPriority[]): boolean {
  if (priorities.length === 0) return true;
  return priorities.includes(ticket.priority);
}

function matchesLabels(ticket: Ticket, labels: readonly string[]): boolean {
  if (labels.length === 0) return true;
  return ticket.labels.some((label) => labels.includes(label));
}

function matchesHarness(ticket: Ticket, harnessIds: readonly string[]): boolean {
  if (harnessIds.length === 0) return true;
  return harnessIds.includes(ticket.harnessId);
}

/**
 * Whether `ticket` satisfies every facet of `filter` (facets AND together).
 * `ticketPrefix` is the owning project's ticket prefix, used only to resolve
 * the search facet's display-id match.
 */
export function matchesFilter(ticket: Ticket, filter: TicketFilter, ticketPrefix: string): boolean {
  return (
    matchesSearch(ticket, filter.search, ticketPrefix) &&
    matchesPriority(ticket, filter.priorities) &&
    matchesLabels(ticket, filter.labels) &&
    matchesHarness(ticket, filter.harnessIds)
  );
}

/**
 * Filters `tickets` by `filter`. Returns the same array reference when the
 * filter is inactive; otherwise a new array of the matching tickets.
 * `ticketPrefix` is the owning project's ticket prefix (all of `tickets` are
 * assumed to belong to the same project) — see {@link matchesFilter}.
 */
export function filterTickets(
  tickets: readonly Ticket[],
  filter: TicketFilter,
  ticketPrefix: string,
): Ticket[] {
  if (!isFilterActive(filter)) return tickets as Ticket[];
  return tickets.filter((ticket) => matchesFilter(ticket, filter, ticketPrefix));
}

/** Every distinct label across `tickets`, unique and sorted ascending. */
export function distinctLabels(tickets: readonly Ticket[]): string[] {
  const labels = new Set<string>();
  for (const ticket of tickets) {
    for (const label of ticket.labels) {
      labels.add(label);
    }
  }
  return [...labels].toSorted();
}
