import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type ChatSessionRecord,
  type SessionListingRow,
  type SessionRecord,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import {
  createTicketSessionRecordsStore,
  subscribeTicketSessionActivity,
  useTicketSessionRecordsStore,
} from "./ticket-session-records";
import type { SessionActivityNotice } from "../../../ipc/contract";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    projectId: "p1",
    ticketId: "t1",
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "agent",
    placement: "tab",
    title: "Session 1",
    cwd: "/repo",
    createdAt: 1,
    endedAt: null,
    exitCode: null,
    lastActivityAt: 1,
    bornTicketless: false,
    ...overrides,
  };
}

function terminalRow(overrides: Partial<SessionRecord> = {}): SessionListingRow {
  return {
    kind: "terminal",
    record: record(overrides),
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };
}

function chatRow(overrides: Partial<ChatSessionRecord> = {}): SessionListingRow {
  return {
    kind: "chat",
    record: {
      sessionId: "chat-1",
      title: "Plan the migration",
      projectId: "p1",
      ticketId: "t1",
      createdAt: 1,
      adapterId: "opencode",
      live: true,
      activity: "idle",
      waitingOn: null,
      outcome: null,
      lastActivityAt: 1,
      bornTicketless: false,
      role: "ticket",
      parentSessionId: null,
      model: null,
      ...overrides,
    },
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    provenance: PERSON_STARTED,
  };
}

/** Narrows a row to its terminal record, for assertions the fixtures already know are terminal-only. */
function terminalRecord(row: SessionListingRow): SessionRecord {
  if (row.kind !== "terminal") throw new Error("expected a terminal row");
  return row.record;
}

/** Stub the preload bridge with a canned `listForTicket` response (or rejection). */
function stubListForTicket(impl: () => Promise<unknown>) {
  vi.stubGlobal("window", { api: { sessions: { listForTicket: vi.fn(impl) } } });
  return vi.mocked(window.api.sessions.listForTicket);
}

/** One pushed row, addressed at a ticket — the shape `volli:session-activity` carries. */
function notice(row: SessionListingRow, ticketId: string | null = "t1"): SessionActivityNotice {
  return { projectId: "p1", ticketId, row };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refresh", () => {
  it("caches the fetched rows under their ticket id, terminal and chat alike", async () => {
    const rows = [terminalRow({ id: "s2", createdAt: 2 }), chatRow()];
    stubListForTicket(() => Promise.resolve({ ok: true, sessions: rows }));
    const store = createTicketSessionRecordsStore();

    await store.getState().refresh("t1");

    expect(store.getState().byTicket["t1"]).toEqual(rows);
    expect(store.getState().listingState.t1).toBe("loaded");
    expect(store.getState().listingError.t1).toBeNull();
  });

  it("toasts and keeps the cache unchanged on a typed failure", async () => {
    stubListForTicket(() => Promise.resolve({ ok: false, error: "db locked" }));
    const store = createTicketSessionRecordsStore();

    await store.getState().refresh("t1");

    expect(store.getState().byTicket["t1"]).toBeUndefined();
    expect(store.getState().listingState.t1).toBe("failed");
    expect(store.getState().listingError.t1).toBe("db locked");
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load sessions: db locked",
      expect.anything(),
    );
  });

  it("toasts and keeps the cache unchanged on a thrown bridge error", async () => {
    stubListForTicket(() => Promise.reject(new Error("ipc gone")));
    const store = createTicketSessionRecordsStore();

    await store.getState().refresh("t1");

    expect(store.getState().byTicket["t1"]).toBeUndefined();
    expect(store.getState().listingState.t1).toBe("failed");
    expect(store.getState().listingError.t1).toBe("ipc gone");
    expect(toast.error).toHaveBeenCalledWith("Couldn't load sessions: ipc gone", expect.anything());
  });

  it("records loading before a baseline has answered", async () => {
    let resolve!: (result: unknown) => void;
    stubListForTicket(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const store = createTicketSessionRecordsStore();

    const pending = store.getState().refresh("t1");
    expect(store.getState().listingState.t1).toBe("loading");
    expect(store.getState().listingError.t1).toBeNull();

    resolve({ ok: true, sessions: [] });
    await pending;
    expect(store.getState().listingState.t1).toBe("loaded");
  });
});

describe("renameLocally", () => {
  it("renames the matching terminal row in place", async () => {
    stubListForTicket(() =>
      Promise.resolve({ ok: true, sessions: [terminalRow(), terminalRow({ id: "s2" })] }),
    );
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("t1");

    store.getState().renameLocally("t1", "s2", "Renamed");

    expect(
      store
        .getState()
        .byTicket["t1"]?.map(terminalRecord)
        .map(({ id, title }) => ({ id, title })),
    ).toEqual([
      { id: "s1", title: "Session 1" },
      { id: "s2", title: "Renamed" },
    ]);
  });

  // A chat row renames as a chat row: same `title` field, same call, and the
  // rest of the record (which has no terminal shape to be coerced into) intact.
  it("renames the matching chat row in place, leaving the rest of its record alone", async () => {
    stubListForTicket(() =>
      Promise.resolve({ ok: true, sessions: [chatRow(), chatRow({ sessionId: "s2" })] }),
    );
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("t1");

    store.getState().renameLocally("t1", "s2", "Renamed");

    expect(store.getState().byTicket["t1"]).toEqual([
      chatRow(),
      chatRow({ sessionId: "s2", title: "Renamed" }),
    ]);
  });

  it("leaves a row of the other kind alone when only the other kind's id matches", async () => {
    stubListForTicket(() =>
      Promise.resolve({ ok: true, sessions: [terminalRow(), chatRow({ sessionId: "s2" })] }),
    );
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("t1");

    store.getState().renameLocally("t1", "unknown", "Renamed");

    expect(store.getState().byTicket["t1"]).toEqual([terminalRow(), chatRow({ sessionId: "s2" })]);
  });

  it("is a no-op for a ticket with no cached rows", () => {
    const store = createTicketSessionRecordsStore();

    store.getState().renameLocally("t1", "s1", "Renamed");

    expect(store.getState().byTicket).toEqual({});
  });
});

describe("setActiveHarness", () => {
  // What is running moves; what launched does not. Both are wanted, and the
  // rail reads them together through `effectiveHarnessId`.
  it("records the announced harness beside the launch one, on the named terminal row", async () => {
    stubListForTicket(() =>
      Promise.resolve({ ok: true, sessions: [terminalRow(), terminalRow({ id: "s2" })] }),
    );
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("t1");

    store.getState().setActiveHarness("t1", "s2", "opencode");

    expect(
      store
        .getState()
        .byTicket["t1"]?.map(terminalRecord)
        .map(({ id, harnessId, activeHarnessId }) => ({ id, harnessId, activeHarnessId })),
    ).toEqual([
      { id: "s1", harnessId: "claude-code", activeHarnessId: null },
      { id: "s2", harnessId: "claude-code", activeHarnessId: "opencode" },
    ]);
  });

  // `activeHarnessId` is a PTY-wrapper fact `ChatSessionRecord` has no field
  // for at all — a chat row sharing the target id must pass through untouched.
  it("leaves a chat row untouched even when its id matches", async () => {
    stubListForTicket(() =>
      Promise.resolve({ ok: true, sessions: [chatRow({ sessionId: "s2" })] }),
    );
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("t1");

    store.getState().setActiveHarness("t1", "s2", "opencode");

    expect(store.getState().byTicket["t1"]).toEqual([chatRow({ sessionId: "s2" })]);
  });

  it("is a no-op for a ticket with no cached rows", () => {
    const store = createTicketSessionRecordsStore();

    store.getState().setActiveHarness("t1", "s1", "opencode");

    expect(store.getState().byTicket).toEqual({});
  });
});

describe("in-flight dedup", () => {
  it("shares one read between callers that collide on a frame", async () => {
    const list = stubListForTicket(() => Promise.resolve({ ok: true, sessions: [terminalRow()] }));
    const store = createTicketSessionRecordsStore();

    // `TicketDetail` and the rail both ask on the frame a ticket opens — the
    // collision this collapses.
    await Promise.all([
      store.getState().refresh("t1"),
      store.getState().refresh("t1"),
      store.getState().ensure("t1"),
    ]);

    expect(list).toHaveBeenCalledTimes(1);
    expect(store.getState().byTicket["t1"]).toEqual([terminalRow()]);
  });

  it("starts a fresh read once the earlier one settled", async () => {
    const list = stubListForTicket(() => Promise.resolve({ ok: true, sessions: [terminalRow()] }));
    const store = createTicketSessionRecordsStore();

    await store.getState().refresh("t1");
    await store.getState().refresh("t1");

    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("ensure", () => {
  it("reads a ticket this cache has never listed", async () => {
    const list = stubListForTicket(() => Promise.resolve({ ok: true, sessions: [terminalRow()] }));
    const store = createTicketSessionRecordsStore();

    await store.getState().ensure("t1");

    expect(list).toHaveBeenCalledTimes(1);
    expect(store.getState().byTicket["t1"]).toEqual([terminalRow()]);
  });

  it("answers a warm ticket — and a ticket the baseline left empty — without re-reading", async () => {
    const list = stubListForTicket(() => Promise.resolve({ ok: true, sessions: [] }));
    const store = createTicketSessionRecordsStore();

    await store.getState().ensure("t1");
    await store.getState().ensure("t1");

    // Empty IS a landed listing: a ticket with no Sessions must not read again
    // on every mount, which is exactly what an `undefined`-only check would do.
    expect(list).toHaveBeenCalledTimes(1);
    expect(store.getState().byTicket["t1"]).toEqual([]);
  });

  it("retries a failed baseline only when another caller asks", async () => {
    const list = stubListForTicket(
      vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce({ ok: false, error: "db locked" })
        .mockResolvedValueOnce({ ok: true, sessions: [terminalRow()] }),
    );
    const store = createTicketSessionRecordsStore();

    await store.getState().ensure("t1");
    expect(store.getState().listingState.t1).toBe("failed");
    expect(store.getState().byTicket.t1).toBeUndefined();

    // No timer retried it: this second, explicit ensure owns the next read.
    await store.getState().ensure("t1");
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.getState().listingState.t1).toBe("loaded");
    expect(store.getState().byTicket.t1).toEqual([terminalRow()]);
  });
});

/**
 * The push path: `volli:session-activity` carries the same `SessionListingRow`
 * the fetch returns, so applying one is an upsert. One test per transition the
 * rail must reflect (VC-373's acceptance): create, split, exit, rename — and
 * the cross-kind crossing, the drop rules, and the subscribe wiring.
 */
describe("applyActivity", () => {
  async function seeded(
    rows: SessionListingRow[],
  ): Promise<ReturnType<typeof createTicketSessionRecordsStore>> {
    stubListForTicket(() => Promise.resolve({ ok: true, sessions: rows }));
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("t1");
    return store;
  }

  it("adds a created Session's row, newest first like the baseline", async () => {
    const store = await seeded([terminalRow({ id: "s1", createdAt: 1 })]);

    store.getState().applyActivity(notice(terminalRow({ id: "s2", createdAt: 2 })));

    expect(
      store
        .getState()
        .byTicket["t1"]?.map(terminalRecord)
        .map((row) => row.id),
    ).toEqual(["s2", "s1"]);
  });

  it("adds a split pane's terminal row beside its tab root", async () => {
    const store = await seeded([terminalRow({ id: "root", placement: "tab" })]);

    // A split boots a NEW durable Session for the pane, so this is a create
    // like any other — the row the panel's old live-pane signature used to
    // refetch for.
    store
      .getState()
      .applyActivity(notice(terminalRow({ id: "leaf", placement: "split", createdAt: 2 })));

    expect(
      store
        .getState()
        .byTicket["t1"]?.map(terminalRecord)
        .map((row) => row.id),
    ).toEqual(["leaf", "root"]);
  });

  it("replaces the row an exited Session's durable update carries", async () => {
    const store = await seeded([terminalRow({ id: "s1", endedAt: null, exitCode: null })]);

    store.getState().applyActivity(notice(terminalRow({ id: "s1", endedAt: 50, exitCode: 0 })));

    const [row] = store.getState().byTicket["t1"] ?? [];
    expect(row?.kind === "terminal" ? row.record : null).toMatchObject({
      id: "s1",
      endedAt: 50,
      exitCode: 0,
    });
  });

  it("replaces the row a rename's durable update carries", async () => {
    const store = await seeded([terminalRow({ id: "s1", title: "Session 1" })]);

    store.getState().applyActivity(notice(terminalRow({ id: "s1", title: "Renamed" })));

    expect(store.getState().byTicket["t1"]?.map(terminalRecord)[0]?.title).toBe("Renamed");
  });

  it("rewrites a Session that crosses from a chat row to a terminal row", async () => {
    // `sessionListingRow`'s precedence: once a terminal attaches, the row
    // changes KIND at the same id. An upsert that compared within one list
    // would leave the chat row beside its own terminal row.
    const store = await seeded([chatRow({ sessionId: "s1" })]);

    store.getState().applyActivity(notice(terminalRow({ id: "s1" })));

    expect(store.getState().byTicket["t1"]).toEqual([terminalRow({ id: "s1" })]);
  });

  it("drops a Board Session's row — the notice names no ticket", async () => {
    const store = await seeded([terminalRow()]);

    store.getState().applyActivity(notice(terminalRow({ id: "s2" }), null));

    expect(
      store
        .getState()
        .byTicket["t1"]?.map(terminalRecord)
        .map((row) => row.id),
    ).toEqual(["s1"]);
  });

  it("drops a row for a ticket this cache has never listed", async () => {
    const store = await seeded([terminalRow()]);

    store.getState().applyActivity(notice(terminalRow({ id: "s2" }), "t2"));

    expect(store.getState().byTicket["t2"]).toBeUndefined();
  });
});

describe("subscribeTicketSessionActivity", () => {
  it("folds a pushed notice through the app-wide subscription", () => {
    const off = vi.fn();
    let push: ((notice: SessionActivityNotice) => void) | null = null;
    const onActivity = vi.fn((callback: (notice: SessionActivityNotice) => void) => {
      push = callback;
      return off;
    });
    Object.assign(globalThis, { window: { api: { sessions: { onActivity } } } });
    useTicketSessionRecordsStore.setState({
      byTicket: { t1: [chatRow({ sessionId: "chat-1" })] },
      listingState: { t1: "loaded" },
      listingError: { t1: null },
    });

    const unsubscribe = subscribeTicketSessionActivity();
    push!(notice(terminalRow({ id: "s9", createdAt: 9 })));

    expect(useTicketSessionRecordsStore.getState().byTicket["t1"]).toEqual([
      terminalRow({ id: "s9", createdAt: 9 }),
      chatRow({ sessionId: "chat-1" }),
    ]);
    unsubscribe();
    expect(off).toHaveBeenCalledTimes(1);
    useTicketSessionRecordsStore.setState({ byTicket: {}, listingState: {}, listingError: {} });
  });
});
