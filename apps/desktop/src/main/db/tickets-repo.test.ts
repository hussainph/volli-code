import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import {
  archiveTicket,
  deleteTicket,
  getTicket,
  getTicketBody,
  getTicketBrief,
  getTicketRow,
  insertTicket,
  listAllTickets,
  listArchivedTicketsByProject,
  listTicketRosterByProject,
  listTicketsByProject,
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

/**
 * Rewrites a live ticket's `status` column to an out-of-vocabulary value,
 * bypassing the migration-001 `CHECK` constraint (`ignore_check_constraints`
 * is a real SQLite pragma, not app-specific) — the only way to reproduce the
 * "status reached the table outside the guarded write paths" scenario #29
 * guards against.
 */
function forceUnknownStatus(db: TestDb["db"], ticketId: string, status: string): void {
  db.pragma("ignore_check_constraints = 1");
  db.prepare("UPDATE tickets SET status = ? WHERE id = ?").run(status, ticketId);
  db.pragma("ignore_check_constraints = 0");
}

describe("getTicketBrief", () => {
  it("joins the project prefix so the brief carries a display id", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId, {
      ticketNumber: 52,
      title: "Rate limit the public search endpoint",
      body: "Anonymous search is unmetered.",
    });
    insertTicket(ctx.db, ticket);

    expect(getTicketBrief(ctx.db, ticket.id)).toEqual({
      displayId: "VC-52",
      title: "Rate limit the public search endpoint",
      body: "Anonymous search is unmetered.",
    });
  });

  it("answers undefined for a ticket that is gone", () => {
    setup();
    expect(getTicketBrief(ctx.db, "ghost")).toBeUndefined();
  });
});

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

describe("unknown-status rows are dropped at the hydrate boundary (#29)", () => {
  it("listTicketsByProject drops the corrupt row but keeps valid ones, warning once", () => {
    const { projectId } = setup();
    const good = testTicket(projectId, { title: "Good" });
    const bad = testTicket(projectId, { title: "Bad" });
    insertTicket(ctx.db, good);
    insertTicket(ctx.db, bad);
    forceUnknownStatus(ctx.db, bad.id, "bogus");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tickets = listTicketsByProject(ctx.db, projectId);

    expect(tickets.map((t) => t.id)).toEqual([good.id]);
    // Asserted before mockRestore(), which also clears recorded calls.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`dropping ticket ${bad.id} with unknown status "bogus"`),
    );
    warnSpy.mockRestore();
  });

  it("listTicketRosterByProject drops the corrupt row, like every other read path", () => {
    const { projectId } = setup();
    const good = testTicket(projectId, { title: "Good" });
    const bad = testTicket(projectId, { title: "Bad" });
    insertTicket(ctx.db, good);
    insertTicket(ctx.db, bad);
    forceUnknownStatus(ctx.db, bad.id, "bogus");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const roster = listTicketRosterByProject(ctx.db, projectId);

    // The roster spells its columns out instead of `SELECT *`, so it is the one
    // read that could have quietly skipped the shared status guard.
    expect(roster.map((t) => t.id)).toEqual([good.id]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`dropping ticket ${bad.id} with unknown status "bogus"`),
    );
    warnSpy.mockRestore();
  });

  it("listAllTickets drops the corrupt row across every project", () => {
    const { projectId } = setup();
    const good = testTicket(projectId, { title: "Good" });
    const bad = testTicket(projectId, { title: "Bad" });
    insertTicket(ctx.db, good);
    insertTicket(ctx.db, bad);
    forceUnknownStatus(ctx.db, bad.id, "bogus");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tickets = listAllTickets(ctx.db);
    warnSpy.mockRestore();

    expect(tickets.map((t) => t.id)).toEqual([good.id]);
  });

  it("listArchivedTicketsByProject drops a corrupt archived row but keeps valid ones", () => {
    const { projectId } = setup();
    const good = testTicket(projectId, { title: "Good" });
    const bad = testTicket(projectId, { title: "Bad" });
    insertTicket(ctx.db, good);
    insertTicket(ctx.db, bad);
    archiveTicket(ctx.db, good.id, 100);
    archiveTicket(ctx.db, bad.id, 100);
    forceUnknownStatus(ctx.db, bad.id, "bogus");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tickets = listArchivedTicketsByProject(ctx.db, projectId);
    warnSpy.mockRestore();

    expect(tickets.map((t) => t.id)).toEqual([good.id]);
  });

  it("getTicket returns undefined for a corrupt row — the same 'not found' shape a mutation handler already treats as Unknown ticket", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId);
    insertTicket(ctx.db, ticket);
    forceUnknownStatus(ctx.db, ticket.id, "bogus");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = getTicket(ctx.db, ticket.id);
    warnSpy.mockRestore();

    expect(result).toBeUndefined();
    // The raw row is still readable — only the domain mapping refuses it.
    expect(getTicketRow(ctx.db, ticket.id)?.status).toBe("bogus");
  });

  it("getTicket still returns a valid ticket unaffected by the guard", () => {
    const { projectId } = setup();
    const ticket = testTicket(projectId);
    insertTicket(ctx.db, ticket);

    expect(getTicket(ctx.db, ticket.id)?.id).toBe(ticket.id);
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

describe("the VC-387 steady-state roster reads", () => {
  it("returns the same board listTicketsByProject does, minus the body", () => {
    const { projectId } = setup();
    const first = testTicket(projectId, { title: "First", body: "# One" });
    const second = testTicket(projectId, { title: "Second", body: "# Two" });
    insertTicket(ctx.db, first);
    insertTicket(ctx.db, second);

    const full = listTicketsByProject(ctx.db, projectId);
    const roster = listTicketRosterByProject(ctx.db, projectId);

    // Order and membership must match exactly: a refresh has to produce the
    // same board the boot payload did, or a card would move for no reason.
    expect(roster).toEqual(full.map(({ body: _body, ...rest }) => rest));
    expect(roster.every((row) => !("body" in row))).toBe(true);
  });

  it("excludes archived tickets, exactly as the live board read does", () => {
    const { projectId } = setup();
    const live = testTicket(projectId, { title: "Live" });
    const gone = testTicket(projectId, { title: "Gone" });
    insertTicket(ctx.db, live);
    insertTicket(ctx.db, gone);
    archiveTicket(ctx.db, gone.id, 100);

    expect(listTicketRosterByProject(ctx.db, projectId).map((t) => t.id)).toEqual([live.id]);
  });

  it("answers another project's roster with nothing rather than this one's", () => {
    const { projectId } = setup();
    insertTicket(ctx.db, testTicket(projectId, { title: "Mine" }));

    expect(listTicketRosterByProject(ctx.db, "some-other-project")).toEqual([]);
  });

  it("reads one ticket's body, including for a ticket that has left the board", () => {
    const { projectId } = setup();
    const live = testTicket(projectId, { title: "Live", body: "# Live body" });
    const archived = testTicket(projectId, { title: "Archived", body: "# Archived body" });
    insertTicket(ctx.db, live);
    insertTicket(ctx.db, archived);
    archiveTicket(ctx.db, archived.id, 100);

    expect(getTicketBody(ctx.db, live.id)).toBe("# Live body");
    // Archived on purpose: the Archive view opens these, and a body is a body
    // whichever side of the board its ticket sits on.
    expect(getTicketBody(ctx.db, archived.id)).toBe("# Archived body");
  });

  it("answers an unknown ticket with undefined, which the handler turns into a refusal", () => {
    setup();
    expect(getTicketBody(ctx.db, "no-such-ticket")).toBeUndefined();
  });

  it("reads the body of a ticket whose status column is corrupt", () => {
    const { projectId } = setup();
    const bad = testTicket(projectId, { title: "Bad", body: "# Still a body" });
    insertTicket(ctx.db, bad);
    forceUnknownStatus(ctx.db, bad.id, "bogus");

    // The roster drops this row; its body read must not, or a ticket the board
    // cannot draw would also be one nobody could recover the text from.
    expect(getTicketBody(ctx.db, bad.id)).toBe("# Still a body");
  });
});
