import type { ChatSessionRecord, SessionListingRow, SessionRecord } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";

import { createProjectSessionsStore } from "./project-sessions";
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

function chatRecord(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId: "c1",
    title: "Plan the migration",
    projectId: "p1",
    ticketId: "t1",
    createdAt: 1,
    adapterId: "pi",
    live: true,
    activity: "idle",
    waitingOn: null,
    lastActivityAt: 1,
    bornTicketless: false,
    ...overrides,
  };
}

function notice(row: SessionListingRow, projectId = "p1"): SessionActivityNotice {
  return {
    projectId,
    ticketId: row.kind === "terminal" ? row.record.ticketId : row.record.ticketId,
    row,
  };
}

function stubList(sessions: SessionListingRow[]) {
  const list = vi.fn().mockResolvedValue({ ok: true, sessions });
  Object.assign(globalThis, { window: { api: { sessions: { list } } } });
  return list;
}

describe("project-sessions store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("splits a fetched listing into the two record shapes", async () => {
    stubList([
      { kind: "terminal", record: record() },
      { kind: "chat", record: chatRecord() },
    ]);
    const store = createProjectSessionsStore();

    await store.getState().refresh("p1");

    expect(store.getState().byProject.p1).toEqual({
      terminal: [record()],
      chat: [chatRecord()],
    });
  });

  it("surfaces a failed listing read instead of silently emptying the project", async () => {
    const list = vi.fn().mockResolvedValue({ ok: false, error: "db closed" });
    Object.assign(globalThis, { window: { api: { sessions: { list } } } });
    const store = createProjectSessionsStore();

    await store.getState().refresh("p1");

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load sessions: db closed",
      expect.anything(),
    );
    expect(store.getState().byProject.p1).toBeUndefined();
  });

  it("upserts a pushed row over the fetched one", async () => {
    stubList([{ kind: "chat", record: chatRecord() }]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store
      .getState()
      .applyActivity(notice({ kind: "chat", record: chatRecord({ activity: "working" }) }));

    expect(store.getState().byProject.p1?.chat).toEqual([chatRecord({ activity: "working" })]);
  });

  it("appends a Session the baseline never saw", async () => {
    stubList([]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store.getState().applyActivity(notice({ kind: "chat", record: chatRecord() }));

    expect(store.getState().byProject.p1?.chat).toEqual([chatRecord()]);
  });

  it("moves a Session across the two lists when a terminal attaches to it", async () => {
    stubList([{ kind: "chat", record: chatRecord({ sessionId: "s1" }) }]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store.getState().applyActivity(notice({ kind: "terminal", record: record({ id: "s1" }) }));

    // One Session, one row — never one of each shape, with the stale one frozen.
    expect(store.getState().byProject.p1).toEqual({ terminal: [record({ id: "s1" })], chat: [] });
  });

  it("drops a notice for a project with no baseline rather than seeding a partial one", () => {
    const store = createProjectSessionsStore();

    store.getState().applyActivity(notice({ kind: "chat", record: chatRecord() }));

    expect(store.getState().byProject.p1).toBeUndefined();
  });

  it("ignores a notice for another project", async () => {
    stubList([]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store
      .getState()
      .applyActivity(notice({ kind: "chat", record: chatRecord({ projectId: "p2" }) }, "p2"));

    expect(store.getState().byProject.p1).toEqual({ terminal: [], chat: [] });
    expect(store.getState().byProject.p2).toBeUndefined();
  });

  it("repoints a terminal row's running harness, and holds identity when nothing moved", async () => {
    stubList([{ kind: "terminal", record: record() }]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");
    const before = store.getState().byProject.p1;

    store.getState().setActiveHarness("p1", "s1", "opencode");
    expect(store.getState().byProject.p1?.terminal[0]?.activeHarnessId).toBe("opencode");

    const patched = store.getState().byProject.p1;
    store.getState().setActiveHarness("p1", "s1", "opencode");
    // Same value announced twice must not mint a fresh array for every consumer
    // to re-derive on — the sidebar's listing is the app's priciest derivation.
    expect(store.getState().byProject.p1).toBe(patched);
    store.getState().setActiveHarness("p1", "unknown-session", "codex");
    expect(store.getState().byProject.p1).toBe(patched);
    expect(before).not.toBe(patched);
  });
});
