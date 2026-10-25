import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, test } from "vite-plus/test";

import { api } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";

const backend = connectBackend();
const uuid = () => randomUUID();

// The backend is shared by every file in the run: this file signs in as a fresh
// subject with its own Workspace and project.
const subject = `user:${uuid()}`;
let projectId: string;

/** A fresh client per call, so calls really run concurrently (one client queues its mutations). */
const client = () => backend.client(subject);

async function createTicket(title: string, status: "todo" | "doing" = "todo") {
  const ticketId = uuid();
  await client().mutation(api.board.createTicket, {
    commandId: uuid(),
    projectId,
    ticketId,
    status,
    title,
  });
  return ticketId;
}

async function column(status: string) {
  const { tickets } = await client().query(api.board.roster, { projectId });
  return tickets
    .filter((ticket) => ticket.status === status)
    .toSorted((a, b) => (a.position < b.position ? -1 : 1));
}

beforeAll(async () => {
  // Sign-up creates the person's own Workspace; the project goes there.
  await client().mutation(api.accounts.ensureViewer, {});
  const [workspace] = await client().query(api.workspaces.listMine, {});
  const workspaceId = workspace!.workspaceId;
  projectId = uuid();
  await client().mutation(api.projects.create, {
    commandId: uuid(),
    workspaceId,
    projectId,
    name: "Board backend",
    origin: "github",
  });
}, 120_000);

describe("the board on the pinned local backend", () => {
  test("concurrent creates get distinct, contiguous ticket numbers", async () => {
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        client().mutation(api.board.createTicket, {
          commandId: uuid(),
          projectId,
          ticketId: uuid(),
          status: "backlog",
          title: `Concurrent ${index}`,
        }),
      ),
    );
    const numbers = replies.map((reply) => reply.number).toSorted((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, index) => numbers[0]! + index));
    expect(new Set((await column("backlog")).map((ticket) => ticket.position)).size).toBe(8);
  });

  test("concurrent moves into the same gap all land in it, each with its own key", async () => {
    const after = await createTicket("After", "doing");
    const before = await createTicket("Before", "doing");
    const movers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createTicket(`Mover ${i}`)),
    );
    await Promise.all(
      movers.map((ticketId) =>
        client().mutation(api.board.moveTickets, {
          commandId: uuid(),
          projectId,
          ticketIds: [ticketId],
          toStatus: "doing",
          afterTicketId: after,
          beforeTicketId: before,
        }),
      ),
    );
    const doing = await column("doing");
    const ids = doing.map((ticket) => ticket.id);
    expect(ids[0]).toBe(after);
    expect(ids.at(-1)).toBe(before);
    expect(new Set(ids.slice(1, -1))).toEqual(new Set(movers));
    expect(new Set(doing.map((ticket) => ticket.position)).size).toBe(doing.length);
  });

  test("concurrent column-only moves append without colliding, and the event order has no gaps", async () => {
    const movers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => createTicket(`Done ${i}`)),
    );
    await Promise.all(
      movers.map((ticketId) =>
        client().mutation(api.board.moveTickets, {
          commandId: uuid(),
          projectId,
          ticketIds: [ticketId],
          toStatus: "done",
        }),
      ),
    );
    const done = await column("done");
    expect(new Set(done.map((ticket) => ticket.id))).toEqual(new Set(movers));
    expect(new Set(done.map((ticket) => ticket.position)).size).toBe(6);

    const events = await Promise.all(
      movers.map((ticketId) => client().query(api.board.ticketEvents, { ticketId })),
    );
    // Nothing else wrote to the project meanwhile: the six creates and six
    // moves hold twelve consecutive sequence numbers, none shared.
    const seqs = events
      .flat()
      .map((event) => event.seq)
      .toSorted((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, index) => seqs[0]! + index));
  });

  test("the same commandId sent concurrently is applied once and replayed for the rest", async () => {
    const ticketId = uuid();
    const args = { commandId: uuid(), projectId, ticketId, status: "todo" as const, title: "Once" };
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => client().mutation(api.board.createTicket, args)),
    );
    expect(replies.filter((reply) => !reply.receipt.replayed)).toHaveLength(1);
    expect(new Set(replies.map((reply) => reply.number)).size).toBe(1);
    const events = await client().query(api.board.ticketEvents, { ticketId });
    expect(events.map((event) => event.kind)).toEqual(["created"]);

    const move = {
      commandId: uuid(),
      projectId,
      ticketIds: [ticketId],
      toStatus: "doing" as const,
    };
    const moves = await Promise.all(
      Array.from({ length: 5 }, () => client().mutation(api.board.moveTickets, move)),
    );
    expect(moves.filter((reply) => !reply.receipt.replayed)).toHaveLength(1);
    const after = await client().query(api.board.ticketEvents, { ticketId });
    expect(after.map((event) => event.kind)).toEqual(["created", "status_changed"]);
  });

  test("refuses an outsider with a typed error", async () => {
    const outsider = backend.client(`user:${uuid()}`);
    await outsider.mutation(api.accounts.ensureViewer, {});
    await expect(outsider.query(api.board.roster, { projectId })).rejects.toMatchObject({
      data: { code: "not_a_member" },
    });
  });
});
