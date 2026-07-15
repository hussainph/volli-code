import { agentActor, USER_ACTOR } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// A controllable failure switch for the "event write fails mid-transaction"
// test below: every other test leaves this false, so recordTicketEvent
// behaves exactly like the real implementation (spread from importOriginal),
// making this mock transparent everywhere except that one test.
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

import {
  createComment,
  deleteComment,
  getComment,
  listComments,
  updateComment,
} from "./comments-repo";
import { listTicketEvents } from "./events-repo";
import { insertProject } from "./projects-repo";
import { insertSession } from "./sessions-repo";
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

describe("listComments", () => {
  it("returns an empty list for a ticket with no comments", () => {
    const { ticketId } = setup();
    expect(listComments(ctx.db, ticketId)).toEqual([]);
  });

  it("returns comments chronologically", () => {
    const { ticketId } = setup();
    createComment(ctx.db, { ticketId, body: "first", actor: USER_ACTOR }, 100);
    createComment(ctx.db, { ticketId, body: "second", actor: USER_ACTOR }, 200);

    const comments = listComments(ctx.db, ticketId);
    expect(comments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("scopes strictly to the requested ticket", () => {
    const { projectId, ticketId } = setup();
    const otherTicket = testTicket(projectId, { id: "other-ticket" });
    insertTicket(ctx.db, otherTicket);

    createComment(ctx.db, { ticketId, body: "mine", actor: USER_ACTOR }, 100);
    createComment(ctx.db, { ticketId: otherTicket.id, body: "theirs", actor: USER_ACTOR }, 100);

    expect(listComments(ctx.db, ticketId).map((c) => c.body)).toEqual(["mine"]);
  });
});

describe("createComment", () => {
  it("inserts the comment row with the given actor/body", () => {
    const { ticketId } = setup();
    const comment = createComment(ctx.db, { ticketId, body: "Looks good", actor: USER_ACTOR }, 100);

    expect(comment.ticketId).toBe(ticketId);
    expect(comment.body).toBe("Looks good");
    expect(comment.actor).toBe(USER_ACTOR);
    expect(comment.sessionId).toBeNull();
    expect(comment.createdAt).toBe(100);
    expect(comment.updatedAt).toBe(100);
  });

  it("accepts an agent actor and a linked sessionId", () => {
    const { projectId, ticketId } = setup();
    const session = testSession(projectId, ticketId);
    insertSession(ctx.db, session);

    const comment = createComment(
      ctx.db,
      {
        ticketId,
        body: "Session summary",
        actor: agentActor("claude-code"),
        sessionId: session.id,
      },
      100,
    );

    expect(comment.actor).toBe("agent:claude-code");
    expect(comment.sessionId).toBe(session.id);
  });

  it("records a commented {commentId} event in the same transaction", () => {
    const { ticketId } = setup();
    const comment = createComment(ctx.db, { ticketId, body: "Looks good", actor: USER_ACTOR }, 100);

    const events = listTicketEvents(ctx.db, ticketId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ kind: "commented", commentId: comment.id });
  });

  it("rolls back the comment row when the comment insert itself is invalid (unknown sessionId FK)", () => {
    const { ticketId } = setup();

    expect(() =>
      createComment(
        ctx.db,
        { ticketId, body: "orphan session", actor: USER_ACTOR, sessionId: "does-not-exist" },
        100,
      ),
    ).toThrow();

    expect(listComments(ctx.db, ticketId)).toEqual([]);
    expect(listTicketEvents(ctx.db, ticketId)).toEqual([]);
  });

  it("rolls back the already-inserted comment row when the event write fails after it", () => {
    const { ticketId } = setup();
    eventWriteFailure.armed = true;

    expect(() =>
      createComment(ctx.db, { ticketId, body: "will roll back", actor: USER_ACTOR }, 100),
    ).toThrow("simulated event-write failure");

    expect(listComments(ctx.db, ticketId)).toEqual([]);
  });
});

describe("updateComment", () => {
  it("updates the body and touches updated_at only", () => {
    const { ticketId } = setup();
    const comment = createComment(ctx.db, { ticketId, body: "v1", actor: USER_ACTOR }, 100);

    const updated = updateComment(ctx.db, { commentId: comment.id, body: "v2" }, 200);

    expect(updated?.body).toBe("v2");
    expect(updated?.createdAt).toBe(100);
    expect(updated?.updatedAt).toBe(200);
  });

  it("records no event", () => {
    const { ticketId } = setup();
    const comment = createComment(ctx.db, { ticketId, body: "v1", actor: USER_ACTOR }, 100);

    updateComment(ctx.db, { commentId: comment.id, body: "v2" }, 200);

    expect(listTicketEvents(ctx.db, ticketId)).toHaveLength(1); // just the original `commented` event
  });

  it("returns undefined for an unknown commentId", () => {
    setup();
    expect(updateComment(ctx.db, { commentId: "nope", body: "x" }, 100)).toBeUndefined();
  });
});

describe("deleteComment", () => {
  it("hard-deletes the row", () => {
    const { ticketId } = setup();
    const comment = createComment(ctx.db, { ticketId, body: "gone soon", actor: USER_ACTOR }, 100);

    deleteComment(ctx.db, comment.id);

    expect(getComment(ctx.db, comment.id)).toBeUndefined();
    expect(listComments(ctx.db, ticketId)).toEqual([]);
  });

  it("is idempotent for an unknown id", () => {
    setup();
    expect(() => deleteComment(ctx.db, "nope")).not.toThrow();
  });

  it("records no event", () => {
    const { ticketId } = setup();
    const comment = createComment(ctx.db, { ticketId, body: "gone soon", actor: USER_ACTOR }, 100);
    deleteComment(ctx.db, comment.id);

    expect(listTicketEvents(ctx.db, ticketId)).toHaveLength(1); // just the original `commented` event
  });
});

describe("cascade behavior", () => {
  it("deleting the ticket cascades its comments away", () => {
    const { ticketId } = setup();
    createComment(ctx.db, { ticketId, body: "will cascade", actor: USER_ACTOR }, 100);

    ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run(ticketId);

    expect(ctx.db.prepare("SELECT COUNT(*) as n FROM ticket_comments").get()).toEqual({ n: 0 });
  });

  it("deleting the linked session nulls the comment's session_id (comment survives)", () => {
    const { projectId, ticketId } = setup();
    const session = testSession(projectId, ticketId);
    insertSession(ctx.db, session);
    const comment = createComment(
      ctx.db,
      {
        ticketId,
        body: "session summary",
        actor: agentActor("claude-code"),
        sessionId: session.id,
      },
      100,
    );

    ctx.db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);

    const survivor = getComment(ctx.db, comment.id);
    expect(survivor).toBeDefined();
    expect(survivor?.sessionId).toBeNull();
  });
});
