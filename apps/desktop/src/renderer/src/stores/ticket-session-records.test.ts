import type { SessionRecord } from "@volli/shared";
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
    harnessSessionId: null,
    launchKind: "agent",
    placement: "tab",
    title: "Session 1",
    cwd: "/repo",
    createdAt: 1,
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
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
  it("caches the fetched records under their ticket id", async () => {
    const records = [record({ id: "s2", createdAt: 2 }), record()];
    stubListForTicket(() => Promise.resolve({ ok: true, sessions: records }));
    const store = createTicketSessionRecordsStore();

    await store.getState().refresh("t1");

    expect(store.getState().byTicket["t1"]).toEqual(records);
  });

  it("toasts and keeps the cache unchanged on a typed failure", async () => {
    stubListForTicket(() => Promise.resolve({ ok: false, error: "db locked" }));
    const store = createTicketSessionRecordsStore();

    await store.getState().refresh("t1");

    expect(store.getState().byTicket["t1"]).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(
      "Could not load sessions: db locked",
      expect.anything(),
    );
  });

  it("toasts and keeps the cache unchanged on a thrown bridge error", async () => {
    stubListForTicket(() => Promise.reject(new Error("ipc gone")));
    const store = createTicketSessionRecordsStore();

    await store.getState().refresh("t1");

    expect(store.getState().byTicket["t1"]).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(
      "Could not load sessions: ipc gone",
      expect.anything(),
    );
  });
});

describe("renameLocally", () => {
  it("renames the matching record in place", async () => {
    stubListForTicket(() =>
      Promise.resolve({ ok: true, sessions: [record(), record({ id: "s2" })] }),
    );
    const store = createTicketSessionRecordsStore();
    await store.getState().refresh("t1");

    store.getState().renameLocally("t1", "s2", "Renamed");

    expect(store.getState().byTicket["t1"]?.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "s1", title: "Session 1" },
      { id: "s2", title: "Renamed" },
    ]);
  });

  it("is a no-op for a ticket with no cached records", () => {
    const store = createTicketSessionRecordsStore();

    store.getState().renameLocally("t1", "s1", "Renamed");

    expect(store.getState().byTicket).toEqual({});
  });
});
