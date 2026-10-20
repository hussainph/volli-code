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
  childSessionIds,
  createProjectSessionsStore,
  mergedProjectSessionRows,
  listableChats,
  projectSessionListingPending,
  sessionReadOf,
  sessionTitleOf,
  subscribeProjectSessionActivity,
  unreadSessionIds,
  useProjectSessionsStore,
  type ProjectSessionRows,
} from "./project-sessions";
import type { SessionActivityNotice, SessionsResult } from "../../../ipc/contract";
import { rememberRemoteProject, resetRemoteOwnersForTest } from "@renderer/lib/remote-owners";
import { setRemoteSessionListing } from "@renderer/lib/session-listing-reader";

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
    outcome: null,
    lastActivityAt: 1,
    bornTicketless: false,
    role: "ticket",
    parentSessionId: null,
    model: null,
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

const chatRow = (overrides: Partial<ChatSessionRecord> = {}): SessionListingRow => ({
  kind: "chat",
  record: chatRecord(overrides),
  usage: EMPTY_SESSION_USAGE_SUMMARY,
  provenance: PERSON_STARTED,
});

describe("a remote project's listing (VC-713)", () => {
  let unregister: (() => void) | null = null;
  afterEach(() => {
    unregister?.();
    unregister = null;
    resetRemoteOwnersForTest();
    Reflect.deleteProperty(globalThis, "window");
    vi.clearAllMocks();
  });

  function remote(list: (input: { projectId: string }) => Promise<SessionsResult>) {
    rememberRemoteProject("remote", { hostId: "box", hostName: "hetzner-1" });
    unregister = setRemoteSessionListing({
      forProject: (projectId) =>
        projectId === "remote"
          ? { list, listForTicket: () => Promise.reject(new Error("unused")) }
          : null,
    });
  }

  it("reads a remote project through its own reader, and This Mac's through window.api", async () => {
    const local = stubList([chatRow({ sessionId: "local" })]);
    const list = vi.fn(async () => ({
      ok: true as const,
      sessions: [chatRow({ sessionId: "boxed", activity: "waiting", waitingOn: "question" })],
    }));
    remote(list);
    const store = createProjectSessionsStore();
    await store.getState().refresh("remote");
    await store.getState().refresh("p1");
    expect(list).toHaveBeenCalledWith({ projectId: "remote" });
    expect(local).toHaveBeenCalledWith({ projectId: "p1" });
    expect(local).not.toHaveBeenCalledWith({ projectId: "remote" });
    expect(store.getState().byProject.remote?.chat).toMatchObject([
      { sessionId: "boxed", activity: "waiting", waitingOn: "question" },
    ]);
  });

  it("applies only the newest read when an older one lands after it", async () => {
    const answers: ((result: SessionsResult) => void)[] = [];
    remote(() => new Promise((resolve) => answers.push(resolve)));
    const store = createProjectSessionsStore();
    const older = store.getState().refresh("remote", { quiet: true });
    const newer = store.getState().refresh("remote", { quiet: true });
    answers[1]!({ ok: true, sessions: [chatRow({ sessionId: "new" })] });
    await newer;
    answers[0]!({ ok: true, sessions: [chatRow({ sessionId: "old" })] });
    await older;
    expect(store.getState().byProject.remote?.chat.map((row) => row.sessionId)).toEqual(["new"]);
    // An older read's failure says nothing either.
    const stale = store.getState().refresh("remote");
    void store.getState().refresh("remote", { quiet: true });
    answers[2]!({ ok: false, error: "late" });
    await stale;
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps the rows on screen through a quiet read, and says nothing when it fails", async () => {
    let next: SessionsResult | Error = { ok: true, sessions: [chatRow({ sessionId: "kept" })] };
    remote(async () => {
      if (next instanceof Error) throw next;
      return next;
    });
    const store = createProjectSessionsStore();
    await store.getState().refresh("remote");
    const states: (string | undefined)[] = [];
    const stop = store.subscribe((state) => states.push(state.listingState.remote));
    next = { ok: false, error: "link dropped" };
    await store.getState().refresh("remote", { quiet: true });
    next = new Error("link dropped");
    await store.getState().refresh("remote", { quiet: true });
    stop();
    expect(states).not.toContain("loading");
    expect(store.getState().listingState.remote).toBe("loaded");
    expect(store.getState().byProject.remote?.chat.map((row) => row.sessionId)).toEqual(["kept"]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stands a superseded read's skeleton down when the quiet read after it fails", async () => {
    const answers: ((result: SessionsResult) => void)[] = [];
    remote(() => new Promise((resolve) => answers.push(resolve)));
    const store = createProjectSessionsStore();
    const first = store.getState().refresh("remote");
    const quiet = store.getState().refresh("remote", { quiet: true });
    answers[1]!({ ok: false, error: "link dropped" });
    await quiet;
    answers[0]!({ ok: true, sessions: [] });
    await first;
    expect(store.getState().listingState.remote).toBe("failed");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("never falls to This Mac's IPC for a project known remote, registered or not (B1)", async () => {
    const list = vi.fn(async () => ({ ok: true as const, sessions: [] }));
    remote(list);
    const stale = setRemoteSessionListing({ forProject: () => null });
    unregister!();
    unregister = stale;
    const local = stubList([]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("remote");
    expect(local).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(store.getState().listingState.remote).toBe("failed");
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load sessions: hetzner-1 isn’t connected",
      expect.anything(),
    );
  });
});

describe("project-sessions store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("splits a fetched listing into the two record shapes", async () => {
    stubList([
      {
        kind: "terminal",
        record: record(),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
      {
        kind: "chat",
        record: chatRecord(),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
    ]);
    const store = createProjectSessionsStore();

    await store.getState().refresh("p1");

    expect(store.getState().byProject.p1).toEqual({
      terminal: [record()],
      chat: [chatRecord()],
      // Empty rather than two `{ kind: "user" }` entries: the resting case is
      // stored as its own absence, which is what makes an unautomated project
      // cost this map nothing (VC-131).
      provenance: {},
      // The same sparseness, for the same reason, for unread (VC-30).
      read: {},
    });
    expect(store.getState().listingState.p1).toBe("loaded");
  });

  // VC-131. The map is keyed by the id each row's own shape answers to, so both
  // arms are exercised: a terminal row is found by `record.id` and a chat row by
  // `record.sessionId`, and getting that backwards would file a mark under an id
  // no surface ever asks for — a bolt that silently never draws.
  it("keeps who started each Session, keyed by the id its own shape answers to", async () => {
    const run = {
      kind: "automation",
      automationRunId: null,
      automationName: "Nightly sweep",
    } as const;
    const child = {
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: "Orchestrator",
    } as const;
    stubList([
      {
        kind: "terminal",
        record: record(),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: child,
      },
      {
        kind: "chat",
        record: chatRecord(),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: run,
      },
    ]);
    const store = createProjectSessionsStore();

    await store.getState().refresh("p1");

    expect(store.getState().byProject.p1?.provenance).toEqual({ s1: child, c1: run });
  });

  // A Run started after this window opened arrives on the push channel before
  // any baseline fetch has seen it, so the fold has to carry the mark — a push
  // that dropped it would leave the newest Run as the one row with no bolt.
  it("folds a pushed row's provenance in, and leaves the resting case absent", async () => {
    const run = {
      kind: "automation",
      automationRunId: null,
      automationName: "Nightly sweep",
    } as const;
    stubList([]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store.getState().applyActivity(
      notice({
        kind: "chat",
        record: chatRecord({ sessionId: "fresh" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: run,
      }),
    );
    expect(store.getState().byProject.p1?.provenance).toEqual({ fresh: run });

    const before = store.getState().byProject.p1?.provenance;
    store.getState().applyActivity(
      notice({
        kind: "terminal",
        record: record({ id: "human" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      }),
    );
    // Not merely equal — the same object. A person-started row must not mint a
    // fresh map identity, or every push in a project nobody automated would
    // re-derive every listing built from it.
    expect(store.getState().byProject.p1?.provenance).toBe(before);
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
    expect(store.getState().listingState.p1).toBe("failed");
  });

  it("surfaces a thrown listing read the same way as a refused one", async () => {
    const list = vi.fn().mockRejectedValue(new Error("bridge gone"));
    Object.assign(globalThis, { window: { api: { sessions: { list } } } });
    const store = createProjectSessionsStore();

    await store.getState().refresh("p1");

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't load sessions: bridge gone",
      expect.anything(),
    );
    expect(store.getState().byProject.p1).toBeUndefined();
    expect(store.getState().listingState.p1).toBe("failed");
  });

  it("marks the baseline as loading until its read settles", async () => {
    let resolve!: (result: { ok: true; sessions: SessionListingRow[] }) => void;
    const list = vi.fn(
      () => new Promise<{ ok: true; sessions: SessionListingRow[] }>((done) => (resolve = done)),
    );
    Object.assign(globalThis, { window: { api: { sessions: { list } } } });
    const store = createProjectSessionsStore();

    const pending = store.getState().refresh("p1");
    expect(store.getState().listingState.p1).toBe("loading");

    resolve({ ok: true, sessions: [] });
    await pending;
    expect(store.getState().listingState.p1).toBe("loaded");
  });

  it("upserts a pushed row over the fetched one, in either shape", async () => {
    // Two rows per shape, so the upsert has to leave the untouched sibling
    // exactly as it was rather than rewriting the whole list.
    stubList([
      {
        kind: "chat",
        record: chatRecord(),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
      {
        kind: "chat",
        record: chatRecord({ sessionId: "c2" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
      {
        kind: "terminal",
        record: record(),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
      {
        kind: "terminal",
        record: record({ id: "s2" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
    ]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store.getState().applyActivity(
      notice({
        kind: "chat",
        record: chatRecord({ activity: "working" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      }),
    );
    store.getState().applyActivity(
      notice({
        kind: "terminal",
        record: record({ title: "Renamed" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      }),
    );

    expect(store.getState().byProject.p1).toEqual({
      terminal: [record({ title: "Renamed" }), record({ id: "s2" })],
      chat: [chatRecord({ activity: "working" }), chatRecord({ sessionId: "c2" })],
      provenance: {},
      read: {},
    });
  });

  it("appends a Session the baseline never saw", async () => {
    stubList([]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store.getState().applyActivity(
      notice({
        kind: "chat",
        record: chatRecord(),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      }),
    );

    expect(store.getState().byProject.p1?.chat).toEqual([chatRecord()]);
  });

  it("moves a Session across the two lists when a terminal attaches to it", async () => {
    stubList([
      {
        kind: "chat",
        record: chatRecord({ sessionId: "s1" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
    ]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store.getState().applyActivity(
      notice({
        kind: "terminal",
        record: record({ id: "s1" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      }),
    );

    // One Session, one row — never one of each shape, with the stale one frozen.
    expect(store.getState().byProject.p1).toEqual({
      terminal: [record({ id: "s1" })],
      chat: [],
      provenance: {},
      read: {},
    });
  });

  it("drops a notice for a project with no baseline rather than seeding a partial one", () => {
    const store = createProjectSessionsStore();

    store.getState().applyActivity(
      notice({
        kind: "chat",
        record: chatRecord(),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      }),
    );

    expect(store.getState().byProject.p1).toBeUndefined();
  });

  it("ignores a notice for another project", async () => {
    stubList([]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store.getState().applyActivity(
      notice(
        {
          kind: "chat",
          record: chatRecord({ projectId: "p2" }),
          usage: EMPTY_SESSION_USAGE_SUMMARY,
          provenance: PERSON_STARTED,
        },
        "p2",
      ),
    );

    expect(store.getState().byProject.p1).toEqual({
      terminal: [],
      chat: [],
      provenance: {},
      read: {},
    });
    expect(store.getState().byProject.p2).toBeUndefined();
  });

  it("ensures the baseline at most once, however many surfaces ask", async () => {
    const list = stubList([]);
    const store = createProjectSessionsStore();

    // Both surfaces asking on the same frame, before either fetch resolves.
    await Promise.all([store.getState().ensure("p1"), store.getState().ensure("p1")]);
    expect(list).toHaveBeenCalledTimes(1);

    // And again once the baseline is there — pushes carry it from here.
    await store.getState().ensure("p1");
    expect(list).toHaveBeenCalledTimes(1);

    // A failed ensure leaves nothing behind, so the next asker really retries.
    list.mockResolvedValue({ ok: false, error: "db closed" });
    await store.getState().ensure("p2");
    await store.getState().ensure("p2");
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("folds a pushed notice through the app-wide subscription", () => {
    const off = vi.fn();
    let push: ((notice: SessionActivityNotice) => void) | null = null;
    const onActivity = vi.fn((callback: (notice: SessionActivityNotice) => void) => {
      push = callback;
      return off;
    });
    Object.assign(globalThis, { window: { api: { sessions: { onActivity } } } });
    useProjectSessionsStore.setState({
      byProject: { p1: { terminal: [], chat: [], provenance: {} } },
    });

    const unsubscribe = subscribeProjectSessionActivity();
    push!(
      notice({
        kind: "chat",
        record: chatRecord(),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      }),
    );

    expect(useProjectSessionsStore.getState().byProject.p1?.chat).toEqual([chatRecord()]);
    unsubscribe();
    expect(off).toHaveBeenCalledTimes(1);
    useProjectSessionsStore.setState({ byProject: {} });
  });

  it("repoints a terminal row's running harness, and holds identity when nothing moved", async () => {
    stubList([
      {
        kind: "terminal",
        record: record(),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
    ]);
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

  it("says nothing about a project with no baseline", async () => {
    stubList([]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");
    const before = store.getState().byProject;

    // An announce can name a project this window has never listed — the harness
    // notice is app-wide. There is nothing to patch and nothing to invent.
    store.getState().setActiveHarness("p-unlisted", "s1", "codex");

    expect(store.getState().byProject).toBe(before);
    expect(store.getState().byProject["p-unlisted"]).toBeUndefined();
  });
});

describe("projectSessionListingPending", () => {
  it("holds only an unread or in-flight baseline", () => {
    expect(projectSessionListingPending(undefined)).toBe(true);
    expect(projectSessionListingPending("loading")).toBe(true);
    expect(projectSessionListingPending("loaded")).toBe(false);
    expect(projectSessionListingPending("failed")).toBe(false);
  });
});

/**
 * The door a surface that DRAWS rows comes through (VC-279). The cache itself
 * keeps every child, because the island, the board, the usage count and tab
 * restore all need them.
 */
describe("listableChats", () => {
  const rows: ProjectSessionRows = {
    terminal: [record()],
    chat: [
      chatRecord({ sessionId: "parent", title: "The chat that delegated" }),
      chatRecord({ sessionId: "board", title: "A Board Session", role: "project" }),
      chatRecord({
        sessionId: "child",
        title: "Find the auth refresh",
        role: "subagent",
        parentSessionId: "parent",
      }),
      // Started BY a Session rather than delegated to (VC-183): a full peer,
      // and a row like any other.
      chatRecord({ sessionId: "peer", title: "Started by another", parentSessionId: "parent" }),
    ],
    provenance: {},
  };

  it("hands over every Session a person could have started, and no delegated child", () => {
    expect(listableChats(rows).map((row) => row.sessionId)).toEqual(["parent", "board", "peer"]);
  });

  it("leaves the cache itself whole — the rule is about drawing, not about holding", () => {
    expect(rows.chat).toHaveLength(4);
  });

  it("answers a project whose listing has never been read", () => {
    expect(listableChats(undefined)).toEqual([]);
  });
});

/**
 * A chat's Browser Tab inventory counts its children's tabs too (VC-238), and
 * a child is a Session whose provenance names this one as parent — the same
 * fact the sidebar's mark draws from, read here rather than re-derived.
 */
describe("childSessionIds", () => {
  it("names the Sessions whose provenance points at this one, and their titles", () => {
    const rows: ProjectSessionRows = {
      terminal: [],
      chat: [
        chatRecord({ sessionId: "parent", title: "Parent" }),
        chatRecord({ sessionId: "child-a", title: "Explore the seam" }),
        chatRecord({ sessionId: "child-b", title: "Write the tests" }),
        chatRecord({ sessionId: "cousin", title: "Cousin" }),
      ],
      provenance: {
        "child-a": { kind: "session", parentSessionId: "parent", parentTitle: "Parent" },
        "child-b": { kind: "session", parentSessionId: "parent", parentTitle: "Parent" },
        cousin: { kind: "session", parentSessionId: "other", parentTitle: null },
        parent: { kind: "automation", automationRunId: null, automationName: "Nightly" },
      },
    };

    expect([...childSessionIds(rows, "parent")]).toEqual(["child-a", "child-b"]);
    expect(childSessionIds(rows, "cousin").size).toBe(0);
    expect(childSessionIds(undefined, "parent").size).toBe(0);
    expect(sessionTitleOf(rows, "child-a")).toBe("Explore the seam");
    expect(sessionTitleOf(rows, "nobody")).toBeNull();
    expect(sessionTitleOf(undefined, "child-a")).toBeNull();
  });
});

/**
 * VC-385 — the command palette used to read every tracked project's Session
 * listing itself, on every open, and keep the answer in component state. That
 * is the same question this store already answers from cache, and the fetch
 * behind it folds a project's whole roster in one blocking main-process
 * transaction (VC-388). The palette now reads the cache; this is the fold that
 * turns per-project rows back into the one global list it draws.
 */
describe("mergedProjectSessionRows", () => {
  it("merges every named project's rows into one global listing", () => {
    const byProject: Record<string, ProjectSessionRows> = {
      p1: {
        terminal: [record({ id: "t-one", projectId: "p1" })],
        chat: [chatRecord({ sessionId: "c-one", projectId: "p1" })],
        provenance: {
          "c-one": { kind: "automation", automationRunId: null, automationName: "Nightly" },
        },
      },
      p2: {
        terminal: [record({ id: "t-two", projectId: "p2" })],
        chat: [chatRecord({ sessionId: "c-two", projectId: "p2" })],
        provenance: { "t-two": { kind: "session", parentSessionId: "c-one", parentTitle: null } },
      },
      // Never asked for: a project the palette does not track contributes
      // nothing, rather than leaking into the global list.
      p3: {
        terminal: [record({ id: "t-three", projectId: "p3" })],
        chat: [chatRecord({ sessionId: "c-three", projectId: "p3" })],
        provenance: {},
      },
    };

    const merged = mergedProjectSessionRows(byProject, ["p1", "p2", "unread"]);

    expect(merged.terminal.map((row) => row.id)).toEqual(["t-one", "t-two"]);
    expect(merged.chat.map((row) => row.sessionId)).toEqual(["c-one", "c-two"]);
    expect(merged.provenance).toEqual({
      "c-one": { kind: "automation", automationRunId: null, automationName: "Nightly" },
      "t-two": { kind: "session", parentSessionId: "c-one", parentTitle: null },
    });
  });
});

/** The read door, stubbed beside the roster a refresh will seed the store from. */
function stubReadDoor(list: SessionListingRow[], impl: () => Promise<unknown>) {
  const setRead = vi.fn(impl);
  Object.assign(globalThis, {
    window: {
      api: {
        sessions: { list: vi.fn().mockResolvedValue({ ok: true, sessions: list }), setRead },
      },
    },
  });
  return setRead;
}

/**
 * Unread, as this store keeps it (VC-30): a sparse map beside the records,
 * exactly like provenance, because the store keeps the two record shapes and
 * discards the listing wrapper the fact rides on.
 */
describe("the unread axis", () => {
  it("keeps only the Sessions with something to say", async () => {
    stubList([
      {
        kind: "chat",
        record: chatRecord({ sessionId: "c1" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
        read: { unreadSince: 4_000 },
      },
      {
        kind: "chat",
        record: chatRecord({ sessionId: "c2" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
    ]);
    const store = createProjectSessionsStore();

    await store.getState().refresh("p1");

    expect(store.getState().byProject.p1?.read).toEqual({ c1: { unreadSince: 4_000 } });
    expect(sessionReadOf(store.getState().byProject.p1, "c1")).toEqual({ unreadSince: 4_000 });
    expect(sessionReadOf(store.getState().byProject.p1, "c2")).toEqual({ unreadSince: null });
    expect(sessionReadOf(undefined, "c1")).toEqual({ unreadSince: null });
    expect([...unreadSessionIds(store.getState().byProject.p1)]).toEqual(["c1"]);
    expect(unreadSessionIds(undefined).size).toBe(0);
    // A map seeded from somewhere other than a refresh (the lab, a restore)
    // may hold a resting entry rather than omitting it. The set is membership,
    // so a stored `null` stamp is not a member.
    expect(
      unreadSessionIds({
        terminal: [],
        chat: [],
        provenance: {},
        read: { c1: { unreadSince: null }, c2: { unreadSince: 7_000 } },
      }),
    ).toEqual(new Set(["c2"]));
  });

  it("folds a pushed row's unread state in, and clears it when the row rests", async () => {
    stubList([
      {
        kind: "chat",
        record: chatRecord({ sessionId: "c1" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      },
    ]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store.getState().applyActivity(
      notice({
        kind: "chat",
        record: chatRecord({ sessionId: "c1" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
        read: { unreadSince: 7_000 },
      }),
    );
    expect(store.getState().byProject.p1?.read).toEqual({ c1: { unreadSince: 7_000 } });

    // The row is the whole answer for that Session: a resting one CLEARS the
    // stamp, rather than leaving the old one standing.
    store.getState().applyActivity(
      notice({
        kind: "chat",
        record: chatRecord({ sessionId: "c1" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
      }),
    );
    expect(store.getState().byProject.p1?.read).toEqual({});
  });

  it("carries the map across a harness announce", async () => {
    stubList([
      {
        kind: "terminal",
        record: record({ id: "s1" }),
        usage: EMPTY_SESSION_USAGE_SUMMARY,
        provenance: PERSON_STARTED,
        read: { unreadSince: 4_000 },
      },
    ]);
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    store.getState().setActiveHarness("p1", "s1", "codex");

    expect(store.getState().byProject.p1?.read).toEqual({ s1: { unreadSince: 4_000 } });
  });

  it("marks a Session unread ahead of the persist and keeps it when the write sticks", async () => {
    const setRead = stubReadDoor(
      [
        {
          kind: "chat",
          record: chatRecord({ sessionId: "c1" }),
          usage: EMPTY_SESSION_USAGE_SUMMARY,
          provenance: PERSON_STARTED,
        },
      ],
      () => Promise.resolve({ ok: true, read: { unreadSince: 9_000 } }),
    );
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    await store.getState().setSessionRead("p1", "c1", true);

    expect(setRead).toHaveBeenCalledWith({ sessionId: "c1", unread: true });
    // A local stamp, replaced by main's when the push lands — the receipt's
    // clock is main's, never a window's.
    expect(store.getState().byProject.p1?.read?.["c1"]?.unreadSince).toEqual(expect.any(Number));
  });

  it("reverts and toasts when the receipt is refused", async () => {
    stubReadDoor(
      [
        {
          kind: "chat",
          record: chatRecord({ sessionId: "c1" }),
          usage: EMPTY_SESSION_USAGE_SUMMARY,
          provenance: PERSON_STARTED,
          read: { unreadSince: 4_000 },
        },
      ],
      () => Promise.resolve({ ok: false, error: "db locked" }),
    );
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    await store.getState().setSessionRead("p1", "c1", false);

    expect(store.getState().byProject.p1?.read).toEqual({ c1: { unreadSince: 4_000 } });
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't mark the session: db locked",
      expect.anything(),
    );
  });

  it("reverts and toasts when the door throws", async () => {
    stubReadDoor(
      [
        {
          kind: "chat",
          record: chatRecord({ sessionId: "c1" }),
          usage: EMPTY_SESSION_USAGE_SUMMARY,
          provenance: PERSON_STARTED,
        },
      ],
      () => Promise.reject(new Error("ipc gone")),
    );
    const store = createProjectSessionsStore();
    await store.getState().refresh("p1");

    await store.getState().setSessionRead("p1", "c1", true);

    expect(store.getState().byProject.p1?.read).toEqual({});
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't mark the session: ipc gone",
      expect.anything(),
    );
  });

  it("says nothing about a project with no baseline", async () => {
    const setRead = stubReadDoor([], () => Promise.resolve({ ok: true, read: { unreadSince: 1 } }));
    const store = createProjectSessionsStore();

    await store.getState().setSessionRead("p-unknown", "c1", true);

    // The write still goes through — the receipt is main's and this window's
    // cache is not the authority on whether the Session exists.
    expect(setRead).toHaveBeenCalledOnce();
    expect(store.getState().byProject["p-unknown"]).toBeUndefined();
  });

  it("merges every named project's unread map", () => {
    const merged = mergedProjectSessionRows(
      {
        p1: { terminal: [], chat: [], provenance: {}, read: { c1: { unreadSince: 1 } } },
        p2: { terminal: [], chat: [], provenance: {} },
      },
      ["p1", "p2"],
    );

    expect(merged.read).toEqual({ c1: { unreadSince: 1 } });
  });
});
