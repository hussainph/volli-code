/**
 * The drift alarm on the board's optimistic updates (VC-889): a client runs
 * the same rules over its own roster for an optimistic paint
 * (`@volli/shared/cloud`'s `dropNeighbours` → `resolveMoveGap` → `decide…`),
 * and with no concurrent change its answer must be exactly the backend's, so
 * the confirmed rows replace the optimistic ones with nothing moving on
 * screen. Each scenario seeds a board, computes the client's answer from
 * `board.roster`, runs the real mutation, and compares every changed ticket.
 */
import { describe, expect, test } from "vite-plus/test";

import {
  boardLabelFromRow,
  boardTicketFromRow,
  decideCreateTicket,
  decideMoveTickets,
  decideUnarchiveTicket,
  dropNeighbours,
  movingTicketIds,
  newId,
  resolveMoveGap,
  type MoveTicketsCommand,
  type ProjectId,
  type TicketId,
  type TicketStatus,
} from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import { boardFixture, createTicket, setup, type Client } from "./board-helpers";

async function seed(as: Client, projectId: string, columns: Record<string, string[]>) {
  const ids: Record<string, TicketId> = {};
  for (const [status, titles] of Object.entries(columns)) {
    for (const title of titles) {
      const { ticketId } = await createTicket(as, projectId, {
        title,
        status: status as TicketStatus,
      });
      ids[title] = ticketId as TicketId;
    }
  }
  return ids;
}

async function facts(as: Client, projectId: string) {
  const { tickets } = await as.query(api.board.roster, { projectId });
  return tickets.map(boardTicketFromRow);
}

/** What the client paints for a move, and what the backend then holds, for the moved tickets. */
async function parity(as: Client, projectId: string, command: MoveTicketsCommand) {
  const before = await facts(as, projectId);
  const named = before.filter((ticket) => command.ticketIds.includes(ticket.id));
  const moving = new Set<string>(movingTicketIds(command, named));
  const gap = resolveMoveGap(before, command, moving);
  const decision = decideMoveTickets(
    { tickets: named, after: gap.after, before: gap.before, now: Date.now() },
    command,
  );
  const optimistic = Object.fromEntries(
    decision.changes.map(({ ticketId, patch }) => {
      const ticket = before.find(({ id }) => id === ticketId)!;
      return [ticketId, { status: patch.status ?? ticket.status, position: patch.position }];
    }),
  );
  await as.mutation(api.board.moveTickets, {
    commandId: newId("command"),
    projectId,
    ticketIds: [...command.ticketIds],
    toStatus: command.toStatus,
    afterTicketId: command.afterTicketId ?? null,
    beforeTicketId: command.beforeTicketId ?? null,
  });
  const after = await facts(as, projectId);
  const confirmed = Object.fromEntries(
    Object.keys(optimistic).map((ticketId) => {
      const ticket = after.find(({ id }) => id === ticketId)!;
      return [ticketId, { status: ticket.status, position: ticket.position }];
    }),
  );
  // Nothing else moved either.
  for (const ticket of after) {
    if (ticket.id in optimistic) continue;
    expect(ticket.position).toBe(before.find(({ id }) => id === ticket.id)!.position);
  }
  return { optimistic, confirmed, changed: decision.changes.length };
}

describe("an optimistic move computes the backend's keys", () => {
  test("a single move between two neighbours of another column", async () => {
    const { as, projectId } = await boardFixture(setup());
    const id = await seed(as, projectId, { todo: ["A", "B", "C"], doing: ["X"] });
    const board = await facts(as, projectId);
    const drop = dropNeighbours(board, "todo", [id.X!], 1);
    const result = await parity(as, projectId, {
      ticketIds: [id.X!],
      toStatus: "todo",
      ...drop,
    });
    expect(result.changed).toBe(1);
    expect(result.optimistic).toEqual(result.confirmed);
  });

  test("a group move across columns, keeping board order", async () => {
    const { as, projectId } = await boardFixture(setup());
    const id = await seed(as, projectId, { todo: ["A", "B"], doing: ["X", "Y"], done: ["D"] });
    const board = await facts(as, projectId);
    const moving = [id.Y!, id.A!, id.X!];
    const result = await parity(as, projectId, {
      ticketIds: moving,
      toStatus: "done",
      ...dropNeighbours(board, "done", moving, 0),
    });
    expect(result.changed).toBe(3);
    expect(result.optimistic).toEqual(result.confirmed);
  });

  test("drops at the start and at the end of a column", async () => {
    const { as, projectId } = await boardFixture(setup());
    const id = await seed(as, projectId, { todo: ["A", "B", "C"], doing: ["X", "Y"] });
    const start = await parity(as, projectId, {
      ticketIds: [id.X!],
      toStatus: "todo",
      ...dropNeighbours(await facts(as, projectId), "todo", [id.X!], 0),
    });
    expect(start.optimistic).toEqual(start.confirmed);
    const end = await parity(as, projectId, {
      ticketIds: [id.Y!],
      toStatus: "todo",
      ...dropNeighbours(await facts(as, projectId), "todo", [id.Y!], 99),
    });
    expect(end.optimistic).toEqual(end.confirmed);
  });

  test("a column-only move, which leaves a ticket already there in place", async () => {
    const { as, projectId } = await boardFixture(setup());
    const id = await seed(as, projectId, { todo: ["A"], doing: ["X", "Y"] });
    const result = await parity(as, projectId, {
      ticketIds: [id.A!, id.X!],
      toStatus: "doing",
    });
    expect(result.changed).toBe(1);
    expect(result.optimistic).toEqual(result.confirmed);
  });

  test("a stale `before`: a ticket arrived between the named pair since the drop", async () => {
    const { as, projectId } = await boardFixture(setup());
    const id = await seed(as, projectId, { todo: ["A", "C"], doing: ["X"] });
    // The drop was named against [A, C]; then B lands between them (moved from Doing).
    const named = dropNeighbours(await facts(as, projectId), "todo", [id.X!], 1);
    const arrived = await seed(as, projectId, { doing: ["B"] });
    await as.mutation(api.board.moveTickets, {
      commandId: newId("command"),
      projectId,
      ticketIds: [arrived.B!],
      toStatus: "todo",
      afterTicketId: id.A!,
      beforeTicketId: id.C!,
    });
    const result = await parity(as, projectId, {
      ticketIds: [id.X!],
      toStatus: "todo",
      ...named,
    });
    expect(result.optimistic).toEqual(result.confirmed);
  });

  test("an anchor that is itself moving, or no longer in the column", async () => {
    const { as, projectId } = await boardFixture(setup());
    const id = await seed(as, projectId, { todo: ["A", "B", "C"], doing: ["X"] });
    const moving = await parity(as, projectId, {
      ticketIds: [id.A!, id.X!],
      toStatus: "todo",
      afterTicketId: id.A!,
      beforeTicketId: id.C!,
    });
    expect(moving.optimistic).toEqual(moving.confirmed);
    const elsewhere = await parity(as, projectId, {
      ticketIds: [id.B!],
      toStatus: "todo",
      beforeTicketId: id.X!,
    });
    expect(elsewhere.optimistic).toEqual(elsewhere.confirmed);
  });
});

describe("an optimistic create and unarchive land where the backend puts them", () => {
  test("a new ticket at its column's end", async () => {
    const { as, projectId } = await boardFixture(setup());
    await seed(as, projectId, { todo: ["A", "B"] });
    const { tickets, labels } = await as.query(api.board.roster, { projectId });
    const column = tickets
      .filter(({ status }) => status === "todo")
      .map(({ position }) => position)
      .toSorted();
    const ticketId = newId("ticket");
    const decision = decideCreateTicket(
      {
        projectId: projectId as ProjectId,
        number: 0,
        columnEnd: column.at(-1) ?? null,
        labels: labels.map(boardLabelFromRow),
        mintLabelId: () => newId("label"),
      },
      { ticketId, status: "todo", title: "New" },
    );
    await as.mutation(api.board.createTicket, {
      commandId: newId("command"),
      projectId,
      ticketId,
      status: "todo",
      title: "New",
    });
    const created = (await facts(as, projectId)).find(({ id }) => id === ticketId)!;
    expect(created.position).toBe(decision.ticket.position);
    expect(created.status).toBe(decision.ticket.status);
  });

  test("an unarchived ticket at its retained column's end", async () => {
    const { as, projectId } = await boardFixture(setup());
    const id = await seed(as, projectId, { doing: ["A", "B"] });
    await as.mutation(api.board.archiveTicket, {
      commandId: newId("command"),
      ticketId: id.A!,
    });
    const before = await facts(as, projectId);
    const end = before
      .filter(({ status }) => status === "doing")
      .map(({ position }) => position)
      .toSorted()
      .at(-1);
    const archived = (await as.query(api.board.getTicket, { ticketId: id.A! })).ticket;
    const decision = decideUnarchiveTicket(boardTicketFromRow(archived), end ?? null);
    await as.mutation(api.board.unarchiveTicket, {
      commandId: newId("command"),
      ticketId: id.A!,
    });
    const revived = (await facts(as, projectId)).find(({ id: ticketId }) => ticketId === id.A)!;
    expect(revived.position).toBe(decision.patch.position);
  });
});
