import {
  EMPTY_SESSION_USAGE_SUMMARY,
  PERSON_STARTED,
  type ChatSessionRecord,
  type SessionListingRow,
  type SessionRecord,
  type Ticket,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import {
  createTicketSessionRecordsStore,
  subscribeTicketSessionActivity,
  ticketSessionListingStateOf,
  useTicketSessionRecordsStore,
} from "./ticket-session-records";
import type { SessionActivityNotice, SessionsResult } from "../../../ipc/contract";
import { rememberRemoteProject, resetRemoteOwnersForTest } from "@renderer/lib/remote-owners";
import { setRemoteSessionListing } from "@renderer/lib/session-listing-reader";
import { useBoardStore } from "@renderer/stores/board";

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

  it("leaves every row the notice did not name exactly as it was", async () => {
    // The replacement walks the whole list, so the rows it passes over have to
    // come out the other side UNCHANGED — same object, not an equal copy: the
    // rail re-derives from row identity and a fresh object for an untouched
    // Session is a re-render nobody asked for.
    const store = await seeded([
      terminalRow({ id: "s2", createdAt: 2 }),
      terminalRow({ id: "s1" }),
    ]);
    const untouched = store.getState().byTicket["t1"]?.[0];

    store.getState().applyActivity(notice(terminalRow({ id: "s1", title: "Renamed" })));

    const rows = store.getState().byTicket["t1"] ?? [];
    expect(rows[0]).toBe(untouched);
    expect(rows.map(terminalRecord).map((row) => row.title)).toEqual(["Session 1", "Renamed"]);
  });
});

describe("ticketSessionListingStateOf", () => {
  it("reads a ticket whose rows arrived before this field existed as loaded", () => {
    // `listingState` is the authority when it has an answer; a cache seeded
    // without one (a restore, an older persisted shape) is judged by whether
    // the rows are there at all.
    expect(ticketSessionListingStateOf({ byTicket: { t1: [chatRow()] } }, "t1")).toBe("loaded");
    expect(ticketSessionListingStateOf({ byTicket: {} }, "t1")).toBe("loading");
    expect(
      ticketSessionListingStateOf({ byTicket: { t1: [] }, listingState: { t1: "failed" } }, "t1"),
    ).toBe("failed");
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

/** The read door, stubbed beside a roster the store can seed one chat row from. */
function stubSetRead(impl: () => Promise<unknown>) {
  vi.stubGlobal("window", {
    api: {
      sessions: {
        listForTicket: vi.fn(() =>
          Promise.resolve({ ok: true, sessions: [chatRow({ sessionId: "chat-1" })] }),
        ),
        setRead: vi.fn(impl),
      },
    },
  });
  return vi.mocked(window.api.sessions.setRead);
}

/** A store holding that roster, so a mark has a row to move. */
async function seededStore() {
  const store = createTicketSessionRecordsStore();
  await store.getState().refresh("t1");
  return store;
}

/**
 * Unread on the rail's own rows (VC-30). The receipt is main's, so everything
 * here is about the optimistic half: the dot has to answer a keypress in the
 * same frame, and a refused write must put the old state back rather than leave
 * the rail asserting a receipt main does not have.
 */
describe("setSessionRead", () => {
  it("marks a row unread ahead of the persist, and keeps it when the write sticks", async () => {
    const setRead = stubSetRead(() => Promise.resolve({ ok: true, read: { unreadSince: 5_000 } }));
    const store = await seededStore();

    await store.getState().setSessionRead("t1", "chat-1", true);

    expect(setRead).toHaveBeenCalledWith({ sessionId: "chat-1", unread: true });
    expect(store.getState().byTicket["t1"]?.[0]?.read?.unreadSince).toEqual(expect.any(Number));
  });

  it("clears the field rather than storing a resting value", async () => {
    stubSetRead(() => Promise.resolve({ ok: true, read: { unreadSince: null } }));
    const store = await seededStore();
    await store.getState().setSessionRead("t1", "chat-1", true);

    await store.getState().setSessionRead("t1", "chat-1", false);

    // Absence is the resting state on a row everywhere else in its life, so a
    // read row must be byte-identical to the row main publishes.
    expect(store.getState().byTicket["t1"]?.[0]).not.toHaveProperty("read");
  });

  it("reverts and toasts when the receipt is refused", async () => {
    stubSetRead(() => Promise.resolve({ ok: false, error: "db locked" }));
    const store = await seededStore();

    await store.getState().setSessionRead("t1", "chat-1", true);

    expect(store.getState().byTicket["t1"]?.[0]).not.toHaveProperty("read");
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't mark the session: db locked",
      expect.anything(),
    );
  });

  it("reverts and toasts when the door throws", async () => {
    stubSetRead(() => Promise.reject(new Error("ipc gone")));
    const store = await seededStore();
    await store.getState().setSessionRead("t1", "chat-1", true);
    const marked = store.getState().byTicket["t1"]?.[0]?.read;

    // Back to unread from read: the revert restores whatever was there before,
    // not a fixed resting value.
    stubSetRead(() => Promise.reject(new Error("ipc gone")));
    useTicketSessionRecordsStore.setState({});
    await store.getState().setSessionRead("t1", "chat-1", false);

    expect(store.getState().byTicket["t1"]?.[0]?.read).toEqual(marked);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't mark the session: ipc gone",
      expect.anything(),
    );
  });

  it("leaves every other row alone, and says nothing about a ticket it never read", async () => {
    vi.stubGlobal("window", {
      api: {
        sessions: {
          listForTicket: vi.fn(() =>
            Promise.resolve({
              ok: true,
              sessions: [chatRow({ sessionId: "chat-1" }), terminalRow({ id: "s1" })],
            }),
          ),
          setRead: vi.fn(() => Promise.resolve({ ok: true, read: { unreadSince: 1 } })),
        },
      },
    });
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("t1");

    await store.getState().setSessionRead("t1", "chat-1", true);
    await store.getState().setSessionRead("t-unknown", "chat-1", true);

    expect(store.getState().byTicket["t1"]?.[1]).toEqual(terminalRow({ id: "s1" }));
    expect(store.getState().byTicket["t-unknown"]).toBeUndefined();
  });
});

describe("a remote ticket's listing (VC-713)", () => {
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.();
    unregister = null;
    resetRemoteOwnersForTest();
    useBoardStore.setState({ ticketsByProject: {} });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function remote(listForTicket: (input: { ticketId: string }) => Promise<SessionsResult>) {
    rememberRemoteProject("remote", { hostId: "box", hostName: "hetzner-1" });
    useBoardStore.setState({ ticketsByProject: { remote: [{ id: "remote-ticket" } as Ticket] } });
    const reader = { list: () => Promise.reject(new Error("unused")), listForTicket };
    unregister = setRemoteSessionListing({
      forProject: (projectId) => (projectId === "remote" ? reader : null),
    });
  }

  it("reads a remote ticket through its own reader, and This Mac's through window.api", async () => {
    const local = vi.fn(async () => ({ ok: true as const, sessions: [] }));
    vi.stubGlobal("window", { api: { sessions: { listForTicket: local } } });
    const listForTicket = vi.fn(async () => ({
      ok: true as const,
      sessions: [chatRow({ sessionId: "boxed", activity: "waiting", waitingOn: "question" })],
    }));
    remote(listForTicket);
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("remote-ticket");
    await store.getState().refresh("t1");
    expect(listForTicket).toHaveBeenCalledWith({ ticketId: "remote-ticket" });
    expect(local.mock.calls).toEqual([[{ ticketId: "t1" }]]);
    expect(store.getState().byTicket["remote-ticket"]).toMatchObject([
      { record: { sessionId: "boxed", waitingOn: "question" } },
    ]);
  });

  it("keeps a loaded ticket's rows through a quiet read, and says nothing when it fails", async () => {
    let next: SessionsResult | Error = { ok: true, sessions: [chatRow({ sessionId: "kept" })] };
    remote(async () => {
      if (next instanceof Error) throw next;
      return next;
    });
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("remote-ticket");
    const states: string[] = [];
    const stop = store.subscribe((state) => states.push(state.listingState["remote-ticket"]!));
    next = { ok: false, error: "link dropped" };
    await store.getState().refresh("remote-ticket", { quiet: true });
    next = new Error("link dropped");
    await store.getState().refresh("remote-ticket", { quiet: true });
    stop();
    expect(states).not.toContain("loading");
    expect(ticketSessionListingStateOf(store.getState(), "remote-ticket")).toBe("loaded");
    expect(store.getState().byTicket["remote-ticket"]).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stands a never-loaded ticket's skeleton down when a quiet read fails, silently", async () => {
    remote(async () => ({ ok: false, error: "link dropped" }));
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("remote-ticket", { quiet: true });
    expect(ticketSessionListingStateOf(store.getState(), "remote-ticket")).toBe("failed");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("never falls to This Mac's IPC for a ticket on a project known remote (B1)", async () => {
    const local = vi.fn(async () => ({ ok: true as const, sessions: [] }));
    vi.stubGlobal("window", { api: { sessions: { listForTicket: local } } });
    rememberRemoteProject("remote", { hostId: "box", hostName: "hetzner-1" });
    useBoardStore.setState({ ticketsByProject: { remote: [{ id: "remote-ticket" } as Ticket] } });
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("remote-ticket");
    expect(local).not.toHaveBeenCalled();
    expect(store.getState().listingError["remote-ticket"]).toBe("hetzner-1 isn’t connected");
  });
});
