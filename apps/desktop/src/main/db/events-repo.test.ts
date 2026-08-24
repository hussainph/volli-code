import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  listTicketEvents,
  listTicketStatusEntries,
  recordSessionStartedOnce,
  recordTicketEvent,
} from "./events-repo";
import { insertProject } from "./projects-repo";
import { openTestDb, testProject, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { archiveTicket, insertTicket } from "./tickets-repo";

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

describe("listTicketStatusEntries", () => {
  it("uses the ticket's newest status_changed event as enteredAt", () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id, { id: "ticket-a", status: "backlog" });
    insertTicket(ctx.db, ticket);
    recordTicketEvent(
      ctx.db,
      ticket.id,
      { kind: "status_changed", from: "backlog", to: "todo" },
      100,
    );
    recordTicketEvent(
      ctx.db,
      ticket.id,
      { kind: "status_changed", from: "todo", to: "doing" },
      300,
    );
    // An older status_changed event must not win over the newer one, even
    // though it's inserted last (out-of-order created_at).
    recordTicketEvent(
      ctx.db,
      ticket.id,
      { kind: "status_changed", from: "backlog", to: "todo" },
      50,
    );

    const entries = listTicketStatusEntries(ctx.db, project.id);
    expect(entries).toEqual([{ ticketId: ticket.id, status: "backlog", enteredAt: 300 }]);
  });

  it("falls back to the ticket's own createdAt when it has never changed status", () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id, { id: "born-backlog", createdAt: 42 });
    insertTicket(ctx.db, ticket);

    const entries = listTicketStatusEntries(ctx.db, project.id);
    expect(entries).toEqual([{ ticketId: ticket.id, status: "backlog", enteredAt: 42 }]);
  });

  it("breaks ties for equal-timestamp status_changed events using insertion order (rowid)", () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id, { id: "ticket-a", status: "backlog" });
    insertTicket(ctx.db, ticket);
    recordTicketEvent(
      ctx.db,
      ticket.id,
      { kind: "status_changed", from: "backlog", to: "todo" },
      100,
    );
    recordTicketEvent(
      ctx.db,
      ticket.id,
      { kind: "status_changed", from: "todo", to: "doing" },
      100,
    );

    const entries = listTicketStatusEntries(ctx.db, project.id);
    expect(entries).toEqual([{ ticketId: ticket.id, status: "backlog", enteredAt: 100 }]);
  });

  it("excludes archived tickets", () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    const live = testTicket(project.id, { id: "live", createdAt: 10 });
    const archived = testTicket(project.id, { id: "archived", createdAt: 20 });
    insertTicket(ctx.db, live);
    insertTicket(ctx.db, archived);
    archiveTicket(ctx.db, archived.id, 999);

    const entries = listTicketStatusEntries(ctx.db, project.id);
    expect(entries.map((e) => e.ticketId)).toEqual([live.id]);
  });

  it("scopes strictly to the requested project", () => {
    ctx = openTestDb();
    const projectA = testProject();
    const projectB = testProject();
    insertProject(ctx.db, projectA);
    insertProject(ctx.db, projectB);
    const ticketA = testTicket(projectA.id, { id: "ticket-a", createdAt: 1 });
    const ticketB = testTicket(projectB.id, { id: "ticket-b", createdAt: 2 });
    insertTicket(ctx.db, ticketA);
    insertTicket(ctx.db, ticketB);

    const entries = listTicketStatusEntries(ctx.db, projectA.id);
    expect(entries.map((e) => e.ticketId)).toEqual([ticketA.id]);
  });

  it("issues one batched query regardless of ticket count", () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    const tickets = Array.from({ length: 5 }, (_, i) =>
      testTicket(project.id, { id: `ticket-${i}`, createdAt: i }),
    );
    for (const ticket of tickets) {
      insertTicket(ctx.db, ticket);
    }
    recordTicketEvent(
      ctx.db,
      tickets[2]?.id ?? "",
      { kind: "status_changed", from: "backlog", to: "todo" },
      500,
    );

    const prepareSpy = vi.spyOn(ctx.db, "prepare");
    const entries = listTicketStatusEntries(ctx.db, project.id);

    expect(entries).toHaveLength(5);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * The one durable write in a `session.start` that carries no idempotency key of
 * its own (VC-162).
 *
 * `session.create` and the kickoff `message.submit` both deduplicate on a
 * command id derived from the caller's operation id, so a replayed
 * `session_start` tool call collapses into one Session and one kickoff. A
 * ticket event has no such key, which is what this guard replaces — and what
 * makes acceptance 5's "one `session_started`" true rather than likely.
 */
describe("recordSessionStartedOnce", () => {
  it("records the planner fact the first time and reports that it wrote", () => {
    const { ticketId } = setup();

    const wrote = recordSessionStartedOnce(ctx.db, {
      ticketId,
      sessionId: "session-1",
      now: 100,
      actor: { kind: "user" },
    });

    expect(wrote).toBe(true);
    expect(listTicketEvents(ctx.db, ticketId).map((event) => event.payload)).toEqual([
      { kind: "session_started", sessionId: "session-1" },
    ]);
  });

  it("is a no-op for the same Session, however many times a start is replayed", () => {
    const { ticketId } = setup();
    const start = (now: number) =>
      recordSessionStartedOnce(ctx.db, {
        ticketId,
        sessionId: "session-1",
        now,
        actor: { kind: "session", sessionId: "caller", ticketId: null },
      });

    expect([start(100), start(200), start(300)]).toEqual([true, false, false]);

    // One line in the Activity feed, and it is the FIRST one: a replay must not
    // restamp the fact to a later time either, or a Session would appear to
    // have started whenever the provider last retried the call.
    const events = listTicketEvents(ctx.db, ticketId);
    expect(events).toHaveLength(1);
    expect(events[0]?.createdAt).toBe(100);
  });

  it("keeps the actor the first call attributed, not a later one's", () => {
    const { ticketId } = setup();
    recordSessionStartedOnce(ctx.db, {
      ticketId,
      sessionId: "session-1",
      now: 100,
      actor: { kind: "session", sessionId: "caller", ticketId: null },
    });

    recordSessionStartedOnce(ctx.db, {
      ticketId,
      sessionId: "session-1",
      now: 200,
      actor: { kind: "user" },
    });

    const events = listTicketEvents(ctx.db, ticketId);
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe("session");
  });

  it("separates Sessions on one Ticket, which is not a replay", () => {
    // A Ticket can legitimately be worked by several Sessions over its life.
    // The key is the Session, never the Ticket.
    const { ticketId } = setup();

    for (const sessionId of ["session-1", "session-2", "session-3"]) {
      expect(
        recordSessionStartedOnce(ctx.db, {
          ticketId,
          sessionId,
          now: 100,
          actor: { kind: "user" },
        }),
      ).toBe(true);
    }

    expect(listTicketEvents(ctx.db, ticketId)).toHaveLength(3);
  });

  it("holds its answer across a long history of unrelated events", () => {
    // The predicate reads both `kind` and the payload's session id, and the
    // rows it has to see through are whatever the Ticket accumulated in
    // between. A guard that matched on `kind` alone would refuse the second
    // Session ever started on a Ticket; one that lost the first row behind
    // later events would let a replay through.
    const { ticketId } = setup();
    for (let index = 0; index < 20; index += 1) {
      recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, index);
      recordTicketEvent(ctx.db, ticketId, { kind: "unarchived" }, index);
    }
    recordSessionStartedOnce(ctx.db, {
      ticketId,
      sessionId: "session-1",
      now: 100,
      actor: { kind: "user" },
    });
    recordTicketEvent(ctx.db, ticketId, { kind: "commented", commentId: "comment-1" }, 150);

    // A Ticket worked by a second Session is the ordinary case, not a replay.
    expect(
      recordSessionStartedOnce(ctx.db, {
        ticketId,
        sessionId: "session-2",
        now: 200,
        actor: { kind: "user" },
      }),
    ).toBe(true);
    // And the first is still held, with all of that between.
    expect(
      recordSessionStartedOnce(ctx.db, {
        ticketId,
        sessionId: "session-1",
        now: 300,
        actor: { kind: "user" },
      }),
    ).toBe(false);

    const started = listTicketEvents(ctx.db, ticketId).filter(
      (event) => event.payload.kind === "session_started",
    );
    expect(started.map((event) => event.payload)).toEqual([
      { kind: "session_started", sessionId: "session-1" },
      { kind: "session_started", sessionId: "session-2" },
    ]);
  });
});
