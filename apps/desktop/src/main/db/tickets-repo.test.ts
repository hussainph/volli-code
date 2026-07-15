import { afterEach, describe, expect, it } from "vite-plus/test";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import {
  deleteTicket,
  getTicket,
  getTicketRow,
  insertTicket,
  nextTicketNumberForProject,
  updateTicketFields,
} from "./tickets-repo";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

function setup(): { projectId: string } {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  return { projectId: project.id };
}

describe("insertTicket / getTicket — worktree identity columns (migration 003)", () => {
  it("defaults worktreePath/branch/baseBranch to null", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId);
    insertTicket(ctx.db, ticket);

    const persisted = getTicket(ctx.db, ticket.id);
    expect(persisted?.worktreePath).toBeNull();
    expect(persisted?.branch).toBeNull();
    expect(persisted?.baseBranch).toBeNull();
  });

  it("persists a ticket created with worktree identity already set", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId, {
      worktreePath: "/repo/.worktrees/VC-12",
      branch: "volli/VC-12-mcp-server",
      baseBranch: "main",
    });
    insertTicket(ctx.db, ticket);

    const persisted = getTicket(ctx.db, ticket.id);
    expect(persisted?.worktreePath).toBe("/repo/.worktrees/VC-12");
    expect(persisted?.branch).toBe("volli/VC-12-mcp-server");
    expect(persisted?.baseBranch).toBe("main");
  });

  it("round-trips through the raw row (getTicketRow) with snake_case columns", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId, {
      worktreePath: "/repo/wt",
      branch: "b",
      baseBranch: "main",
    });
    insertTicket(ctx.db, ticket);

    const row = getTicketRow(ctx.db, ticket.id);
    expect(row?.worktree_path).toBe("/repo/wt");
    expect(row?.branch).toBe("b");
    expect(row?.base_branch).toBe("main");
  });
});

describe("updateTicketFields — worktree identity fields", () => {
  it("sets a previously-null field", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId);
    insertTicket(ctx.db, ticket);

    updateTicketFields(ctx.db, ticket.id, { worktreePath: "/repo/wt" }, 100);

    const persisted = getTicket(ctx.db, ticket.id);
    expect(persisted?.worktreePath).toBe("/repo/wt");
    expect(persisted?.branch).toBeNull();
    expect(persisted?.baseBranch).toBeNull();
  });

  it("sets all three worktree fields together in one call", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId);
    insertTicket(ctx.db, ticket);

    updateTicketFields(
      ctx.db,
      ticket.id,
      { worktreePath: "/repo/wt", branch: "volli/VC-1-x", baseBranch: "main" },
      100,
    );

    const persisted = getTicket(ctx.db, ticket.id);
    expect(persisted?.worktreePath).toBe("/repo/wt");
    expect(persisted?.branch).toBe("volli/VC-1-x");
    expect(persisted?.baseBranch).toBe("main");
  });

  it("an explicit null clears a previously-set field", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId, {
      worktreePath: "/repo/wt",
      branch: "b",
      baseBranch: "main",
    });
    insertTicket(ctx.db, ticket);

    updateTicketFields(ctx.db, ticket.id, { worktreePath: null }, 100);

    const persisted = getTicket(ctx.db, ticket.id);
    expect(persisted?.worktreePath).toBeNull();
    expect(persisted?.branch).toBe("b");
    expect(persisted?.baseBranch).toBe("main");
  });

  it("bumps row_version and updated_at when a worktree field changes", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId);
    insertTicket(ctx.db, ticket);

    updateTicketFields(ctx.db, ticket.id, { branch: "b" }, 500);

    const row = getTicketRow(ctx.db, ticket.id);
    expect(row?.row_version).toBe(2);
    expect(row?.updated_at).toBe(500);
  });

  it("leaves title/body behavior intact alongside a worktree change", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId, { title: "Old title" });
    insertTicket(ctx.db, ticket);

    updateTicketFields(ctx.db, ticket.id, { title: "New title", branch: "b" }, 100);

    const persisted = getTicket(ctx.db, ticket.id);
    expect(persisted?.title).toBe("New title");
    expect(persisted?.branch).toBe("b");
  });

  it("no-ops when no field (including worktree ones) is present", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId);
    insertTicket(ctx.db, ticket);

    updateTicketFields(ctx.db, ticket.id, {}, 999);

    const row = getTicketRow(ctx.db, ticket.id);
    expect(row?.row_version).toBe(1);
    expect(row?.updated_at).toBe(ticket.updatedAt);
  });
});

describe("nextTicketNumberForProject — monotonic counter (migration 005)", () => {
  it("starts a fresh project at 1 and increments on each allocation", () => {
    const { projectId } = setup();

    expect(nextTicketNumberForProject(ctx.db, projectId)).toBe(1);
    expect(nextTicketNumberForProject(ctx.db, projectId)).toBe(2);
    expect(nextTicketNumberForProject(ctx.db, projectId)).toBe(3);
  });

  it("never reuses a number after the ticket that used it is hard-deleted", () => {
    const { projectId } = setup();

    const one = nextTicketNumberForProject(ctx.db, projectId);
    const two = nextTicketNumberForProject(ctx.db, projectId);
    const three = nextTicketNumberForProject(ctx.db, projectId);
    const ticketThree = testTicket(projectId, { ticketNumber: three });
    insertTicket(ctx.db, testTicket(projectId, { ticketNumber: one }));
    insertTicket(ctx.db, testTicket(projectId, { ticketNumber: two }));
    insertTicket(ctx.db, ticketThree);

    // Hard-delete the highest-numbered ticket — the exact scenario from
    // issue #35: with the old MAX(ticket_number)+1 logic, this would free
    // number 3 for reuse by the very next created ticket.
    deleteTicket(ctx.db, ticketThree.id);

    expect(nextTicketNumberForProject(ctx.db, projectId)).toBe(4);
  });

  it("keeps counters independent per project", () => {
    ctx = openTestDb();
    const projectA = testProject();
    const projectB = testProject();
    insertProject(ctx.db, projectA);
    insertProject(ctx.db, projectB);

    expect(nextTicketNumberForProject(ctx.db, projectA.id)).toBe(1);
    expect(nextTicketNumberForProject(ctx.db, projectA.id)).toBe(2);
    expect(nextTicketNumberForProject(ctx.db, projectB.id)).toBe(1);
  });

  it("falls back to MAX(ticket_number) + 1 when the counter has fallen behind a live row", () => {
    const { projectId } = setup();
    // Simulate a stale/corrupt counter — lower than a ticket_number already
    // on a live row — and confirm the belt-and-braces guard wins: the
    // allocated number can never collide with that row.
    ctx.db.prepare("UPDATE projects SET next_ticket_number = 1 WHERE id = ?").run(projectId);
    insertTicket(ctx.db, testTicket(projectId, { ticketNumber: 5 }));

    expect(nextTicketNumberForProject(ctx.db, projectId)).toBe(6);
  });

  it("throws for an unknown project id", () => {
    ctx = openTestDb();
    expect(() => nextTicketNumberForProject(ctx.db, "no-such-project")).toThrow(/Unknown project/);
  });
});
