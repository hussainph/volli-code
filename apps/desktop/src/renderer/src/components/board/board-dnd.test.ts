import { createTicket, TICKET_STATUSES, type Ticket, type TicketStatus } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  columnDroppableId,
  parseColumnDroppableId,
  resolveDrop,
  ticketPosition,
} from "./board-dnd";

// Ids are opaque (a real ticket's `id` is a UUID) — "VC-n" here is just a
// stable, readable test id, not a display id.
function ticket(ticketNumber: number, status: TicketStatus, order: number): Ticket {
  return createTicket({
    id: `VC-${ticketNumber}`,
    projectId: "p1",
    ticketNumber,
    title: `Ticket ${ticketNumber}`,
    status,
    order,
    now: 0,
  });
}

// VC-1, VC-2 in backlog; VC-3 in todo; doing/needs_review/done empty.
const TICKETS: Ticket[] = [ticket(1, "backlog", 0), ticket(2, "backlog", 1), ticket(3, "todo", 0)];

describe("columnDroppableId / parseColumnDroppableId", () => {
  it("round-trips every status", () => {
    for (const status of TICKET_STATUSES) {
      expect(parseColumnDroppableId(columnDroppableId(status))).toBe(status);
    }
  });

  it("returns null for a ticket id", () => {
    expect(parseColumnDroppableId("VC-1")).toBeNull();
  });

  it("returns null for an unknown status", () => {
    expect(parseColumnDroppableId("column:bogus")).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(parseColumnDroppableId("")).toBeNull();
  });
});

describe("resolveDrop", () => {
  it("targets the end of a column when over its droppable", () => {
    expect(resolveDrop(TICKETS, "VC-1", columnDroppableId("todo"))).toEqual({
      toStatus: "todo",
      toIndex: 1,
    });
  });

  it("targets the end of an empty column", () => {
    expect(resolveDrop(TICKETS, "VC-1", columnDroppableId("done"))).toEqual({
      toStatus: "done",
      toIndex: 0,
    });
  });

  it("uses the full column length over the active ticket's own column (clamped downstream)", () => {
    expect(resolveDrop(TICKETS, "VC-1", columnDroppableId("backlog"))).toEqual({
      toStatus: "backlog",
      toIndex: 2,
    });
  });

  it("targets a card's own slot when over a card in another column", () => {
    expect(resolveDrop(TICKETS, "VC-1", "VC-3")).toEqual({ toStatus: "todo", toIndex: 0 });
  });

  it("targets a card's slot within the same column", () => {
    expect(resolveDrop(TICKETS, "VC-1", "VC-2")).toEqual({ toStatus: "backlog", toIndex: 1 });
  });

  it("resolves over-self to the ticket's current slot (no-op downstream)", () => {
    expect(resolveDrop(TICKETS, "VC-1", "VC-1")).toEqual({ toStatus: "backlog", toIndex: 0 });
  });

  it("returns null for an unknown active ticket", () => {
    expect(resolveDrop(TICKETS, "VC-99", "VC-1")).toBeNull();
  });

  it("returns null for an over id that is neither a column nor a ticket", () => {
    expect(resolveDrop(TICKETS, "VC-1", "nope")).toBeNull();
  });
});

describe("ticketPosition", () => {
  it("returns the ticket's column and index", () => {
    expect(ticketPosition(TICKETS, "VC-2")).toEqual({ toStatus: "backlog", toIndex: 1 });
  });

  it("returns null for an unknown ticket", () => {
    expect(ticketPosition(TICKETS, "VC-99")).toBeNull();
  });
});
