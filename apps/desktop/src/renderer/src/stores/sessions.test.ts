import { describe, expect, it } from "vite-plus/test";
import {
  createSessionsStore,
  findSessionPane,
  findTabBySessionId,
  scratchScope,
  sessionActivityState,
  sessionPanes,
  ticketScope,
} from "./sessions";

const P = scratchScope("p");

describe("sessionActivityState", () => {
  it("is exited whenever the shell has exited, regardless of recency", () => {
    expect(sessionActivityState(1000, true, 1000)).toBe("exited");
    expect(sessionActivityState(null, true, 5000)).toBe("exited");
  });

  it("is working when output landed within the 10s window", () => {
    expect(sessionActivityState(1000, false, 1000)).toBe("working");
    expect(sessionActivityState(1000, false, 11_000)).toBe("working"); // exactly 10s
  });

  it("is idle when live but quiet past the window, or when there was no output", () => {
    expect(sessionActivityState(1000, false, 11_001)).toBe("idle");
    expect(sessionActivityState(null, false, 50_000)).toBe("idle");
  });
});

describe("addSession", () => {
  it("appends a scratch tab titled from the counter, stamps its scope, and activates it", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");

    const container = store.getState().byOwner["p"];
    expect(container?.tabs).toEqual([
      {
        sessionId: "s1",
        title: "Terminal 1",
        scope: { kind: "scratch", projectId: "p" },
        layout: { kind: "pane", sessionId: "s1", exitCode: null },
        activePaneId: "s1",
      },
    ]);
    expect(container?.activeSessionId).toBe("s1");
    expect(container?.nextTabNumber).toBe(2);
    expect(store.getState().sessionOwner["s1"]).toBe("p");
  });

  it("uses the supplied title (main's Session N) for ticket sessions", () => {
    const store = createSessionsStore();
    store.getState().addSession(ticketScope("proj", "t1"), "s1", "Session 1");

    const container = store.getState().byOwner["t1"];
    expect(container?.tabs[0]?.title).toBe("Session 1");
    expect(container?.tabs[0]?.scope).toEqual({
      kind: "ticket",
      projectId: "proj",
      ticketId: "t1",
    });
    expect(store.getState().sessionOwner["s1"]).toBe("t1");
  });

  it("keeps insertion order, numbers scratch titles monotonically, and activates each", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSession(P, "s2");
    store.getState().addSession(P, "s3");

    const container = store.getState().byOwner["p"];
    expect(container?.tabs.map((t) => t.title)).toEqual(["Terminal 1", "Terminal 2", "Terminal 3"]);
    expect(container?.activeSessionId).toBe("s3");
  });

  it("never reuses a closed tab's number — no duplicate titles", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSession(P, "s2");
    store.getState().closeSession("p", "s1");
    store.getState().addSession(P, "s3");

    expect(store.getState().byOwner["p"]?.tabs.map((t) => t.title)).toEqual([
      "Terminal 2",
      "Terminal 3",
    ]);
  });

  it("scopes sessions and numbering per owner", () => {
    const store = createSessionsStore();
    store.getState().addSession(scratchScope("a"), "a1");
    store.getState().addSession(scratchScope("b"), "b1");

    expect(store.getState().byOwner["a"]?.tabs.map((t) => t.sessionId)).toEqual(["a1"]);
    expect(store.getState().byOwner["b"]?.tabs[0]?.title).toBe("Terminal 1");
  });

  it("ignores a duplicate sessionId in the same owner", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    const before = store.getState().byOwner;
    store.getState().addSession(P, "s1");

    expect(store.getState().byOwner).toBe(before);
  });
});

describe("setActiveSession", () => {
  it("activates an existing session", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSession(P, "s2");

    store.getState().setActiveSession("p", "s1");
    expect(store.getState().byOwner["p"]?.activeSessionId).toBe("s1");
  });

  it("is a no-op for an unknown owner or session", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    const before = store.getState().byOwner;

    store.getState().setActiveSession("missing", "s1");
    store.getState().setActiveSession("p", "nope");
    expect(store.getState().byOwner).toBe(before);
  });
});

describe("split panes", () => {
  it("inserts a fresh session leaf beside the focused pane, activates it, and indexes it", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");

    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    const tab = store.getState().byOwner["p"]?.tabs[0];
    expect(tab?.activePaneId).toBe("s2");
    expect(tab && sessionPanes(tab.layout).map((pane) => pane.sessionId)).toEqual(["s1", "s2"]);
    expect(tab?.layout).toMatchObject({
      kind: "split",
      id: "s2",
      direction: "vertical",
      ratio: 0.5,
    });
    expect(store.getState().sessionOwner["s2"]).toBe("p");
  });

  it("supports nested splits without duplicating or replacing sibling leaves", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    const tab = store.getState().byOwner["p"]!.tabs[0]!;
    expect(sessionPanes(tab.layout).map((pane) => pane.sessionId)).toEqual(["s1", "s3", "s2"]);
  });

  it("works for a ticket tab too — ticket sessions gain the full split machinery", () => {
    const store = createSessionsStore();
    store.getState().addSession(ticketScope("proj", "t1"), "s1", "Session 1");
    store.getState().addSplit("t1", "s1", "s1", "s2", "vertical");

    const tab = store.getState().byOwner["t1"]!.tabs[0]!;
    expect(sessionPanes(tab.layout).map((pane) => pane.sessionId)).toEqual(["s1", "s2"]);
    expect(store.getState().sessionOwner["s2"]).toBe("t1");
  });

  it("ignores unknown owners, tabs, source panes, and duplicate pane ids", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    const before = store.getState().byOwner;

    store.getState().addSplit("missing", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "missing", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "missing", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s1", "vertical");

    expect(store.getState().byOwner).toBe(before);
  });

  it("closes one leaf, collapses its parent split, focuses a neighbor, and drops its index", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    store.getState().closePane("p", "s1", "s1");

    const tab = store.getState().byOwner["p"]!.tabs[0]!;
    expect(tab.layout).toEqual({ kind: "pane", sessionId: "s2", exitCode: null });
    expect(tab.activePaneId).toBe("s2");
    expect(store.getState().sessionOwner["s1"]).toBeUndefined();
    expect(store.getState().sessionOwner["s2"]).toBe("p");
  });

  it("collapses a nested split while leaving the sibling subtree intact", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    store.getState().closePane("p", "s1", "s2");

    const tab = store.getState().byOwner["p"]!.tabs[0]!;
    expect(sessionPanes(tab.layout).map((pane) => pane.sessionId)).toEqual(["s1", "s3"]);
  });

  it("ignores invalid pane-close targets and refuses to remove a tab's only leaf", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    const before = store.getState().byOwner;

    store.getState().closePane("missing", "s1", "s1");
    store.getState().closePane("p", "missing", "s1");
    store.getState().closePane("p", "s1", "missing");
    store.getState().closePane("p", "s1", "s1");

    expect(store.getState().byOwner).toBe(before);
  });

  it("updates only the targeted split ratio and clamps unsafe extremes", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    store.getState().setSplitRatio("p", "s1", "s2", 0.99);

    expect(store.getState().byOwner["p"]?.tabs[0]?.layout).toMatchObject({ ratio: 0.9 });
  });

  it("updates a nested split and ignores unknown split/owner/tab ids", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    store.getState().setSplitRatio("p", "s1", "s3", 0.25);
    const changed = store.getState().byOwner;
    expect(store.getState().byOwner["p"]?.tabs[0]?.layout).toMatchObject({
      first: { ratio: 0.25 },
    });

    store.getState().setSplitRatio("missing", "s1", "s3", 0.4);
    store.getState().setSplitRatio("p", "missing", "s3", 0.4);
    store.getState().setSplitRatio("p", "s1", "missing", 0.4);
    expect(store.getState().byOwner).toBe(changed);
  });
});

describe("setActivePane", () => {
  it("focuses a pane inside a split tree", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    store.getState().setActivePane("p", "s1", "s1");

    expect(store.getState().byOwner["p"]?.tabs[0]?.activePaneId).toBe("s1");
  });

  it("is a no-op for the active pane or unknown owner, tab, and pane", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    const before = store.getState().byOwner;

    store.getState().setActivePane("p", "s1", "s1");
    store.getState().setActivePane("missing", "s1", "s1");
    store.getState().setActivePane("p", "missing", "s1");
    store.getState().setActivePane("p", "s1", "missing");

    expect(store.getState().byOwner).toBe(before);
  });
});

describe("closeSession", () => {
  it("removes the tab, selects the neighbor, and clears its indexes", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSession(P, "s2");
    store.getState().addSession(P, "s3");
    store.getState().setActiveSession("p", "s2");
    store.getState().bumpOutput("s2", 1000);

    store.getState().closeSession("p", "s2");

    const container = store.getState().byOwner["p"];
    expect(container?.tabs.map((t) => t.sessionId)).toEqual(["s1", "s3"]);
    expect(container?.activeSessionId).toBe("s3");
    expect(store.getState().sessionOwner["s2"]).toBeUndefined();
    expect(store.getState().lastOutputAt["s2"]).toBeUndefined();
  });

  it("sets activeSessionId to null when closing the only tab", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");

    store.getState().closeSession("p", "s1");

    const container = store.getState().byOwner["p"];
    expect(container?.tabs).toEqual([]);
    expect(container?.activeSessionId).toBeNull();
  });

  it("is a no-op for an unknown owner or session", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    const before = store.getState().byOwner;

    store.getState().closeSession("missing", "s1");
    store.getState().closeSession("p", "nope");
    expect(store.getState().byOwner).toBe(before);
  });
});

describe("renameSession", () => {
  it("retitles the tab identified by its root sessionId", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");

    store.getState().renameSession("s1", "Deploy");

    expect(store.getState().byOwner["p"]?.tabs[0]?.title).toBe("Deploy");
  });

  it("is a no-op for an unchanged title or an unknown session", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Fixed");
    const before = store.getState().byOwner;

    store.getState().renameSession("s1", "Fixed");
    store.getState().renameSession("ghost", "X");

    expect(store.getState().byOwner).toBe(before);
  });
});

describe("markExited", () => {
  it("records the exit code on the matching tab, routing across owners", () => {
    const store = createSessionsStore();
    store.getState().addSession(scratchScope("a"), "a1");
    store.getState().addSession(ticketScope("proj", "t1"), "b1", "Session 1");

    store.getState().markExited("b1", 130);

    expect(findSessionPane(store.getState().byOwner["t1"]!.tabs[0]!.layout, "b1")?.exitCode).toBe(
      130,
    );
    expect(
      findSessionPane(store.getState().byOwner["a"]!.tabs[0]!.layout, "a1")?.exitCode,
    ).toBeNull();
  });

  it("records an exit on a nested split leaf without changing its sibling", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    store.getState().markExited("s2", 7);

    const layout = store.getState().byOwner["p"]!.tabs[0]!.layout;
    expect(findSessionPane(layout, "s1")?.exitCode).toBeNull();
    expect(findSessionPane(layout, "s2")?.exitCode).toBe(7);
    expect(findSessionPane(layout, "s3")?.exitCode).toBeNull();
  });

  it("is a no-op for an unknown session", () => {
    const store = createSessionsStore();
    store.getState().addSession(scratchScope("a"), "a1");
    const before = store.getState().byOwner;

    store.getState().markExited("ghost", 0);
    expect(store.getState().byOwner).toBe(before);
  });
});

describe("bumpOutput", () => {
  it("records the timestamp for a tracked session", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().bumpOutput("s1", 5000);
    expect(store.getState().lastOutputAt["s1"]).toBe(5000);
  });

  it("throttles to one write per second", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().bumpOutput("s1", 5000);
    store.getState().bumpOutput("s1", 5500); // within 1s — ignored
    expect(store.getState().lastOutputAt["s1"]).toBe(5000);
    store.getState().bumpOutput("s1", 6000); // exactly 1s later — recorded
    expect(store.getState().lastOutputAt["s1"]).toBe(6000);
  });

  it("ignores an untracked session, and a post-close chunk is free", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1");
    store.getState().bumpOutput("scratch", 5000);
    expect(store.getState().lastOutputAt["scratch"]).toBeUndefined();

    store.getState().closeSession("p", "s1");
    store.getState().bumpOutput("s1", 9999);
    expect(store.getState().lastOutputAt["s1"]).toBeUndefined();
  });
});

describe("setStarting", () => {
  it("toggles an owner's in-flight flag and no-ops on a repeat", () => {
    const store = createSessionsStore();
    store.getState().setStarting("a", true);
    expect(store.getState().starting["a"]).toBe(true);

    const before = store.getState().starting;
    store.getState().setStarting("a", true);
    expect(store.getState().starting).toBe(before);

    store.getState().setStarting("a", false);
    expect(store.getState().starting["a"]).toBeUndefined();
  });

  it("is a no-op when clearing an owner that isn't starting", () => {
    const store = createSessionsStore();
    const before = store.getState().starting;
    store.getState().setStarting("a", false);
    expect(store.getState().starting).toBe(before);
  });
});

describe("forgetOwner", () => {
  it("drops the container, its sessions' indexes, and its starting flag", () => {
    const store = createSessionsStore();
    store.getState().addSession(scratchScope("a"), "a1");
    store.getState().addSession(scratchScope("a"), "a2");
    store.getState().bumpOutput("a1", 1000);
    store.getState().setStarting("a", true);
    store.getState().addSession(scratchScope("b"), "b1");

    store.getState().forgetOwner("a");

    expect(store.getState().byOwner["a"]).toBeUndefined();
    expect(store.getState().byOwner["b"]?.tabs.map((t) => t.sessionId)).toEqual(["b1"]);
    expect(store.getState().sessionOwner["a1"]).toBeUndefined();
    expect(store.getState().lastOutputAt["a1"]).toBeUndefined();
    expect(store.getState().starting["a"]).toBeUndefined();
  });

  it("clears the starting flag for an owner removed mid-create", () => {
    const store = createSessionsStore();
    store.getState().setStarting("a", true);
    store.getState().forgetOwner("a");
    expect(store.getState().starting["a"]).toBeUndefined();
  });

  it("is a no-op for an owner with no sessions and no starting flag", () => {
    const store = createSessionsStore();
    store.getState().addSession(scratchScope("a"), "a1");
    const before = store.getState().byOwner;
    store.getState().forgetOwner("never-added");
    expect(store.getState().byOwner).toBe(before);
  });
});

describe("findTabBySessionId", () => {
  it("finds the owner + tab for a root session id across owners", () => {
    const store = createSessionsStore();
    store.getState().addSession(scratchScope("a"), "a1");
    store.getState().addSession(ticketScope("proj", "t1"), "b1", "Session 1");

    expect(findTabBySessionId(store.getState().byOwner, "b1")?.ownerId).toBe("t1");
    expect(findTabBySessionId(store.getState().byOwner, "ghost")).toBeNull();
  });
});
