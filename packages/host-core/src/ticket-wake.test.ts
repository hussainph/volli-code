import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { TicketEvent } from "@volli/shared";

import { listTicketEvents, recordTicketEvent } from "./db/events-repo";
import { insertProject } from "./db/projects-repo";
import { createSignal } from "./db/signals-repo";
import { openTestDb, testProject, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { insertTicket } from "./db/tickets-repo";
import {
  emitTicketWake,
  markTicketWake,
  subscribeTicketWake,
  withTicketWake,
  type TicketWake,
} from "./ticket-wake";

function wake(kind: "commented" | "archived" = "commented"): TicketWake {
  const event: TicketEvent = {
    id: "event-1",
    ticketId: "ticket-1",
    actor: "session",
    createdAt: 1_700_000_000_000,
    payload: kind === "commented" ? { kind, commentId: "comment-1" } : { kind },
  };
  return { event, projectId: "project-1", cursor: "ticket-event-v1:1" };
}

describe("the ticket wake bus", () => {
  it("fans one wake out to every subscriber, in subscription order", () => {
    const order: string[] = [];
    const offA = subscribeTicketWake(() => order.push("a"));
    const offB = subscribeTicketWake(() => order.push("b"));
    emitTicketWake(wake());
    offA();
    offB();
    expect(order).toEqual(["a", "b"]);
  });

  it("stops delivering after unsubscribe, so a settled wait holds nothing", () => {
    const seen: TicketWake[] = [];
    const off = subscribeTicketWake((one) => seen.push(one));
    emitTicketWake(wake());
    off();
    emitTicketWake(wake("archived"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event.payload.kind).toBe("commented");
  });

  it("isolates a throwing listener: the door is not unwound and the rest still wake", () => {
    const failures: unknown[] = [];
    const seen: string[] = [];
    const offA = subscribeTicketWake(() => {
      throw new Error("listener bug");
    });
    const offB = subscribeTicketWake(() => seen.push("b"));
    expect(() => emitTicketWake(wake(), (error) => failures.push(error))).not.toThrow();
    offA();
    offB();
    expect(seen).toEqual(["b"]);
    expect(failures).toHaveLength(1);
  });

  it("reports a listener failure to console by default, and still does not throw", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const off = subscribeTicketWake(() => {
      throw new Error("listener bug");
    });
    try {
      expect(() => emitTicketWake(wake())).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      off();
      spy.mockRestore();
    }
  });
});

/**
 * The producer half (slice C): how a door turns "I committed something" into
 * the wakes above, without every write path handing back the events it wrote.
 */
describe("marking and emitting what a mutation committed", () => {
  let ctx: TestDb;
  const unsubscribes: Array<() => void> = [];

  afterEach(() => {
    for (const off of unsubscribes.splice(0)) off();
    ctx.cleanup();
  });

  function watch(): TicketWake[] {
    const seen: TicketWake[] = [];
    unsubscribes.push(subscribeTicketWake((notice) => seen.push(notice)));
    return seen;
  }

  function setup(): { projectId: string; ticketId: string } {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    const ticket = testTicket(project.id);
    insertTicket(ctx.db, ticket);
    return { projectId: project.id, ticketId: ticket.id };
  }

  it("wakes once per event a command appended, in the order it wrote them", () => {
    const { projectId, ticketId } = setup();
    const seen = watch();

    withTicketWake(ctx.db, ticketId, () => {
      recordTicketEvent(ctx.db, ticketId, { kind: "status_changed", from: "todo", to: "doing" }, 1);
      createSignal(ctx.db, { ticketId, kind: "review", verdict: "pass", actor: "session" }, 2);
    });

    expect(seen.map((notice) => notice.event.payload.kind)).toEqual(["status_changed", "signaled"]);
    expect(seen.map((notice) => notice.cursor)).toEqual(["ticket-event-v1:1", "ticket-event-v1:2"]);
    // The project rides along so a subscriber can filter without a second read.
    expect(seen.every((notice) => notice.projectId === projectId)).toBe(true);
  });

  it("wakes only on what happened AFTER the mark", () => {
    const { ticketId } = setup();
    recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, 1);
    const seen = watch();

    withTicketWake(ctx.db, ticketId, () => {
      recordTicketEvent(ctx.db, ticketId, { kind: "unarchived" }, 2);
    });

    expect(seen.map((notice) => notice.event.payload.kind)).toEqual(["unarchived"]);
  });

  it("says nothing for a mutation that wrote nothing", () => {
    const { ticketId } = setup();
    const seen = watch();

    // A same-column move is the real case: the command layer writes no event,
    // so there is no fact to wake anybody with.
    withTicketWake(ctx.db, ticketId, () => undefined);

    expect(seen).toEqual([]);
  });

  it("wakes on a fact the caller can already read back — the commit came first", () => {
    const { ticketId } = setup();
    const readable: boolean[] = [];
    unsubscribes.push(
      subscribeTicketWake((notice) => {
        // Inside the listener, the event is durable: a wake for something SQLite
        // could still roll back is a wake for something that never happened.
        readable.push(
          listTicketEvents(ctx.db, notice.event.ticketId).some(
            (event) => event.id === notice.event.id,
          ),
        );
      }),
    );

    withTicketWake(ctx.db, ticketId, () =>
      ctx.db.transaction(() => {
        recordTicketEvent(ctx.db, ticketId, { kind: "body_edited" }, 1);
      })(),
    );

    expect(readable).toEqual([true]);
  });

  it("still announces a committed fact when the command failed after it", () => {
    const { ticketId } = setup();
    const seen = watch();

    expect(() =>
      withTicketWake(ctx.db, ticketId, () => {
        recordTicketEvent(
          ctx.db,
          ticketId,
          { kind: "status_changed", from: "todo", to: "done" },
          1,
        );
        throw new Error("the side effect after the commit failed");
      }),
    ).toThrow("the side effect after the commit failed");

    // The move is durably in the log whatever the caller was told, and a waiter
    // reads the log rather than the caller's exit code.
    expect(seen.map((notice) => notice.event.payload.kind)).toEqual(["status_changed"]);
  });

  it("wakes nobody for a ticket that no longer exists to attribute", () => {
    const { ticketId } = setup();
    const seen = watch();

    withTicketWake(ctx.db, ticketId, () => {
      recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, 1);
      // The FK cascade takes the events with it; there is no project to name.
      ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);
    });

    expect(seen).toEqual([]);
  });

  it("takes 0 as the mark for a ticket with no history yet", () => {
    const { ticketId } = setup();
    expect(markTicketWake(ctx.db, ticketId)).toBe(0);
    recordTicketEvent(ctx.db, ticketId, { kind: "archived" }, 1);
    expect(markTicketWake(ctx.db, ticketId)).toBeGreaterThan(0);
  });
});
