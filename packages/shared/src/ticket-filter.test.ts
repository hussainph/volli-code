import { describe, it, expect } from "vite-plus/test";
import { createTicket, displayTicketId } from "./ticket";
import type { Ticket } from "./ticket";
import {
  EMPTY_TICKET_FILTER,
  isFilterActive,
  matchesFilter,
  filterTickets,
  distinctLabels,
} from "./ticket-filter";
import type { TicketFilter } from "./ticket-filter";

const PREFIX = "VC";

function ticket(overrides: {
  ticketNumber: number;
  title: string;
  priority?: "low" | "medium" | "high";
  labels?: string[];
  harnessId?: string;
}): Ticket {
  return createTicket({
    id: displayTicketId(PREFIX, overrides.ticketNumber),
    projectId: "proj-1",
    ticketNumber: overrides.ticketNumber,
    title: overrides.title,
    status: "backlog",
    order: 0,
    now: 0,
    priority: overrides.priority,
    labels: overrides.labels,
    harnessId: overrides.harnessId,
  });
}

describe("EMPTY_TICKET_FILTER", () => {
  it("matches every ticket and is inactive", () => {
    expect(isFilterActive(EMPTY_TICKET_FILTER)).toBe(false);
    const t = ticket({ ticketNumber: 1, title: "Anything" });
    expect(matchesFilter(t, EMPTY_TICKET_FILTER, PREFIX)).toBe(true);
  });
});

describe("isFilterActive", () => {
  it("is active when search is non-empty", () => {
    expect(isFilterActive({ ...EMPTY_TICKET_FILTER, search: "mcp" })).toBe(true);
  });

  it("is inactive when search is only whitespace", () => {
    expect(isFilterActive({ ...EMPTY_TICKET_FILTER, search: "   " })).toBe(false);
  });

  it("is active when priorities is non-empty", () => {
    expect(isFilterActive({ ...EMPTY_TICKET_FILTER, priorities: ["high"] })).toBe(true);
  });

  it("is active when labels is non-empty", () => {
    expect(isFilterActive({ ...EMPTY_TICKET_FILTER, labels: ["bug"] })).toBe(true);
  });

  it("is active when harnessIds is non-empty", () => {
    expect(isFilterActive({ ...EMPTY_TICKET_FILTER, harnessIds: ["codex"] })).toBe(true);
  });
});

describe("matchesFilter", () => {
  it("matches search against the title case-insensitively", () => {
    const t = ticket({ ticketNumber: 1, title: "MCP Server" });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, search: "server" }, PREFIX)).toBe(true);
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, search: "nope" }, PREFIX)).toBe(false);
  });

  it("matches search against the display id (ticketPrefix-ticketNumber) case-insensitively", () => {
    const t = ticket({ ticketNumber: 12, title: "Something" });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, search: "vc-12" }, PREFIX)).toBe(true);
  });

  it("matches the display id under a different project's prefix, not the ticket's own opaque id", () => {
    const t = ticket({ ticketNumber: 7, title: "Something else" });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, search: "other-7" }, "OTHER")).toBe(true);
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, search: "vc-7" }, "OTHER")).toBe(false);
  });

  it("trims the search term before matching", () => {
    const t = ticket({ ticketNumber: 1, title: "MCP Server" });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, search: "  server  " }, PREFIX)).toBe(true);
  });

  it("matches when priorities includes the ticket's priority", () => {
    const t = ticket({ ticketNumber: 1, title: "T", priority: "high" });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, priorities: ["low", "high"] }, PREFIX)).toBe(
      true,
    );
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, priorities: ["low"] }, PREFIX)).toBe(false);
  });

  it("matches when any of the filter's labels is present on the ticket (OR)", () => {
    const t = ticket({ ticketNumber: 1, title: "T", labels: ["bug", "urgent"] });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, labels: ["urgent", "chore"] }, PREFIX)).toBe(
      true,
    );
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, labels: ["chore"] }, PREFIX)).toBe(false);
  });

  it("matches when harnessIds includes the ticket's harness", () => {
    const t = ticket({ ticketNumber: 1, title: "T", harnessId: "codex" });
    expect(
      matchesFilter(t, { ...EMPTY_TICKET_FILTER, harnessIds: ["codex", "opencode"] }, PREFIX),
    ).toBe(true);
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, harnessIds: ["opencode"] }, PREFIX)).toBe(
      false,
    );
  });

  it("ANDs facets together", () => {
    const t = ticket({ ticketNumber: 1, title: "MCP Server", priority: "high", labels: ["bug"] });
    const filter: TicketFilter = {
      search: "mcp",
      priorities: ["high"],
      labels: ["bug"],
      harnessIds: [],
    };
    expect(matchesFilter(t, filter, PREFIX)).toBe(true);
    expect(matchesFilter(t, { ...filter, priorities: ["low"] }, PREFIX)).toBe(false);
  });
});

describe("filterTickets", () => {
  it("returns the same array reference when the filter is inactive", () => {
    const tickets = [ticket({ ticketNumber: 1, title: "T" })];
    expect(filterTickets(tickets, EMPTY_TICKET_FILTER, PREFIX)).toBe(tickets);
  });

  it("returns a new array containing only matching tickets when active", () => {
    const a = ticket({ ticketNumber: 1, title: "MCP Server" });
    const b = ticket({ ticketNumber: 2, title: "Fix bug" });
    const tickets = [a, b];
    const result = filterTickets(tickets, { ...EMPTY_TICKET_FILTER, search: "mcp" }, PREFIX);
    expect(result).not.toBe(tickets);
    expect(result).toEqual([a]);
  });

  it("matches the display id when filtering the full list", () => {
    const a = ticket({ ticketNumber: 1, title: "First" });
    const b = ticket({ ticketNumber: 2, title: "Second" });
    const result = filterTickets([a, b], { ...EMPTY_TICKET_FILTER, search: "VC-2" }, PREFIX);
    expect(result).toEqual([b]);
  });
});

describe("distinctLabels", () => {
  it("returns unique labels sorted ascending", () => {
    const a = ticket({ ticketNumber: 1, title: "T", labels: ["bug", "urgent"] });
    const b = ticket({ ticketNumber: 2, title: "T", labels: ["urgent", "chore"] });
    expect(distinctLabels([a, b])).toEqual(["bug", "chore", "urgent"]);
  });

  it("returns an empty array when no tickets have labels", () => {
    const a = ticket({ ticketNumber: 1, title: "T" });
    expect(distinctLabels([a])).toEqual([]);
  });
});
