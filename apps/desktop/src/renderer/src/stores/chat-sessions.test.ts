import type { CommandReceipt, SessionProjection, SessionStartResult } from "@volli/shared";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  ChatCommandRequest,
  ChatSessionRpc,
  ChatSessionTransport,
  ChatStreamCursor,
} from "@renderer/chat/client";
import { getChatClient } from "@renderer/chat/registry";
import { EMPTY_TRANSCRIPT } from "@renderer/chat/transcript";
import { createChatSessionsStore } from "./chat-sessions";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const SESSION = { id: "durable-1", projectId: "p1", ticketId: "t1", title: "VC-1", createdAt: 0 };
const ACCEPTED_RECEIPT: CommandReceipt = {
  id: "receipt-accepted",
  commandId: "command-accepted",
  status: "accepted",
  acceptedAt: 0,
  result: { kind: "session.signaled", sessionId: SESSION.id },
  recordedAt: 0,
  sequence: 1,
};
const REJECTED_RECEIPT: CommandReceipt = {
  id: "receipt-rejected",
  commandId: "command-rejected",
  status: "rejected",
  code: "adapter_unavailable",
  detail: "OpenCode is unavailable",
  recordedAt: 0,
  sequence: 1,
};
const ACCEPTED = { sessionId: SESSION.id, receipt: ACCEPTED_RECEIPT };
const REFUSED = {
  sessionId: SESSION.id,
  receipt: REJECTED_RECEIPT,
};

const projection: SessionProjection = {
  session: SESSION,
  status: "open",
  commands: [],
  receipts: [],
  pendingExecutorStart: null,
  attachments: [],
  liveExecutor: null,
  attention: { active: [], primary: null },
  capabilities: [],
  interactions: { active: [], resolved: [] },
  signal: null,
  modelSelection: null,
  turnActive: false,
  lastActivityAt: SESSION.createdAt,
  bornTicketless: SESSION.ticketId === null,
};

interface CommandAnswer {
  sessionId: string;
  receipt?: CommandReceipt | null;
}

type StartAnswer = SessionStartResult;

function fakeTransport() {
  const commands: ChatCommandRequest[] = [];
  const ticketStarts: unknown[] = [];
  const projectStarts: unknown[] = [];
  const subscriptions: ChatStreamCursor[] = [];
  const state = {
    answer: (() => ACCEPTED) as (request: ChatCommandRequest) => CommandAnswer,
    startAnswer: (() => ({ ...ACCEPTED, state: "ready", throughSequence: 2 })) as () => StartAnswer,
    snapshotError: null as Error | null,
  };
  const rpc: ChatSessionRpc = {
    session: {
      snapshot: {
        query: async () => {
          if (state.snapshotError !== null) throw state.snapshotError;
          return { projection, frames: [], throughSequence: 0 };
        },
      },
      projection: { query: async () => ({ projection }) },
      subscribe: {
        subscribe: (input) => {
          subscriptions.push(input);
          return { unsubscribe: () => undefined };
        },
      },
      command: {
        mutate: async (input) => {
          commands.push(input);
          return state.answer(input);
        },
      },
      cancelInteraction: { mutate: async () => ACCEPTED },
      reconcile: { mutate: async () => ACCEPTED },
    },
  };
  let ids = 0;
  const transport: ChatSessionTransport = {
    rpc,
    scheduler: { schedule: () => () => undefined },
    newCommandId: () => `cmd-${++ids}`,
    startSession: async (input) => {
      if (input.ticketId === null) {
        projectStarts.push({
          operationId: input.operationId,
          projectId: input.projectId,
          title: input.title,
        });
      } else ticketStarts.push(input);
      return state.startAnswer();
    },
    attachSession: async () => ({ ...ACCEPTED, state: "ready", throughSequence: 2 }),
  };
  return { commands, projectStarts, subscriptions, state, ticketStarts, transport };
}

function fixture() {
  const edge = fakeTransport();
  const store = createChatSessionsStore(() => edge.transport);
  opened.push(store);
  return { ...edge, store };
}

const opened: ReturnType<typeof createChatSessionsStore>[] = [];

afterEach(() => {
  for (const store of opened) {
    for (const sessionId of Object.keys(store.getState().sessions)) {
      store.getState().closeChatSession(sessionId);
    }
  }
  opened.length = 0;
  vi.mocked(toast.error).mockClear();
});

describe("createChatSession", () => {
  it("starts a Ticket Session through the product route without runtime identity", async () => {
    const { commands, store, subscriptions, ticketStarts } = fixture();

    const sessionId = await store.getState().createChatSession({
      projectId: "p1",
      ticketId: "t1",
      title: "VC-1 · parser",
    });

    expect(sessionId).toBe(SESSION.id);
    expect(ticketStarts).toEqual([
      {
        operationId: "cmd-1",
        projectId: "p1",
        ticketId: "t1",
        title: "VC-1 · parser",
      },
    ]);
    expect(commands).toEqual([]);
    expect(subscriptions).toHaveLength(1);
    expect(store.getState().sessions[SESSION.id]).toMatchObject({
      lifecycle: "ready",
      sessionError: null,
      queue: [],
      transcript: EMPTY_TRANSCRIPT,
    });
    expect(getChatClient(SESSION.id)).toBeDefined();
  });

  it("keeps ticketless compatibility behind the private project route", async () => {
    const { commands, projectStarts, store } = fixture();

    await store.getState().createChatSession({
      projectId: "p1",
      ticketId: null,
      title: null,
    });

    expect(projectStarts).toEqual([{ operationId: "cmd-1", projectId: "p1", title: null }]);
    expect(commands).toEqual([]);
  });

  it("keeps the durable Session when the attach is refused", async () => {
    // A refused attach does not un-create the Session: the id comes back so the
    // retry addresses it, and the error sits on the Session it belongs to.
    const { state, store } = fixture();
    state.startAnswer = () => ({ ...REFUSED, state: "needs-recovery", throughSequence: 2 });

    const sessionId = await store.getState().createChatSession({
      projectId: "p1",
      ticketId: null,
      title: null,
    });

    expect(sessionId).toBe(SESSION.id);
    expect(store.getState().sessions[SESSION.id]).toMatchObject({
      lifecycle: "error",
      sessionError: "Could not start Session: OpenCode is unavailable",
    });
  });

  it("uses a product recovery message when a ticketless attach has no receipt", async () => {
    const { state, store } = fixture();
    state.startAnswer = () => ({
      sessionId: SESSION.id,
      state: "needs-recovery",
      receipt: null,
      throughSequence: 2,
    });

    await store.getState().createChatSession({ projectId: "p1", ticketId: null, title: null });

    expect(store.getState().sessions[SESSION.id]?.sessionError).toBe(
      "Could not start Session: Runtime recovery is required.",
    );
  });

  it("lets durable Ticket Attention explain a refused attach without masking recovery", async () => {
    const { state, store } = fixture();
    state.startAnswer = () => ({ ...REFUSED, state: "needs-recovery", throughSequence: 2 });

    const sessionId = await store.getState().createChatSession({
      projectId: "p1",
      ticketId: "ticket-1",
      title: null,
    });

    expect(sessionId).toBe(SESSION.id);
    expect(store.getState().sessions[SESSION.id]).toMatchObject({
      lifecycle: "ready",
      sessionError: null,
    });
  });

  it("has no Session to keep when the create itself never answered", async () => {
    const { state, store } = fixture();
    state.startAnswer = () => {
      throw new Error("socket hang up");
    };

    await expect(
      store.getState().createChatSession({ projectId: "p1", ticketId: null, title: null }),
    ).resolves.toBeNull();

    expect(store.getState().sessions).toEqual({});
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Could not start Session: socket hang up",
      expect.anything(),
    );
  });
});

describe("adoptChatSession", () => {
  it("seeds a slice and opens the stream for a Session that is already durable", async () => {
    const { store, subscriptions } = fixture();

    store.getState().adoptChatSession("durable-9");
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().sessions["durable-9"]).toMatchObject({ lifecycle: "ready" });
    expect(subscriptions).toEqual([{ sessionId: "durable-9", afterSequence: 0 }]);
  });

  it("adopts a Session it already holds only once", () => {
    const { store, subscriptions } = fixture();

    store.getState().adoptChatSession("durable-9");
    const first = store.getState().sessions["durable-9"];
    store.getState().adoptChatSession("durable-9");

    expect(store.getState().sessions["durable-9"]).toBe(first);
    expect(subscriptions).toHaveLength(0);
  });
});

describe("closeChatSession", () => {
  it("disposes the client and drops the slice", async () => {
    const { store } = fixture();
    store.getState().adoptChatSession("durable-9");

    store.getState().closeChatSession("durable-9");

    expect(store.getState().sessions["durable-9"]).toBeUndefined();
    expect(getChatClient("durable-9")).toBeUndefined();
  });

  it("is a no-op for a Session this surface never held", () => {
    const { store } = fixture();
    const before = store.getState().sessions;

    store.getState().closeChatSession("never-opened");

    expect(store.getState().sessions).toBe(before);
  });
});

describe("writes addressed to a Session that is gone", () => {
  it("land nowhere rather than resurrecting a slice", () => {
    const { store } = fixture();

    store.getState().applyStream("ghost", [], []);
    store.getState().setProjection("ghost", projection);
    store.getState().attaching("ghost");
    store.getState().delivered("ghost");
    store.getState().settle("ghost", "gone");
    store.getState().enqueue("ghost", { id: "q1", text: "hello" });
    store.getState().dequeue("ghost", "q1");
    store.getState().retitle("ghost", "Parser");

    expect(store.getState().sessions).toEqual({});
  });
});

describe("retitle", () => {
  function seeded() {
    const edge = fixture();
    edge.store.getState().adoptChatSession("durable-9");
    return { ...edge, slice: () => edge.store.getState().sessions["durable-9"]! };
  }

  it("moves the title the surface reads, ahead of the stream", () => {
    const { store, slice } = seeded();
    store.getState().setProjection("durable-9", projection);

    store.getState().retitle("durable-9", "Parser");

    expect(slice().projection?.session).toMatchObject({ id: SESSION.id, title: "Parser" });
  });

  /** No projection is no title to correct — inventing one would put a Session
   * on screen that nothing has described yet. */
  it("keeps its identity for a Session the stream has not described", () => {
    const { store, slice } = seeded();
    const before = slice();

    store.getState().retitle("durable-9", "Parser");

    expect(slice()).toBe(before);
    expect(slice().projection).toBeNull();
  });
});

describe("the in-flight flag", () => {
  it("names the owners with a create in flight, and forgets them once cleared", () => {
    const { store } = fixture();

    store.getState().setStarting("t1", true);
    expect(store.getState().starting).toEqual({ t1: true });

    store.getState().setStarting("t2", true);
    store.getState().setStarting("t1", false);

    expect(store.getState().starting).toEqual({ t2: true });
  });

  it("keeps its identity when the flag already says what it was told", () => {
    const { store } = fixture();
    const empty = store.getState().starting;

    store.getState().setStarting("t1", false);
    expect(store.getState().starting).toBe(empty);

    store.getState().setStarting("t1", true);
    const raised = store.getState().starting;
    store.getState().setStarting("t1", true);

    expect(store.getState().starting).toBe(raised);
  });
});

describe("the slice", () => {
  function seeded() {
    const edge = fixture();
    edge.store.getState().adoptChatSession("durable-9");
    return { ...edge, slice: () => edge.store.getState().sessions["durable-9"]! };
  }

  it("keeps its identity for a batch that folded to nothing", () => {
    const { store, slice } = seeded();
    const before = slice();

    store.getState().applyStream("durable-9", [], []);

    expect(slice()).toBe(before);
  });

  it("latches starting until a command settles it", () => {
    const { store, slice } = seeded();

    store.getState().attaching("durable-9");
    store.getState().setProjection("durable-9", projection);
    expect(slice().lifecycle).toBe("starting");

    store.getState().settle("durable-9", null);

    expect(slice().lifecycle).toBe("ready");
  });

  it("latches an error until a command clears it", () => {
    const { store, slice } = seeded();

    store.getState().settle("durable-9", "Lost the Session stream: socket hang up");
    store.getState().setProjection("durable-9", projection);
    expect(slice()).toMatchObject({
      lifecycle: "error",
      sessionError: "Lost the Session stream: socket hang up",
    });

    store.getState().settle("durable-9", null);

    expect(slice()).toMatchObject({ lifecycle: "ready", sessionError: null });
  });

  it("settles a cleared failure onto whatever the stream is already saying", () => {
    const { store, slice } = seeded();
    store.getState().setProjection("durable-9", {
      ...projection,
      liveExecutor: { id: "attach-1" },
    });
    store.getState().applyStream(
      "durable-9",
      [
        {
          sessionId: SESSION.id,
          sequence: 1,
          event: { payload: { kind: "turn.started" } } as never,
          transcript: null,
        },
      ],
      [],
    );

    store.getState().settle("durable-9", "broke");
    store.getState().settle("durable-9", null);

    expect(slice().lifecycle).toBe("working");
  });

  it("marks a delivered message working without waiting for the turn", () => {
    const { store, slice } = seeded();

    store.getState().delivered("durable-9");

    expect(slice()).toMatchObject({ lifecycle: "working", sessionError: null });
  });
});

describe("the queue", () => {
  function seeded() {
    const edge = fixture();
    edge.store.getState().adoptChatSession("durable-9");
    return { ...edge, slice: () => edge.store.getState().sessions["durable-9"]! };
  }

  it("holds what was typed, in the order it was typed", () => {
    const { store, slice } = seeded();

    store.getState().enqueue("durable-9", { id: "q1", text: " first " });
    store.getState().enqueue("durable-9", { id: "q2", text: "second" });

    expect(slice().queue).toEqual([
      { id: "q1", text: "first" },
      { id: "q2", text: "second" },
    ]);
  });

  it("never takes blank text, and never republishes the slice for it", () => {
    const { store, slice } = seeded();
    const before = slice();

    store.getState().enqueue("durable-9", { id: "q1", text: "   " });

    expect(slice()).toBe(before);
  });

  it("takes one entry back out", () => {
    const { store, slice } = seeded();
    store.getState().enqueue("durable-9", { id: "q1", text: "first" });
    store.getState().enqueue("durable-9", { id: "q2", text: "second" });

    store.getState().dequeue("durable-9", "q1");

    expect(slice().queue).toEqual([{ id: "q2", text: "second" }]);
  });

  it("keeps its identity when the entry to drop was never there", () => {
    const { store, slice } = seeded();
    store.getState().enqueue("durable-9", { id: "q1", text: "first" });
    const before = slice();

    store.getState().dequeue("durable-9", "q9");

    expect(slice()).toBe(before);
  });
});

describe("open chat tabs", () => {
  it("records a ticket's tabs in the order they were opened, once each", () => {
    const { store } = fixture();

    store.getState().openChatTab("t1", "durable-1");
    store.getState().openChatTab("t1", "durable-2");
    store.getState().openChatTab("t1", "durable-1");

    expect(store.getState().openTabs).toEqual({ t1: ["durable-1", "durable-2"] });
  });

  it("keeps its identity when the tab is already open", () => {
    const { store } = fixture();
    store.getState().openChatTab("t1", "durable-1");
    const before = store.getState().openTabs;

    store.getState().openChatTab("t1", "durable-1");

    expect(store.getState().openTabs).toBe(before);
  });

  it("keeps one ticket's tabs out of another's", () => {
    const { store } = fixture();

    store.getState().openChatTab("t1", "durable-1");
    store.getState().openChatTab("t2", "durable-2");

    expect(store.getState().openTabs).toEqual({ t1: ["durable-1"], t2: ["durable-2"] });
  });

  /** The single-owner invariant: a session's tab lives under exactly one
   * owner, so opening it under a new one forgets the old. */
  it("moves the tab to a new owner, stripping it from the old one", () => {
    const { store } = fixture();
    store.getState().openChatTab("t1", "durable-1");

    store.getState().openChatTab("p1", "durable-1");

    expect(store.getState().openTabs).toEqual({ p1: ["durable-1"] });
  });

  it("keeps the old owner's other tabs when only one of them moves", () => {
    const { store } = fixture();
    store.getState().openChatTab("t1", "durable-1");
    store.getState().openChatTab("t1", "durable-2");

    store.getState().openChatTab("p1", "durable-1");

    expect(store.getState().openTabs).toEqual({ t1: ["durable-2"], p1: ["durable-1"] });
  });

  it("repairs a broken invariant by dropping a duplicate elsewhere, even when the owner already has it", () => {
    const { store } = fixture();
    store.setState({ openTabs: { t1: ["durable-1"], p1: ["durable-1"] } });

    store.getState().openChatTab("p1", "durable-1");

    expect(store.getState().openTabs).toEqual({ p1: ["durable-1"] });
  });

  /** Closing the view retires the client; the Session itself is untouched. */
  it("drops the resident Session with the tab that held it", () => {
    const { store } = fixture();
    store.getState().adoptChatSession("durable-1");
    store.getState().openChatTab("t1", "durable-1");

    store.getState().closeChatTab("t1", "durable-1");

    expect(store.getState().openTabs).toEqual({});
    expect(store.getState().sessions["durable-1"]).toBeUndefined();
    expect(getChatClient("durable-1")).toBeUndefined();
  });

  it("leaves the ticket's other tabs where they were", () => {
    const { store } = fixture();
    store.getState().openChatTab("t1", "durable-1");
    store.getState().openChatTab("t1", "durable-2");

    store.getState().closeChatTab("t1", "durable-1");

    expect(store.getState().openTabs).toEqual({ t1: ["durable-2"] });
  });

  it("clears a rehomed tab's temporary ticket origin when the tab closes", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["durable-1"] },
      rehomedTicketBySession: { "durable-1": "t1" },
    });

    store.getState().closeChatTab("p1", "durable-1");

    expect(store.getState().openTabs).toEqual({});
    expect(store.getState().rehomedTicketBySession).toEqual({});
  });

  it("is a no-op for a tab that was never open", () => {
    const { store } = fixture();
    store.getState().openChatTab("t1", "durable-1");
    const before = store.getState().openTabs;

    store.getState().closeChatTab("t1", "durable-9");
    store.getState().closeChatTab("t9", "durable-1");

    expect(store.getState().openTabs).toBe(before);
  });

  /** The tab decides: a close aimed at a ticket that holds none must not retire
   * the client the tab that DOES hold it is still drawing from. */
  it("keeps the Session alive when the close named a ticket without its tab", () => {
    const { store } = fixture();
    store.getState().adoptChatSession("durable-1");
    store.getState().openChatTab("t1", "durable-1");

    store.getState().closeChatTab("t9", "durable-1");

    expect(store.getState().sessions["durable-1"]).toBeDefined();
    expect(getChatClient("durable-1")).toBeDefined();
  });
});

describe("reconcileTicketChatTabs", () => {
  it("moves departed ticket tabs onto the project and records their exact ticket origins", () => {
    const { store } = fixture();
    // No resident slices: ownership reconciliation cannot depend on an
    // arriving projection, which is legitimately null while a chat attaches.
    store.setState({
      openTabs: {
        p1: ["ticketless"],
        t1: ["durable-1", "durable-2"],
        t2: ["durable-3"],
      },
    });

    store.getState().reconcileTicketChatTabs("p1", ["t1", "t2"], []);

    expect(store.getState().openTabs).toEqual({
      p1: ["ticketless", "durable-1", "durable-2", "durable-3"],
    });
    expect(store.getState().rehomedTicketBySession).toEqual({
      "durable-1": "t1",
      "durable-2": "t1",
      "durable-3": "t2",
    });
  });

  it("creates the project tab strip when a departed ticket is its first tab owner", () => {
    const { store } = fixture();
    store.setState({ openTabs: { t1: ["durable-1"] } });

    store.getState().reconcileTicketChatTabs("p1", ["t1"], []);

    expect(store.getState().openTabs).toEqual({ p1: ["durable-1"] });
    expect(store.getState().rehomedTicketBySession).toEqual({ "durable-1": "t1" });
  });

  it("returns only the matching ticket's tabs, preserving unrelated project order and single ownership", () => {
    const { store } = fixture();
    store.setState({
      openTabs: {
        p1: ["ticketless", "from-t1", "from-t2"],
        t2: ["already-open"],
      },
      rehomedTicketBySession: { "from-t1": "t1", "from-t2": "t2" },
    });

    store.getState().reconcileTicketChatTabs("p1", [], ["t1"]);

    expect(store.getState().openTabs).toEqual({
      p1: ["ticketless", "from-t2"],
      t2: ["already-open"],
      t1: ["from-t1"],
    });
    expect(store.getState().rehomedTicketBySession).toEqual({ "from-t2": "t2" });
  });

  it("deduplicates a stale project copy as it restores the tab to its stamped ticket", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["ticketless", "returning"], t1: ["already-open", "returning"] },
      rehomedTicketBySession: { returning: "t1" },
    });

    store.getState().reconcileTicketChatTabs("p1", [], ["t1"]);

    expect(store.getState().openTabs).toEqual({
      p1: ["ticketless"],
      t1: ["already-open", "returning"],
    });
    expect(store.getState().rehomedTicketBySession).toEqual({});
  });

  it("removes an empty project tab owner when its last rehomed tab returns", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["returning"] },
      rehomedTicketBySession: { returning: "t1" },
    });

    store.getState().reconcileTicketChatTabs("p1", [], ["t1"]);

    expect(store.getState().openTabs).toEqual({ t1: ["returning"] });
    expect(store.getState().rehomedTicketBySession).toEqual({});
  });

  it("deduplicates an already-stamped departure without replacing its provenance", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["ticketless", "shared"], t1: ["shared", "from-t1"] },
      rehomedTicketBySession: { shared: "t1", "from-t1": "t1" },
    });
    const provenance = store.getState().rehomedTicketBySession;

    store.getState().reconcileTicketChatTabs("p1", ["t1"], []);

    expect(store.getState().openTabs).toEqual({ p1: ["ticketless", "shared", "from-t1"] });
    expect(store.getState().rehomedTicketBySession).toBe(provenance);
  });

  it("restores each returned ticket independently after a multi-ticket departure", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["ticketless"], t1: ["durable-1", "durable-2"], t2: ["durable-3"] },
    });

    store.getState().reconcileTicketChatTabs("p1", ["t1", "t2"], []);
    store.getState().reconcileTicketChatTabs("p1", [], ["t2"]);

    expect(store.getState().openTabs).toEqual({
      p1: ["ticketless", "durable-1", "durable-2"],
      t2: ["durable-3"],
    });
    expect(store.getState().rehomedTicketBySession).toEqual({
      "durable-1": "t1",
      "durable-2": "t1",
    });

    store.getState().reconcileTicketChatTabs("p1", [], ["t1"]);

    expect(store.getState().openTabs).toEqual({
      p1: ["ticketless"],
      t2: ["durable-3"],
      t1: ["durable-1", "durable-2"],
    });
    expect(store.getState().rehomedTicketBySession).toEqual({});
  });

  it("is a no-op (unchanged identity) when no departure or return has a matching tab", () => {
    const { store } = fixture();
    store.setState({ openTabs: { p1: ["durable-1"] } });
    const before = store.getState().openTabs;

    store.getState().reconcileTicketChatTabs("p1", ["t1", "t2"], ["t3"]);

    expect(store.getState().openTabs).toBe(before);
  });
});

describe("clearRehomedTicketProvenance", () => {
  it("clears only the deleted ticket's transient origins without touching tabs or clients", () => {
    const { store } = fixture();
    store.getState().adoptChatSession("from-t1");
    store.setState({
      openTabs: { p1: ["from-t1", "from-t2"] },
      rehomedTicketBySession: { "from-t1": "t1", "from-t2": "t2" },
    });
    const openTabs = store.getState().openTabs;
    const sessions = store.getState().sessions;
    const client = getChatClient("from-t1");

    store.getState().clearRehomedTicketProvenance("t1");

    expect(store.getState().openTabs).toBe(openTabs);
    expect(store.getState().sessions).toBe(sessions);
    expect(getChatClient("from-t1")).toBe(client);
    expect(store.getState().rehomedTicketBySession).toEqual({ "from-t2": "t2" });
  });

  it("is a no-op when no tab was rehomed from the ticket", () => {
    const { store } = fixture();
    store.setState({ rehomedTicketBySession: { "from-t2": "t2" } });
    const before = store.getState().rehomedTicketBySession;

    store.getState().clearRehomedTicketProvenance("t1");

    expect(store.getState().rehomedTicketBySession).toBe(before);
  });
});

describe("dropChatTabs", () => {
  it("deletes every named owner's entry", () => {
    const { store } = fixture();
    store.setState({
      openTabs: { p1: ["durable-1"], t1: ["durable-2"], t2: ["durable-3"] },
      rehomedTicketBySession: { "durable-1": "t1", "durable-2": "t1", "durable-3": "t2" },
    });

    store.getState().dropChatTabs(["p1", "t1"]);

    expect(store.getState().openTabs).toEqual({ t2: ["durable-3"] });
    expect(store.getState().rehomedTicketBySession).toEqual({ "durable-3": "t2" });
  });

  it("retires resident clients as it drops their project owner tabs", () => {
    const { store } = fixture();
    store.getState().adoptChatSession("durable-1");
    store.setState({
      openTabs: { p1: ["durable-1"] },
      rehomedTicketBySession: { "durable-1": "t1" },
    });

    store.getState().dropChatTabs(["p1", "missing-owner"]);

    expect(store.getState().sessions["durable-1"]).toBeUndefined();
    expect(getChatClient("durable-1")).toBeUndefined();
    expect(store.getState().openTabs).toEqual({});
    expect(store.getState().rehomedTicketBySession).toEqual({});
  });

  it("is a no-op (unchanged identity) when none of the ids have an entry", () => {
    const { store } = fixture();
    store.setState({ openTabs: { t2: ["durable-3"] } });
    const before = store.getState().openTabs;

    store.getState().dropChatTabs(["p1", "t1"]);

    expect(store.getState().openTabs).toBe(before);
  });
});
