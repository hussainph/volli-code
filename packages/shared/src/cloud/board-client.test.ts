import { describe, expect, test } from "vite-plus/test";

import {
  applyTicketChanges,
  boardLabelFromRow,
  boardTicketFromRow,
  dropNeighbours,
  resolveMoveGap,
  type BoardTicketRow,
} from "./board-client";
import type { BoardTicket } from "./board-rules";

const P = "00000000-0000-4000-8000-000000000001";

function row(n: number, overrides: Partial<BoardTicketRow> = {}): BoardTicketRow {
  return {
    id: `t${n}`,
    projectId: P,
    number: n,
    title: `T${n}`,
    status: "todo",
    priority: "medium",
    position: `a${n}`,
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

const ticket = (n: number, overrides: Partial<BoardTicketRow> = {}): BoardTicket =>
  boardTicketFromRow(row(n, overrides));

describe("rows as the rules' facts", () => {
  test("maps a ticket row field for field, copying its labels", () => {
    const stored = { ...row(1, { labelIds: ["l1"] }), extra: "ignored", createdAt: 5 };
    const facts = boardTicketFromRow(stored);
    expect(facts).toEqual(row(1, { labelIds: ["l1"] }));
    expect(facts.labelIds).not.toBe(stored.labelIds);
  });

  test("maps a label row field for field", () => {
    const label = {
      id: "l1",
      projectId: P,
      name: "UI",
      nameKey: "ui",
      color: null,
      mergedIntoId: "l2",
      createdAt: 1,
    };
    expect(boardLabelFromRow(label)).toEqual({
      id: "l1",
      projectId: P,
      name: "UI",
      nameKey: "ui",
      color: null,
      mergedIntoId: "l2",
    });
  });
});

describe("dropNeighbours", () => {
  const board = [
    ticket(1),
    ticket(2),
    ticket(3),
    ticket(4, { status: "doing" }),
    ticket(5, { archivedAt: 9, position: "a0" }),
  ];

  test("names the tickets around the drop index, the moving ones taken out", () => {
    expect(dropNeighbours(board, "todo", ["t4"], 0)).toEqual({
      afterTicketId: null,
      beforeTicketId: "t1",
    });
    expect(dropNeighbours(board, "todo", ["t4"], 1)).toEqual({
      afterTicketId: "t1",
      beforeTicketId: "t2",
    });
    expect(dropNeighbours(board, "todo", ["t4"], 3)).toEqual({
      afterTicketId: "t3",
      beforeTicketId: null,
    });
    // A selection already in the column, moved within it.
    expect(dropNeighbours(board, "todo", ["t1", "t2"], 1)).toEqual({
      afterTicketId: "t3",
      beforeTicketId: null,
    });
    // A group spanning columns into Doing.
    expect(dropNeighbours(board, "doing", ["t1", "t4"], 0)).toEqual({
      afterTicketId: null,
      beforeTicketId: null,
    });
  });

  test("orders equal positions by number, as the backend does", () => {
    const tied = [ticket(7, { position: "a5" }), ticket(6, { position: "a5" })];
    expect(dropNeighbours(tied, "todo", [], 1)).toEqual({
      afterTicketId: "t6",
      beforeTicketId: "t7",
    });
  });

  test("clamps an index past either end, and names nothing in an empty column", () => {
    expect(dropNeighbours(board, "todo", [], -3)).toEqual({
      afterTicketId: null,
      beforeTicketId: "t1",
    });
    expect(dropNeighbours(board, "todo", [], 99)).toEqual({
      afterTicketId: "t3",
      beforeTicketId: null,
    });
    expect(dropNeighbours(board, "done", ["t1"], 0)).toEqual({
      afterTicketId: null,
      beforeTicketId: null,
    });
  });
});

describe("resolveMoveGap", () => {
  const board = [ticket(1), ticket(2), ticket(3), ticket(4, { status: "doing" })];
  const none = new Set<string>();

  test("lands right after a usable `after`, before the next ticket that stays", () => {
    expect(
      resolveMoveGap(board, { toStatus: "todo", afterTicketId: "t1" }, new Set(["t2"])),
    ).toEqual({ after: board[0], before: board[2] });
    expect(resolveMoveGap(board, { toStatus: "todo", afterTicketId: "t3" }, none)).toEqual({
      after: board[2],
      before: null,
    });
  });

  test("lands right before a usable `before` when `after` is not", () => {
    // A stale `before`: a ticket arrived in between since the drop was named.
    expect(
      resolveMoveGap(board, { toStatus: "todo", afterTicketId: "t4", beforeTicketId: "t3" }, none),
    ).toEqual({ after: board[1], before: board[2] });
    expect(resolveMoveGap(board, { toStatus: "todo", beforeTicketId: "t1" }, none)).toEqual({
      after: null,
      before: board[0],
    });
  });

  test("ignores unusable anchors: gone, another column, or moving", () => {
    // Only a `before` named, and it moves: the column's start.
    expect(
      resolveMoveGap(board, { toStatus: "todo", beforeTicketId: "t1" }, new Set(["t1"])),
    ).toEqual({ after: null, before: board[1] });
    // An `after` that is gone, and no `before`: the column's end.
    expect(
      resolveMoveGap(
        board,
        { toStatus: "todo", afterTicketId: "gone", beforeTicketId: null },
        none,
      ),
    ).toEqual({ after: board[2], before: null });
    // Neither named: the end; an empty column: nothing either side.
    expect(resolveMoveGap(board, { toStatus: "todo" }, none)).toEqual({
      after: board[2],
      before: null,
    });
    expect(resolveMoveGap(board, { toStatus: "done", beforeTicketId: "t1" }, none)).toEqual({
      after: null,
      before: null,
    });
    expect(resolveMoveGap(board, { toStatus: "done" }, none)).toEqual({
      after: null,
      before: null,
    });
  });
});

describe("applyTicketChanges", () => {
  test("patches copies of the changed rows, keeps the rest, and never mutates its input", () => {
    const rows = [row(1), row(2), row(3)];
    const frozen = rows.map((value) => Object.freeze({ ...value }));
    const next = applyTicketChanges(frozen, [
      { ticketId: "t2" as never, patch: { status: "doing" } },
      { ticketId: "t2" as never, patch: { position: "b0" } },
      { ticketId: "unknown" as never, patch: { status: "done" } },
    ]);
    expect(next[0]).toBe(frozen[0]);
    expect(next[2]).toBe(frozen[2]);
    expect(next[1]).toEqual({ ...row(2), status: "doing", position: "b0" });
    expect(frozen[1]).toEqual(row(2));
  });
});
