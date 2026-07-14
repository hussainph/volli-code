import type {
  Result,
  SessionRenameResult,
  SessionsResult,
  Ticket,
  TicketCommentResult,
  TicketCommentsResult,
  TicketEventsResult,
  TicketResult,
  VolliIpcChannel,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Hoisted above module evaluation, like ipc.test.ts, so the electron mock
// factory can capture into it.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
}));

import { registerDataIpcHandlers } from "./data-ipc";
import { insertSession } from "./db/sessions-repo";
import { openTestDb, testSession } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";

/** Fake IPC event; unused by any data-ipc handler, but every handler signature expects one. */
const fakeEvent = { sender: {} };

/** Invokes a captured handler the way `ipcMain.handle` dispatch would. */
function invoke<T>(channel: VolliIpcChannel, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)(fakeEvent, ...args);
}

let ctx: TestDb;

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
  registerDataIpcHandlers({ ok: true, db: ctx.db });
});

afterEach(() => {
  ctx.cleanup();
});

function createProject(): string {
  const result = invoke<{ ok: true; project: { id: string } }>("volli:project-create", {
    path: "/repo/proj",
    name: "Proj",
  });
  return result.project.id;
}

function createTicket(projectId: string): Ticket {
  const result = invoke<TicketResult>("volli:ticket-create", {
    projectId,
    status: "backlog",
    title: "A ticket",
  });
  if (!result.ok) throw new Error(result.error);
  return result.ticket;
}

describe("volli:ticket-update — worktree identity", () => {
  it("records one worktree_changed event when all three fields change together", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      worktreePath: "/repo/.worktrees/VC-1",
      branch: "volli/VC-1-x",
      baseBranch: "main",
    });
    expect(result.ok).toBe(true);

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const worktreeEvents = events.events.filter((e) => e.payload.kind === "worktree_changed");
    expect(worktreeEvents).toHaveLength(1);
    expect(worktreeEvents[0]?.payload).toEqual({
      kind: "worktree_changed",
      from: { worktreePath: null, branch: null, baseBranch: null },
      to: {
        worktreePath: "/repo/.worktrees/VC-1",
        branch: "volli/VC-1-x",
        baseBranch: "main",
      },
    });
  });

  it("records a second worktree_changed event chaining from the prior identity", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      worktreePath: "/repo/.worktrees/VC-1",
      branch: "volli/VC-1-x",
      baseBranch: "main",
    });
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, branch: "volli/VC-1-y" });

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    const worktreeEvents = events.events.filter((e) => e.payload.kind === "worktree_changed");
    expect(worktreeEvents).toHaveLength(2);
    expect(worktreeEvents[1]?.payload).toEqual({
      kind: "worktree_changed",
      from: { worktreePath: "/repo/.worktrees/VC-1", branch: "volli/VC-1-x", baseBranch: "main" },
      to: { worktreePath: "/repo/.worktrees/VC-1", branch: "volli/VC-1-y", baseBranch: "main" },
    });
  });

  it("an explicit null clears a previously-set worktree field, recorded in the event", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath: "/repo/wt" });

    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath: null });

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      title: "noop-touch",
    });
    expect(result.ok && result.ticket.worktreePath).toBeNull();

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    const worktreeEvents = events.events.filter((e) => e.payload.kind === "worktree_changed");
    expect(worktreeEvents[1]?.payload).toMatchObject({
      from: { worktreePath: "/repo/wt" },
      to: { worktreePath: null },
    });
  });

  it("keeps title/body behavior intact and does not fire worktree_changed for a plain title/body update", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      title: "New title",
      body: "New body",
    });
    expect(result.ok && result.ticket.title).toBe("New title");
    expect(result.ok && result.ticket.body).toBe("New body");

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.map((e) => e.payload.kind)).toEqual(
      expect.arrayContaining(["retitled", "body_edited"]),
    );
    expect(events.events.some((e) => e.payload.kind === "worktree_changed")).toBe(false);
  });

  it("rejects an invalid worktree field type", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, branch: 42 });
    expect(result).toEqual({ ok: false, error: "Invalid ticket update" });
  });

  it("rejects a syntactically-invalid branch name without persisting it", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      branch: "bad..branch",
    });
    expect(result).toEqual({ ok: false, error: "Invalid branch name" });
    const after = invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, title: "t" });
    expect(after.ok && after.ticket.branch).toBeNull();
  });

  it("rejects a syntactically-invalid base branch name", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      baseBranch: "-nope",
    });
    expect(result).toEqual({ ok: false, error: "Invalid base branch name" });
  });

  it("allows clearing the branch fields with an explicit null", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      branch: null,
      baseBranch: null,
    });
    expect(result.ok).toBe(true);
  });
});

describe("volli:ticket-events", () => {
  it("rejects a non-object payload", () => {
    expect(invoke<TicketEventsResult>("volli:ticket-events", "nope")).toEqual({
      ok: false,
      error: "Invalid ticket",
    });
  });

  it("returns the ticket's chronological event history", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.events.map((e) => e.payload.kind)).toEqual(["created"]);
  });
});

describe("volli:comment-* channels", () => {
  it("comment-create rejects an empty body", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketCommentResult>("volli:comment-create", {
      ticketId: ticket.id,
      body: "   ",
    });
    expect(result).toEqual({ ok: false, error: "Invalid comment" });
  });

  it("creates a comment as the user actor, listable, updatable, and removable", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    const created = invoke<TicketCommentResult>("volli:comment-create", {
      ticketId: ticket.id,
      body: "Looks good",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.comment.actor).toBe("user");

    const listed = invoke<TicketCommentsResult>("volli:comment-list", { ticketId: ticket.id });
    expect(listed.ok && listed.comments.map((c) => c.body)).toEqual(["Looks good"]);

    const updated = invoke<TicketCommentResult>("volli:comment-update", {
      commentId: created.comment.id,
      body: "Looks great",
    });
    expect(updated.ok && updated.comment.body).toBe("Looks great");

    const removed = invoke<Result>("volli:comment-remove", { commentId: created.comment.id });
    expect(removed).toEqual({ ok: true });

    const afterRemove = invoke<TicketCommentsResult>("volli:comment-list", { ticketId: ticket.id });
    expect(afterRemove.ok && afterRemove.comments).toEqual([]);
  });

  it("also records a commented event, discoverable from volli:ticket-events", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const created = invoke<TicketCommentResult>("volli:comment-create", {
      ticketId: ticket.id,
      body: "Looks good",
    });
    if (!created.ok) throw new Error(created.error);

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.map((e) => e.payload.kind)).toEqual(["created", "commented"]);
    expect(events.events[1]?.payload).toEqual({ kind: "commented", commentId: created.comment.id });
  });

  it("comment-update returns a typed error for an unknown commentId", () => {
    const result = invoke<TicketCommentResult>("volli:comment-update", {
      commentId: "nope",
      body: "x",
    });
    expect(result).toEqual({ ok: false, error: "Unknown comment" });
  });

  it("comment-remove returns a typed error for an unknown commentId", () => {
    const result = invoke<Result>("volli:comment-remove", { commentId: "nope" });
    expect(result).toEqual({ ok: false, error: "Unknown comment" });
  });
});

describe("volli:session-list / volli:session-list-for-ticket", () => {
  it("session-list returns every session in a project, newest first", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", createdAt: 100 }));
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "s2", createdAt: 200 }));

    const result = invoke<SessionsResult>("volli:session-list", { projectId });
    expect(result.ok && result.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("session-list-for-ticket scopes to just that ticket", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    insertSession(ctx.db, testSession(projectId, null, { id: "scratch" }));
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "scoped" }));

    const result = invoke<SessionsResult>("volli:session-list-for-ticket", { ticketId: ticket.id });
    expect(result.ok && result.sessions.map((s) => s.id)).toEqual(["scoped"]);
  });

  it("rejects invalid input", () => {
    expect(invoke<SessionsResult>("volli:session-list", 42)).toEqual({
      ok: false,
      error: "Invalid project",
    });
    expect(invoke<SessionsResult>("volli:session-list-for-ticket", 42)).toEqual({
      ok: false,
      error: "Invalid ticket",
    });
  });
});

describe("volli:session-rename", () => {
  it("renames a session and persists the trimmed title", () => {
    const projectId = createProject();
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", title: "Session 1" }));

    const result = invoke<SessionRenameResult>("volli:session-rename", {
      sessionId: "s1",
      title: "  Renamed  ",
    });
    expect(result).toEqual({ ok: true });

    const list = invoke<SessionsResult>("volli:session-list", { projectId });
    expect(list.ok && list.sessions[0]?.title).toBe("Renamed");
  });

  it("rejects a blank title", () => {
    expect(
      invoke<SessionRenameResult>("volli:session-rename", { sessionId: "s1", title: "   " }),
    ).toEqual({ ok: false, error: "Invalid session title" });
  });

  it("reports an unknown session", () => {
    createProject();
    expect(
      invoke<SessionRenameResult>("volli:session-rename", { sessionId: "ghost", title: "X" }),
    ).toEqual({ ok: false, error: "Unknown session" });
  });
});

describe("degraded db handle", () => {
  it("every new channel resolves with the degraded error instead of throwing", () => {
    handlers.clear();
    registerDataIpcHandlers({ ok: false, error: "db is down" });

    expect(invoke<TicketEventsResult>("volli:ticket-events", { ticketId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(invoke<TicketCommentsResult>("volli:comment-list", { ticketId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(invoke<SessionsResult>("volli:session-list", { projectId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(
      invoke<SessionRenameResult>("volli:session-rename", { sessionId: "x", title: "Y" }),
    ).toEqual({
      ok: false,
      error: "db is down",
    });
  });
});
