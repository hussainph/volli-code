import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeCloud } from "@renderer/stores/cloud-board/fake-cloud.test-support";
import type { CloudSession } from "./cloud-client";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";

const mocks = await vi.hoisted(async () => {
  const { createStore } = await import("zustand/vanilla");
  const rebind = vi.fn();
  const chats = {
    rebindChatSessions: rebind,
    openTabs: {} as Record<string, string[]>,
    adoptChatSession: vi.fn(),
  };
  return {
    projects: createStore(() => ({ projects: [] as { id: string }[] })),
    rows: createStore(() => ({ byProject: {}, listingState: {} })),
    tickets: createStore(() => ({
      byTicket: {} as Record<string, unknown[]>,
      listingState: {},
      listingError: {},
    })),
    chat: { getState: () => chats },
    follow: null as ((session: CloudSession | null) => void) | null,
    followers: new Set<(session: CloudSession | null) => void>(),
    stop: vi.fn(),
  };
});
vi.mock("./cloud-client", () => ({
  followCloudSession: (fn: (session: CloudSession | null) => void) => {
    mocks.followers.add(fn);
    mocks.follow = (session) => {
      for (const listener of mocks.followers) listener(session);
    };
    return () => {
      mocks.followers.delete(fn);
      mocks.stop();
    };
  },
}));
vi.mock("@renderer/stores/projects", () => ({ useProjectsStore: mocks.projects }));
vi.mock("@renderer/stores/project-sessions", () => ({ useProjectSessionsStore: mocks.rows }));
vi.mock("@renderer/stores/ticket-session-records", () => ({
  useTicketSessionRecordsStore: mocks.tickets,
}));
vi.mock("@renderer/stores/chat-sessions", () => ({ useChatSessionsStore: mocks.chat }));
vi.mock("./session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({
    runners: { subscribeThisMac: { subscribe: () => ({ unsubscribe: () => {} }) } },
  }),
}));
import { useCloudPlacesStore } from "./cloud-places";
import { bindCloudSessions, cloudSessionReader } from "./cloud-sessions";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  mocks.projects.setState({ projects: [] });
  mocks.rows.setState({ byProject: {}, listingState: {} });
  mocks.tickets.setState({ byTicket: {}, listingState: {}, listingError: {} });
  mocks.chat.getState().openTabs = {};
  mocks.chat.getState().adoptChatSession.mockClear();
  vi.restoreAllMocks();
});
const args = { projectId: "p", paginationOpts: { cursor: null, numItems: 100 } };
const row = {
  id: "s",
  projectId: "p",
  ticketId: "t",
  role: "ticket",
  parentSessionId: null,
  ownerUserId: "u",
  origin: { kind: "session", sessionId: "parent" },
  title: "Cloud",
  visibility: "shared",
  status: "open",
  turnActive: false,
  lastTurnOutcome: null,
  signal: null,
  stopped: null,
  needsUser: true,
  attentionCount: 1,
  placeRunnerId: "r",
  model: null,
  usageTotals: EMPTY_SESSION_USAGE_SUMMARY,
  listing: { activity: "waiting", waitingOn: "question", live: false, bornTicketless: false },
  createdAt: 1,
  lastActivityAt: 2,
};

describe("cloud Session binding", () => {
  it("re-adopts a kept durable tab only when its returned Workspace lists it", () => {
    const fake = fakeCloud();
    mocks.projects.setState({ projects: [{ id: "p" }] });
    stop = bindCloudSessions();
    mocks.follow!(fake.session);
    mocks.chat.getState().openTabs = { p: ["s", "not-authorized"] };
    fake.answer("sessions:list", args, { page: [row], isDone: true, continueCursor: "end" });
    expect(mocks.chat.getState().adoptChatSession).toHaveBeenCalledExactlyOnceWith("s", "p");
  });
  it("does not reopen a departed project or return its pending listing into a new scope", async () => {
    const fake = fakeCloud();
    mocks.projects.setState({ projects: [{ id: "p" }] });
    stop = bindCloudSessions();
    mocks.follow!(fake.session);
    const reader = cloudSessionReader("p");
    const pending = reader.list({ projectId: "p" });
    mocks.projects.setState({ projects: [] });
    expect(await pending).toEqual({ ok: false, error: "The Workspace changed." });
    expect(await reader.list({ projectId: "p" })).toEqual({
      ok: false,
      error: "The project is not in this Workspace.",
    });
    expect(fake.watchers("sessions:list", args)).toBe(0);
    mocks.projects.setState({ projects: [{ id: "p" }] });
    const replacing = reader.list({ projectId: "p" });
    mocks.follow!(null);
    expect(await replacing).toEqual({ ok: false, error: "The Workspace changed." });
  });
  it("fails closed before connection and for a ticket whose project is unknown", async () => {
    expect(await cloudSessionReader("p").list({ projectId: "p" })).toMatchObject({ ok: false });
    const fake = fakeCloud();
    stop = bindCloudSessions();
    mocks.follow!(fake.session);
    expect(await cloudSessionReader(null).listForTicket({ ticketId: "unknown" })).toMatchObject({
      ok: false,
    });
  });

  it("paints the same live rows into sidebar and ticket caches, then removes them on close", async () => {
    const fake = fakeCloud();
    mocks.projects.setState({ projects: [{ id: "p" }] });
    stop = bindCloudSessions();
    mocks.follow!(fake.session);
    const pending = cloudSessionReader("p").list({ projectId: "p" });
    fake.answer("sessions:list", args, { page: [row], isDone: true, continueCursor: "end" });
    expect(await pending).toMatchObject({ ok: true, sessions: [{ record: { sessionId: "s" } }] });
    expect(mocks.rows.getState().byProject).toMatchObject({
      p: {
        chat: [{ sessionId: "s", activity: "waiting" }],
        provenance: { s: { kind: "session" } },
      },
    });
    expect(mocks.tickets.getState().byTicket.t).toHaveLength(1);
    // The Place the listing shape drops is kept for "Waiting for <Mac>".
    expect(useCloudPlacesStore.getState().sessions).toEqual({
      s: { placeRunnerId: "r", turnActive: false },
    });
    expect(await cloudSessionReader("p").listForTicket({ ticketId: "t" })).toMatchObject({
      ok: true,
      sessions: [{ record: { sessionId: "s" } }],
    });
    expect(await cloudSessionReader("p").listForTicket({ ticketId: "empty" })).toEqual({
      ok: true,
      sessions: [],
    });
    fake.answer("sessions:list", args, {
      page: [{ ...row, ticketId: null, origin: { kind: "user" } }],
      isDone: true,
      continueCursor: "end",
    });
    expect(mocks.tickets.getState().byTicket.t).toEqual([]);
    mocks.projects.setState({ projects: [] });
    expect(fake.watchers("sessions:list", args)).toBe(0);
    expect(mocks.rows.getState().byProject).toMatchObject({ p: { chat: [] } });
    expect(useCloudPlacesStore.getState().sessions).toEqual({});
    mocks.projects.setState({ projects: [{ id: "p" }] });
    mocks.follow!(null);
    expect(mocks.tickets.getState().byTicket.t).toEqual([]);
    mocks.follow!(fake.session);
    stop();
    stop = null;
    expect(mocks.stop).toHaveBeenCalled();
    expect(fake.watchers("sessions:list", args)).toBe(0);
  });

  it("reports a failed Place read and removes its stale runner label", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeCloud();
    mocks.projects.setState({ projects: [{ id: "p" }] });
    stop = bindCloudSessions();
    mocks.follow!(fake.session);
    fake.answer("sessions:list", args, { page: [row], isDone: true, continueCursor: "end" });
    const placeArgs = { sessionIds: ["s"] };
    fake.answer("runners:places", placeArgs, [
      {
        sessionId: "s",
        place: {
          id: "r",
          name: "hp-mac",
          kind: "mac",
          status: "offline",
          statusChangedAt: 0,
          statusReason: null,
          owned: true,
        },
      },
    ]);
    expect(useCloudPlacesStore.getState().runners.r?.name).toBe("hp-mac");
    const failure = new Error("place unavailable");
    fake.fail("runners:places", placeArgs, failure);
    expect(warn).toHaveBeenCalledWith("[volli] cloud Session places:", failure);
    expect(useCloudPlacesStore.getState().runners).toEqual({});
  });

  it("reports failed cloud reads without ever using local IPC", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeCloud();
    mocks.projects.setState({ projects: [{ id: "p" }] });
    stop = bindCloudSessions();
    mocks.follow!(fake.session);
    const pending = cloudSessionReader("p").list({ projectId: "p" });
    fake.fail("sessions:list", args, "offline");
    expect(await pending).toEqual({ ok: false, error: "offline" });
    expect(warn).toHaveBeenCalled();
    mocks.projects.setState({ projects: [{ id: "p" }, { id: "other" }] });
    const pending2 = cloudSessionReader("other").list({ projectId: "other" });
    fake.fail("sessions:list", { ...args, projectId: "other" }, new Error("unavailable"));
    expect(await pending2).toEqual({ ok: false, error: "unavailable" });
  });
});
