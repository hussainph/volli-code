import { describe, it, expect } from "vite-plus/test";
import {
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  FIRST_CLASS_HARNESS_IDS,
  HARNESS_LABELS,
  harnessLabel,
  displayTicketId,
  createTicket,
  isTicketStatus,
  isTicketPriority,
  isFirstClassHarnessId,
  parseHarnessId,
  type HarnessId,
  type CustomHarnessId,
  ACTIVE_TICKET_STATUSES,
  isActiveTicketStatus,
  leavesActiveColumns,
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

describe("isActiveTicketStatus", () => {
  it("treats doing and needs_review as active", () => {
    for (const status of ACTIVE_TICKET_STATUSES) {
      expect(isActiveTicketStatus(status)).toBe(true);
    }
  });

  it("treats backlog, todo, and done as inactive", () => {
    expect(isActiveTicketStatus("backlog")).toBe(false);
    expect(isActiveTicketStatus("todo")).toBe(false);
    expect(isActiveTicketStatus("done")).toBe(false);
  });
});

describe("leavesActiveColumns", () => {
  it("is true when doing exits to backlog, todo, or done", () => {
    expect(leavesActiveColumns("doing", "backlog")).toBe(true);
    expect(leavesActiveColumns("doing", "todo")).toBe(true);
    expect(leavesActiveColumns("doing", "done")).toBe(true);
  });

  it("is true when needs_review exits to backlog, todo, or done", () => {
    expect(leavesActiveColumns("needs_review", "backlog")).toBe(true);
    expect(leavesActiveColumns("needs_review", "todo")).toBe(true);
    expect(leavesActiveColumns("needs_review", "done")).toBe(true);
  });

  it("is false when moving between active columns", () => {
    expect(leavesActiveColumns("doing", "needs_review")).toBe(false);
    expect(leavesActiveColumns("needs_review", "doing")).toBe(false);
  });

  it("is false when the ticket was never active", () => {
    expect(leavesActiveColumns("backlog", "todo")).toBe(false);
    expect(leavesActiveColumns("todo", "doing")).toBe(false);
    expect(leavesActiveColumns("backlog", "done")).toBe(false);
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
    for (const harness of FIRST_CLASS_HARNESS_IDS) {
      expect(HARNESS_LABELS[harness]).toBeTypeOf("string");
    }
  });
});

describe("harnessLabel", () => {
  it("labels every first-class harness from HARNESS_LABELS", () => {
    for (const harness of FIRST_CLASS_HARNESS_IDS) {
      expect(harnessLabel(harness)).toBe(HARNESS_LABELS[harness]);
    }
    expect(harnessLabel("claude-code")).toBe("Claude Code");
  });

  it("returns a custom, non-first-class harness id verbatim", () => {
    expect(harnessLabel("my-custom-harness")).toBe("my-custom-harness");
    expect(harnessLabel("")).toBe("");
  });
});

describe("isFirstClassHarnessId", () => {
  it("accepts every first-class harness id", () => {
    for (const harness of FIRST_CLASS_HARNESS_IDS) {
      expect(isFirstClassHarnessId(harness)).toBe(true);
    }
  });

  it("rejects unknown strings and non-strings", () => {
    expect(isFirstClassHarnessId("my-custom-harness")).toBe(false);
    expect(isFirstClassHarnessId("")).toBe(false);
    expect(isFirstClassHarnessId(42)).toBe(false);
    expect(isFirstClassHarnessId(null)).toBe(false);
    expect(isFirstClassHarnessId(undefined)).toBe(false);
    expect(isFirstClassHarnessId({ harnessId: "codex" })).toBe(false);
  });
});

describe("parseHarnessId", () => {
  it("mints every first-class harness id unchanged", () => {
    for (const harness of FIRST_CLASS_HARNESS_IDS) {
      expect(parseHarnessId(harness)).toBe(harness);
    }
  });

  it("mints a well-formed slug a third party could register", () => {
    expect(parseHarnessId("my-harness")).toBe("my-harness");
    expect(parseHarnessId("aider2")).toBe("aider2");
    expect(parseHarnessId("a".repeat(32))).toBe("a".repeat(32));
  });

  it("refuses a slug that could not name a directory or an env-var suffix", () => {
    expect(parseHarnessId("")).toBeNull();
    expect(parseHarnessId("x")).toBeNull();
    expect(parseHarnessId("a".repeat(33))).toBeNull();
    expect(parseHarnessId("Claude-Code")).toBeNull();
    expect(parseHarnessId("2fast")).toBeNull();
    expect(parseHarnessId("-lead")).toBeNull();
    expect(parseHarnessId("has space")).toBeNull();
    expect(parseHarnessId("../escape")).toBeNull();
    expect(parseHarnessId("semi;colon")).toBeNull();
  });
});

/**
 * A `switch` an exhaustiveness assert would guard. The residual after the four
 * first-class arms must type as {@link CustomHarnessId}, never `never` — the
 * union stays open for registered harnesses.
 */
function describeHarnessArm(id: HarnessId): string {
  switch (id) {
    case "claude-code":
    case "codex":
    case "cursor":
    case "opencode": {
      return "first-class";
    }
    default: {
      const residual: CustomHarnessId = id;
      return residual;
    }
  }
}

describe("HarnessId (type-level)", () => {
  it("keeps first-class literals assignable so existing call sites are untouched", () => {
    const id: HarnessId = "claude-code";
    expect(id).toBe("claude-code");
  });

  it("refuses a bare string, forcing every DB read and IPC payload through parseHarnessId", () => {
    const fromDatabase: string = "claude-code";
    // @ts-expect-error a `string` is assignable to neither arm of HarnessId.
    const unchecked: HarnessId = fromDatabase;
    expect(unchecked).toBe("claude-code");

    const checked = parseHarnessId(fromDatabase);
    expect(checked).toBe("claude-code");
  });

  it("leaves a CustomHarnessId residual after the four first-class arms, not never", () => {
    expect(describeHarnessArm("codex")).toBe("first-class");
    expect(describeHarnessArm(parseHarnessId("my-harness") as CustomHarnessId)).toBe("my-harness");
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

  it("defaults worktreePath, branch, baseBranch, and prUrl to null", () => {
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
    expect(ticket.prUrl).toBeNull();
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
      prUrl: "https://github.com/acme/repo/pull/7",
    });
    expect(ticket.body).toBe("Some markdown body");
    expect(ticket.priority).toBe("high");
    expect(ticket.labels).toEqual(["bug", "urgent"]);
    expect(ticket.usesWorktree).toBe(false);
    expect(ticket.worktreePath).toBe("/repo/.worktrees/VC-1");
    expect(ticket.branch).toBe("volli/VC-1-title");
    expect(ticket.baseBranch).toBe("main");
    expect(ticket.prUrl).toBe("https://github.com/acme/repo/pull/7");
  });
});
