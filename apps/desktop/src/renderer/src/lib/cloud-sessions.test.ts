import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fakeCloud } from "@renderer/stores/cloud-board/fake-cloud.test-support";
import type { CloudSession } from "./cloud-client";
import { EMPTY_SESSION_USAGE_SUMMARY } from "@volli/shared";

const mocks = await vi.hoisted(async () => {
  const { createStore } = await import("zustand/vanilla");
  const rebind = vi.fn();
  return {
    projects: createStore(() => ({ projects: [] as { id: string }[] })),
    rows: createStore(() => ({ byProject: {}, listingState: {} })),
    tickets: createStore(() => ({
      byTicket: {} as Record<string, unknown[]>,
      listingState: {},
      listingError: {},
    })),
    chat: { getState: () => ({ rebindChatSessions: rebind }) },
    follow: null as ((session: CloudSession | null) => void) | null,
    stop: vi.fn(),
  };
});
vi.mock("./cloud-client", () => ({
  followCloudSession: (fn: (session: CloudSession | null) => void) => {
    mocks.follow = fn;
    return mocks.stop;
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
    const pending2 = cloudSessionReader("other").list({ projectId: "other" });
    fake.fail("sessions:list", { ...args, projectId: "other" }, new Error("unavailable"));
    expect(await pending2).toEqual({ ok: false, error: "unavailable" });
  });
});
