import type { TicketComment, TicketEvent } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import { createTicketActivityStore } from "./ticket-activity";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const EVENTS: TicketEvent[] = [{ id: "e1" } as unknown as TicketEvent];
const COMMENTS: TicketComment[] = [{ id: "c1" } as unknown as TicketComment];

/** Installs the two IPC doors a full activity baseline needs. */
function stubActivity(
  events: () => Promise<unknown>,
  comments: () => Promise<unknown> = () => Promise.resolve({ ok: true, comments: COMMENTS }),
) {
  const eventsDoor = vi.fn(events);
  const commentsDoor = vi.fn(comments);
  vi.stubGlobal("window", {
    api: { tickets: { events: eventsDoor }, comments: { list: commentsDoor } },
  });
  return { eventsDoor, commentsDoor };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apply", () => {
  it("records what main answered with, under the planning version it was read at", () => {
    const store = createTicketActivityStore();

    store.getState().apply("t1", { events: EVENTS, comments: COMMENTS, version: 4 });

    expect(store.getState().byTicket["t1"]).toEqual({
      events: EVENTS,
      comments: COMMENTS,
      version: 4,
    });
    expect(store.getState().listingState.t1).toBe("loaded");
    expect(store.getState().listingError.t1).toBeNull();
  });

  it("replaces the ticket's earlier entry whole", () => {
    const store = createTicketActivityStore();
    store.getState().apply("t1", { events: EVENTS, comments: COMMENTS, version: 4 });

    store.getState().apply("t1", { events: [], comments: [], version: 9 });

    expect(store.getState().byTicket["t1"]).toEqual({ events: [], comments: [], version: 9 });
  });
});

describe("baseline reads", () => {
  it("records loading while the events and comments baseline is in flight", async () => {
    let resolveEvents!: (result: unknown) => void;
    const { eventsDoor, commentsDoor } = stubActivity(
      () =>
        new Promise((resolve) => {
          resolveEvents = resolve;
        }),
    );
    const store = createTicketActivityStore();

    const first = store.getState().refresh("t1", 4);
    const second = store.getState().ensure("t1", 4);
    expect(store.getState().listingState.t1).toBe("loading");
    expect(store.getState().listingError.t1).toBeNull();
    expect(eventsDoor).toHaveBeenCalledTimes(1);
    expect(commentsDoor).toHaveBeenCalledTimes(1);

    resolveEvents({ ok: true, events: EVENTS });
    await Promise.all([first, second]);
    expect(store.getState().byTicket.t1).toEqual({
      events: EVENTS,
      comments: COMMENTS,
      version: 4,
    });
    expect(store.getState().listingState.t1).toBe("loaded");
  });

  it("keeps a refused baseline out of the empty state and records its detail", async () => {
    stubActivity(() => Promise.resolve({ ok: false, error: "db locked" }));
    const store = createTicketActivityStore();

    await store.getState().refresh("t1", 4);

    expect(store.getState().byTicket.t1).toBeUndefined();
    expect(store.getState().listingState.t1).toBe("failed");
    expect(store.getState().listingError.t1).toBe("db locked");
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load activity: db locked",
      expect.anything(),
    );
  });

  it("records a thrown bridge error as the same failed state", async () => {
    stubActivity(() => Promise.reject(new Error("ipc gone")));
    const store = createTicketActivityStore();

    await store.getState().refresh("t1", 4);

    expect(store.getState().byTicket.t1).toBeUndefined();
    expect(store.getState().listingState.t1).toBe("failed");
    expect(store.getState().listingError.t1).toBe("ipc gone");
    expect(toast.error).toHaveBeenCalledWith("Couldn't load activity: ipc gone", expect.anything());
  });

  it("retries a failed baseline only when a later ensure asks for it", async () => {
    let attempt = 0;
    const { eventsDoor } = stubActivity(() => {
      attempt += 1;
      return Promise.resolve(
        attempt === 1
          ? { ok: false as const, error: "db locked" }
          : { ok: true as const, events: EVENTS },
      );
    });
    const store = createTicketActivityStore();

    await store.getState().ensure("t1", 4);
    expect(store.getState().listingState.t1).toBe("failed");

    await store.getState().ensure("t1", 4);
    expect(eventsDoor).toHaveBeenCalledTimes(2);
    expect(store.getState().listingState.t1).toBe("loaded");
  });

  it("fails the baseline when the COMMENTS door refuses, though the events door answered", async () => {
    // The feed is both reads. A half-answer is not a feed the cache may claim
    // landed: an events list with no comments beside it would draw as a
    // complete activity feed that is quietly missing every comment.
    stubActivity(
      () => Promise.resolve({ ok: true, events: EVENTS }),
      () => Promise.resolve({ ok: false, error: "comments table locked" }),
    );
    const store = createTicketActivityStore();

    await store.getState().refresh("t1", 4);

    expect(store.getState().byTicket.t1).toBeUndefined();
    expect(store.getState().listingState.t1).toBe("failed");
    expect(store.getState().listingError.t1).toBe("comments table locked");
  });

  it("drops a superseded read's late answer rather than letting it replace the newer one", async () => {
    // IPC cannot retract a request. A planning change that starts a second read
    // must therefore win on ARRIVAL as well as on order, or the older answer
    // lands last and the feed shows a moment the ticket has already left.
    const resolvers: ((result: unknown) => void)[] = [];
    stubActivity(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const store = createTicketActivityStore();

    const stale = store.getState().refresh("t1", 4);
    const fresh = store.getState().refresh("t1", 5);

    // The NEWER read answers first, then the one it superseded.
    resolvers[1]?.({ ok: true, events: [] });
    await fresh;
    resolvers[0]?.({ ok: true, events: EVENTS });
    await stale;

    // The stale answer carried EVENTS and version 4; neither may be here.
    expect(store.getState().byTicket.t1).toEqual({ events: [], comments: COMMENTS, version: 5 });
  });

  it("lets the read that owns the ticket finish cleanly after a superseded one settles", async () => {
    // The in-flight slot belongs to the newest read. A superseded read clearing
    // it on its way out would leave the live read unshared, so the next caller
    // would start a THIRD read against a ticket already being read.
    const resolvers: ((result: unknown) => void)[] = [];
    const { eventsDoor } = stubActivity(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const store = createTicketActivityStore();

    const stale = store.getState().refresh("t1", 4);
    store.getState().refresh("t1", 5);

    // The superseded read settles FIRST, while the newer one is still open.
    resolvers[0]?.({ ok: true, events: EVENTS });
    await stale;

    // The live read is still the shared one: asking again joins it.
    void store.getState().refresh("t1", 5);
    expect(eventsDoor).toHaveBeenCalledTimes(2);

    resolvers[1]?.({ ok: true, events: [] });
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
