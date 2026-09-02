import { createTicket, TICKET_STATUSES, type Ticket, type TicketStatus } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  columnDroppableId,
  isTicketDragData,
  parseColumnDroppableId,
  resolveDrop,
  resolveGroupDrop,
  ticketPosition,
} from "./board-dnd";

// Ticket identities stay opaque and independent of their human-facing display ids.
function ticket(ticketNumber: number, status: TicketStatus, order: number): Ticket {
  return createTicket({
    id: `ticket-${ticketNumber}`,
    projectId: "p1",
    ticketNumber,
    title: `Ticket ${ticketNumber}`,
    status,
    order,
    now: 0,
  });
}

const TICKETS: Ticket[] = [ticket(1, "backlog", 0), ticket(2, "backlog", 1), ticket(3, "todo", 0)];

describe("isTicketDragData", () => {
  it("accepts a non-empty multi-ticket payload", () => {
    expect(isTicketDragData({ kind: "tickets", projectId: "p1", ticketIds: ["t1", "t2"] })).toBe(
      true,
    );
  });

  it("rejects malformed, empty, and non-ticket payloads", () => {
    expect(isTicketDragData(null)).toBe(false);
    expect(isTicketDragData("tickets")).toBe(false);
    expect(isTicketDragData({ kind: "other", projectId: "p1", ticketIds: ["t1"] })).toBe(false);
    expect(isTicketDragData({ kind: "tickets", projectId: 1, ticketIds: ["t1"] })).toBe(false);
    expect(isTicketDragData({ kind: "tickets", projectId: "p1", ticketIds: "t1" })).toBe(false);
    expect(isTicketDragData({ kind: "tickets", projectId: "p1", ticketIds: [] })).toBe(false);
    expect(isTicketDragData({ kind: "tickets", projectId: "p1", ticketIds: [1] })).toBe(false);
  });
});

describe("columnDroppableId / parseColumnDroppableId", () => {
  it("round-trips every status", () => {
    for (const status of TICKET_STATUSES) {
      expect(parseColumnDroppableId(columnDroppableId(status))).toBe(status);
    }
  });

  it("returns null for a ticket id", () => {
    expect(parseColumnDroppableId("ticket-1")).toBeNull();
  });

  it("returns null for an unknown status", () => {
    expect(parseColumnDroppableId("column:bogus")).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(parseColumnDroppableId("")).toBeNull();
  });
});

describe("resolveGroupDrop", () => {
  it("appends a selected group to a column after excluding selected members already there", () => {
    expect(
      resolveGroupDrop(TICKETS, ["ticket-1", "ticket-3"], "ticket-1", columnDroppableId("todo")),
    ).toEqual({ toStatus: "todo", toIndex: 0 });
  });

  it("lands after a non-selected card when the active card approaches from above", () => {
    expect(resolveGroupDrop(TICKETS, ["ticket-1"], "ticket-1", "ticket-2")).toEqual({
      toStatus: "backlog",
      toIndex: 1,
    });
  });

  it("lands before a non-selected card when the active card approaches from below or another column", () => {
    expect(resolveGroupDrop(TICKETS, ["ticket-2"], "ticket-2", "ticket-1")).toEqual({
      toStatus: "backlog",
      toIndex: 0,
    });
    expect(resolveGroupDrop(TICKETS, ["ticket-3"], "ticket-3", "ticket-1")).toEqual({
      toStatus: "backlog",
      toIndex: 0,
    });
  });

  it("uses the active card for direction when a defensive payload spans columns", () => {
    const tickets = [ticket(1, "backlog", 0), ticket(2, "todo", 0), ticket(3, "todo", 1)];
    expect(resolveGroupDrop(tickets, ["ticket-1", "ticket-2"], "ticket-1", "ticket-3")).toEqual({
      toStatus: "todo",
      toIndex: 0,
    });
  });

  it("uses the active card's index when selected cards straddle a same-column target", () => {
    const tickets = [ticket(1, "todo", 0), ticket(2, "todo", 1), ticket(3, "todo", 2)];
    expect(resolveGroupDrop(tickets, ["ticket-1", "ticket-3"], "ticket-3", "ticket-2")).toEqual({
      toStatus: "todo",
      toIndex: 0,
    });
    expect(resolveGroupDrop(tickets, ["ticket-1", "ticket-3"], "ticket-1", "ticket-2")).toEqual({
      toStatus: "todo",
      toIndex: 1,
    });
  });

  it("returns null over one of the selected cards, for an empty selection, or an invalid active card", () => {
    expect(resolveGroupDrop(TICKETS, ["ticket-1", "ticket-2"], "ticket-1", "ticket-2")).toBeNull();
    expect(resolveGroupDrop(TICKETS, [], "ticket-1", "ticket-2")).toBeNull();
    expect(resolveGroupDrop(TICKETS, ["ticket-1"], "ticket-2", "ticket-3")).toBeNull();
  });

  it("returns null for an unknown over id", () => {
    expect(resolveGroupDrop(TICKETS, ["ticket-1"], "ticket-1", "unknown")).toBeNull();
  });
});

describe("resolveDrop", () => {
  it("targets the end of a column when over its droppable", () => {
    expect(resolveDrop(TICKETS, "ticket-1", columnDroppableId("todo"))).toEqual({
      toStatus: "todo",
      toIndex: 1,
    });
  });

  it("targets the end of an empty column", () => {
    expect(resolveDrop(TICKETS, "ticket-1", columnDroppableId("done"))).toEqual({
      toStatus: "done",
      toIndex: 0,
    });
  });

  it("uses the full column length over the active ticket's own column (clamped downstream)", () => {
    expect(resolveDrop(TICKETS, "ticket-1", columnDroppableId("backlog"))).toEqual({
      toStatus: "backlog",
      toIndex: 2,
    });
  });

  it("targets a card's own slot when over a card in another column", () => {
    expect(resolveDrop(TICKETS, "ticket-1", "ticket-3")).toEqual({
      toStatus: "todo",
      toIndex: 0,
    });
  });

  it("targets a card's slot within the same column", () => {
    expect(resolveDrop(TICKETS, "ticket-1", "ticket-2")).toEqual({
      toStatus: "backlog",
      toIndex: 1,
    });
  });

  it("resolves over-self to the ticket's current slot (no-op downstream)", () => {
    expect(resolveDrop(TICKETS, "ticket-1", "ticket-1")).toEqual({
      toStatus: "backlog",
      toIndex: 0,
    });
  });

  it("returns null for an unknown active ticket", () => {
    expect(resolveDrop(TICKETS, "ticket-99", "ticket-1")).toBeNull();
  });

  it("returns null for an over id that is neither a column nor a ticket", () => {
    expect(resolveDrop(TICKETS, "ticket-1", "nope")).toBeNull();
  });
});

describe("ticketPosition", () => {
  it("returns the ticket's column and index", () => {
    expect(ticketPosition(TICKETS, "ticket-2")).toEqual({ toStatus: "backlog", toIndex: 1 });
  });

  it("returns null for an unknown ticket", () => {
    expect(ticketPosition(TICKETS, "ticket-99")).toBeNull();
  });
});
