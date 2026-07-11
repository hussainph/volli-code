import { describe, it, expect } from "vite-plus/test";
import { createTicket } from "./ticket";
import type { Ticket } from "./ticket";
import {
  EMPTY_TICKET_FILTER,
  isFilterActive,
  matchesFilter,
  filterTickets,
  distinctTags,
} from "./ticket-filter";
import type { TicketFilter } from "./ticket-filter";

function ticket(overrides: {
  ticketNumber: number;
  title: string;
  priority?: "low" | "medium" | "high";
  tags?: string[];
  harnessId?: string;
}): Ticket {
  return createTicket({
    prefix: "VC",
    projectId: "proj-1",
    ticketNumber: overrides.ticketNumber,
    title: overrides.title,
    status: "backlog",
    order: 0,
    now: 0,
    priority: overrides.priority,
    tags: overrides.tags,
    harnessId: overrides.harnessId,
  });
}

describe("EMPTY_TICKET_FILTER", () => {
  it("matches every ticket and is inactive", () => {
    expect(isFilterActive(EMPTY_TICKET_FILTER)).toBe(false);
    const t = ticket({ ticketNumber: 1, title: "Anything" });
    expect(matchesFilter(t, EMPTY_TICKET_FILTER)).toBe(true);
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

  it("is active when tags is non-empty", () => {
    expect(isFilterActive({ ...EMPTY_TICKET_FILTER, tags: ["bug"] })).toBe(true);
  });

  it("is active when harnessIds is non-empty", () => {
    expect(isFilterActive({ ...EMPTY_TICKET_FILTER, harnessIds: ["codex"] })).toBe(true);
  });
});

describe("matchesFilter", () => {
  it("matches search against the title case-insensitively", () => {
    const t = ticket({ ticketNumber: 1, title: "MCP Server" });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, search: "server" })).toBe(true);
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, search: "nope" })).toBe(false);
  });

  it("matches search against the ticket id case-insensitively", () => {
    const t = ticket({ ticketNumber: 12, title: "Something" });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, search: "vc-12" })).toBe(true);
  });

  it("trims the search term before matching", () => {
    const t = ticket({ ticketNumber: 1, title: "MCP Server" });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, search: "  server  " })).toBe(true);
  });

  it("matches when priorities includes the ticket's priority", () => {
    const t = ticket({ ticketNumber: 1, title: "T", priority: "high" });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, priorities: ["low", "high"] })).toBe(true);
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, priorities: ["low"] })).toBe(false);
  });

  it("matches when any of the filter's tags is present on the ticket (OR)", () => {
    const t = ticket({ ticketNumber: 1, title: "T", tags: ["bug", "urgent"] });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, tags: ["urgent", "chore"] })).toBe(true);
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, tags: ["chore"] })).toBe(false);
  });

  it("matches when harnessIds includes the ticket's harness", () => {
    const t = ticket({ ticketNumber: 1, title: "T", harnessId: "codex" });
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, harnessIds: ["codex", "opencode"] })).toBe(
      true,
    );
    expect(matchesFilter(t, { ...EMPTY_TICKET_FILTER, harnessIds: ["opencode"] })).toBe(false);
  });

  it("ANDs facets together", () => {
    const t = ticket({ ticketNumber: 1, title: "MCP Server", priority: "high", tags: ["bug"] });
    const filter: TicketFilter = {
      search: "mcp",
      priorities: ["high"],
      tags: ["bug"],
      harnessIds: [],
    };
    expect(matchesFilter(t, filter)).toBe(true);
    expect(matchesFilter(t, { ...filter, priorities: ["low"] })).toBe(false);
  });
});

describe("filterTickets", () => {
  it("returns the same array reference when the filter is inactive", () => {
    const tickets = [ticket({ ticketNumber: 1, title: "T" })];
    expect(filterTickets(tickets, EMPTY_TICKET_FILTER)).toBe(tickets);
  });

  it("returns a new array containing only matching tickets when active", () => {
    const a = ticket({ ticketNumber: 1, title: "MCP Server" });
    const b = ticket({ ticketNumber: 2, title: "Fix bug" });
    const tickets = [a, b];
    const result = filterTickets(tickets, { ...EMPTY_TICKET_FILTER, search: "mcp" });
    expect(result).not.toBe(tickets);
    expect(result).toEqual([a]);
  });
});

describe("distinctTags", () => {
  it("returns unique tags sorted ascending", () => {
    const a = ticket({ ticketNumber: 1, title: "T", tags: ["bug", "urgent"] });
    const b = ticket({ ticketNumber: 2, title: "T", tags: ["urgent", "chore"] });
    expect(distinctTags([a, b])).toEqual(["bug", "chore", "urgent"]);
  });

  it("returns an empty array when no tickets have tags", () => {
    const a = ticket({ ticketNumber: 1, title: "T" });
    expect(distinctTags([a])).toEqual([]);
  });
});
