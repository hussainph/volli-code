import { afterEach, describe, expect, it } from "vite-plus/test";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { getTicket, getTicketRow, insertTicket, updateTicketFields } from "./tickets-repo";

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
