/** Which Workspace a board resource belongs to (VC-565): the router's resource port. */
import { USER_ACTOR } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { listTicketLabels } from "../db/labels-repo";
import { createTicketCommand, createTicketCommentCommand } from "../ticket-commands";
import { boardResourceWorkspace } from "./resources";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "p", ticketPrefix: "VC" }));
  insertProject(ctx.db, testProject({ id: "q", ticketPrefix: "QQ" }));
});

afterEach(() => {
  ctx.cleanup();
});

describe("boardResourceWorkspace", () => {
  it("resolves a ticket, its comment and its label to the ticket's project", () => {
    const context = { now: 1, actor: { kind: "user" } as const };
    const ticket = createTicketCommand(
      ctx.db,
      { id: "t", projectId: "q", title: "t", status: "todo", labels: ["bug"] },
      context,
    );
    const comment = createTicketCommentCommand(
      ctx.db,
      { ticketId: ticket.id, body: "hi", commentActor: USER_ACTOR },
      context,
    );
    const [label] = listTicketLabels(ctx.db, ticket.id);
    const resolve = boardResourceWorkspace(ctx.db);
    expect(resolve({ kind: "ticket", id: "t" })).toBe("q");
    expect(resolve({ kind: "comment", id: comment.id })).toBe("q");
    expect(resolve({ kind: "label", id: label!.id })).toBe("q");
  });

  it("answers null for an absent id of every kind, and for a kind it does not hold", () => {
    const resolve = boardResourceWorkspace(ctx.db);
    expect(resolve({ kind: "ticket", id: "missing" })).toBeNull();
    expect(resolve({ kind: "comment", id: "missing" })).toBeNull();
    expect(resolve({ kind: "label", id: "missing" })).toBeNull();
    // A project is its own Workspace, answered by the router, never here.
    expect(resolve({ kind: "project", id: "p" })).toBeNull();
    expect(resolve({ kind: "session", id: "s" })).toBeNull();
  });
});
