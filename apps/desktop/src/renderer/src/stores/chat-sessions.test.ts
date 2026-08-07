import type { SessionProjection } from "@volli/shared";
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
const ACCEPTED = { sessionId: SESSION.id, receipt: { status: "accepted" } };
const REFUSED = {
  sessionId: SESSION.id,
  receipt: { status: "rejected", code: "adapter_unavailable", detail: "OpenCode is unavailable" },
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
  turnActive: false,
  lastActivityAt: SESSION.createdAt,
  bornTicketless: SESSION.ticketId === null,
};

interface CommandAnswer {
  sessionId: string;
  receipt?: unknown;
}

function fakeTransport() {
  const commands: ChatCommandRequest[] = [];
  const subscriptions: ChatStreamCursor[] = [];
  const state = {
    answer: (() => ACCEPTED) as (request: ChatCommandRequest) => CommandAnswer,
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
  };
  return { commands, subscriptions, state, transport };
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
  it("persists the intent, seeds the slice and attaches the default executor", async () => {
    const { commands, store, subscriptions } = fixture();

    const sessionId = await store.getState().createChatSession({
      projectId: "p1",
      ticketId: "t1",
      title: "VC-1 · parser",
    });

    expect(sessionId).toBe(SESSION.id);
    expect(commands.map((request) => request.command)).toEqual([
      { kind: "session.create", projectId: "p1", ticketId: "t1", title: "VC-1 · parser" },
      {
        kind: "adapter.attach",
        adapterId: "opencode",
        profileId: "native",
        continuity: "fresh",
      },
    ]);
    expect(commands[0]!.sessionId).toBeUndefined();
    expect(subscriptions).toHaveLength(1);
    expect(store.getState().sessions[SESSION.id]).toMatchObject({
      lifecycle: "ready",
      sessionError: null,
      queue: [],
      transcript: EMPTY_TRANSCRIPT,
    });
    expect(getChatClient(SESSION.id)).toBeDefined();
  });

  it("attaches the executor it was given rather than the default", async () => {
    const { commands, store } = fixture();

    await store.getState().createChatSession({
      projectId: "p1",
      ticketId: null,
      title: null,
      executor: { adapterId: "claude-code", profileId: "acp" },
    });

    expect(commands[1]!.command).toMatchObject({ adapterId: "claude-code", profileId: "acp" });
  });

  it("keeps the durable Session when the attach is refused", async () => {
    // A refused attach does not un-create the Session: the id comes back so the
    // retry addresses it, and the error sits on the Session it belongs to.
    const { state, store } = fixture();
    state.answer = (request) => (request.command.kind === "adapter.attach" ? REFUSED : ACCEPTED);

    const sessionId = await store.getState().createChatSession({
      projectId: "p1",
      ticketId: null,
      title: null,
    });

    expect(sessionId).toBe(SESSION.id);
    expect(store.getState().sessions[SESSION.id]).toMatchObject({
      lifecycle: "error",
      sessionError: "Could not start OpenCode: OpenCode is unavailable",
    });
  });

  it("has no Session to keep when the create itself never answered", async () => {
    const { state, store } = fixture();
    state.answer = () => {
      throw new Error("socket hang up");
    };

    await expect(
      store.getState().createChatSession({ projectId: "p1", ticketId: null, title: null }),
    ).resolves.toBeNull();

    expect(store.getState().sessions).toEqual({});
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Could not start OpenCode: socket hang up",
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

  it("remembers a non-default executor for the retry that may follow", async () => {
    const { commands, store } = fixture();

    store.getState().adoptChatSession("durable-9", { adapterId: "codex", profileId: "acp" });
    await getChatClient("durable-9")!.attach();

    expect(commands[0]!.command).toMatchObject({ adapterId: "codex", profileId: "acp" });
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
    store.getState().setSelection("ghost", {
      providerId: "p",
      modelId: "m",
      variant: "",
      agent: "",
    });
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
      liveExecutor: {
        id: "attach-1",
        sessionId: SESSION.id,
        adapterId: "opencode",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: null,
        status: "open",
        openedAt: 0,
        closedAt: null,
        outcome: null,
        failure: null,
      },
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

  it("keeps a selection the composer picked", () => {
    const { store, slice } = seeded();
    const selection = { providerId: "anthropic", modelId: "claude", variant: "", agent: "build" };

    store.getState().setSelection("durable-9", selection);

    expect(slice().selection).toBe(selection);
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
