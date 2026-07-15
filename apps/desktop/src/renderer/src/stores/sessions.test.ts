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
  it("is exited whenever the shell has exited, regardless of recency or park state", () => {
    expect(sessionActivityState(1000, true, 1000, false)).toBe("exited");
    expect(sessionActivityState(null, true, 5000, false)).toBe("exited");
    expect(sessionActivityState(1000, true, 1000, true)).toBe("exited"); // exited beats parked
  });

  it("is parked when parked and live, regardless of recent output", () => {
    expect(sessionActivityState(null, false, 1000, true)).toBe("parked");
    expect(sessionActivityState(1000, false, 1000, true)).toBe("parked"); // parked beats working
  });

  it("is working when output landed within the 10s window", () => {
    expect(sessionActivityState(1000, false, 1000, false)).toBe("working");
    expect(sessionActivityState(1000, false, 11_000, false)).toBe("working"); // exactly 10s
  });

  it("is idle when live but quiet past the window, or when there was no output", () => {
    expect(sessionActivityState(1000, false, 11_001, false)).toBe("idle");
    expect(sessionActivityState(null, false, 50_000, false)).toBe("idle");
  });
});

describe("addSession", () => {
  it("appends a scratch tab with the given title, stamps its scope, and activates it", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");

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

  it("keeps insertion order across appended tabs and activates each", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSession(P, "s2", "Terminal 2");
    store.getState().addSession(P, "s3", "Terminal 3");

    const container = store.getState().byOwner["p"];
    expect(container?.tabs.map((t) => t.title)).toEqual(["Terminal 1", "Terminal 2", "Terminal 3"]);
    expect(container?.activeSessionId).toBe("s3");
  });

  it("scopes sessions per owner", () => {
    const store = createSessionsStore();
    store.getState().addSession(scratchScope("a"), "a1", "Terminal 1");
    store.getState().addSession(scratchScope("b"), "b1", "Terminal 1");

    expect(store.getState().byOwner["a"]?.tabs.map((t) => t.sessionId)).toEqual(["a1"]);
    expect(store.getState().byOwner["b"]?.tabs[0]?.title).toBe("Terminal 1");
  });

  it("ignores a duplicate sessionId in the same owner", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    const before = store.getState().byOwner;
    store.getState().addSession(P, "s1", "Terminal 1");

    expect(store.getState().byOwner).toBe(before);
  });
});

describe("setActiveSession", () => {
  it("activates an existing session", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSession(P, "s2", "Terminal 2");

    store.getState().setActiveSession("p", "s1");
    expect(store.getState().byOwner["p"]?.activeSessionId).toBe("s1");
  });

  it("is a no-op for an unknown owner or session", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    const before = store.getState().byOwner;

    store.getState().setActiveSession("missing", "s1");
    store.getState().setActiveSession("p", "nope");
    expect(store.getState().byOwner).toBe(before);
  });
});

describe("split panes", () => {
  it("inserts a fresh session leaf beside the focused pane, activates it, and indexes it", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");

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
    store.getState().addSession(P, "s1", "Terminal 1");
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

  it("splits a pane that lives in the second child of an existing split", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    // s2 is the SECOND child of the split — this recurses past an unchanged
    // first subtree into the second before replacing the leaf.
    store.getState().addSplit("p", "s1", "s2", "s3", "horizontal");

    const tab = store.getState().byOwner["p"]!.tabs[0]!;
    expect(tab.layout).toEqual({
      kind: "split",
      id: "s2",
      direction: "vertical",
      ratio: 0.5,
      first: { kind: "pane", sessionId: "s1", exitCode: null },
      second: {
        kind: "split",
        id: "s3",
        direction: "horizontal",
        ratio: 0.5,
        first: { kind: "pane", sessionId: "s2", exitCode: null },
        second: { kind: "pane", sessionId: "s3", exitCode: null },
      },
    });
  });

  it("rebuilds a split when removing a deep pane collapses its nested first subtree but leaves the second sibling intact", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");
    // layout: split(s2, vertical){ first: split(s3, horizontal){first: s1, second: s3}, second: s2 }

    store.getState().closePane("p", "s1", "s1");

    const tab = store.getState().byOwner["p"]!.tabs[0]!;
    expect(tab.layout).toEqual({
      kind: "split",
      id: "s2",
      direction: "vertical",
      ratio: 0.5,
      first: { kind: "pane", sessionId: "s3", exitCode: null },
      second: { kind: "pane", sessionId: "s2", exitCode: null },
    });
  });

  it("leaves a nested split subtree untouched (same reference) when the split target lives outside it entirely", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");
    // layout: split(s2, vertical){ first: split(s3, horizontal){first: s1, second: s3}, second: s2 }
    const nestedFirst = (store.getState().byOwner["p"]!.tabs[0]!.layout as { first: unknown })
      .first;

    // s2 is the SIMPLE second pane, entirely outside the nested first subtree —
    // recursing into that subtree to look for s2 finds no match on either side,
    // so it must come back unchanged (the ternary's untouched-layout arm).
    store.getState().addSplit("p", "s1", "s2", "s4", "vertical");

    const layout = store.getState().byOwner["p"]!.tabs[0]!.layout as { first: unknown };
    expect(layout.first).toBe(nestedFirst);
  });

  it("rebuilds a split when removing a deep pane collapses its nested second subtree but leaves the first sibling intact", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s2", "s3", "horizontal");
    // layout: split(s2, vertical){ first: s1, second: split(s3, horizontal){first: s2, second: s3} }

    store.getState().closePane("p", "s1", "s2");

    const tab = store.getState().byOwner["p"]!.tabs[0]!;
    expect(tab.layout).toEqual({
      kind: "split",
      id: "s2",
      direction: "vertical",
      ratio: 0.5,
      first: { kind: "pane", sessionId: "s1", exitCode: null },
      second: { kind: "pane", sessionId: "s3", exitCode: null },
    });
  });

  it("ignores unknown owners, tabs, source panes, and duplicate pane ids", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    const before = store.getState().byOwner;

    store.getState().addSplit("missing", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "missing", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "missing", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s1", "vertical");

    expect(store.getState().byOwner).toBe(before);
  });

  it("closes one leaf, collapses its parent split, focuses a neighbor, and drops its index", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().setParkState("s2", true, false);

    // Close the NON-root leaf s2: its index is dropped and the tab collapses onto
    // the root pane s1 (root-pane retention is covered separately below).
    store.getState().closePane("p", "s1", "s2");

    const tab = store.getState().byOwner["p"]!.tabs[0]!;
    expect(tab.layout).toEqual({ kind: "pane", sessionId: "s1", exitCode: null });
    expect(tab.activePaneId).toBe("s1");
    expect(store.getState().sessionOwner["s2"]).toBeUndefined();
    expect(store.getState().sessionOwner["s1"]).toBe("p");
    expect(store.getState().parkState["s2"]).toBeUndefined();
  });

  it("keeps the tab-root routing entry (dropping only its output/park stamps) when the root pane closes, so rename still lands", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().bumpOutput("s1", 1000);
    store.getState().setParkState("s1", true, false);

    // Close the ROOT pane (sessionId === tabId). The tab keeps s1 as its stable
    // identity, so its routing entry must survive — otherwise a later rename
    // would silently no-op while the DB write still lands (titles diverge).
    store.getState().closePane("p", "s1", "s1");

    expect(store.getState().sessionOwner["s1"]).toBe("p"); // retained for routing
    expect(store.getState().lastOutputAt["s1"]).toBeUndefined(); // per-pane stamp dropped
    expect(store.getState().parkState["s1"]).toBeUndefined(); // per-pane park stamp dropped

    store.getState().renameSession("s1", "Renamed");
    expect(store.getState().byOwner["p"]?.tabs[0]?.title).toBe("Renamed");
  });

  it("clears the retained tab-root routing entry when the whole tab later closes", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().setParkState("s1", true, false);
    store.getState().closePane("p", "s1", "s1"); // root pane gone; sessionOwner[s1] retained

    store.getState().closeSession("p", "s1");

    expect(store.getState().sessionOwner["s1"]).toBeUndefined();
    expect(store.getState().sessionOwner["s2"]).toBeUndefined();
    expect(store.getState().parkState["s1"]).toBeUndefined();
  });

  it("collapses a nested split while leaving the sibling subtree intact", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    store.getState().closePane("p", "s1", "s2");

    const tab = store.getState().byOwner["p"]!.tabs[0]!;
    expect(sessionPanes(tab.layout).map((pane) => pane.sessionId)).toEqual(["s1", "s3"]);
  });

  it("ignores invalid pane-close targets and refuses to remove a tab's only leaf", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    const before = store.getState().byOwner;

    store.getState().closePane("missing", "s1", "s1");
    store.getState().closePane("p", "missing", "s1");
    store.getState().closePane("p", "s1", "missing");
    store.getState().closePane("p", "s1", "s1");

    expect(store.getState().byOwner).toBe(before);
  });

  it("updates only the targeted split ratio and clamps unsafe extremes", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    store.getState().setSplitRatio("p", "s1", "s2", 0.99);

    expect(store.getState().byOwner["p"]?.tabs[0]?.layout).toMatchObject({ ratio: 0.9 });
  });

  it("updates a nested split and ignores unknown split/owner/tab ids", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
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
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    store.getState().setActivePane("p", "s1", "s1");

    expect(store.getState().byOwner["p"]?.tabs[0]?.activePaneId).toBe("s1");
  });

  it("is a no-op for the active pane or unknown owner, tab, and pane", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
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
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSession(P, "s2", "Terminal 2");
    store.getState().addSession(P, "s3", "Terminal 3");
    store.getState().setActiveSession("p", "s2");
    store.getState().bumpOutput("s2", 1000);
    store.getState().setParkState("s2", true, true);

    store.getState().closeSession("p", "s2");

    const container = store.getState().byOwner["p"];
    expect(container?.tabs.map((t) => t.sessionId)).toEqual(["s1", "s3"]);
    expect(container?.activeSessionId).toBe("s3");
    expect(store.getState().sessionOwner["s2"]).toBeUndefined();
    expect(store.getState().lastOutputAt["s2"]).toBeUndefined();
    expect(store.getState().parkState["s2"]).toBeUndefined();
  });

  it("leaves the active tab untouched when a different (non-active) tab is closed", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().addSession(P, "s2", "Terminal 2"); // s2 becomes active

    store.getState().closeSession("p", "s1"); // close the NON-active tab

    const container = store.getState().byOwner["p"];
    expect(container?.tabs.map((t) => t.sessionId)).toEqual(["s2"]);
    expect(container?.activeSessionId).toBe("s2");
  });

  it("sets activeSessionId to null when closing the only tab", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");

    store.getState().closeSession("p", "s1");

    const container = store.getState().byOwner["p"];
    expect(container?.tabs).toEqual([]);
    expect(container?.activeSessionId).toBeNull();
  });

  it("is a no-op for an unknown owner or session", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    const before = store.getState().byOwner;

    store.getState().closeSession("missing", "s1");
    store.getState().closeSession("p", "nope");
    expect(store.getState().byOwner).toBe(before);
  });
});

describe("renameSession", () => {
  it("retitles the tab identified by its root sessionId", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");

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

  it("is a no-op when the routing index names an owner with no container (defensive)", () => {
    const store = createSessionsStore();
    store.setState({ sessionOwner: { s1: "ghost-owner" } });
    const before = store.getState().byOwner;

    store.getState().renameSession("s1", "New title");

    expect(store.getState().byOwner).toBe(before);
  });
});

describe("markExited", () => {
  it("records the exit code on the matching tab, routing across owners", () => {
    const store = createSessionsStore();
    store.getState().addSession(scratchScope("a"), "a1", "Terminal 1");
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
    store.getState().addSession(P, "s1", "Terminal 1");
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
    store.getState().addSession(scratchScope("a"), "a1", "Terminal 1");
    const before = store.getState().byOwner;

    store.getState().markExited("ghost", 0);
    expect(store.getState().byOwner).toBe(before);
  });

  it("is a no-op when the routing index names an owner with no container (defensive)", () => {
    const store = createSessionsStore();
    store.setState({ sessionOwner: { s1: "ghost-owner" } });
    const before = store.getState().byOwner;

    store.getState().markExited("s1", 1);

    expect(store.getState().byOwner).toBe(before);
  });

  it("is a no-op when the routing index outlives the pane it points to (defensive)", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    // s1's own routing index is intact, but "ghost" is (incorrectly) routed to
    // the same owner without any pane in its tabs to match.
    store.setState((state) => ({ sessionOwner: { ...state.sessionOwner, ghost: "p" } }));
    const before = store.getState().byOwner;

    store.getState().markExited("ghost", 1);

    expect(store.getState().byOwner).toBe(before);
  });
});

describe("bumpOutput", () => {
  it("records the timestamp for a tracked session", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().bumpOutput("s1", 5000);
    expect(store.getState().lastOutputAt["s1"]).toBe(5000);
  });

  it("throttles to one write per second", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().bumpOutput("s1", 5000);
    store.getState().bumpOutput("s1", 5500); // within 1s — ignored
    expect(store.getState().lastOutputAt["s1"]).toBe(5000);
    store.getState().bumpOutput("s1", 6000); // exactly 1s later — recorded
    expect(store.getState().lastOutputAt["s1"]).toBe(6000);
  });

  it("ignores an untracked session, and a post-close chunk is free", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().bumpOutput("scratch", 5000);
    expect(store.getState().lastOutputAt["scratch"]).toBeUndefined();

    store.getState().closeSession("p", "s1");
    store.getState().bumpOutput("s1", 9999);
    expect(store.getState().lastOutputAt["s1"]).toBeUndefined();
  });
});

describe("setParkState", () => {
  it("records park+keepAwake for a previously untracked session", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");

    store.getState().setParkState("s1", true, false);

    expect(store.getState().parkState["s1"]).toEqual({ parked: true, keepAwake: false });
  });

  it("updates an existing entry when either field changes", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().setParkState("s1", true, false);

    store.getState().setParkState("s1", true, true); // pinned while still parked

    expect(store.getState().parkState["s1"]).toEqual({ parked: true, keepAwake: true });
  });

  it("is a no-op when park state is unchanged", () => {
    const store = createSessionsStore();
    store.getState().addSession(P, "s1", "Terminal 1");
    store.getState().setParkState("s1", true, false);
    const before = store.getState().parkState;

    store.getState().setParkState("s1", true, false);

    expect(store.getState().parkState).toBe(before);
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
    store.getState().addSession(scratchScope("a"), "a1", "Terminal 1");
    store.getState().addSession(scratchScope("a"), "a2", "Terminal 2");
    store.getState().bumpOutput("a1", 1000);
    store.getState().setParkState("a1", true, false);
    store.getState().setStarting("a", true);
    store.getState().addSession(scratchScope("b"), "b1", "Terminal 1");

    store.getState().forgetOwner("a");

    expect(store.getState().byOwner["a"]).toBeUndefined();
    expect(store.getState().byOwner["b"]?.tabs.map((t) => t.sessionId)).toEqual(["b1"]);
    expect(store.getState().sessionOwner["a1"]).toBeUndefined();
    expect(store.getState().lastOutputAt["a1"]).toBeUndefined();
    expect(store.getState().parkState["a1"]).toBeUndefined();
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
    store.getState().addSession(scratchScope("a"), "a1", "Terminal 1");
    const before = store.getState().byOwner;
    store.getState().forgetOwner("never-added");
    expect(store.getState().byOwner).toBe(before);
  });
});

describe("findTabBySessionId", () => {
  it("finds the owner + tab for a root session id across owners", () => {
    const store = createSessionsStore();
    store.getState().addSession(scratchScope("a"), "a1", "Terminal 1");
    store.getState().addSession(ticketScope("proj", "t1"), "b1", "Session 1");

    expect(findTabBySessionId(store.getState().byOwner, "b1")?.ownerId).toBe("t1");
    expect(findTabBySessionId(store.getState().byOwner, "ghost")).toBeNull();
  });
});
