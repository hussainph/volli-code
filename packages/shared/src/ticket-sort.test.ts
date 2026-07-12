import { describe, it, expect } from "vite-plus/test";
import { createTicket, displayTicketId } from "./ticket";
import type { Ticket, TicketPriority } from "./ticket";
import {
  DEFAULT_SORT_DIRECTION,
  DEFAULT_TICKET_SORT,
  sortTickets,
  TICKET_SORT_KEYS,
  TICKET_SORT_LABELS,
  type TicketSort,
} from "./ticket-sort";

function ticket(overrides: {
  ticketNumber: number;
  title?: string;
  priority?: TicketPriority;
  order?: number;
  createdAt?: number;
  updatedAt?: number;
}): Ticket {
  const created = createTicket({
    id: displayTicketId("VC", overrides.ticketNumber),
    projectId: "proj-1",
    ticketNumber: overrides.ticketNumber,
    title: overrides.title ?? `Ticket ${overrides.ticketNumber}`,
    status: "todo",
    order: overrides.order ?? 0,
    now: overrides.createdAt ?? 0,
    priority: overrides.priority ?? "medium",
  });
  // `createTicket` stamps createdAt and updatedAt together; override updatedAt
  // when a test needs them to diverge.
  return { ...created, updatedAt: overrides.updatedAt ?? overrides.createdAt ?? 0 };
}

const asc = (key: TicketSort["key"]): TicketSort => ({ key, direction: "asc" });
const desc = (key: TicketSort["key"]): TicketSort => ({ key, direction: "desc" });

describe("constants", () => {
  it("exposes the five sort keys in order", () => {
    expect(TICKET_SORT_KEYS).toEqual(["manual", "priority", "created", "updated", "title"]);
  });

  it("labels every key", () => {
    expect(TICKET_SORT_LABELS).toEqual({
      manual: "Manual",
      priority: "Priority",
      created: "Created",
      updated: "Updated",
      title: "Title",
    });
  });

  it("defaults to manual ascending", () => {
    expect(DEFAULT_TICKET_SORT).toEqual({ key: "manual", direction: "asc" });
  });

  it("starts each key on its most-useful end", () => {
    expect(DEFAULT_SORT_DIRECTION).toEqual({
      manual: "asc",
      priority: "desc",
      created: "desc",
      updated: "desc",
      title: "asc",
    });
  });
});

describe("sortTickets — purity", () => {
  it("does not mutate the input array", () => {
    const input = [ticket({ ticketNumber: 2, order: 1 }), ticket({ ticketNumber: 1, order: 0 })];
    const snapshot = [...input];
    sortTickets(input, asc("manual"));
    expect(input).toEqual(snapshot);
  });

  it("returns a new array", () => {
    const input = [ticket({ ticketNumber: 1, order: 0 })];
    expect(sortTickets(input, asc("manual"))).not.toBe(input);
  });

  it("returns an empty array for an empty column", () => {
    expect(sortTickets([], asc("priority"))).toEqual([]);
  });
});

describe("sortTickets — manual", () => {
  it("orders by order ascending, tie-broken by ticketNumber", () => {
    const a = ticket({ ticketNumber: 1, order: 2 });
    const b = ticket({ ticketNumber: 2, order: 0 });
    const c = ticket({ ticketNumber: 3, order: 1 });
    expect(sortTickets([a, b, c], asc("manual")).map((t) => t.ticketNumber)).toEqual([2, 3, 1]);
  });

  it("breaks order ties by ticketNumber ascending", () => {
    const a = ticket({ ticketNumber: 5, order: 0 });
    const b = ticket({ ticketNumber: 2, order: 0 });
    expect(sortTickets([a, b], asc("manual")).map((t) => t.ticketNumber)).toEqual([2, 5]);
  });

  it("ignores direction — desc still reads order ascending", () => {
    const a = ticket({ ticketNumber: 1, order: 2 });
    const b = ticket({ ticketNumber: 2, order: 0 });
    const c = ticket({ ticketNumber: 3, order: 1 });
    expect(sortTickets([a, b, c], desc("manual")).map((t) => t.ticketNumber)).toEqual([2, 3, 1]);
  });
});

describe("sortTickets — priority", () => {
  it("ascending orders low < medium < high", () => {
    const high = ticket({ ticketNumber: 1, priority: "high" });
    const low = ticket({ ticketNumber: 2, priority: "low" });
    const medium = ticket({ ticketNumber: 3, priority: "medium" });
    expect(sortTickets([high, low, medium], asc("priority")).map((t) => t.priority)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("descending orders high first (the default direction)", () => {
    const low = ticket({ ticketNumber: 1, priority: "low" });
    const high = ticket({ ticketNumber: 2, priority: "high" });
    const medium = ticket({ ticketNumber: 3, priority: "medium" });
    expect(sortTickets([low, high, medium], desc("priority")).map((t) => t.priority)).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });

  it("breaks priority ties by ticketNumber ascending regardless of direction", () => {
    const a = ticket({ ticketNumber: 7, priority: "high" });
    const b = ticket({ ticketNumber: 3, priority: "high" });
    expect(sortTickets([a, b], desc("priority")).map((t) => t.ticketNumber)).toEqual([3, 7]);
    expect(sortTickets([a, b], asc("priority")).map((t) => t.ticketNumber)).toEqual([3, 7]);
  });
});

describe("sortTickets — created", () => {
  it("ascending orders oldest first", () => {
    const a = ticket({ ticketNumber: 1, createdAt: 300 });
    const b = ticket({ ticketNumber: 2, createdAt: 100 });
    const c = ticket({ ticketNumber: 3, createdAt: 200 });
    expect(sortTickets([a, b, c], asc("created")).map((t) => t.ticketNumber)).toEqual([2, 3, 1]);
  });

  it("descending orders newest first", () => {
    const a = ticket({ ticketNumber: 1, createdAt: 300 });
    const b = ticket({ ticketNumber: 2, createdAt: 100 });
    const c = ticket({ ticketNumber: 3, createdAt: 200 });
    expect(sortTickets([a, b, c], desc("created")).map((t) => t.ticketNumber)).toEqual([1, 3, 2]);
  });

  it("breaks createdAt ties by ticketNumber ascending", () => {
    const a = ticket({ ticketNumber: 9, createdAt: 100 });
    const b = ticket({ ticketNumber: 4, createdAt: 100 });
    expect(sortTickets([a, b], desc("created")).map((t) => t.ticketNumber)).toEqual([4, 9]);
  });
});

describe("sortTickets — updated", () => {
  it("ascending orders least-recently-updated first", () => {
    const a = ticket({ ticketNumber: 1, updatedAt: 300 });
    const b = ticket({ ticketNumber: 2, updatedAt: 100 });
    expect(sortTickets([a, b], asc("updated")).map((t) => t.ticketNumber)).toEqual([2, 1]);
  });

  it("descending orders most-recently-updated first", () => {
    const a = ticket({ ticketNumber: 1, updatedAt: 100 });
    const b = ticket({ ticketNumber: 2, updatedAt: 300 });
    expect(sortTickets([a, b], desc("updated")).map((t) => t.ticketNumber)).toEqual([2, 1]);
  });

  it("breaks updatedAt ties by ticketNumber ascending", () => {
    const a = ticket({ ticketNumber: 8, updatedAt: 200 });
    const b = ticket({ ticketNumber: 5, updatedAt: 200 });
    expect(sortTickets([a, b], asc("updated")).map((t) => t.ticketNumber)).toEqual([5, 8]);
  });
});

describe("sortTickets — title", () => {
  it("ascending sorts A→Z, case-insensitively", () => {
    const a = ticket({ ticketNumber: 1, title: "banana" });
    const b = ticket({ ticketNumber: 2, title: "Apple" });
    const c = ticket({ ticketNumber: 3, title: "cherry" });
    expect(sortTickets([a, b, c], asc("title")).map((t) => t.title)).toEqual([
      "Apple",
      "banana",
      "cherry",
    ]);
  });

  it("descending sorts Z→A", () => {
    const a = ticket({ ticketNumber: 1, title: "banana" });
    const b = ticket({ ticketNumber: 2, title: "Apple" });
    const c = ticket({ ticketNumber: 3, title: "cherry" });
    expect(sortTickets([a, b, c], desc("title")).map((t) => t.title)).toEqual([
      "cherry",
      "banana",
      "Apple",
    ]);
  });

  it("breaks case-insensitive title ties by ticketNumber ascending", () => {
    const a = ticket({ ticketNumber: 6, title: "Fix bug" });
    const b = ticket({ ticketNumber: 2, title: "fix bug" });
    // Same title under base sensitivity — falls to ticketNumber, unflipped by desc.
    expect(sortTickets([a, b], desc("title")).map((t) => t.ticketNumber)).toEqual([2, 6]);
    expect(sortTickets([a, b], asc("title")).map((t) => t.ticketNumber)).toEqual([2, 6]);
  });
});
