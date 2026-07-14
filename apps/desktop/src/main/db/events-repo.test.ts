import { afterEach, describe, expect, it } from "vite-plus/test";
import { listTicketEvents, recordTicketEvent } from "./events-repo";
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
