import { afterEach, describe, expect, it } from "vite-plus/test";
import { latestSessionSignalsByProject, listTicketEvents, recordTicketEvent } from "./events-repo";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { insertTicket } from "./tickets-repo";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

function setup(): { ticketId: string } {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  return { ticketId: ticket.id };
}

const FIVE_MIN_MS = 5 * 60 * 1000;

describe("listTicketEvents", () => {
  it("returns an empty list for a ticket with no events", () => {
    const { ticketId } = setup();
    expect(listTicketEvents(ctx.db, ticketId)).toEqual([]);
  });

  it("returns events chronologically", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, 100);
    recordTicketEvent(ctx.db, ticketId, { kind: "unarchived" }, 200);
    recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, 50);

    const events = listTicketEvents(ctx.db, ticketId);
    expect(events.map((e) => e.createdAt)).toEqual([50, 100, 200]);
  });

  it("uses insertion order (rowid) as a stable tiebreak for equal timestamps", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, 100);
    recordTicketEvent(ctx.db, ticketId, { kind: "unarchived" }, 100);

    const events = listTicketEvents(ctx.db, ticketId);
    expect(events.map((e) => e.payload.kind)).toEqual(["archived", "unarchived"]);
  });

  it("scopes strictly to the requested ticket", () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    const ticketA = testTicket(project.id, { id: "ticket-a" });
    const ticketB = testTicket(project.id, { id: "ticket-b" });
    insertTicket(ctx.db, ticketA);
    insertTicket(ctx.db, ticketB);

    recordTicketEvent(ctx.db, ticketA.id, { kind: "archived" }, 100);
    recordTicketEvent(ctx.db, ticketB.id, { kind: "unarchived" }, 100);

    expect(listTicketEvents(ctx.db, ticketA.id).map((e) => e.payload.kind)).toEqual(["archived"]);
  });

  it("parses the JSON payload back into a typed union", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "retitled", from: "Old", to: "New" }, 100);

    const [event] = listTicketEvents(ctx.db, ticketId);
    expect(event?.payload).toEqual({ kind: "retitled", from: "Old", to: "New" });
    expect(event?.actor).toBe("user");
  });

  it("round-trips the session door and its context for agent-originated mutations", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, 100, {
      kind: "session",
      sessionId: "session-7",
      ticketId,
    });

    expect(listTicketEvents(ctx.db, ticketId)[0]).toMatchObject({
      actor: "session",
      actorContext: { sessionId: "session-7", ticketId },
    });
  });

  it("round-trips a context-less system automation as the bare token", () => {
    // The worktree ensure/remove/sweep pipeline has no session — it stores as a
    // bare "automation" token (like "user"), not JSON with a context.
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, 100, { kind: "automation" });

    expect(listTicketEvents(ctx.db, ticketId)[0]).toMatchObject({
      actor: "automation",
      actorContext: null,
    });
  });
});

describe("recordTicketEvent — body_edited coalescing", () => {
  it("appends the first body_edited event (no prior event to coalesce into)", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "body_edited" }, 1000);

    const events = listTicketEvents(ctx.db, ticketId);
    expect(events).toHaveLength(1);
    expect(events[0]?.createdAt).toBe(1000);
  });

  it("touches (not appends) a second body_edited event within the 5-minute window", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "body_edited" }, 1000);
    recordTicketEvent(ctx.db, ticketId, { kind: "body_edited" }, 1000 + 60_000);

    const events = listTicketEvents(ctx.db, ticketId);
    expect(events).toHaveLength(1);
    expect(events[0]?.createdAt).toBe(1000 + 60_000);
  });

  it("keeps extending the coalesce window across a burst of edits", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "body_edited" }, 0);
    recordTicketEvent(ctx.db, ticketId, { kind: "body_edited" }, FIVE_MIN_MS - 1);
    // A third touch just under 5 minutes after the SECOND touch (not the
    // first) still coalesces — the window resets on every touch.
    recordTicketEvent(
      ctx.db,
      ticketId,
      { kind: "body_edited" },
      FIVE_MIN_MS - 1 + (FIVE_MIN_MS - 1),
    );

    const events = listTicketEvents(ctx.db, ticketId);
    expect(events).toHaveLength(1);
    expect(events[0]?.createdAt).toBe(FIVE_MIN_MS - 1 + (FIVE_MIN_MS - 1));
  });

  it("appends a new event once the gap since the last touch reaches 5 minutes", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "body_edited" }, 0);
    recordTicketEvent(ctx.db, ticketId, { kind: "body_edited" }, FIVE_MIN_MS);

    const events = listTicketEvents(ctx.db, ticketId);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.createdAt)).toEqual([0, FIVE_MIN_MS]);
  });

  it("a non-body_edited event in between breaks the coalesce chain", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "body_edited" }, 0);
    recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, 1000);
    recordTicketEvent(ctx.db, ticketId, { kind: "body_edited" }, 2000);

    const events = listTicketEvents(ctx.db, ticketId);
    expect(events.map((e) => e.payload.kind)).toEqual(["body_edited", "archived", "body_edited"]);
    expect(events.map((e) => e.createdAt)).toEqual([0, 1000, 2000]);
  });

  it("coalescing is scoped per-ticket", () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    const ticketA = testTicket(project.id, { id: "ticket-a" });
    const ticketB = testTicket(project.id, { id: "ticket-b" });
    insertTicket(ctx.db, ticketA);
    insertTicket(ctx.db, ticketB);

    recordTicketEvent(ctx.db, ticketA.id, { kind: "body_edited" }, 0);
    recordTicketEvent(ctx.db, ticketB.id, { kind: "body_edited" }, 1000);

    expect(listTicketEvents(ctx.db, ticketA.id)).toHaveLength(1);
    expect(listTicketEvents(ctx.db, ticketB.id)).toHaveLength(1);
  });
});

describe("latestSessionSignalsByProject", () => {
  it("returns no signals for a project whose tickets never signaled", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, 100);
    expect(latestSessionSignalsByProject(ctx.db, "project-1")).toEqual([]);
  });

  it("keeps only the newest session_signal per ticket and carries its session context", () => {
    ctx = openTestDb();
    const project = testProject({ id: "project-1" });
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id, { id: "ticket-a" });
    insertTicket(ctx.db, ticket);

    // An older 'done' is superseded by a newer 'blocked' on the same session.
    recordTicketEvent(
      ctx.db,
      ticket.id,
      { kind: "session_signal", signal: "done", reason: null },
      100,
      { kind: "session", sessionId: "s1", ticketId: ticket.id },
    );
    recordTicketEvent(
      ctx.db,
      ticket.id,
      { kind: "session_signal", signal: "blocked", reason: "Approve access" },
      200,
      { kind: "session", sessionId: "s2", ticketId: ticket.id },
    );

    expect(latestSessionSignalsByProject(ctx.db, project.id)).toEqual([
      {
        ticketId: "ticket-a",
        sessionId: "s2",
        signal: "blocked",
        reason: "Approve access",
        createdAt: 200,
      },
    ]);
  });

  it("ignores non-signal events and unsignaled tickets", () => {
    ctx = openTestDb();
    const project = testProject({ id: "project-1" });
    insertProject(ctx.db, project);
    const signaled = testTicket(project.id, { id: "signaled" });
    const quiet = testTicket(project.id, { id: "quiet" });
    insertTicket(ctx.db, signaled);
    insertTicket(ctx.db, quiet);

    recordTicketEvent(ctx.db, signaled.id, { kind: "archived" }, 50);
    recordTicketEvent(
      ctx.db,
      signaled.id,
      { kind: "session_signal", signal: "done", reason: null },
      100,
      { kind: "automation" },
    );
    recordTicketEvent(ctx.db, quiet.id, { kind: "body_edited" }, 100);

    // A context-less automation signal reports a null sessionId.
    expect(latestSessionSignalsByProject(ctx.db, project.id)).toEqual([
      { ticketId: "signaled", sessionId: null, signal: "done", reason: null, createdAt: 100 },
    ]);
  });

  it("scopes strictly to the requested project", () => {
    ctx = openTestDb();
    const projectA = testProject({ id: "project-a" });
    const projectB = testProject({ id: "project-b" });
    insertProject(ctx.db, projectA);
    insertProject(ctx.db, projectB);
    const ticketA = testTicket(projectA.id, { id: "ticket-a" });
    const ticketB = testTicket(projectB.id, { id: "ticket-b" });
    insertTicket(ctx.db, ticketA);
    insertTicket(ctx.db, ticketB);

    recordTicketEvent(
      ctx.db,
      ticketA.id,
      { kind: "session_signal", signal: "blocked", reason: null },
      100,
      { kind: "session", sessionId: "sa", ticketId: ticketA.id },
    );
    recordTicketEvent(
      ctx.db,
      ticketB.id,
      { kind: "session_signal", signal: "done", reason: null },
      100,
      { kind: "session", sessionId: "sb", ticketId: ticketB.id },
    );

    expect(latestSessionSignalsByProject(ctx.db, projectA.id).map((s) => s.ticketId)).toEqual([
      "ticket-a",
    ]);
  });
});
