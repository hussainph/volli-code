import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { ARMED_RUN_DELAY_MS } from "@volli/shared";
import { boardReceiptExpiry, newId } from "@volli/shared/cloud";

const BOARD_RECEIPT_TTL_MS = boardReceiptExpiry(0);

import { api, internal } from "../functions/_generated/api";
import {
  boardFixture,
  code,
  createTicket,
  jobs,
  projectEvents,
  seedAutomation,
  seedRunner,
  seedSession,
  seedWorkingCopy,
  setup,
  signIn,
  ticketRow,
  type Client,
  type Tester,
} from "./board-helpers";

afterEach(() => {
  vi.useRealTimers();
});

const command = () => newId("command");

async function columnOrder(as: Client, projectId: string, status: string) {
  const { tickets } = await as.query(api.board.roster, { projectId });
  return tickets
    .filter((ticket) => ticket.status === status)
    .toSorted((a, b) => (a.position < b.position ? -1 : 1))
    .map((ticket) => ticket.title);
}

describe("board.createTicket", () => {
  test("numbers from the project's counter, appends to its column, stores the body apart", async () => {
    const t = setup();
    const { as, userId, projectId } = await boardFixture(t);
    const first = await createTicket(as, projectId, {
      title: "One",
      labels: ["UI", "ui", "Backend"],
    });
    const second = await createTicket(as, projectId, { title: "Two" });
    expect(first).toMatchObject({ number: 1, key: "VC-1", receipt: { replayed: false } });
    expect(second).toMatchObject({ number: 2, key: "VC-2" });

    const { tickets, labels } = await as.query(api.board.roster, { projectId });
    expect(labels.map((label) => label.name)).toEqual(["Backend", "UI"]);
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).not.toHaveProperty("_id");
    expect(await columnOrder(as, projectId, "todo")).toEqual(["One", "Two"]);

    const read = await as.query(api.board.getTicket, { ticketId: first.ticketId });
    expect(read).toMatchObject({
      body: "",
      bodyRevision: 1,
      ticket: {
        title: "One",
        status: "todo",
        priority: "medium",
        checkoutMode: "worktree",
        createdBy: { kind: "person", userId },
      },
    });
    expect(read.ticket.labelIds).toHaveLength(2);

    const events = await as.query(api.board.ticketEvents, { ticketId: first.ticketId });
    expect(events.map((event) => event.payload)).toEqual([
      { kind: "created", status: "todo", title: "One" },
      { kind: "labels_changed", added: ["UI", "Backend"], removed: [] },
    ]);
    // A gapless per-project order: project_created, then each write's events.
    expect((await projectEvents(t, projectId)).map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  test("is idempotent by commandId, and a reused id with another intent conflicts", async () => {
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    const args = {
      commandId: command(),
      projectId,
      ticketId: newId("ticket"),
      status: "todo" as const,
      title: "Once",
    };
    const first = await as.mutation(api.board.createTicket, args);
    const again = await as.mutation(api.board.createTicket, args);
    expect(again).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } });
    expect((await as.query(api.board.roster, { projectId })).tickets).toHaveLength(1);
    await expect(as.mutation(api.board.createTicket, { ...args, title: "Twice" })).rejects.toThrow(
      code("command_conflict"),
    );
    // The same id from someone else is never their replay.
    const bob = await signIn(t, "bob");
    await expect(bob.as.mutation(api.board.createTicket, args)).rejects.toThrow(
      code("command_conflict"),
    );
    // A new command with a taken ticket id is refused.
    await expect(
      as.mutation(api.board.createTicket, { ...args, commandId: command() }),
    ).rejects.toThrow(code("id_taken"));
  });

  test("a receipt stops answering after seven days, and the sweep removes it", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    const args = {
      commandId: command(),
      projectId,
      ticketId: newId("ticket"),
      status: "todo" as const,
      title: "Once",
    };
    await as.mutation(api.board.createTicket, args);
    vi.setSystemTime(Date.now() + BOARD_RECEIPT_TTL_MS + 1);
    // Past the window the receipt is absent; the create-by-id check still holds.
    await expect(as.mutation(api.board.createTicket, args)).rejects.toThrow(code("id_taken"));
    const swept = await t.mutation(internal.boardReceipts.prune, {});
    expect(swept.removed).toBeGreaterThan(0);
    const left = await t.run((ctx) => ctx.db.query("boardReceipts").collect());
    expect(left.every((receipt) => receipt.expiresAt > Date.now())).toBe(true);
  });

  test("an expired receipt's id can be used again", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    const commandId = command();
    await createTicket(as, projectId);
    const ticketId = newId("ticket");
    await as.mutation(api.board.createTicket, {
      commandId,
      projectId,
      ticketId,
      status: "todo",
      title: "A",
    });
    vi.setSystemTime(Date.now() + BOARD_RECEIPT_TTL_MS + 1);
    const reply = await as.mutation(api.board.archiveTicket, { commandId, ticketId });
    expect(reply).toMatchObject({ changed: true, receipt: { replayed: false } });
    const receipts = await t.run((ctx) =>
      ctx.db
        .query("boardReceipts")
        .withIndex("by_command", (q) => q.eq("commandId", commandId))
        .collect(),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.operation).toBe("board.archiveTicket");
  });

  test("the sweep reschedules itself while it finds full batches", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i += 1) {
        await ctx.db.insert("boardReceipts", {
          commandId: newId("command"),
          projectId: newId("project"),
          operation: "op",
          intentDigest: "x",
          reply: {},
          createdAt: 0,
          expiresAt: 1,
        });
      }
    });
    expect(await t.mutation(internal.boardReceipts.prune, {})).toEqual({ removed: 256 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("boardReceipts").collect())).toEqual([]);
  });

  test("refuses outsiders, anonymous callers, archived projects and bad input", async () => {
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    await expect(createTicket(t as never, projectId)).rejects.toThrow(code("unauthenticated"));
    const bob = await signIn(t, "bob");
    await expect(createTicket(bob.as, projectId)).rejects.toThrow(code("not_a_member"));
    await expect(bob.as.query(api.board.roster, { projectId })).rejects.toThrow(
      code("not_a_member"),
    );
    await expect(createTicket(as, projectId, { title: " " })).rejects.toThrow(
      code("invalid_argument"),
    );
    await expect(
      as.mutation(api.board.createTicket, {
        commandId: "not-a-uuid",
        projectId,
        ticketId: newId("ticket"),
        status: "todo",
        title: "A",
      }),
    ).rejects.toThrow(code("invalid_id"));
    await as.mutation(api.projects.archive, { commandId: command(), projectId });
    await expect(createTicket(as, projectId)).rejects.toThrow(code("project_archived"));
  });
});

describe("board.updateTicket", () => {
  test("changes fields, body and labels in one write, recording only what changed", async () => {
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    const { ticketId } = await createTicket(as, projectId, { labels: ["UI"] });
    const reply = await as.mutation(api.board.updateTicket, {
      commandId: command(),
      ticketId,
      title: "Renamed",
      body: "Hello",
      priority: "high",
      addLabels: ["Backend"],
      removeLabels: ["ui"],
    });
    expect(reply).toMatchObject({ ticketId, changed: true });
    await as.mutation(api.board.updateTicket, {
      commandId: command(),
      ticketId,
      bodyMutation: { mode: "append", text: "World" },
    });
    const read = await as.query(api.board.getTicket, { ticketId });
    expect(read).toMatchObject({
      body: "Hello\n\nWorld",
      bodyRevision: 3,
      ticket: { title: "Renamed", priority: "high" },
    });
    const kinds = (await as.query(api.board.ticketEvents, { ticketId })).map((event) => event.kind);
    expect(kinds).toEqual([
      "created",
      "labels_changed",
      "retitled",
      "body_edited",
      "priority_changed",
      "labels_changed",
      "body_edited",
    ]);
    const unchanged = await as.mutation(api.board.updateTicket, {
      commandId: command(),
      ticketId,
      title: "Renamed",
    });
    expect(unchanged.changed).toBe(false);
  });

  test("switching to a worktree asks the ticket's Place for one; the switch locks once one exists", async () => {
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    const ticket = await createTicket(as, projectId);
    await as.mutation(api.board.updateTicket, {
      commandId: command(),
      ticketId: ticket.ticketId,
      checkoutMode: "main_checkout",
    });
    // No Place yet: the first Session start makes the worktree.
    await as.mutation(api.board.updateTicket, {
      commandId: command(),
      ticketId: ticket.ticketId,
      checkoutMode: "worktree",
    });
    expect(await jobs(t, ticket.ticketId)).toEqual([]);

    const placeRunnerId = newId("runner");
    const row = await ticketRow(t, ticket.ticketId);
    await t.run((ctx) => ctx.db.patch(row!._id, { placeRunnerId, checkoutMode: "main_checkout" }));
    await as.mutation(api.board.updateTicket, {
      commandId: command(),
      ticketId: ticket.ticketId,
      checkoutMode: "worktree",
    });
    expect(await jobs(t, ticket.ticketId)).toEqual([
      expect.objectContaining({
        kind: "workingCopy.materialize",
        runnerId: placeRunnerId,
        status: "queued",
        payload: { ticketId: ticket.ticketId, reason: "checkout_mode_changed" },
      }),
    ]);

    await seedWorkingCopy(t, { ticketId: ticket.ticketId, projectId }, { runnerId: placeRunnerId });
    await expect(
      as.mutation(api.board.updateTicket, {
        commandId: command(),
        ticketId: ticket.ticketId,
        checkoutMode: "main_checkout",
      }),
    ).rejects.toThrow(code("checkout_mode_locked"));
  });

  test("a materialization being made locks the mode; a failed or reclaimed worktree does not", async () => {
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    const ticket = await createTicket(as, projectId);
    const placeRunnerId = newId("runner");
    const row = await ticketRow(t, ticket.ticketId);
    await t.run((ctx) => ctx.db.patch(row!._id, { placeRunnerId, checkoutMode: "main_checkout" }));
    const toggle = async (mode: "worktree" | "main_checkout") =>
      as.mutation(api.board.updateTicket, {
        commandId: command(),
        ticketId: ticket.ticketId,
        checkoutMode: mode,
      });
    await toggle("worktree");
    // Being made counts as existing: the switch back is refused, as locally.
    await expect(toggle("main_checkout")).rejects.toThrow(code("checkout_mode_locked"));
    // A materialization that failed made nothing: the mode is free again.
    const [materialize] = await jobs(t, ticket.ticketId);
    await t.run((ctx) => ctx.db.patch(materialize!._id, { status: "failed" }));
    await seedWorkingCopy(
      t,
      { ticketId: ticket.ticketId, projectId },
      { runnerId: placeRunnerId, state: "failed" },
    );
    await toggle("main_checkout");
    await toggle("worktree");
    expect((await jobs(t, ticket.ticketId)).map((job) => [job.kind, job.status])).toEqual([
      ["workingCopy.materialize", "failed"],
      ["workingCopy.materialize", "queued"],
    ]);
    // A reclaimed worktree is gone: the lock does not hold and a new one is asked for.
    const again = await createTicket(as, projectId);
    const againRow = await ticketRow(t, again.ticketId);
    await t.run((ctx) =>
      ctx.db.patch(againRow!._id, { placeRunnerId, checkoutMode: "main_checkout" }),
    );
    await seedWorkingCopy(
      t,
      { ticketId: again.ticketId, projectId },
      { runnerId: placeRunnerId, state: "reclaimed" },
    );
    await as.mutation(api.board.updateTicket, {
      commandId: command(),
      ticketId: again.ticketId,
      checkoutMode: "worktree",
    });
    expect((await jobs(t, again.ticketId)).map((job) => job.kind)).toEqual([
      "workingCopy.materialize",
    ]);
  });

  test("refuses an archived ticket, an unknown one and a stale body edit", async () => {
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    const { ticketId } = await createTicket(as, projectId);
    await expect(
      as.mutation(api.board.updateTicket, {
        commandId: command(),
        ticketId,
        bodyMutation: { mode: "edit", oldText: "missing", newText: "x" },
      }),
    ).rejects.toThrow(code("body_match_failed"));
    await expect(
      as.mutation(api.board.updateTicket, {
        commandId: command(),
        ticketId: newId("ticket"),
        title: "x",
      }),
    ).rejects.toThrow(code("not_found"));
    await as.mutation(api.board.archiveTicket, { commandId: command(), ticketId });
    await expect(
      as.mutation(api.board.updateTicket, { commandId: command(), ticketId, title: "x" }),
    ).rejects.toThrow(code("archived"));
  });
});

/** A project with A, B, C in Doing and T in Todo. */
async function board(t: Tester) {
  const fixture = await boardFixture(t);
  const ids: Record<string, string> = {};
  for (const title of ["A", "B", "C"]) {
    ids[title] = (
      await createTicket(fixture.as, fixture.projectId, { title, status: "doing" })
    ).ticketId;
  }
  ids["T"] = (await createTicket(fixture.as, fixture.projectId, { title: "T" })).ticketId;
  return { ...fixture, ids };
}

describe("board.moveTickets", () => {
  test("lands between named neighbours, writing only the moved ticket", async () => {
    const t = setup();
    const { as, projectId, ids } = await board(t);
    const before = await ticketRow(t, ids["A"]!);
    const reply = await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["T"]!],
      toStatus: "doing",
      afterTicketId: ids["A"]!,
      beforeTicketId: ids["B"]!,
    });
    expect(reply.moved).toEqual([ids["T"]]);
    expect(await columnOrder(as, projectId, "doing")).toEqual(["A", "T", "B", "C"]);
    expect((await ticketRow(t, ids["A"]!))!.updatedAt).toBe(before!.updatedAt);
    const events = await as.query(api.board.ticketEvents, { ticketId: ids["T"]! });
    expect(events.at(-1)!.payload).toEqual({ kind: "status_changed", from: "todo", to: "doing" });
  });

  test("one neighbour is enough; to the top, to the end, and column-only", async () => {
    const t = setup();
    const { as, projectId, ids } = await board(t);
    const move = (fields: Record<string, unknown>) =>
      as.mutation(api.board.moveTickets, {
        commandId: command(),
        projectId,
        toStatus: "doing",
        ...fields,
      } as never);
    await move({ ticketIds: [ids["C"]], beforeTicketId: ids["A"] });
    expect(await columnOrder(as, projectId, "doing")).toEqual(["C", "A", "B"]);
    await move({ ticketIds: [ids["C"]], afterTicketId: ids["A"] });
    expect(await columnOrder(as, projectId, "doing")).toEqual(["A", "C", "B"]);
    await move({ ticketIds: [ids["T"]] });
    expect(await columnOrder(as, projectId, "doing")).toEqual(["A", "C", "B", "T"]);
    // Column-only into the column a ticket is already in: nothing moves.
    expect((await move({ ticketIds: [ids["A"]] })).moved).toEqual([]);
  });

  test("moves a group in board order; a neighbour that left the column is ignored", async () => {
    const t = setup();
    const { as, projectId, ids } = await board(t);
    // B left `doing` before this move arrived.
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["B"]!],
      toStatus: "backlog",
    });
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["T"]!, ids["C"]!],
      toStatus: "doing",
      beforeTicketId: ids["B"]!,
    });
    // Only `before` was named and it is gone: the group goes to the column's start.
    expect(await columnOrder(as, projectId, "doing")).toEqual(["T", "C", "A"]);
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "doing",
      afterTicketId: ids["B"]!,
      beforeTicketId: ids["T"]!,
    });
    // `after` gone, `before` usable.
    expect(await columnOrder(as, projectId, "doing")).toEqual(["A", "T", "C"]);
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "doing",
      afterTicketId: ids["C"]!,
      beforeTicketId: ids["T"]!,
    });
    // Out of order (C sorts after T): anchored after C.
    expect(await columnOrder(as, projectId, "doing")).toEqual(["T", "C", "A"]);
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "doing",
      afterTicketId: ids["B"]!,
    });
    // Nothing usable, `after` named: the end, where A already is.
    expect(await columnOrder(as, projectId, "doing")).toEqual(["T", "C", "A"]);
  });

  test("a column-only group move lands after a named ticket that stays, never on its key", async () => {
    const t = setup();
    const { as, projectId, ids } = await board(t);
    // C is last in Doing and named; T comes from Todo.
    const reply = await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["C"]!, ids["T"]!],
      toStatus: "doing",
    });
    expect(reply.moved).toEqual([ids["T"]]);
    const { tickets } = await as.query(api.board.roster, { projectId });
    const doing = tickets.filter((ticket) => ticket.status === "doing");
    expect(new Set(doing.map((ticket) => ticket.position)).size).toBe(doing.length);
    expect(await columnOrder(as, projectId, "doing")).toEqual(["A", "B", "C", "T"]);
  });

  test("is idempotent by commandId: a retry after the move does not move again", async () => {
    const t = setup();
    const { as, projectId, ids } = await board(t);
    const args = {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "done" as const,
    };
    const first = await as.mutation(api.board.moveTickets, args);
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "todo",
    });
    const replay = await as.mutation(api.board.moveTickets, args);
    expect(replay).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } });
    expect((await ticketRow(t, ids["A"]!))!.status).toBe("todo");
  });

  test("refuses unknown, foreign, archived and malformed tickets and neighbours", async () => {
    const t = setup();
    const { as, projectId, ids, workspaceId } = await board(t);
    const move = (fields: Record<string, unknown>) =>
      as.mutation(api.board.moveTickets, {
        commandId: command(),
        projectId,
        toStatus: "doing",
        ticketIds: [ids["T"]],
        ...fields,
      } as never);
    await expect(move({ ticketIds: [newId("ticket")] })).rejects.toThrow(code("not_found"));
    await expect(move({ ticketIds: ["nope"] })).rejects.toThrow(code("invalid_id"));
    await expect(move({ ticketIds: [] })).rejects.toThrow(code("invalid_argument"));
    await expect(move({ afterTicketId: newId("ticket") })).rejects.toThrow(code("not_found"));
    const other = newId("project");
    await as.mutation(api.projects.create, {
      commandId: command(),
      workspaceId,
      projectId: other,
      name: "Other",
      ticketPrefix: "OT",
      origin: "github",
    });
    const foreign = await createTicket(as, other, { status: "doing" });
    await expect(move({ ticketIds: [foreign.ticketId] })).rejects.toThrow(code("not_found"));
    await expect(
      move({ ticketIds: Array.from({ length: 101 }, () => newId("ticket")) }),
    ).rejects.toThrow(code("invalid_argument"));
    await expect(move({ afterTicketId: foreign.ticketId })).rejects.toThrow(code("not_found"));
    await as.mutation(api.board.archiveTicket, { commandId: command(), ticketId: ids["T"]! });
    await expect(move({})).rejects.toThrow(code("archived"));
  });

  test("a Done move trims ready worktrees and interrupts running agents, as runner jobs", async () => {
    const t = setup();
    const { as, projectId, userId, ids } = await board(t);
    const ticket = { ticketId: ids["A"]!, projectId };
    const ready = await seedWorkingCopy(t, ticket);
    await seedWorkingCopy(t, ticket, { state: "trimmed" });
    await seedWorkingCopy(t, ticket, { kind: "main_checkout" });
    const running = await seedSession(t, ticket, userId);
    await seedSession(t, ticket, userId, { turnActive: false });
    await seedSession(t, ticket, userId, { stopped: true });
    await seedSession(t, ticket, userId, { intake: "released" });
    await seedSession(t, ticket, userId, { intake: null });

    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "done",
    });
    const queued = await jobs(t, ids["A"]!);
    expect(queued).toEqual([
      expect.objectContaining({
        kind: "workingCopy.trim",
        runnerId: ready.runnerId,
        workingCopyId: ready.workingCopyId,
        status: "queued",
        priority: "normal",
        rank: 1,
        payload: { ticketId: ids["A"], workingCopyId: ready.workingCopyId, reason: "done" },
        createdBy: { kind: "person", userId },
      }),
      expect.objectContaining({
        kind: "session.command",
        runnerId: running.runnerId,
        sessionId: running.sessionId,
        priority: "urgent",
        rank: 0,
        payload: expect.objectContaining({
          sessionId: running.sessionId,
          intent: { kind: "executor.interrupt" },
          from: "doing",
          to: "done",
        }),
        createdBy: { kind: "volli", reason: "supervision", onBehalfOf: userId },
      }),
    ]);
    expect(queued[1]!.id).toBe(queued[1]!.commandId);

    // Back to Doing and Done again: the trim already queued is not asked for twice.
    for (const toStatus of ["doing", "done"] as const) {
      await as.mutation(api.board.moveTickets, {
        commandId: command(),
        projectId,
        ticketIds: [ids["A"]!],
        toStatus,
      });
    }
    expect(
      (await jobs(t, ids["A"]!)).filter((job) => job.kind === "workingCopy.trim"),
    ).toHaveLength(1);
  });

  test("a kept ticket is never trimmed, and an archive trims as a Done move does", async () => {
    const t = setup();
    const { as, projectId, ids } = await board(t);
    await seedWorkingCopy(t, { ticketId: ids["A"]!, projectId });
    await seedWorkingCopy(t, { ticketId: ids["B"]!, projectId });
    const kept = await ticketRow(t, ids["A"]!);
    await t.run((ctx) => ctx.db.patch(kept!._id, { retentionKeep: true }));
    await as.mutation(api.board.archiveTicket, { commandId: command(), ticketId: ids["A"]! });
    await as.mutation(api.board.archiveTicket, { commandId: command(), ticketId: ids["B"]! });
    expect(await jobs(t, ids["A"]!)).toEqual([]);
    expect((await jobs(t, ids["B"]!)).map((job) => job.payload)).toEqual([
      expect.objectContaining({ reason: "archived" }),
    ]);
  });

  test("an armed column queues the Automation run on its armer's runner after the delay", async () => {
    const t = setup();
    const { as, projectId, userId, ids } = await board(t);
    const armed = await seedAutomation(t, projectId, userId, { status: "needs_review" });
    const before = Date.now();
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "needs_review",
    });
    const [run] = await jobs(t, ids["A"]!);
    expect(run).toMatchObject({
      kind: "automation.run",
      runnerId: armed.runnerId,
      status: "queued",
      payload: {
        ticketId: ids["A"],
        automationId: armed.automationId,
        from: "doing",
        status: "needs_review",
        origin: "armed",
        armedByUserId: userId,
      },
    });
    expect(run!.availableAt).toBeGreaterThanOrEqual(before + ARMED_RUN_DELAY_MS);

    // Leaving the column cancels the run nobody has claimed yet; "move only" starts none.
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "doing",
    });
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "needs_review",
      choice: { kind: "move-only" },
    });
    const all = await jobs(t, ids["A"]!);
    expect(all.map((job) => [job.kind, job.status])).toEqual([["automation.run", "cancelled"]]);
    expect(all[0]!.expiresAt).not.toBeNull();
  });

  test("a picked Automation runs on the ticket's Place, or on the armed runner when it is the armed one", async () => {
    const t = setup();
    const { as, projectId, userId, ids } = await board(t);
    const armed = await seedAutomation(t, projectId, userId, { status: "needs_review" });
    const picked = await seedAutomation(t, projectId, userId, null);
    const gone = await seedAutomation(t, projectId, userId, { status: "todo", deleted: true });
    const move = (ticketId: string, toStatus: "needs_review" | "todo", automationId: string) =>
      as.mutation(api.board.moveTickets, {
        commandId: command(),
        projectId,
        ticketIds: [ticketId],
        toStatus,
        choice: { kind: "automation", automationId },
      });

    // No Place: a pick of a non-armed Automation waits for one (nothing queued).
    await move(ids["A"]!, "needs_review", picked.automationId);
    expect(await jobs(t, ids["A"]!)).toEqual([]);

    const placeRunnerId = await seedRunner(t, userId);
    const row = await ticketRow(t, ids["B"]!);
    await t.run((ctx) => ctx.db.patch(row!._id, { placeRunnerId }));
    await move(ids["B"]!, "needs_review", picked.automationId);
    await move(ids["C"]!, "needs_review", armed.automationId);
    expect(await jobs(t, ids["B"]!)).toEqual([
      expect.objectContaining({
        runnerId: placeRunnerId,
        payload: expect.objectContaining({ origin: "chosen", armedByUserId: null }),
      }),
    ]);
    expect(await jobs(t, ids["C"]!)).toEqual([
      expect.objectContaining({
        runnerId: armed.runnerId,
        payload: expect.objectContaining({ origin: "chosen", armedByUserId: userId }),
      }),
    ]);

    // A deleted Automation (armed or picked) and an unknown pick start nothing.
    await move(ids["T"]!, "todo", gone.automationId);
    const t2 = await createTicket(as, projectId, { status: "doing" });
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [t2.ticketId],
      toStatus: "todo",
    });
    await move(ids["A"]!, "todo", newId("automation"));
    expect(await jobs(t, ids["T"]!)).toEqual([]);
    expect(await jobs(t, t2.ticketId)).toEqual([]);
    expect(await jobs(t, ids["A"]!)).toEqual([]);
  });

  test("a pick with nowhere to run is reported, and a later move leaves other runs alone", async () => {
    const t = setup();
    const { as, projectId, userId, ids } = await board(t);
    const picked = await seedAutomation(t, projectId, userId, null);
    const scheduled = newId("job");
    await t.run((ctx) =>
      ctx.db.insert("runnerJobs", {
        id: scheduled,
        runnerId: newId("runner"),
        kind: "automation.run",
        projectId,
        sessionId: null,
        ticketId: ids["A"]!,
        workingCopyId: null,
        commandId: null,
        payload: { trigger: "schedule" },
        priority: "normal",
        rank: 1,
        status: "queued",
        availableAt: 0,
        lease: null,
        receipt: null,
        result: null,
        createdBy: { kind: "person", userId },
        createdAt: 0,
        completedAt: null,
        expiresAt: null,
      }),
    );
    const reply = await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "needs_review",
      choice: { kind: "automation", automationId: picked.automationId },
    });
    expect(reply.unstartedRuns).toEqual([
      { ticketId: ids["A"], automationId: picked.automationId, reason: "no_place" },
    ]);
    // A Place on a teammate's runner (or an unknown one) is never used for a pick.
    const teammate = await signIn(t, "teammate");
    for (const placeRunnerId of [await seedRunner(t, teammate.userId), newId("runner")]) {
      const row = await ticketRow(t, ids["B"]!);
      await t.run((ctx) => ctx.db.patch(row!._id, { placeRunnerId }));
      const picked2 = await as.mutation(api.board.moveTickets, {
        commandId: command(),
        projectId,
        ticketIds: [ids["B"]!],
        toStatus: row!.status === "needs_review" ? "doing" : "needs_review",
        choice: { kind: "automation", automationId: picked.automationId },
      });
      expect(picked2.unstartedRuns).toEqual([
        { ticketId: ids["B"], automationId: picked.automationId, reason: "place_not_yours" },
      ]);
    }
    expect(await jobs(t, ids["B"]!)).toEqual([]);
    expect((await jobs(t, ids["A"]!)).map((job) => [job.id, job.status])).toEqual([
      [scheduled, "queued"],
    ]);
  });

  test("an Automation of another project is never started", async () => {
    const t = setup();
    const { as, projectId, userId, ids, workspaceId } = await board(t);
    const other = newId("project");
    await as.mutation(api.projects.create, {
      commandId: command(),
      workspaceId,
      projectId: other,
      name: "Other",
      ticketPrefix: "OT",
      origin: "github",
    });
    const foreign = await seedAutomation(t, other, userId, null);
    const row = await ticketRow(t, ids["A"]!);
    await t.run((ctx) => ctx.db.patch(row!._id, { placeRunnerId: newId("runner") }));
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["A"]!],
      toStatus: "needs_review",
      choice: { kind: "automation", automationId: foreign.automationId },
    });
    expect(await jobs(t, ids["A"]!)).toEqual([]);
  });

  test("a key grown past the rebalance length rewrites its column, in order", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { as, projectId, ids } = await board(t);
    const a = await ticketRow(t, ids["A"]!);
    const b = await ticketRow(t, ids["B"]!);
    const long = `a0${"V".repeat(60)}`;
    await t.run(async (ctx) => {
      // Two neighbours so close that any key between them is longer still.
      await ctx.db.patch(a!._id, { position: long });
      await ctx.db.patch(b!._id, { position: `${long}V` });
    });
    await as.mutation(api.board.moveTickets, {
      commandId: command(),
      projectId,
      ticketIds: [ids["T"]!],
      toStatus: "doing",
      afterTicketId: ids["A"]!,
      beforeTicketId: ids["B"]!,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const { tickets } = await as.query(api.board.roster, { projectId });
    expect(
      tickets
        .filter((ticket) => ticket.status === "doing")
        .every((ticket) => ticket.position.length < 5),
    ).toBe(true);
    expect(await columnOrder(as, projectId, "doing")).toEqual(["A", "T", "B", "C"]);
    // A column with short keys is left alone.
    expect(
      await t.mutation(internal.board.rebalanceColumn, { projectId, status: "doing" }),
    ).toEqual({
      rewritten: 0,
    });
  });
});

describe("archive", () => {
  test("archive hides from the roster into the Archive; unarchive returns to its column's end", async () => {
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    const a = await createTicket(as, projectId, { title: "A" });
    await createTicket(as, projectId, { title: "B" });
    await as.mutation(api.board.archiveTicket, { commandId: command(), ticketId: a.ticketId });
    const again = await as.mutation(api.board.archiveTicket, {
      commandId: command(),
      ticketId: a.ticketId,
    });
    expect(again.changed).toBe(false);
    expect(await columnOrder(as, projectId, "todo")).toEqual(["B"]);
    expect(
      (
        await as.query(api.board.archivedTickets, {
          projectId,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((ticket) => ticket.title),
    ).toEqual(["A"]);
    await as.mutation(api.board.unarchiveTicket, { commandId: command(), ticketId: a.ticketId });
    expect(await columnOrder(as, projectId, "todo")).toEqual(["B", "A"]);
    const live = await as.mutation(api.board.unarchiveTicket, {
      commandId: command(),
      ticketId: a.ticketId,
    });
    expect(live.changed).toBe(false);
    const kinds = (await as.query(api.board.ticketEvents, { ticketId: a.ticketId })).map(
      (e) => e.kind,
    );
    expect(kinds).toEqual(["created", "archived", "unarchived"]);
  });
});

describe("comments", () => {
  test("create, edit and remove by the author; others are refused", async () => {
    const t = setup();
    const { as, projectId, userId, workspaceId } = await boardFixture(t);
    const { ticketId } = await createTicket(as, projectId);
    const commentId = newId("comment");
    await as.mutation(api.board.createComment, {
      commandId: command(),
      ticketId,
      commentId,
      body: "Hi",
    });
    await expect(
      as.mutation(api.board.createComment, {
        commandId: command(),
        ticketId,
        commentId,
        body: "Again",
      }),
    ).rejects.toThrow(code("id_taken"));
    expect(await as.query(api.board.comments, { ticketId })).toEqual([
      expect.objectContaining({
        id: commentId,
        body: "Hi",
        author: { kind: "person", userId },
        sessionId: null,
      }),
    ]);
    const events = await as.query(api.board.ticketEvents, { ticketId });
    expect(events.at(-1)!.payload).toEqual({ kind: "commented", commentId });

    // A teammate sees it but cannot change it.
    const bob = await signIn(t, "bob");
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        id: newId("member"),
        workspaceId,
        userId: bob.userId,
        role: "member",
        status: "active",
        billingTier: "free",
        joinedAt: 0,
        suspendedAt: null,
        leftAt: null,
        invitedByUserId: null,
      }),
    );
    expect(await bob.as.query(api.board.comments, { ticketId })).toHaveLength(1);
    await expect(
      bob.as.mutation(api.board.updateComment, { commandId: command(), commentId, body: "Mine" }),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      bob.as.mutation(api.board.removeComment, { commandId: command(), commentId }),
    ).rejects.toThrow(code("forbidden"));

    await as.mutation(api.board.updateComment, { commandId: command(), commentId, body: "Edited" });
    await as.mutation(api.board.updateComment, { commandId: command(), commentId, body: "Edited" });
    const [edited] = await as.query(api.board.comments, { ticketId });
    expect(edited).toMatchObject({ body: "Edited", editedAt: expect.any(Number) });
    await as.mutation(api.board.removeComment, { commandId: command(), commentId });
    expect(await as.query(api.board.comments, { ticketId })).toEqual([]);
    await expect(
      as.mutation(api.board.updateComment, { commandId: command(), commentId, body: "Back" }),
    ).rejects.toThrow(code("invalid_argument"));
    await expect(
      as.mutation(api.board.removeComment, { commandId: command(), commentId: newId("comment") }),
    ).rejects.toThrow(code("not_found"));
  });
});

describe("signals", () => {
  test("record a typed verdict and a signaled event; never move the ticket", async () => {
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    const { ticketId } = await createTicket(as, projectId);
    const signalId = newId("signal");
    await as.mutation(api.board.createSignal, {
      commandId: command(),
      ticketId,
      signalId,
      kind: "review",
      verdict: "pass",
      detail: " looks good ",
    });
    await expect(
      as.mutation(api.board.createSignal, {
        commandId: command(),
        ticketId,
        signalId,
        kind: "review",
        verdict: "fail",
      }),
    ).rejects.toThrow(code("id_taken"));
    expect(await as.query(api.board.signals, { ticketId })).toEqual([
      expect.objectContaining({
        id: signalId,
        kind: "review",
        verdict: "pass",
        detail: "looks good",
      }),
    ]);
    const events = await as.query(api.board.ticketEvents, { ticketId });
    expect(events.at(-1)!.payload).toEqual({
      kind: "signaled",
      signalKind: "review",
      verdict: "pass",
      detail: "looks good",
    });
    expect((await ticketRow(t, ticketId))!.status).toBe("todo");
  });
});

describe("labels", () => {
  test("a label's colour is set and cleared without a board event", async () => {
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    await createTicket(as, projectId, { labels: ["UI"] });
    const { labels } = await as.query(api.board.roster, { projectId });
    const labelId = labels[0]!.id;
    const eventsBefore = (await projectEvents(t, projectId)).length;
    await as.mutation(api.board.setLabelColor, { commandId: command(), labelId, color: "#D26A6A" });
    expect((await as.query(api.board.roster, { projectId })).labels[0]!.color).toBe("#D26A6A");
    await as.mutation(api.board.setLabelColor, { commandId: command(), labelId, color: null });
    await as.mutation(api.board.setLabelColor, { commandId: command(), labelId, color: null });
    expect((await as.query(api.board.roster, { projectId })).labels[0]!.color).toBeNull();
    expect((await projectEvents(t, projectId)).length).toBe(eventsBefore);
    await expect(
      as.mutation(api.board.setLabelColor, {
        commandId: command(),
        labelId: newId("label"),
        color: null,
      }),
    ).rejects.toThrow(code("not_found"));
    await expect(
      as.mutation(api.board.setLabelColor, { commandId: command(), labelId, color: "" }),
    ).rejects.toThrow(code("invalid_argument"));
  });
});

describe("reads", () => {
  test("a deleted ticket reads as absent", async () => {
    const t = setup();
    const { as, projectId } = await boardFixture(t);
    const { ticketId } = await createTicket(as, projectId);
    const row = await ticketRow(t, ticketId);
    await t.run((ctx) => ctx.db.patch(row!._id, { deletedAt: 1 }));
    await expect(as.query(api.board.getTicket, { ticketId })).rejects.toThrow(code("not_found"));
    expect((await as.query(api.board.roster, { projectId })).tickets).toEqual([]);
  });
});
