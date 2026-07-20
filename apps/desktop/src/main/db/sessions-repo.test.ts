import { afterEach, describe, expect, it } from "vite-plus/test";
import { insertProject } from "./projects-repo";
import {
  countProjectScratchSessions,
  countTicketSessions,
  endLiveSessions,
  endSession,
  getTicketSessionContext,
  insertSession,
  listSessions,
  listTicketSessions,
  setHarnessSessionId,
  updateTitle,
} from "./sessions-repo";
import { openTestDb, testProject, testSession, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { insertTicket } from "./tickets-repo";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

function setup(): { projectId: string; ticketId: string } {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  return { projectId: project.id, ticketId: ticket.id };
}

describe("insertSession / listSessions", () => {
  it("round-trips a ticket-scoped session", () => {
    const { projectId, ticketId } = setup();
    const session = testSession(projectId, ticketId, {
      title: "Fix the bug",
      launchKind: "agent",
      placement: "split",
      harnessId: "codex",
    });
    insertSession(ctx.db, session);

    expect(listSessions(ctx.db, projectId)).toEqual([session]);
  });

  it("round-trips a project-scoped scratch session (ticketId null)", () => {
    const { projectId } = setup();
    const session = testSession(projectId, null, { title: "Scratch" });
    insertSession(ctx.db, session);

    const [persisted] = listSessions(ctx.db, projectId);
    expect(persisted?.ticketId).toBeNull();
  });

  it("lists all scopes together, newest first", () => {
    const { projectId, ticketId } = setup();
    const scratch = testSession(projectId, null, { id: "s1", createdAt: 100 });
    const scoped = testSession(projectId, ticketId, { id: "s2", createdAt: 200 });
    insertSession(ctx.db, scratch);
    insertSession(ctx.db, scoped);

    expect(listSessions(ctx.db, projectId).map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("uses insertion order as a tiebreak for equal createdAt", () => {
    const { projectId } = setup();
    const a = testSession(projectId, null, { id: "a", createdAt: 100 });
    const b = testSession(projectId, null, { id: "b", createdAt: 100 });
    insertSession(ctx.db, a);
    insertSession(ctx.db, b);

    // Newest-first by createdAt, insertion-order (rowid) tiebreak: b inserted after a.
    expect(listSessions(ctx.db, projectId).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("scopes strictly to the requested project", () => {
    ctx = openTestDb();
    const projectA = testProject();
    const projectB = testProject();
    insertProject(ctx.db, projectA);
    insertProject(ctx.db, projectB);

    insertSession(ctx.db, testSession(projectA.id, null, { id: "sa" }));
    insertSession(ctx.db, testSession(projectB.id, null, { id: "sb" }));

    expect(listSessions(ctx.db, projectA.id).map((s) => s.id)).toEqual(["sa"]);
  });
});

describe("listTicketSessions", () => {
  it("returns only a ticket's sessions, newest first", () => {
    const { projectId, ticketId } = setup();
    const otherTicket = testTicket(projectId, { id: "other-ticket" });
    insertTicket(ctx.db, otherTicket);

    insertSession(ctx.db, testSession(projectId, ticketId, { id: "s1", createdAt: 100 }));
    insertSession(ctx.db, testSession(projectId, ticketId, { id: "s2", createdAt: 200 }));
    insertSession(ctx.db, testSession(projectId, otherTicket.id, { id: "s3", createdAt: 300 }));
    insertSession(ctx.db, testSession(projectId, null, { id: "s4", createdAt: 400 }));

    expect(listTicketSessions(ctx.db, ticketId).map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("returns an empty list for a ticket with no sessions", () => {
    const { ticketId } = setup();
    expect(listTicketSessions(ctx.db, ticketId)).toEqual([]);
  });
});

describe("endSession", () => {
  it("stamps ended_at, leaving everything else untouched", () => {
    const { projectId } = setup();
    const session = testSession(projectId, null);
    insertSession(ctx.db, session);

    endSession(ctx.db, session.id, 500);

    const [persisted] = listSessions(ctx.db, projectId);
    expect(persisted?.endedAt).toBe(500);
    expect(persisted?.title).toBe(session.title);
  });
});

describe("updateTitle", () => {
  it("renames a session and reports one row changed", () => {
    const { projectId } = setup();
    const session = testSession(projectId, null, { title: "Session 1" });
    insertSession(ctx.db, session);

    expect(updateTitle(ctx.db, session.id, "Renamed")).toBe(1);
    expect(listSessions(ctx.db, projectId)[0]?.title).toBe("Renamed");
  });

  it("reports zero rows changed for an unknown session", () => {
    const { projectId } = setup();
    expect(updateTitle(ctx.db, "ghost", "Nope")).toBe(0);
    expect(listSessions(ctx.db, projectId)).toEqual([]);
  });
});

describe("setHarnessSessionId", () => {
  it("fills in the harness resume/session UUID", () => {
    const { projectId } = setup();
    const session = testSession(projectId, null);
    insertSession(ctx.db, session);

    setHarnessSessionId(ctx.db, session.id, "claude-resume-uuid");

    const [persisted] = listSessions(ctx.db, projectId);
    expect(persisted?.harnessSessionId).toBe("claude-resume-uuid");
  });
});

describe("endLiveSessions (boot sweep)", () => {
  it("stamps ended_at on every still-live row and leaves ended rows untouched", () => {
    const { projectId, ticketId } = setup();
    insertSession(ctx.db, testSession(projectId, ticketId, { id: "live1" }));
    insertSession(ctx.db, testSession(projectId, null, { id: "live2" }));
    const alreadyEnded = testSession(projectId, null, { id: "done" });
    insertSession(ctx.db, alreadyEnded);
    endSession(ctx.db, "done", 42);

    const swept = endLiveSessions(ctx.db, 999);

    expect(swept).toBe(2);
    const byId = new Map(listSessions(ctx.db, projectId).map((s) => [s.id, s.endedAt]));
    expect(byId.get("live1")).toBe(999);
    expect(byId.get("live2")).toBe(999);
    expect(byId.get("done")).toBe(42);
  });

  it("reports zero when nothing is live", () => {
    const { projectId } = setup();
    expect(endLiveSessions(ctx.db, 1)).toBe(0);
    expect(listSessions(ctx.db, projectId)).toEqual([]);
  });
});

describe("session counts", () => {
  it("counts a ticket's sessions and a project's scratch sessions separately", () => {
    const { projectId, ticketId } = setup();
    insertSession(ctx.db, testSession(projectId, ticketId, { id: "t1" }));
    insertSession(ctx.db, testSession(projectId, ticketId, { id: "t2" }));
    insertSession(ctx.db, testSession(projectId, null, { id: "s1" }));

    expect(countTicketSessions(ctx.db, ticketId)).toBe(2);
    expect(countProjectScratchSessions(ctx.db, projectId)).toBe(1);
  });

  it("returns zero for a ticket/project with no matching sessions", () => {
    const { projectId, ticketId } = setup();
    expect(countTicketSessions(ctx.db, ticketId)).toBe(0);
    expect(countProjectScratchSessions(ctx.db, projectId)).toBe(0);
  });
});

describe("getTicketSessionContext", () => {
  it("resolves a ticket to its project path, prefix, number, worktree flag, and setup command", () => {
    ctx = openTestDb();
    const project = testProject({
      path: "/repo/app",
      ticketPrefix: "APP",
      setupCommand: "pnpm install",
    });
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id, { ticketNumber: 7 });
    insertTicket(ctx.db, ticket);

    expect(getTicketSessionContext(ctx.db, ticket.id)).toEqual({
      projectId: project.id,
      projectPath: "/repo/app",
      ticketPrefix: "APP",
      ticketNumber: 7,
      preferredHarnessId: "claude-code",
      // testTicket defaults usesWorktree → true; the project carries a setup command.
      usesWorktree: true,
      setupCommand: "pnpm install",
    });
  });

  it("maps a non-worktree ticket and a null setup command", () => {
    ctx = openTestDb();
    const project = testProject({ path: "/repo/plain", ticketPrefix: "PL" });
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id, { ticketNumber: 3, usesWorktree: false });
    insertTicket(ctx.db, ticket);

    const context = getTicketSessionContext(ctx.db, ticket.id);
    expect(context?.usesWorktree).toBe(false);
    expect(context?.setupCommand).toBeNull();
  });

  it("returns undefined for an unknown ticket", () => {
    const { projectId } = setup();
    expect(getTicketSessionContext(ctx.db, "ghost")).toBeUndefined();
    // sanity: a real project without that ticket still yields nothing
    expect(countProjectScratchSessions(ctx.db, projectId)).toBe(0);
  });
});

describe("cascade behavior", () => {
  it("deleting the project cascades its sessions away", () => {
    const { projectId } = setup();
    insertSession(ctx.db, testSession(projectId, null));

    ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);

    expect(ctx.db.prepare("SELECT COUNT(*) as n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("deleting the ticket nulls the session's ticket_id (session survives as project-scoped)", () => {
    const { projectId, ticketId } = setup();
    const session = testSession(projectId, ticketId);
    insertSession(ctx.db, session);

    ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);

    const [survivor] = listSessions(ctx.db, projectId);
    expect(survivor).toBeDefined();
    expect(survivor?.ticketId).toBeNull();
  });
});
