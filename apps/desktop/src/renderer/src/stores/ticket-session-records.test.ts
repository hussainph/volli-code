import type { ChatSessionRecord, SessionListingRow, SessionRecord } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import { createTicketSessionRecordsStore } from "./ticket-session-records";

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
  return { kind: "terminal", record: record(overrides) };
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
      lastActivityAt: 1,
      bornTicketless: false,
      ...overrides,
    },
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
  });

  it("toasts and keeps the cache unchanged on a typed failure", async () => {
    stubListForTicket(() => Promise.resolve({ ok: false, error: "db locked" }));
    const store = createTicketSessionRecordsStore();

    await store.getState().refresh("t1");

    expect(store.getState().byTicket["t1"]).toBeUndefined();
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
    expect(toast.error).toHaveBeenCalledWith("Couldn't load sessions: ipc gone", expect.anything());
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
