import { createTicket, groupTicketsByStatus } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { createBoardMoveFixture } from "./board-move-fixture";

const initial = [0, 1, 2].map((order) =>
  createTicket({
    id: `t${order}`,
    projectId: "p1",
    ticketNumber: order + 1,
    title: `Ticket ${order + 1}`,
    status: "todo",
    order,
    now: 1,
  }),
);

describe("the interactive board's move fixture", () => {
  it("returns an authoritative snapshot instead of rolling back a successful-looking drop", async () => {
    const board = createBoardMoveFixture("p1", initial);
    const result = await board.move({
      projectId: "p1",
      ticketId: "t0",
      toStatus: "doing",
      toIndex: 0,
      choice: { kind: "automation", automationId: "a1" },
    });
    expect(result).toEqual({ ok: true, tickets: board.read() });
    expect(board.read().find((ticket) => ticket.id === "t0")?.status).toBe("doing");
    expect(initial[0]!.status).toBe("todo");
    // Accepting a choice is not an Automation Run: this fixture has no executor.
    board.reset();
    expect(board.read()).toEqual(initial);
  });

  it("persists group moves in board order and reconciles subsequent single moves", async () => {
    const board = createBoardMoveFixture("p1", initial);
    const result = await board.moveMany({
      projectId: "p1",
      ticketIds: ["t1", "t0"],
      toStatus: "doing",
      toIndex: 0,
      choice: { kind: "move-only" },
    });
    expect(result.ok).toBe(true);
    expect(groupTicketsByStatus(board.read()).doing.map((ticket) => ticket.id)).toEqual([
      "t0",
      "t1",
    ]);
    await board.move({ projectId: "p1", ticketId: "t0", toStatus: "todo", toIndex: 1 });
    expect(groupTicketsByStatus(board.read()).todo.map((ticket) => ticket.id)).toEqual([
      "t2",
      "t0",
    ]);
  });

  it("rejects another project's commands without touching the board", async () => {
    const board = createBoardMoveFixture("p1", initial);
    const before = board.read();
    expect(
      (await board.move({ projectId: "other", ticketId: "t0", toStatus: "done", toIndex: 0 })).ok,
    ).toBe(false);
    expect(
      (
        await board.moveMany({
          projectId: "other",
          ticketIds: ["t0"],
          toStatus: "done",
          toIndex: 0,
        })
      ).ok,
    ).toBe(false);
    expect(board.read()).toBe(before);
  });
});
