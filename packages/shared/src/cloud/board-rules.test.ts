import { describe, expect, test } from "vite-plus/test";

import { ARMED_RUN_DELAY_MS } from "../armed-arrival";
import type { Actor } from "./actor";
import {
  BOARD_LIMITS,
  BoardRuleError,
  decideArchiveTicket,
  decideCreateComment,
  decideCreateSignal,
  decideCreateTicket,
  decideEditComment,
  decideMoveTickets,
  decideUnarchiveTicket,
  decideUpdateTicket,
  movingTicketIds,
  normalizeLabelColor,
  requireCommentEditable,
  type BoardLabel,
  type BoardTicket,
  type UpdateTicketState,
} from "./board-rules";
import type { CommentId, LabelId, ProjectId, SessionId, SignalId, TicketId, UserId } from "./ids";

const PROJECT = "00000000-0000-4000-8000-000000000001" as ProjectId;
const OTHER_PROJECT = "00000000-0000-4000-8000-000000000002" as ProjectId;
const ALICE = "00000000-0000-4000-8000-0000000000a1" as UserId;
const BOB = "00000000-0000-4000-8000-0000000000b0" as UserId;
const SESSION = "00000000-0000-4000-8000-0000000000c0" as SessionId;

const tid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as TicketId;
const lid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}` as LabelId;

function ticket(n: number, overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id: tid(n),
    projectId: PROJECT,
    number: n,
    title: `Ticket ${n}`,
    status: "todo",
    priority: "medium",
    position: "a0",
    labelIds: [],
    assigneeUserId: null,
    checkoutMode: "worktree",
    preferredHarnessId: "claude-code",
    branch: null,
    baseBranch: null,
    retentionKeep: false,
    placeRunnerId: null,
    archivedAt: null,
    ...overrides,
  };
}

function label(n: number, name: string, overrides: Partial<BoardLabel> = {}): BoardLabel {
  return {
    id: lid(n),
    projectId: PROJECT,
    name,
    nameKey: name.toLowerCase(),
    color: null,
    mergedIntoId: null,
    ...overrides,
  };
}

function minter(start = 100): () => LabelId {
  let next = start;
  return () => lid(next++);
}

function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BoardRuleError);
    return { code: (error as BoardRuleError).code, message: (error as Error).message };
  }
  throw new Error("expected a refusal");
}

const person: Actor = { kind: "person", userId: ALICE };
const agent: Actor = { kind: "agent", userId: ALICE, sessionId: SESSION };

describe("BoardRuleError", () => {
  test("carries a stable code", () => {
    const error = new BoardRuleError("archived", "nope");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BoardRuleError");
    expect(error.code).toBe("archived");
    expect(error.message).toBe("nope");
  });
});

describe("labels", () => {
  const create = (labels: BoardLabel[], names: string[]) =>
    decideCreateTicket(
      { projectId: PROJECT, number: 1, columnEnd: null, labels, mintLabelId: minter() },
      { ticketId: tid(1), status: "todo", title: "T", labels: names },
    );

  test("a name is trimmed and bounded", () => {
    expect(create([], [" ui "]).createdLabels[0]!.name).toBe("ui");
    expect(refusal(() => create([], [" "])).code).toBe("invalid_argument");
    expect(refusal(() => create([], ["x".repeat(BOARD_LIMITS.labelNameLength + 1)])).code).toBe(
      "invalid_argument",
    );
  });

  test("a name resolves to an existing label ignoring ASCII case, or mints one, once", () => {
    const decision = create([label(1, "UI")], ["ui", " Backend ", "BACKEND", "UI"]);
    expect(decision.ticket.labelIds).toEqual([lid(1), lid(100)]);
    expect(decision.createdLabels).toEqual([
      {
        id: lid(100),
        projectId: PROJECT,
        name: "Backend",
        nameKey: "backend",
        color: null,
        mergedIntoId: null,
      },
    ]);
  });

  test("a merged label resolves to the end of its merge chain, stopping at a gap or a cycle", () => {
    const chain = [
      label(1, "old", { mergedIntoId: lid(2) }),
      label(2, "mid", { mergedIntoId: lid(3) }),
      label(3, "new"),
      label(4, "dangling", { mergedIntoId: lid(99) }),
      label(5, "loop-a", { mergedIntoId: lid(6) }),
      label(6, "loop-b", { mergedIntoId: lid(5) }),
    ];
    expect(create(chain, ["OLD", "dangling", "loop-a"]).ticket.labelIds).toEqual([
      lid(3),
      lid(4),
      lid(6),
    ]);
  });

  test("a live label wins its name over an alias that shares it, in either order", () => {
    const alias = label(1, "ui", { mergedIntoId: lid(9) });
    const live = label(2, "UI", { nameKey: "ui" });
    expect(create([alias, live], ["ui"]).ticket.labelIds).toEqual([lid(2)]);
    expect(create([live, alias], ["ui"]).ticket.labelIds).toEqual([lid(2)]);
    // Two aliases (of labels that are gone): the first keeps the key.
    const other = label(3, "ui", { mergedIntoId: lid(8) });
    expect(create([alias, other], ["ui"]).ticket.labelIds).toEqual([lid(1)]);
  });

  test("normalizeLabelColor keeps a 1–64 character colour or null", () => {
    expect(normalizeLabelColor(null)).toBeNull();
    expect(normalizeLabelColor("#AbCdEf")).toBe("#AbCdEf");
    expect(refusal(() => normalizeLabelColor("")).code).toBe("invalid_argument");
    expect(refusal(() => normalizeLabelColor("x".repeat(65))).code).toBe("invalid_argument");
  });
});

describe("decideCreateTicket", () => {
  const base = {
    projectId: PROJECT,
    number: 7,
    columnEnd: null,
    labels: [],
    mintLabelId: minter(),
  };

  test("defaults a ticket at the end of its column and records created", () => {
    const decision = decideCreateTicket(base, {
      ticketId: tid(7),
      status: "backlog",
      title: " Hi ",
    });
    expect(decision.ticket).toEqual(
      ticket(7, {
        title: "Hi",
        status: "backlog",
        position: "a0",
        preferredHarnessId: "claude-code",
      }),
    );
    expect(decision.body).toBe("");
    expect(decision.createdLabels).toEqual([]);
    expect(decision.events).toEqual([
      { ticketId: tid(7), payload: { kind: "created", status: "backlog", title: "Hi" } },
    ]);
  });

  test("takes every field, appends after the column's last key and records the labels it named", () => {
    const decision = decideCreateTicket(
      { ...base, columnEnd: "a5", labels: [label(1, "UI")], mintLabelId: minter() },
      {
        ticketId: tid(7),
        status: "doing",
        title: "Hi",
        priority: "high",
        body: "Body",
        labels: ["ui", "new"],
        checkoutMode: "main_checkout",
        preferredHarnessId: "my-harness",
        baseBranch: "main",
      },
    );
    expect(decision.ticket).toMatchObject({
      status: "doing",
      priority: "high",
      position: "a6",
      labelIds: [lid(1), lid(100)],
      checkoutMode: "main_checkout",
      preferredHarnessId: "my-harness",
      baseBranch: "main",
    });
    expect(decision.body).toBe("Body");
    expect(decision.createdLabels.map((created) => created.name)).toEqual(["new"]);
    expect(decision.events[1]).toEqual({
      ticketId: tid(7),
      payload: { kind: "labels_changed", added: ["UI", "new"], removed: [] },
    });
  });

  test("refuses a bad title, body, harness, base branch or too many labels", () => {
    const create = (fields: Record<string, unknown>) =>
      refusal(() =>
        decideCreateTicket(base, { ticketId: tid(7), status: "todo", title: "T", ...fields }),
      ).code;
    expect(create({ title: "  " })).toBe("invalid_argument");
    expect(create({ title: "x".repeat(BOARD_LIMITS.titleLength + 1) })).toBe("invalid_argument");
    expect(create({ body: "é".repeat(BOARD_LIMITS.bodyBytes / 2 + 1) })).toBe("invalid_argument");
    expect(create({ preferredHarnessId: "Not A Harness" })).toBe("invalid_argument");
    expect(create({ baseBranch: "bad..branch" })).toBe("invalid_argument");
    expect(
      create({
        labels: Array.from({ length: BOARD_LIMITS.labelsPerTicket + 1 }, (_, i) => `l${i}`),
      }),
    ).toBe("invalid_argument");
  });
});

describe("decideUpdateTicket", () => {
  function state(overrides: Partial<UpdateTicketState> = {}): UpdateTicketState {
    return {
      ticket: ticket(1, { labelIds: [lid(1)] }),
      body: "Hello",
      labels: [label(1, "UI"), label(2, "Backend")],
      hasWorktree: false,
      mintLabelId: minter(),
      ...overrides,
    };
  }

  test("an update that changes nothing records nothing", () => {
    const decision = decideUpdateTicket(state(), {
      title: "Ticket 1",
      body: "Hello",
      priority: "medium",
      preferredHarnessId: "claude-code",
      checkoutMode: "worktree",
      labels: ["ui"],
    });
    expect(decision).toEqual({
      patch: {},
      body: null,
      createdLabels: [],
      events: [],
      sideEffects: [],
    });
    expect(decideUpdateTicket(state(), {}).events).toEqual([]);
  });

  test("records fields, then priority, then labels, in one decision", () => {
    const decision = decideUpdateTicket(state(), {
      title: "Renamed",
      body: "New body",
      preferredHarnessId: "codex",
      checkoutMode: "main_checkout",
      priority: "high",
      labels: ["backend", "fresh"],
    });
    expect(decision.patch).toEqual({
      title: "Renamed",
      preferredHarnessId: "codex",
      checkoutMode: "main_checkout",
      priority: "high",
      labelIds: [lid(2), lid(100)],
    });
    expect(decision.body).toBe("New body");
    expect(decision.events.map((event) => event.payload)).toEqual([
      { kind: "retitled", from: "Ticket 1", to: "Renamed" },
      { kind: "body_edited" },
      { kind: "harness_changed", from: "claude-code", to: "codex" },
      { kind: "checkout_mode_changed", from: "worktree", to: "main_checkout" },
      { kind: "priority_changed", from: "medium", to: "high" },
      { kind: "labels_changed", added: ["Backend", "fresh"], removed: ["UI"] },
    ]);
    expect(decision.sideEffects).toEqual([]);
  });

  test("a body mutation applies to the body as it stands, and a stale edit is refused", () => {
    expect(
      decideUpdateTicket(state(), { bodyMutation: { mode: "append", text: "More" } }).body,
    ).toBe("Hello\n\nMore");
    expect(
      refusal(() =>
        decideUpdateTicket(state(), {
          bodyMutation: { mode: "edit", oldText: "Gone", newText: "x" },
        }),
      ).code,
    ).toBe("body_match_failed");
    expect(
      refusal(() => decideUpdateTicket(state(), { body: "x".repeat(BOARD_LIMITS.bodyBytes + 1) }))
        .code,
    ).toBe("invalid_argument");
  });

  test("switching to a worktree asks for one; the switch is refused once a worktree exists", () => {
    const main = state({ ticket: ticket(1, { checkoutMode: "main_checkout" }) });
    expect(decideUpdateTicket(main, { checkoutMode: "worktree" }).sideEffects).toEqual([
      { kind: "materialize_working_copy", ticketId: tid(1) },
    ]);
    expect(
      refusal(() =>
        decideUpdateTicket({ ...main, hasWorktree: true }, { checkoutMode: "worktree" }),
      ).code,
    ).toBe("checkout_mode_locked");
  });

  test("edits add and remove labels by name, ignoring case, without phantom changes", () => {
    const decision = decideUpdateTicket(state(), {
      addLabels: ["UI", "backend"],
      removeLabels: ["nothing-worn"],
    });
    expect(decision.patch.labelIds).toEqual([lid(1), lid(2)]);
    expect(decision.events.map((event) => event.payload)).toEqual([
      { kind: "labels_changed", added: ["Backend"], removed: [] },
    ]);
    expect(decision.createdLabels).toEqual([]);
    expect(decideUpdateTicket(state(), { removeLabels: ["ui"] }).patch.labelIds).toEqual([]);
    expect(decideUpdateTicket(state(), { addLabels: ["ui"] }).events).toEqual([]);
  });

  test("a label is removed by any name that resolves to it, a merged-away one included", () => {
    const decision = decideUpdateTicket(
      state({
        ticket: ticket(1, { labelIds: [lid(2)] }),
        labels: [label(2, "Defect"), label(3, "bug", { mergedIntoId: lid(2) })],
      }),
      { removeLabels: ["BUG", "never-existed"] },
    );
    expect(decision.patch).toEqual({ labelIds: [] });
    expect(decision.createdLabels).toEqual([]);
  });

  test("stored aliases and unknown ids are rewritten to the labels worn now, with no event", () => {
    const decision = decideUpdateTicket(
      state({
        ticket: ticket(1, { labelIds: [lid(3), lid(2), lid(2), lid(42)] }),
        labels: [label(2, "Backend"), label(3, "old", { mergedIntoId: lid(2) })],
      }),
      { addLabels: [] },
    );
    expect(decision.patch).toEqual({ labelIds: [lid(2)] });
    expect(decision.events).toEqual([]);
  });

  test("refuses an archived ticket, a body with a mutation, labels set and edited, and bad fields", () => {
    expect(
      refusal(() => decideUpdateTicket(state({ ticket: ticket(1, { archivedAt: 5 }) }), {})).code,
    ).toBe("archived");
    expect(
      refusal(() =>
        decideUpdateTicket(state(), { body: "x", bodyMutation: { mode: "replace", body: "y" } }),
      ).code,
    ).toBe("invalid_argument");
    expect(
      refusal(() => decideUpdateTicket(state(), { labels: [], removeLabels: ["ui"] })).code,
    ).toBe("invalid_argument");
    expect(refusal(() => decideUpdateTicket(state(), { title: "" })).code).toBe("invalid_argument");
    expect(refusal(() => decideUpdateTicket(state(), { preferredHarnessId: "!" })).code).toBe(
      "invalid_argument",
    );
    expect(
      refusal(() =>
        decideUpdateTicket(state(), {
          addLabels: Array.from({ length: BOARD_LIMITS.labelsPerTicket }, (_, i) => `l${i}`),
        }),
      ).code,
    ).toBe("invalid_argument");
  });
});

describe("decideMoveTickets", () => {
  const now = 50_000;
  const column = (n: number, position: string, overrides: Partial<BoardTicket> = {}) =>
    ticket(n, { status: "doing", position, ...overrides });

  test("a cross-column move between two neighbours records the move and its consequences", () => {
    const moved = ticket(1, { status: "doing" });
    const decision = decideMoveTickets(
      {
        tickets: [moved],
        after: column(2, "a1", { status: "done" }),
        before: column(3, "a2", { status: "done" }),
        now,
      },
      { ticketIds: [tid(1)], toStatus: "done", afterTicketId: tid(2), beforeTicketId: tid(3) },
    );
    expect(decision.changes).toEqual([
      { ticketId: tid(1), patch: { position: "a1V", status: "done" } },
    ]);
    expect(decision.events).toEqual([
      { ticketId: tid(1), payload: { kind: "status_changed", from: "doing", to: "done" } },
    ]);
    expect(decision.sideEffects).toEqual([
      { kind: "trim_working_copies", ticketId: tid(1), reason: "done" },
      { kind: "interrupt_sessions", ticketId: tid(1), from: "doing", to: "done" },
      {
        kind: "column_arrival",
        ticketId: tid(1),
        from: "doing",
        to: "done",
        choice: null,
        notBefore: now + ARMED_RUN_DELAY_MS,
      },
    ]);
  });

  test("an arrival into an active column carries the picker's choice and nothing else", () => {
    const decision = decideMoveTickets(
      { tickets: [ticket(1)], after: null, before: null, now },
      { ticketIds: [tid(1)], toStatus: "doing", choice: { kind: "move-only" } },
    );
    expect(decision.sideEffects).toEqual([
      {
        kind: "column_arrival",
        ticketId: tid(1),
        from: "todo",
        to: "doing",
        choice: { kind: "move-only" },
        notBefore: now + ARMED_RUN_DELAY_MS,
      },
    ]);
  });

  test("a reorder within a column moves only the named ticket and records no event", () => {
    const decision = decideMoveTickets(
      { tickets: [column(1, "a5")], after: null, before: column(2, "a1"), now },
      { ticketIds: [tid(1)], toStatus: "doing", beforeTicketId: tid(2) },
    );
    expect(decision).toEqual({
      changes: [{ ticketId: tid(1), patch: { position: "a0" } }],
      events: [],
      sideEffects: [],
    });
  });

  test("a group lands in board order with even keys, whatever order it was named in", () => {
    const decision = decideMoveTickets(
      {
        tickets: [
          column(4, "a1", { status: "needs_review" }),
          column(3, "a1"),
          column(2, "a1"),
          ticket(5, { status: "backlog", position: "Zz" }),
        ],
        after: column(9, "a3", { status: "todo" }),
        before: null,
        now,
      },
      {
        ticketIds: [tid(4), tid(3), tid(2), tid(5), tid(4)],
        toStatus: "todo",
        afterTicketId: tid(9),
      },
    );
    expect(decision.changes.map((change) => change.ticketId)).toEqual([
      tid(5),
      tid(2),
      tid(3),
      tid(4),
    ]);
    const keys = decision.changes.map((change) => change.patch.position!);
    expect(keys).toEqual(keys.toSorted());
    expect(keys.every((key) => key > "a3")).toBe(true);
    expect(decision.events).toHaveLength(4);
  });

  test("a column-only move leaves a ticket already in the column where it is", () => {
    // A null neighbour is no neighbour: still column-only.
    const command = {
      ticketIds: [tid(1), tid(2)],
      toStatus: "doing" as const,
      afterTicketId: null,
    };
    expect(movingTicketIds(command, [column(1, "a0"), ticket(2)])).toEqual([tid(2)]);
    expect(
      movingTicketIds({ ...command, beforeTicketId: tid(9) }, [column(1, "a0"), ticket(2)]),
    ).toEqual([tid(1), tid(2)]);
    const decision = decideMoveTickets(
      { tickets: [column(1, "a0"), ticket(2)], after: column(3, "a4"), before: null, now },
      { ticketIds: [tid(1), tid(2)], toStatus: "doing", afterTicketId: null },
    );
    expect(decision.changes).toEqual([
      { ticketId: tid(2), patch: { position: "a5", status: "doing" } },
    ]);
    // The ticket that stays may be the gap's neighbour: the newcomer lands after it.
    const after = decideMoveTickets(
      { tickets: [column(1, "a4"), ticket(2)], after: column(1, "a4"), before: null, now },
      { ticketIds: [tid(1), tid(2)], toStatus: "doing" },
    );
    expect(after.changes).toEqual([
      { ticketId: tid(2), patch: { position: "a5", status: "doing" } },
    ]);
    expect(
      decideMoveTickets(
        { tickets: [column(1, "a0")], after: column(3, "a4"), before: null, now },
        { ticketIds: [tid(1)], toStatus: "doing" },
      ),
    ).toEqual({ changes: [], events: [], sideEffects: [] });
  });

  test("a move that lands every ticket where it already sits changes nothing", () => {
    const settled = decideMoveTickets(
      { tickets: [column(1, "a2")], after: column(2, "a1"), before: column(3, "a3"), now },
      { ticketIds: [tid(1)], toStatus: "doing", afterTicketId: tid(2) },
    );
    expect(settled.changes).toEqual([]);
    // Outside the gap on either side, it moves.
    const below = decideMoveTickets(
      { tickets: [column(1, "a0")], after: column(2, "a1"), before: column(3, "a3"), now },
      { ticketIds: [tid(1)], toStatus: "doing", afterTicketId: tid(2) },
    );
    expect(below.changes).toHaveLength(1);
    const above = decideMoveTickets(
      { tickets: [column(1, "a4")], after: column(2, "a1"), before: column(3, "a3"), now },
      { ticketIds: [tid(1)], toStatus: "doing", afterTicketId: tid(2) },
    );
    expect(above.changes).toHaveLength(1);
  });

  test("refuses an empty or oversized move, an unknown, archived or foreign ticket", () => {
    const move = (tickets: BoardTicket[], ticketIds: TicketId[]) =>
      refusal(() =>
        decideMoveTickets(
          { tickets, after: null, before: null, now },
          { ticketIds, toStatus: "doing" },
        ),
      ).code;
    expect(move([], [])).toBe("invalid_argument");
    expect(
      move(
        [],
        Array.from({ length: BOARD_LIMITS.ticketsPerMove + 1 }, (_, i) => tid(i + 1)),
      ),
    ).toBe("invalid_argument");
    expect(move([], [tid(1)])).toBe("invalid_argument");
    expect(move([ticket(1, { archivedAt: 3 })], [tid(1)])).toBe("archived");
    expect(move([ticket(1), ticket(2, { projectId: OTHER_PROJECT })], [tid(1), tid(2)])).toBe(
      "wrong_project",
    );
  });

  test("refuses neighbours that are not live tickets of the destination column, or out of order", () => {
    const withNeighbour = (neighbour: BoardTicket, ticketIds = [tid(1)]) =>
      refusal(() =>
        decideMoveTickets(
          { tickets: [ticket(1), neighbour], after: neighbour, before: null, now },
          { ticketIds, toStatus: "doing", afterTicketId: neighbour.id },
        ),
      ).code;
    expect(withNeighbour(column(2, "a1", { projectId: OTHER_PROJECT }))).toBe("invalid_position");
    expect(withNeighbour(column(2, "a1", { status: "todo" }))).toBe("invalid_position");
    expect(withNeighbour(column(2, "a1", { archivedAt: 1 }))).toBe("invalid_position");
    expect(withNeighbour(column(2, "a1"), [tid(1), tid(2)])).toBe("invalid_position");
    expect(
      refusal(() =>
        decideMoveTickets(
          { tickets: [ticket(1)], after: column(2, "a3"), before: column(3, "a3"), now },
          { ticketIds: [tid(1)], toStatus: "doing", afterTicketId: tid(2), beforeTicketId: tid(3) },
        ),
      ).code,
    ).toBe("invalid_position");
    // A neighbour holding a key that is not one is refused, not sorted outside the gap.
    expect(
      refusal(() =>
        decideMoveTickets(
          { tickets: [ticket(1)], after: column(2, "a!"), before: null, now },
          { ticketIds: [tid(1)], toStatus: "doing", afterTicketId: tid(2) },
        ),
      ).code,
    ).toBe("invalid_position");
  });

  test("a group lands in board order: column, then position, then number", () => {
    const decision = decideMoveTickets(
      {
        tickets: [
          ticket(3, { status: "doing", position: "a0" }),
          ticket(2, { status: "todo", position: "a1" }),
          ticket(1, { status: "todo", position: "a1" }),
          ticket(4, { status: "todo", position: "a0" }),
        ],
        after: null,
        before: null,
        now,
      },
      { ticketIds: [tid(3), tid(2), tid(1), tid(4)], toStatus: "backlog" },
    );
    expect(decision.changes.map((change) => change.ticketId)).toEqual([
      tid(4),
      tid(1),
      tid(2),
      tid(3),
    ]);
  });
});

describe("archive", () => {
  test("archiving records the archive and trims; a repeat changes nothing", () => {
    expect(decideArchiveTicket(ticket(1), 9)).toEqual({
      patch: { archivedAt: 9 },
      events: [{ ticketId: tid(1), payload: { kind: "archived" } }],
      sideEffects: [{ kind: "trim_working_copies", ticketId: tid(1), reason: "archived" }],
    });
    expect(decideArchiveTicket(ticket(1, { archivedAt: 9 }), 10)).toEqual({
      patch: {},
      events: [],
      sideEffects: [],
    });
  });

  test("unarchiving returns the ticket to the end of its column; a live ticket changes nothing", () => {
    expect(decideUnarchiveTicket(ticket(1, { archivedAt: 9 }), "a3")).toEqual({
      patch: { archivedAt: null, position: "a4" },
      events: [{ ticketId: tid(1), payload: { kind: "unarchived" } }],
      sideEffects: [],
    });
    expect(decideUnarchiveTicket(ticket(1), null)).toEqual({
      patch: {},
      events: [],
      sideEffects: [],
    });
  });
});

describe("comments", () => {
  const commentId = "00000000-0000-4000-a000-000000000001" as CommentId;

  test("an agent's comment cites its Session; a person's cites none", () => {
    expect(decideCreateComment(ticket(1), { commentId, body: "Hi" }, agent)).toEqual({
      comment: {
        id: commentId,
        ticketId: tid(1),
        projectId: PROJECT,
        sessionId: SESSION,
        body: "Hi",
      },
      events: [{ ticketId: tid(1), payload: { kind: "commented", commentId } }],
    });
    expect(
      decideCreateComment(ticket(1), { commentId, body: "Hi" }, person).comment.sessionId,
    ).toBeNull();
  });

  test("refuses an empty or oversized comment, and one on an archived ticket", () => {
    expect(
      refusal(() => decideCreateComment(ticket(1), { commentId, body: " \n" }, person)).code,
    ).toBe("invalid_argument");
    expect(
      refusal(() =>
        decideCreateComment(
          ticket(1),
          { commentId, body: "x".repeat(BOARD_LIMITS.commentBytes + 1) },
          person,
        ),
      ).code,
    ).toBe("invalid_argument");
    expect(
      refusal(() =>
        decideCreateComment(ticket(1, { archivedAt: 1 }), { commentId, body: "Hi" }, person),
      ).code,
    ).toBe("archived");
  });

  test("only the author's person edits or removes a comment, through any client or agent", () => {
    const comment = { author: agent, deletedAt: null };
    expect(
      refusal(() =>
        decideEditComment(
          { author: { kind: "legacy", was: "user" }, deletedAt: null },
          "x",
          person,
        ),
      ).code,
    ).toBe("forbidden");
    expect(decideEditComment(comment, "New", person)).toBe("New");
    expect(
      refusal(() => decideEditComment(comment, "New", { kind: "person", userId: BOB })).code,
    ).toBe("forbidden");
    expect(refusal(() => decideEditComment({ ...comment, deletedAt: 1 }, "New", person)).code).toBe(
      "invalid_argument",
    );
    expect(refusal(() => decideEditComment(comment, "", person)).code).toBe("invalid_argument");
    expect(() => requireCommentEditable(comment, person)).not.toThrow();
  });

  test("an automation's comment cites its Session only when it has one", () => {
    const automation: Actor = { kind: "automation", userId: ALICE, automationId: "a", runId: "r" };
    const cites = (actor: Actor) =>
      decideCreateComment(ticket(1), { commentId, body: "Hi" }, actor).comment.sessionId;
    expect(cites(automation)).toBeNull();
    expect(cites({ ...automation, sessionId: SESSION })).toBe(SESSION);
  });
});

describe("decideCreateSignal", () => {
  const signalId = "00000000-0000-4000-b000-000000000001" as SignalId;

  test("records a typed verdict, trimming its detail to null when empty", () => {
    expect(
      decideCreateSignal(
        ticket(1),
        { signalId, kind: "review", verdict: "pass", detail: " ok " },
        agent,
      ),
    ).toEqual({
      signal: {
        id: signalId,
        ticketId: tid(1),
        projectId: PROJECT,
        sessionId: SESSION,
        kind: "review",
        verdict: "pass",
        detail: "ok",
      },
      events: [
        {
          ticketId: tid(1),
          payload: { kind: "signaled", signalKind: "review", verdict: "pass", detail: "ok" },
        },
      ],
    });
    for (const detail of [undefined, null, "  "]) {
      expect(
        decideCreateSignal(ticket(1), { signalId, kind: "merge", verdict: "fail", detail }, person)
          .signal.detail,
      ).toBeNull();
    }
  });

  test("refuses an oversized detail and an archived ticket", () => {
    expect(
      refusal(() =>
        decideCreateSignal(
          ticket(1),
          {
            signalId,
            kind: "review",
            verdict: "pass",
            detail: "x".repeat(BOARD_LIMITS.signalDetailBytes + 1),
          },
          person,
        ),
      ).code,
    ).toBe("invalid_argument");
    expect(
      refusal(() =>
        decideCreateSignal(
          ticket(1, { archivedAt: 2 }),
          { signalId, kind: "review", verdict: "pass" },
          person,
        ),
      ).code,
    ).toBe("archived");
  });
});
