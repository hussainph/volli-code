import type { TicketComment, TicketEvent } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { createTicketActivityStore } from "./ticket-activity";

const EVENTS: TicketEvent[] = [{ id: "e1" } as unknown as TicketEvent];
const COMMENTS: TicketComment[] = [{ id: "c1" } as unknown as TicketComment];

describe("apply", () => {
  it("records what main answered with, under the planning version it was read at", () => {
    const store = createTicketActivityStore();

    store.getState().apply("t1", { events: EVENTS, comments: COMMENTS, version: 4 });

    expect(store.getState().byTicket["t1"]).toEqual({
      events: EVENTS,
      comments: COMMENTS,
      version: 4,
    });
  });

  it("replaces the ticket's earlier entry whole", () => {
    const store = createTicketActivityStore();
    store.getState().apply("t1", { events: EVENTS, comments: COMMENTS, version: 4 });

    store.getState().apply("t1", { events: [], comments: [], version: 9 });

    expect(store.getState().byTicket["t1"]).toEqual({ events: [], comments: [], version: 9 });
  });
});

/**
 * The watermark bump for a change that provably did not touch this ticket: the
 * data stays, the version moves, so a later Doc-tab return still paints from
 * cache instead of refetching over a change that could not have mattered.
 */
describe("noteVersion", () => {
  it("advances an entry without touching its data", () => {
    const store = createTicketActivityStore();
    store.getState().apply("t1", { events: EVENTS, comments: COMMENTS, version: 4 });

    store.getState().noteVersion("t1", 7);

    expect(store.getState().byTicket["t1"]).toEqual({
      events: EVENTS,
      comments: COMMENTS,
      version: 7,
    });
  });

  it("is a no-op for a version the entry already carries, holding its identity", () => {
    const store = createTicketActivityStore();
    store.getState().apply("t1", { events: EVENTS, comments: COMMENTS, version: 7 });
    const before = store.getState().byTicket["t1"];

    store.getState().noteVersion("t1", 7);

    // Same object: nothing renders from a version it already carried.
    expect(store.getState().byTicket["t1"]).toBe(before);
  });

  it("mints no entry for a ticket this cache has never read", () => {
    const store = createTicketActivityStore();

    store.getState().noteVersion("t1", 7);

    // An entry here would be an empty feed pretending to be a landed read.
    expect(store.getState().byTicket).toEqual({});
  });
});
