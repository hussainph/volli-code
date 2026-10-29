import { randomUUID } from "node:crypto";

import type { ConvexClient } from "convex/browser";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { PREVIEW_ENROLLMENT_AGREEMENT_VERSION } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { concurrently, connectBackend } from "../fixture/testing";
import { enrollBackendPreview } from "./preview-fixtures";

const backend = connectBackend();
const uuid = () => randomUUID();

// The backend is shared by every file in the run: this file signs in as a fresh
// subject with its own Workspace and project.
const subject = `user:${uuid()}`;
let projectId: string;

/** An HTTP client for reads and setup (one client queues its mutations; writers below have their own). */
const client = () => backend.client(subject);

/**
 * Concurrent writers, each on its own socket as a desktop window writes: one
 * socket runs its mutations in order. A board's writes serialize on its
 * project's counter, so a burst can exhaust the backend's own concurrency
 * retries; a socket then reconnects and resends the same command (same
 * `commandId`), which is the product's policy for that, and every assertion
 * below still holds of what lands.
 */
const WRITERS = 8;
const windows: ConvexClient[] = [];

/** Creates a ticket through writer `writer`'s socket. */
async function createTicket(title: string, status: "todo" | "doing" = "todo", writer = 0) {
  const ticketId = uuid();
  await windows[writer % WRITERS]!.mutation(api.board.createTicket, {
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
  const { userId } = await client().mutation(api.accounts.ensureViewer, {});
  await backend.admin(internal.previewAccess.set, { kind: "user", value: userId, enabled: true });
  await client().mutation(api.accounts.ensureViewer, {
    acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  });
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
  for (let index = 0; index < WRITERS; index++) windows.push(backend.socket(subject));
}, 120_000);

afterAll(async () => {
  await Promise.all(windows.map((window) => window.close()));
});

describe("the board on the pinned local backend", () => {
  test("concurrent creates get distinct, contiguous ticket numbers", async () => {
    const replies = await concurrently(
      windows.map(
        (window, index) => () =>
          window.mutation(api.board.createTicket, {
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
    const movers = await concurrently(
      Array.from({ length: 8 }, (_, i) => () => createTicket(`Mover ${i}`, "todo", i)),
    );
    await concurrently(
      movers.map(
        (ticketId, index) => () =>
          windows[index]!.mutation(api.board.moveTickets, {
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
    const movers = await concurrently(
      Array.from({ length: 6 }, (_, i) => () => createTicket(`Done ${i}`, "todo", i)),
    );
    await concurrently(
      movers.map(
        (ticketId, index) => () =>
          windows[index]!.mutation(api.board.moveTickets, {
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
    const replies = await concurrently(
      windows.slice(0, 5).map((window) => () => window.mutation(api.board.createTicket, args)),
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
    const moves = await concurrently(
      windows.slice(0, 5).map((window) => () => window.mutation(api.board.moveTickets, move)),
    );
    expect(moves.filter((reply) => !reply.receipt.replayed)).toHaveLength(1);
    const after = await client().query(api.board.ticketEvents, { ticketId });
    expect(after.map((event) => event.kind)).toEqual(["created", "status_changed"]);
  });

  test("refuses an outsider with a typed error", async () => {
    const outsider = backend.client(`user:${uuid()}`);
    const { userId } = await outsider.mutation(api.accounts.ensureViewer, {});
    // Enrolled, so the refusal is membership, not the preview gate.
    await enrollBackendPreview(backend, outsider, userId);
    await expect(outsider.query(api.board.roster, { projectId })).rejects.toMatchObject({
      data: { code: "not_a_member" },
    });
  });
});
