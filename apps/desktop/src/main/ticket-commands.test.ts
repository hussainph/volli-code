/**
 * Direct unit coverage for the shared Ticket-mutation + Ticket-event command
 * layer (ticket-commands.ts) that BOTH doors (Electron IPC + the `volli` CLI)
 * route mutations through. It had only transitive coverage via data-ipc.test.ts
 * / agent-commands.test.ts; this pins its own contract:
 *   - Actor attribution — every event carries the `user`/`session`/`automation`
 *     actor the caller derived (CONTEXT: callers never self-declare; the command
 *     records whatever it's handed).
 *   - One event per mutation, and NO event on a genuine no-op.
 *   - Deliberate-move parity (CONTEXT "Deliberate move"): an explicit move
 *     applies and records identically regardless of the actor issuing it.
 *   - interruptOnBackwardMove (CONCEPT #20, issue #78): a move leaving the active
 *     columns interrupts live sessions without adding a planner lifecycle fact;
 *     automation only de-escalates; a missing seam / no live sessions is a clean
 *     no-op.
 *   - Guard edges — unknown ticket, archived ticket, invalid branch names.
 *
 * Reuses the same temp-file better-sqlite3 fixture (openTestDb) every repo suite
 * builds on, so the native binding is resolved by the shared helper — this file
 * never rebuilds anything.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { TicketEventActor } from "@volli/shared";

import { listTicketEvents } from "./db/events-repo";
import { insertProject } from "./db/projects-repo";
import { getTicketRow } from "./db/tickets-repo";
import { openTestDb, testProject, type TestDb } from "./db/test-helpers";
import {
  archiveTicketCommand,
  createTicketCommand,
  createTicketCommentCommand,
  deleteTicketCommand,
  interruptOnBackwardMove,
  moveTicketCommand,
  moveTicketsCommand,
  setTicketLabelsCommand,
  setTicketPriorityCommand,
  unarchiveTicketCommand,
  updateTicketFieldsCommand,
  type CreateTicketCommandInput,
} from "./ticket-commands";

let ctx: TestDb;
afterEach(() => ctx.cleanup());

const USER: TicketEventActor = { kind: "user" };
const AUTOMATION: TicketEventActor = { kind: "automation" };
const SESSION: TicketEventActor = { kind: "session", sessionId: "sess-1", ticketId: "t1" };

const PROJECT_ID = "p1";

/** Opens a fresh migrated db and seeds one project; returns the project id. */
function seed(): string {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: PROJECT_ID, ticketPrefix: "VC" }));
  return PROJECT_ID;
}

/** The payload kinds recorded for a ticket, in chronological order. */
function eventKinds(ticketId: string): string[] {
  return listTicketEvents(ctx.db, ticketId).map((event) => event.payload.kind);
}

/** The first event of a given kind, or undefined. */
function eventOfKind(ticketId: string, kind: string) {
  return listTicketEvents(ctx.db, ticketId).find((event) => event.payload.kind === kind);
}

/** Creates a ticket via the command layer and returns its id. */
function createTicket(
  id: string,
  status: CreateTicketCommandInput["status"] = "backlog",
  extra: Partial<CreateTicketCommandInput> = {},
): string {
  createTicketCommand(
    ctx.db,
    { id, projectId: PROJECT_ID, title: `Ticket ${id}`, status, ...extra },
    { now: 1, actor: USER },
  );
  return id;
}

describe("ticket-commands actor attribution", () => {
  it("records the created event under whichever actor kind (and context) it was handed", () => {
    seed();

    createTicketCommand(
      ctx.db,
      { id: "t-user", projectId: PROJECT_ID, title: "U", status: "backlog" },
      { now: 1, actor: USER },
    );
    createTicketCommand(
      ctx.db,
      { id: "t-session", projectId: PROJECT_ID, title: "S", status: "backlog" },
      { now: 1, actor: SESSION },
    );
    createTicketCommand(
      ctx.db,
      { id: "t-automation", projectId: PROJECT_ID, title: "A", status: "backlog" },
      { now: 1, actor: AUTOMATION },
    );

    const user = eventOfKind("t-user", "created")!;
    expect(user.actor).toBe("user");
    expect(user.actorContext).toBeNull();

    const session = eventOfKind("t-session", "created")!;
    expect(session.actor).toBe("session");
    // The session actor's context (session + ticket) round-trips onto the event.
    expect(session.actorContext).toEqual({ sessionId: "sess-1", ticketId: "t1" });

    const automation = eventOfKind("t-automation", "created")!;
    expect(automation.actor).toBe("automation");
    // A system-level automation (no session) stores as a bare token — no context.
    expect(automation.actorContext).toBeNull();
  });
});

describe("ticket-commands event emission", () => {
  it("emits created (+ labels_changed when labels are set) on create", () => {
    seed();
    createTicket("t1");
    expect(eventKinds("t1")).toEqual(["created"]);

    createTicket("t2", "backlog", { labels: ["bug", "ui"] });
    expect(eventKinds("t2")).toEqual(["created", "labels_changed"]);
    expect(eventOfKind("t2", "labels_changed")!.payload).toMatchObject({
      added: ["bug", "ui"],
      removed: [],
    });
  });

  it("emits status_changed only when a move actually changes columns", () => {
    seed();
    createTicket("t1", "todo");

    // A real column change records status_changed with from/to.
    moveTicketCommand(
      ctx.db,
      { projectId: PROJECT_ID, ticketId: "t1", toStatus: "doing", toIndex: 0 },
      { now: 2, actor: USER },
    );
    expect(eventOfKind("t1", "status_changed")!.payload).toMatchObject({
      from: "todo",
      to: "doing",
    });

    // A same-column "move" (no status change) records nothing new.
    const before = listTicketEvents(ctx.db, "t1").length;
    moveTicketCommand(
      ctx.db,
      { projectId: PROJECT_ID, ticketId: "t1", toStatus: "doing", toIndex: 0 },
      { now: 3, actor: USER },
    );
    expect(listTicketEvents(ctx.db, "t1").length).toBe(before);
  });

  it("moves several tickets atomically and emits a status event for each column change", () => {
    seed();
    createTicket("t1", "backlog");
    createTicket("t2", "todo");
    createTicket("t3", "doing");

    const moved = moveTicketsCommand(
      ctx.db,
      {
        projectId: PROJECT_ID,
        // Deliberately reverse click order: canonical board order wins.
        ticketIds: ["t2", "t1"],
        toStatus: "doing",
        toIndex: 0,
      },
      { now: 2, actor: USER },
    );

    expect(
      moved
        .filter((ticket) => ticket.status === "doing")
        .toSorted((a, b) => a.order - b.order)
        .map((ticket) => ticket.id),
    ).toEqual(["t1", "t2", "t3"]);
    expect(eventOfKind("t1", "status_changed")!.payload).toMatchObject({
      from: "backlog",
      to: "doing",
    });
    expect(eventOfKind("t2", "status_changed")!.payload).toMatchObject({
      from: "todo",
      to: "doing",
    });
    expect(eventOfKind("t3", "status_changed")).toBeUndefined();
  });

  it("persists the group timestamp even when one selected card keeps its exact slot", () => {
    seed();
    createTicket("t1", "todo");
    createTicket("t2", "todo");
    createTicket("t3", "todo");

    moveTicketsCommand(
      ctx.db,
      {
        projectId: PROJECT_ID,
        // t1 remains at todo:0 while t3 joins it and t2 shifts around them.
        ticketIds: ["t1", "t3"],
        toStatus: "todo",
        toIndex: 0,
      },
      { now: 7, actor: USER },
    );

    expect(getTicketRow(ctx.db, "t1")!.position).toBe(0);
    expect(getTicketRow(ctx.db, "t1")!.updated_at).toBe(7);
  });

  it("rolls a multi-ticket move back when any selected ticket is invalid", () => {
    seed();
    createTicket("t1", "backlog");

    expect(() =>
      moveTicketsCommand(
        ctx.db,
        {
          projectId: PROJECT_ID,
          ticketIds: ["t1", "missing"],
          toStatus: "doing",
          toIndex: 0,
        },
        { now: 2, actor: USER },
      ),
    ).toThrow(/Unknown ticket/);
    expect(getTicketRow(ctx.db, "t1")!.status).toBe("backlog");
    expect(eventOfKind("t1", "status_changed")).toBeUndefined();
  });

  it("emits the right field event for each updated field, and nothing for a no-op", () => {
    seed();
    createTicket("t1");

    updateTicketFieldsCommand(
      ctx.db,
      {
        ticketId: "t1",
        title: "Renamed",
        body: "New body",
        preferredHarnessId: "codex",
      },
      { now: 2, actor: USER },
    );
    const kinds = eventKinds("t1");
    expect(kinds).toContain("retitled");
    expect(kinds).toContain("body_edited");
    expect(kinds).toContain("harness_changed");

    // Setting the SAME values is a genuine no-op — no new events.
    const before = listTicketEvents(ctx.db, "t1").length;
    updateTicketFieldsCommand(
      ctx.db,
      { ticketId: "t1", title: "Renamed", body: "New body" },
      { now: 3, actor: USER },
    );
    expect(listTicketEvents(ctx.db, "t1").length).toBe(before);
  });

  it("emits one worktree_changed carrying the from/to identity when worktree fields move", () => {
    seed();
    createTicket("t1");

    updateTicketFieldsCommand(
      ctx.db,
      {
        ticketId: "t1",
        worktreePath: "/wt/VC-1",
        branch: "volli/VC-1-ship",
        baseBranch: "main",
      },
      { now: 2, actor: AUTOMATION },
    );

    const changed = eventOfKind("t1", "worktree_changed")!;
    expect(changed.actor).toBe("automation");
    expect(changed.payload).toMatchObject({
      from: { worktreePath: null, branch: null, baseBranch: null },
      to: { worktreePath: "/wt/VC-1", branch: "volli/VC-1-ship", baseBranch: "main" },
    });
  });

  it("changes worktree scoping while no worktree has materialized, and records the change", () => {
    seed();
    createTicket("t1"); // usesWorktree defaults to true, worktree_path null

    const updated = updateTicketFieldsCommand(
      ctx.db,
      { ticketId: "t1", usesWorktree: false },
      { now: 2, actor: USER },
    );

    expect(updated.usesWorktree).toBe(false);
    expect(eventOfKind("t1", "worktree_scope_changed")!.payload).toMatchObject({
      from: true,
      to: false,
    });

    // Setting the SAME value is a genuine no-op — no new events.
    const before = listTicketEvents(ctx.db, "t1").length;
    updateTicketFieldsCommand(
      ctx.db,
      { ticketId: "t1", usesWorktree: false },
      { now: 3, actor: USER },
    );
    expect(listTicketEvents(ctx.db, "t1").length).toBe(before);
  });

  it("refuses to change worktree scoping once a worktree is stamped on the ticket", () => {
    // A materialized worktree is a fact on disk — flipping the flag under it
    // would strand the checkout (or silently rebind the Main checkout, #38).
    seed();
    createTicket("t1");
    updateTicketFieldsCommand(
      ctx.db,
      { ticketId: "t1", worktreePath: "/wt/VC-1", branch: "volli/VC-1-x", baseBranch: "main" },
      { now: 2, actor: AUTOMATION },
    );

    expect(() =>
      updateTicketFieldsCommand(
        ctx.db,
        { ticketId: "t1", usesWorktree: false },
        { now: 3, actor: USER },
      ),
    ).toThrow(/worktree already exists/i);
    expect(getTicketRow(ctx.db, "t1")!.uses_worktree).toBe(1);
  });

  it("emits priority_changed only on a real change", () => {
    seed();
    createTicket("t1", "backlog", { priority: "medium" });

    setTicketPriorityCommand(ctx.db, { ticketId: "t1", priority: "high" }, { now: 2, actor: USER });
    expect(eventOfKind("t1", "priority_changed")!.payload).toMatchObject({
      from: "medium",
      to: "high",
    });

    const before = listTicketEvents(ctx.db, "t1").length;
    setTicketPriorityCommand(ctx.db, { ticketId: "t1", priority: "high" }, { now: 3, actor: USER });
    expect(listTicketEvents(ctx.db, "t1").length).toBe(before);
  });

  it("emits labels_changed with the added/removed diff", () => {
    seed();
    createTicket("t1", "backlog", { labels: ["a"] });

    setTicketLabelsCommand(ctx.db, { ticketId: "t1", labels: ["a", "b"] }, { now: 2, actor: USER });
    // The latest labels_changed (create seeded one too) carries this diff.
    const changed = listTicketEvents(ctx.db, "t1").findLast(
      (event) => event.payload.kind === "labels_changed",
    )!;
    expect(changed.payload).toMatchObject({ added: ["b"], removed: [] });

    setTicketLabelsCommand(ctx.db, { ticketId: "t1", labels: ["b"] }, { now: 3, actor: USER });
    const removed = listTicketEvents(ctx.db, "t1").findLast(
      (event) => event.payload.kind === "labels_changed",
    )!;
    expect(removed.payload).toMatchObject({ added: [], removed: ["a"] });
  });

  it("records a commented event when a comment is created", () => {
    seed();
    createTicket("t1");
    createTicketCommentCommand(
      ctx.db,
      { ticketId: "t1", body: "looks good", commentActor: "user" },
      { now: 2, actor: USER },
    );
    expect(eventKinds("t1")).toContain("commented");
  });

  it("archives idempotently and unarchives, each recording exactly one event", () => {
    seed();
    createTicket("t1");

    archiveTicketCommand(ctx.db, "t1", { now: 2, actor: USER });
    expect(eventKinds("t1").filter((kind) => kind === "archived")).toEqual(["archived"]);

    // Re-archiving an already-archived ticket is a no-op — no second event.
    archiveTicketCommand(ctx.db, "t1", { now: 3, actor: USER });
    expect(eventKinds("t1").filter((kind) => kind === "archived")).toEqual(["archived"]);

    unarchiveTicketCommand(ctx.db, "t1", { now: 4, actor: USER });
    expect(eventKinds("t1")).toContain("unarchived");
  });
});

describe("ticket-commands deliberate-move parity", () => {
  it("applies and records an explicit move identically no matter the actor (CONTEXT: deliberate move)", () => {
    seed();
    createTicket("t1", "todo");

    // A move issued by a session actor (an explicit `volli` move) is a deliberate
    // move: it applies unconditionally — the command consults NO lifecycle state —
    // and records status_changed attributed to that session, exactly like a drag.
    moveTicketCommand(
      ctx.db,
      { projectId: PROJECT_ID, ticketId: "t1", toStatus: "doing", toIndex: 0 },
      { now: 2, actor: SESSION },
    );

    expect(getTicketRow(ctx.db, "t1")!.status).toBe("doing");
    const changed = eventOfKind("t1", "status_changed")!;
    expect(changed.actor).toBe("session");
    expect(changed.actorContext).toEqual({ sessionId: "sess-1", ticketId: "t1" });
  });
});

describe("interruptOnBackwardMove", () => {
  it("interrupts live sessions on a move out of the active columns without planner history", () => {
    seed();
    createTicket("t1", "doing");

    const interrupted = interruptOnBackwardMove(
      { ticketId: "t1", fromStatus: "doing", toStatus: "todo" },
      () => ["s1", "s2"],
    );

    expect(interrupted).toEqual(["s1", "s2"]);
    expect(listTicketEvents(ctx.db, "t1").map((event) => event.payload.kind)).toEqual(["created"]);
  });

  it("does not add a planner event when automation drives the de-escalation", () => {
    seed();
    createTicket("t1", "doing");

    interruptOnBackwardMove({ ticketId: "t1", fromStatus: "doing", toStatus: "backlog" }, () => [
      "s1",
    ]);
    expect(listTicketEvents(ctx.db, "t1").map((event) => event.payload.kind)).toEqual(["created"]);
  });

  it("also interrupts on a completion move to done (leaves the active columns)", () => {
    seed();
    createTicket("t1", "doing");

    const interrupted = interruptOnBackwardMove(
      { ticketId: "t1", fromStatus: "doing", toStatus: "done" },
      () => ["s1"],
    );
    expect(interrupted).toEqual(["s1"]);
  });

  it("does nothing when the move stays inside the active columns (doing ⇄ needs_review)", () => {
    seed();
    createTicket("t1", "doing");

    const interrupted = interruptOnBackwardMove(
      { ticketId: "t1", fromStatus: "doing", toStatus: "needs_review" },
      () => ["s1"],
    );
    expect(interrupted).toEqual([]);
  });

  it("is a clean no-op when the interrupt seam is absent (tests / degraded boot)", () => {
    seed();
    createTicket("t1", "doing");

    const interrupted = interruptOnBackwardMove(
      { ticketId: "t1", fromStatus: "doing", toStatus: "todo" },
      undefined,
    );
    expect(interrupted).toEqual([]);
  });

  it("records nothing when a backward move interrupts no live sessions", () => {
    seed();
    createTicket("t1", "doing");

    const interrupted = interruptOnBackwardMove(
      { ticketId: "t1", fromStatus: "doing", toStatus: "todo" },
      () => [],
    );
    expect(interrupted).toEqual([]);
  });

  it("passes through the Session ids from an asynchronous interrupt seam", async () => {
    seed();
    createTicket("t1", "doing");

    await expect(
      interruptOnBackwardMove(
        { ticketId: "t1", fromStatus: "doing", toStatus: "todo" },
        async () => ["session-a", "session-b"],
      ),
    ).resolves.toEqual(["session-a", "session-b"]);
  });
});

describe("ticket-commands guard edges", () => {
  it("throws on an unknown ticket for move and update", () => {
    seed();
    expect(() =>
      moveTicketCommand(
        ctx.db,
        { projectId: PROJECT_ID, ticketId: "nope", toStatus: "doing", toIndex: 0 },
        { now: 2, actor: USER },
      ),
    ).toThrow(/Unknown ticket/);
    expect(() =>
      updateTicketFieldsCommand(ctx.db, { ticketId: "nope", title: "x" }, { now: 2, actor: USER }),
    ).toThrow(/Unknown ticket/);
  });

  it("refuses a single-card move scoped to another project", () => {
    seed();
    createTicket("t1", "doing");
    insertProject(ctx.db, testProject({ id: "p2", ticketPrefix: "PX" }));

    expect(() =>
      moveTicketCommand(
        ctx.db,
        { projectId: "p2", ticketId: "t1", toStatus: "todo", toIndex: 0 },
        { now: 2, actor: USER },
      ),
    ).toThrow(/does not belong to project/);
    expect(getTicketRow(ctx.db, "t1")!.status).toBe("doing");
  });

  it("refuses to move, update, or reprioritize an archived ticket", () => {
    seed();
    createTicket("t1", "doing");
    archiveTicketCommand(ctx.db, "t1", { now: 2, actor: USER });

    expect(() =>
      moveTicketCommand(
        ctx.db,
        { projectId: PROJECT_ID, ticketId: "t1", toStatus: "todo", toIndex: 0 },
        { now: 3, actor: USER },
      ),
    ).toThrow(/archived/);
    expect(() =>
      updateTicketFieldsCommand(ctx.db, { ticketId: "t1", title: "x" }, { now: 3, actor: USER }),
    ).toThrow(/archived/);
    expect(() =>
      setTicketPriorityCommand(
        ctx.db,
        { ticketId: "t1", priority: "high" },
        { now: 3, actor: USER },
      ),
    ).toThrow(/archived/);
  });

  it("allows the narrow allowArchived worktree-identity clear on an archived ticket", () => {
    seed();
    createTicket("t1", "doing");
    updateTicketFieldsCommand(
      ctx.db,
      { ticketId: "t1", worktreePath: "/wt/VC-1", branch: "volli/VC-1-x", baseBranch: "main" },
      { now: 2, actor: AUTOMATION },
    );
    archiveTicketCommand(ctx.db, "t1", { now: 3, actor: USER });

    // The worktree module's system clear (remove.ts): null worktree_path even on
    // an archived ticket, since the dir is already gone. branch stays stamped.
    updateTicketFieldsCommand(
      ctx.db,
      { ticketId: "t1", worktreePath: null },
      { now: 4, actor: AUTOMATION },
      { allowArchived: true },
    );
    const row = getTicketRow(ctx.db, "t1")!;
    expect(row.worktree_path).toBeNull();
    expect(row.branch).toBe("volli/VC-1-x");
  });

  it("rejects invalid branch and base-branch names", () => {
    seed();
    createTicket("t1");
    expect(() =>
      updateTicketFieldsCommand(
        ctx.db,
        { ticketId: "t1", branch: "bad branch name" },
        { now: 2, actor: USER },
      ),
    ).toThrow(/Invalid branch name/);
    expect(() =>
      createTicketCommand(
        ctx.db,
        { id: "t2", projectId: PROJECT_ID, title: "x", status: "backlog", baseBranch: "bad name" },
        { now: 2, actor: USER },
      ),
    ).toThrow(/Invalid base branch name/);
  });

  it("only deletes archived tickets", () => {
    seed();
    createTicket("t1");
    expect(() => deleteTicketCommand(ctx.db, "t1")).toThrow(/Only archived tickets can be deleted/);

    archiveTicketCommand(ctx.db, "t1", { now: 2, actor: USER });
    deleteTicketCommand(ctx.db, "t1");
    expect(getTicketRow(ctx.db, "t1")).toBeUndefined();
  });
});
