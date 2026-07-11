import { describe, it, expect } from "vite-plus/test";
import { createTicket } from "./ticket";
import type { Ticket, TicketStatus } from "./ticket";
import {
  groupTicketsByStatus,
  moveTicket,
  emptyStatuses,
  nextTicketNumber,
  setTicketPriority,
  removeTicket,
} from "./board";

function ticket(overrides: {
  ticketNumber: number;
  status: TicketStatus;
  order: number;
  updatedAt?: number;
}): Ticket {
  return createTicket({
    prefix: "VC",
    projectId: "proj-1",
    ticketNumber: overrides.ticketNumber,
    title: `Ticket ${overrides.ticketNumber}`,
    status: overrides.status,
    order: overrides.order,
    now: overrides.updatedAt ?? 0,
  });
}

describe("groupTicketsByStatus", () => {
  it("includes every status, empty columns included", () => {
    const groups = groupTicketsByStatus([]);
    expect(groups.backlog).toEqual([]);
    expect(groups.todo).toEqual([]);
    expect(groups.doing).toEqual([]);
    expect(groups.needs_review).toEqual([]);
    expect(groups.done).toEqual([]);
  });

  it("sorts each column by order ascending", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 2 });
    const b = ticket({ ticketNumber: 2, status: "todo", order: 0 });
    const c = ticket({ ticketNumber: 3, status: "todo", order: 1 });
    const groups = groupTicketsByStatus([a, b, c]);
    expect(groups.todo.map((t) => t.ticketNumber)).toEqual([2, 3, 1]);
  });

  it("breaks order ties by ticketNumber ascending", () => {
    const a = ticket({ ticketNumber: 5, status: "backlog", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "backlog", order: 0 });
    const groups = groupTicketsByStatus([a, b]);
    expect(groups.backlog.map((t) => t.ticketNumber)).toEqual([2, 5]);
  });

  it("partitions tickets into their own status column", () => {
    const a = ticket({ ticketNumber: 1, status: "backlog", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "done", order: 0 });
    const groups = groupTicketsByStatus([a, b]);
    expect(groups.backlog.map((t) => t.ticketNumber)).toEqual([1]);
    expect(groups.done.map((t) => t.ticketNumber)).toEqual([2]);
  });
});

describe("moveTicket", () => {
  it("returns the same array reference when the ticket id is unknown", () => {
    const tickets = [ticket({ ticketNumber: 1, status: "todo", order: 0 })];
    const result = moveTicket(tickets, "VC-999", "doing", 0, 100);
    expect(result).toBe(tickets);
  });

  it("returns the same array reference when the position is unchanged (same column, same index)", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "todo", order: 1 });
    const tickets = [a, b];
    const result = moveTicket(tickets, "VC-1", "todo", 0, 100);
    expect(result).toBe(tickets);
  });

  it("moves a ticket down within the same column and rebalances order", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "todo", order: 1 });
    const c = ticket({ ticketNumber: 3, status: "todo", order: 2 });
    const result = moveTicket([a, b, c], "VC-1", "todo", 2, 100);
    const groups = groupTicketsByStatus(result);
    expect(groups.todo.map((t) => t.ticketNumber)).toEqual([2, 3, 1]);
    expect(groups.todo.map((t) => t.order)).toEqual([0, 1, 2]);
  });

  it("moves a ticket up within the same column and rebalances order", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "todo", order: 1 });
    const c = ticket({ ticketNumber: 3, status: "todo", order: 2 });
    const result = moveTicket([a, b, c], "VC-3", "todo", 0, 100);
    const groups = groupTicketsByStatus(result);
    expect(groups.todo.map((t) => t.ticketNumber)).toEqual([3, 1, 2]);
  });

  it("moves a ticket across columns, rebalancing both source and destination", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "todo", order: 1 });
    const c = ticket({ ticketNumber: 3, status: "doing", order: 0 });
    const result = moveTicket([a, b, c], "VC-1", "doing", 0, 100);
    const groups = groupTicketsByStatus(result);
    expect(groups.todo.map((t) => t.ticketNumber)).toEqual([2]);
    expect(groups.todo.map((t) => t.order)).toEqual([0]);
    expect(groups.doing.map((t) => t.ticketNumber)).toEqual([1, 3]);
    expect(groups.doing.map((t) => t.order)).toEqual([0, 1]);
  });

  it("sets status and updatedAt on the moved ticket", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const result = moveTicket([a], "VC-1", "doing", 0, 4242);
    const moved = result.find((t) => t.id === "VC-1")!;
    expect(moved.status).toBe("doing");
    expect(moved.updatedAt).toBe(4242);
  });

  it("clamps a negative toIndex to the start of the destination column", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "doing", order: 0 });
    const result = moveTicket([a, b], "VC-1", "doing", -5, 100);
    const groups = groupTicketsByStatus(result);
    expect(groups.doing.map((t) => t.ticketNumber)).toEqual([1, 2]);
  });

  it("clamps a toIndex beyond the destination column length to the end", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "doing", order: 0 });
    const result = moveTicket([a, b], "VC-1", "doing", 99, 100);
    const groups = groupTicketsByStatus(result);
    expect(groups.doing.map((t) => t.ticketNumber)).toEqual([2, 1]);
  });

  it("is a no-op (same reference) when moved to its own current index in an empty-otherwise column", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const tickets = [a];
    const result = moveTicket(tickets, "VC-1", "todo", 0, 100);
    expect(result).toBe(tickets);
  });

  it("does not treat an out-of-range same-column index as a no-op when it clamps to a different position", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "todo", order: 1 });
    const tickets = [a, b];
    // Ticket "VC-2" is already last (index 1); requesting index 99 clamps to 1 too, so this is a no-op.
    const result = moveTicket(tickets, "VC-2", "todo", 99, 100);
    expect(result).toBe(tickets);
  });
});

describe("emptyStatuses", () => {
  it("returns all statuses when there are no tickets", () => {
    expect(emptyStatuses([])).toEqual(["backlog", "todo", "doing", "needs_review", "done"]);
  });

  it("excludes statuses that have at least one ticket", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    expect(emptyStatuses([a])).toEqual(["backlog", "doing", "needs_review", "done"]);
  });

  it("returns an empty array when every status has a ticket", () => {
    const tickets = ["backlog", "todo", "doing", "needs_review", "done"].map((status, i) =>
      ticket({ ticketNumber: i + 1, status: status as TicketStatus, order: 0 }),
    );
    expect(emptyStatuses(tickets)).toEqual([]);
  });
});

describe("nextTicketNumber", () => {
  it("returns 1 when there are no tickets", () => {
    expect(nextTicketNumber([])).toBe(1);
  });

  it("returns one greater than the highest ticket number", () => {
    const a = ticket({ ticketNumber: 3, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 7, status: "done", order: 0 });
    expect(nextTicketNumber([a, b])).toBe(8);
  });
});

describe("setTicketPriority", () => {
  it("returns the same array reference when the ticket id is unknown", () => {
    const tickets = [ticket({ ticketNumber: 1, status: "todo", order: 0 })];
    expect(setTicketPriority(tickets, "VC-999", "high", 100)).toBe(tickets);
  });

  it("returns the same array reference when the priority is unchanged", () => {
    const tickets = [ticket({ ticketNumber: 1, status: "todo", order: 0 })];
    expect(setTicketPriority(tickets, "VC-1", "medium", 100)).toBe(tickets);
  });

  it("returns a new array with the priority updated and updatedAt bumped, leaving other tickets untouched", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "todo", order: 1 });
    const tickets = [a, b];
    const result = setTicketPriority(tickets, "VC-1", "high", 555);
    expect(result).not.toBe(tickets);
    expect(result[0]!.priority).toBe("high");
    expect(result[0]!.updatedAt).toBe(555);
    expect(result[1]).toBe(b);
  });
});

describe("removeTicket", () => {
  it("returns the same array reference when the ticket id is unknown", () => {
    const tickets = [ticket({ ticketNumber: 1, status: "todo", order: 0 })];
    expect(removeTicket(tickets, "VC-999")).toBe(tickets);
  });

  it("removes the ticket and rebalances the source column's order", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "todo", order: 1 });
    const c = ticket({ ticketNumber: 3, status: "todo", order: 2 });
    const result = removeTicket([a, b, c], "VC-2");
    expect(result.map((t) => t.ticketNumber)).toEqual([1, 3]);
    const groups = groupTicketsByStatus(result);
    expect(groups.todo.map((t) => t.order)).toEqual([0, 1]);
  });

  it("does not affect other columns' order", () => {
    const a = ticket({ ticketNumber: 1, status: "todo", order: 0 });
    const b = ticket({ ticketNumber: 2, status: "doing", order: 0 });
    const result = removeTicket([a, b], "VC-1");
    expect(result.map((t) => t.ticketNumber)).toEqual([2]);
    expect(result[0]!.order).toBe(0);
  });
});
