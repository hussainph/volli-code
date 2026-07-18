import { describe, it, expect } from "vite-plus/test";
import {
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  HARNESS_IDS,
  HARNESS_LABELS,
  harnessLabel,
  displayTicketId,
  createTicket,
  isTicketStatus,
  isTicketPriority,
  isHarnessId,
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

describe("isTicketStatus", () => {
  it("accepts every board status", () => {
    for (const status of TICKET_STATUSES) {
      expect(isTicketStatus(status)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isTicketStatus("archived")).toBe(false);
    expect(isTicketStatus("")).toBe(false);
    expect(isTicketStatus(42)).toBe(false);
    expect(isTicketStatus(null)).toBe(false);
    expect(isTicketStatus(undefined)).toBe(false);
  });
});

describe("isTicketPriority", () => {
  it("accepts every priority", () => {
    for (const priority of TICKET_PRIORITIES) {
      expect(isTicketPriority(priority)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isTicketPriority("urgent")).toBe(false);
    expect(isTicketPriority("")).toBe(false);
    expect(isTicketPriority(1)).toBe(false);
    expect(isTicketPriority(null)).toBe(false);
    expect(isTicketPriority(undefined)).toBe(false);
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
});

describe("harnessLabel", () => {
  it("labels every first-class harness from HARNESS_LABELS", () => {
    for (const harness of HARNESS_IDS) {
      expect(harnessLabel(harness)).toBe(HARNESS_LABELS[harness]);
    }
    expect(harnessLabel("claude-code")).toBe("Claude Code");
  });

  it("returns a custom, non-first-class harness id verbatim", () => {
    expect(harnessLabel("my-custom-harness")).toBe("my-custom-harness");
    expect(harnessLabel("")).toBe("");
  });
});

describe("isHarnessId", () => {
  it("accepts every first-class harness id", () => {
    for (const harness of HARNESS_IDS) {
      expect(isHarnessId(harness)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isHarnessId("my-custom-harness")).toBe(false);
    expect(isHarnessId("")).toBe(false);
    expect(isHarnessId(42)).toBe(false);
    expect(isHarnessId(null)).toBe(false);
    expect(isHarnessId(undefined)).toBe(false);
    expect(isHarnessId({ harnessId: "codex" })).toBe(false);
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

  it("defaults worktreePath, branch, and baseBranch to null", () => {
    const ticket = createTicket({
      id: "id-1",
      projectId: "proj-1",
      ticketNumber: 1,
      title: "Title",
      status: "todo",
      order: 0,
      now: 0,
    });
    expect(ticket.worktreePath).toBeNull();
    expect(ticket.branch).toBeNull();
    expect(ticket.baseBranch).toBeNull();
    expect(ticket.preferredHarnessId).toBe("claude-code");
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
      worktreePath: "/repo/.worktrees/VC-1",
      branch: "volli/VC-1-title",
      baseBranch: "main",
    });
    expect(ticket.body).toBe("Some markdown body");
    expect(ticket.priority).toBe("high");
    expect(ticket.labels).toEqual(["bug", "urgent"]);
    expect(ticket.usesWorktree).toBe(false);
    expect(ticket.worktreePath).toBe("/repo/.worktrees/VC-1");
    expect(ticket.branch).toBe("volli/VC-1-title");
    expect(ticket.baseBranch).toBe("main");
  });
});
