/**
 * The verdict channel's storage (VC-85): what a signal is worth depends on it
 * being unambiguous, so these tests are about exactly that — one row per
 * signal, one event with it, and one answer to "where does this ticket stand".
 */
import { USER_ACTOR } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The same controllable failure switch `comments-repo.test.ts` uses, for the
// same one test: transparent everywhere except where the transaction is under
// examination.
const { eventWriteFailure } = vi.hoisted(() => ({ eventWriteFailure: { armed: false } }));

vi.mock("./events-repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./events-repo")>();
  return {
    ...actual,
    recordTicketEvent: (...args: Parameters<typeof actual.recordTicketEvent>) => {
      if (eventWriteFailure.armed) throw new Error("simulated event-write failure");
      return actual.recordTicketEvent(...args);
    },
  };
});

import { listTicketEvents } from "./events-repo";
import { insertProject } from "./projects-repo";
import { createSignal, listLatestSignals, listSignals } from "./signals-repo";
import { insertSession } from "../session-control/test-support";
import { openTestDb, testProject, testSession, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { insertTicket } from "./tickets-repo";

let ctx: TestDb;

afterEach(() => {
  eventWriteFailure.armed = false;
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

describe("createSignal", () => {
  it("records the row and its signaled event in one transaction", () => {
    const { ticketId } = setup();

    const signal = createSignal(
      ctx.db,
      { ticketId, kind: "review", verdict: "pass", detail: "Two nits, fixed", actor: "session" },
      100,
    );

    expect(signal).toMatchObject({
      ticketId,
      kind: "review",
      verdict: "pass",
      detail: "Two nits, fixed",
      actor: "session",
      sessionId: null,
      createdAt: 100,
    });
    // The event carries the whole typed fact, not a row id: a signal is
    // immutable, so a reader of planner history needs no join to know what was
    // decided.
    expect(listTicketEvents(ctx.db, ticketId).map((event) => event.payload)).toEqual([
      { kind: "signaled", signalKind: "review", verdict: "pass", detail: "Two nits, fixed" },
    ]);
  });

  it("leaves neither the row nor the event behind when the event write fails", () => {
    const { ticketId } = setup();
    eventWriteFailure.armed = true;

    expect(() =>
      createSignal(ctx.db, { ticketId, kind: "merge", verdict: "fail", actor: USER_ACTOR }, 100),
    ).toThrow("simulated event-write failure");

    expect(listSignals(ctx.db, ticketId)).toEqual([]);
    expect(listTicketEvents(ctx.db, ticketId)).toEqual([]);
  });

  it("links the Session that signed it", () => {
    const { projectId, ticketId } = setup();
    const session = testSession(projectId, ticketId);
    insertSession(ctx.db, session);

    const signal = createSignal(
      ctx.db,
      { ticketId, kind: "implement", verdict: "pass", actor: "session", sessionId: session.id },
      100,
    );

    expect(signal.sessionId).toBe(session.id);
    expect(signal.detail).toBeNull();
  });

  it("refuses a signal on a ticket that does not exist", () => {
    setup();
    expect(() =>
      createSignal(
        ctx.db,
        { ticketId: "no-such-ticket", kind: "review", verdict: "pass", actor: USER_ACTOR },
        100,
      ),
    ).toThrow();
  });
});

describe("listLatestSignals", () => {
  it("answers with nothing for a ticket nobody has signalled", () => {
    const { ticketId } = setup();
    expect(listLatestSignals(ctx.db, ticketId)).toEqual([]);
  });

  it("keeps the newest of each kind and drops what it superseded", () => {
    const { ticketId } = setup();
    createSignal(ctx.db, { ticketId, kind: "review", verdict: "fail", actor: "session" }, 100);
    createSignal(ctx.db, { ticketId, kind: "implement", verdict: "pass", actor: "session" }, 200);
    createSignal(
      ctx.db,
      { ticketId, kind: "review", verdict: "pass", detail: "Re-reviewed", actor: "session" },
      300,
    );

    // Ordered by when each SURVIVING signal was recorded, so the reader sees
    // the stages in the order they actually happened.
    expect(listLatestSignals(ctx.db, ticketId)).toMatchObject([
      { kind: "implement", verdict: "pass", createdAt: 200 },
      { kind: "review", verdict: "pass", detail: "Re-reviewed", createdAt: 300 },
    ]);
    // Nothing was edited or erased to make that true.
    expect(listSignals(ctx.db, ticketId)).toHaveLength(3);
  });

  it("breaks a same-millisecond tie by insertion order, so the later write wins", () => {
    const { ticketId } = setup();
    createSignal(ctx.db, { ticketId, kind: "merge", verdict: "blocked", actor: "session" }, 100);
    createSignal(ctx.db, { ticketId, kind: "merge", verdict: "pass", actor: "session" }, 100);

    expect(listLatestSignals(ctx.db, ticketId)).toMatchObject([{ kind: "merge", verdict: "pass" }]);
  });

  it("answers about one ticket only", () => {
    const { projectId, ticketId } = setup();
    const other = testTicket(projectId);
    insertTicket(ctx.db, other);
    createSignal(ctx.db, { ticketId, kind: "review", verdict: "pass", actor: "session" }, 100);
    createSignal(
      ctx.db,
      { ticketId: other.id, kind: "review", verdict: "fail", actor: "session" },
      200,
    );

    expect(listLatestSignals(ctx.db, ticketId)).toMatchObject([{ verdict: "pass" }]);
    expect(listLatestSignals(ctx.db, other.id)).toMatchObject([{ verdict: "fail" }]);
  });
});
