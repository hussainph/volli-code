import { describe, it, expect } from "vite-plus/test";
import {
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  HARNESS_IDS,
  HARNESS_LABELS,
  DEFAULT_HARNESS_ID,
  displayTicketId,
  createTicket,
} from "./ticket";

describe("displayTicketId", () => {
  it("joins the prefix and ticket number", () => {
    expect(displayTicketId("VC", 12)).toBe("VC-12");
  });
});

describe("TICKET_STATUS_LABELS", () => {
  it("has a human label for every status", () => {
    for (const status of TICKET_STATUSES) {
      expect(TICKET_STATUS_LABELS[status]).toBeTypeOf("string");
    }
  });

  it("labels needs_review as two words", () => {
    expect(TICKET_STATUS_LABELS.needs_review).toBe("Needs Review");
  });
});

describe("TICKET_PRIORITY_LABELS", () => {
  it("has a human label for every priority", () => {
    for (const priority of TICKET_PRIORITIES) {
      expect(TICKET_PRIORITY_LABELS[priority]).toBeTypeOf("string");
    }
  });
});

describe("HARNESS_LABELS", () => {
  it("has a human label for every harness", () => {
    for (const harness of HARNESS_IDS) {
      expect(HARNESS_LABELS[harness]).toBeTypeOf("string");
    }
  });

  it("defaults to claude-code", () => {
    expect(DEFAULT_HARNESS_ID).toBe("claude-code");
  });
});

describe("createTicket", () => {
  it("uses the supplied id verbatim", () => {
    const ticket = createTicket({
      id: "11111111-1111-1111-1111-111111111111",
      projectId: "proj-1",
      ticketNumber: 12,
      title: "MCP server",
      status: "backlog",
      order: 0,
      now: 1000,
    });
    expect(ticket.id).toBe("11111111-1111-1111-1111-111111111111");
    expect(ticket.projectId).toBe("proj-1");
    expect(ticket.ticketNumber).toBe(12);
    expect(ticket.title).toBe("MCP server");
    expect(ticket.status).toBe("backlog");
    expect(ticket.order).toBe(0);
  });

  it("stamps createdAt and updatedAt from now", () => {
    const ticket = createTicket({
      id: "id-1",
      projectId: "proj-1",
      ticketNumber: 1,
      title: "Title",
      status: "todo",
      order: 0,
      now: 5000,
    });
    expect(ticket.createdAt).toBe(5000);
    expect(ticket.updatedAt).toBe(5000);
  });

  it("defaults body to an empty string", () => {
    const ticket = createTicket({
      id: "id-1",
      projectId: "proj-1",
      ticketNumber: 1,
      title: "Title",
      status: "todo",
      order: 0,
      now: 0,
    });
    expect(ticket.body).toBe("");
  });

  it("defaults priority to medium", () => {
    const ticket = createTicket({
      id: "id-1",
      projectId: "proj-1",
      ticketNumber: 1,
      title: "Title",
      status: "todo",
      order: 0,
      now: 0,
    });
    expect(ticket.priority).toBe("medium");
  });

  it("defaults labels to an empty array", () => {
    const ticket = createTicket({
      id: "id-1",
      projectId: "proj-1",
      ticketNumber: 1,
      title: "Title",
      status: "todo",
      order: 0,
      now: 0,
    });
    expect(ticket.labels).toEqual([]);
  });

  it("defaults usesWorktree to true", () => {
    const ticket = createTicket({
      id: "id-1",
      projectId: "proj-1",
      ticketNumber: 1,
      title: "Title",
      status: "todo",
      order: 0,
      now: 0,
    });
    expect(ticket.usesWorktree).toBe(true);
  });

  it("defaults harnessId to DEFAULT_HARNESS_ID", () => {
    const ticket = createTicket({
      id: "id-1",
      projectId: "proj-1",
      ticketNumber: 1,
      title: "Title",
      status: "todo",
      order: 0,
      now: 0,
    });
    expect(ticket.harnessId).toBe(DEFAULT_HARNESS_ID);
  });

  it("honors explicit overrides for all optional fields", () => {
    const ticket = createTicket({
      id: "id-1",
      projectId: "proj-1",
      ticketNumber: 1,
      title: "Title",
      status: "doing",
      order: 3,
      now: 0,
      body: "Some markdown body",
      priority: "high",
      labels: ["bug", "urgent"],
      usesWorktree: false,
      harnessId: "custom-harness",
    });
    expect(ticket.body).toBe("Some markdown body");
    expect(ticket.priority).toBe("high");
    expect(ticket.labels).toEqual(["bug", "urgent"]);
    expect(ticket.usesWorktree).toBe(false);
    expect(ticket.harnessId).toBe("custom-harness");
  });
});
