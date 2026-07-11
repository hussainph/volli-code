import { describe, expect, it } from "vite-plus/test";
import { createSessionsStore, findSessionPane, sessionPanes } from "./sessions";

describe("addSession", () => {
  it("appends a tab titled from the counter and makes it active", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");

    const project = store.getState().byProject["p"];
    expect(project?.tabs).toEqual([
      {
        sessionId: "s1",
        title: "Terminal 1",
        layout: { kind: "pane", sessionId: "s1", exitCode: null },
        activePaneId: "s1",
      },
    ]);
    expect(project?.activeSessionId).toBe("s1");
    expect(project?.nextTabNumber).toBe(2);
  });

  it("keeps insertion order, numbers titles monotonically, and activates each added session", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSession("p", "s2");
    store.getState().addSession("p", "s3");

    const project = store.getState().byProject["p"];
    expect(project?.tabs.map((t) => t.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(project?.tabs.map((t) => t.title)).toEqual(["Terminal 1", "Terminal 2", "Terminal 3"]);
    expect(project?.activeSessionId).toBe("s3");
  });

  it("never reuses a closed tab's number — no duplicate titles", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSession("p", "s2");
    store.getState().closeSession("p", "s1");

    store.getState().addSession("p", "s3");

    expect(store.getState().byProject["p"]?.tabs.map((t) => t.title)).toEqual([
      "Terminal 2",
      "Terminal 3",
    ]);
  });

  it("scopes sessions and numbering per project", () => {
    const store = createSessionsStore();
    store.getState().addSession("a", "a1");
    store.getState().addSession("b", "b1");

    expect(store.getState().byProject["a"]?.tabs.map((t) => t.sessionId)).toEqual(["a1"]);
    expect(store.getState().byProject["b"]?.tabs.map((t) => t.sessionId)).toEqual(["b1"]);
    expect(store.getState().byProject["b"]?.tabs[0]?.title).toBe("Terminal 1");
  });

  it("ignores a duplicate sessionId in the same project", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    const before = store.getState().byProject;
    store.getState().addSession("p", "s1");

    expect(store.getState().byProject).toBe(before);
  });
});

describe("setActiveSession", () => {
  it("activates an existing session", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSession("p", "s2");

    store.getState().setActiveSession("p", "s1");
    expect(store.getState().byProject["p"]?.activeSessionId).toBe("s1");
  });

  it("is a no-op for an unknown project or session", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    const before = store.getState().byProject;

    store.getState().setActiveSession("missing", "s1");
    store.getState().setActiveSession("p", "nope");
    expect(store.getState().byProject).toBe(before);
  });
});

describe("split panes", () => {
  it("inserts a fresh session leaf beside the focused pane and activates it", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");

    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    const tab = store.getState().byProject["p"]?.tabs[0];
    expect(tab?.activePaneId).toBe("s2");
    expect(tab && sessionPanes(tab.layout).map((pane) => pane.sessionId)).toEqual(["s1", "s2"]);
    expect(tab?.layout).toMatchObject({
      kind: "split",
      id: "s2",
      direction: "vertical",
      ratio: 0.5,
    });
  });

  it("supports nested splits without duplicating or replacing sibling leaves", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    const tab = store.getState().byProject["p"]!.tabs[0]!;
    expect(sessionPanes(tab.layout).map((pane) => pane.sessionId)).toEqual(["s1", "s3", "s2"]);
  });

  it("can split a leaf in the second branch after traversing an untouched subtree", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    store.getState().addSplit("p", "s1", "s2", "s4", "horizontal");

    const tab = store.getState().byProject["p"]!.tabs[0]!;
    expect(sessionPanes(tab.layout).map((pane) => pane.sessionId)).toEqual([
      "s1",
      "s3",
      "s2",
      "s4",
    ]);
  });

  it("ignores unknown projects, tabs, source panes, and duplicate pane ids", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    const before = store.getState().byProject;

    store.getState().addSplit("missing", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "missing", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "missing", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s1", "vertical");

    expect(store.getState().byProject).toBe(before);
  });

  it("closes one leaf, collapses its parent split, and focuses a neighbor", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    store.getState().closePane("p", "s1", "s1");

    const tab = store.getState().byProject["p"]!.tabs[0]!;
    expect(tab.layout).toEqual({ kind: "pane", sessionId: "s2", exitCode: null });
    expect(tab.activePaneId).toBe("s2");
  });

  it("collapses either side of a split and preserves a non-removed active pane", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().setActivePane("p", "s1", "s1");

    store.getState().closePane("p", "s1", "s2");

    const tab = store.getState().byProject["p"]!.tabs[0]!;
    expect(tab.activePaneId).toBe("s1");
  });

  it("collapses a nested split while leaving the sibling subtree intact", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    store.getState().closePane("p", "s1", "s2");

    const tab = store.getState().byProject["p"]!.tabs[0]!;
    expect(sessionPanes(tab.layout).map((pane) => pane.sessionId)).toEqual(["s1", "s3"]);
  });

  it("rebuilds an ancestor when a nested leaf is removed", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    store.getState().closePane("p", "s1", "s3");

    const tab = store.getState().byProject["p"]!.tabs[0]!;
    expect(sessionPanes(tab.layout).map((pane) => pane.sessionId)).toEqual(["s1", "s2"]);
  });

  it("ignores invalid pane-close targets and refuses to remove a tab's only leaf", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    const before = store.getState().byProject;

    store.getState().closePane("missing", "s1", "s1");
    store.getState().closePane("p", "missing", "s1");
    store.getState().closePane("p", "s1", "missing");
    store.getState().closePane("p", "s1", "s1");

    expect(store.getState().byProject).toBe(before);
  });

  it("updates only the targeted split ratio and clamps unsafe extremes", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    store.getState().setSplitRatio("p", "s1", "s2", 0.99);

    expect(store.getState().byProject["p"]?.tabs[0]?.layout).toMatchObject({ ratio: 0.9 });
  });

  it("updates a nested split and ignores unknown split/project/tab ids", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    store.getState().setSplitRatio("p", "s1", "s3", 0.25);
    const changed = store.getState().byProject;
    expect(store.getState().byProject["p"]?.tabs[0]?.layout).toMatchObject({
      first: { ratio: 0.25 },
    });

    store.getState().setSplitRatio("missing", "s1", "s3", 0.4);
    store.getState().setSplitRatio("p", "missing", "s3", 0.4);
    store.getState().setSplitRatio("p", "s1", "missing", 0.4);
    expect(store.getState().byProject).toBe(changed);
  });
});

describe("setActivePane", () => {
  it("focuses a pane inside a split tree", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");

    store.getState().setActivePane("p", "s1", "s1");

    expect(store.getState().byProject["p"]?.tabs[0]?.activePaneId).toBe("s1");
  });

  it("is a no-op for the active pane or unknown project, tab, and pane", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    const before = store.getState().byProject;

    store.getState().setActivePane("p", "s1", "s1");
    store.getState().setActivePane("missing", "s1", "s1");
    store.getState().setActivePane("p", "missing", "s1");
    store.getState().setActivePane("p", "s1", "missing");

    expect(store.getState().byProject).toBe(before);
  });
});

describe("closeSession", () => {
  it("removes the tab and selects the neighbor now at the removed index", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSession("p", "s2");
    store.getState().addSession("p", "s3");
    store.getState().setActiveSession("p", "s2");

    store.getState().closeSession("p", "s2");

    const project = store.getState().byProject["p"];
    expect(project?.tabs.map((t) => t.sessionId)).toEqual(["s1", "s3"]);
    expect(project?.activeSessionId).toBe("s3");
  });

  it("selects the new last tab when closing the active last tab", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSession("p", "s2");
    store.getState().setActiveSession("p", "s2");

    store.getState().closeSession("p", "s2");

    expect(store.getState().byProject["p"]?.activeSessionId).toBe("s1");
  });

  it("leaves the active selection untouched when closing a non-active tab", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSession("p", "s2");
    store.getState().setActiveSession("p", "s1");

    store.getState().closeSession("p", "s2");

    expect(store.getState().byProject["p"]?.activeSessionId).toBe("s1");
    expect(store.getState().byProject["p"]?.tabs.map((t) => t.sessionId)).toEqual(["s1"]);
  });

  it("sets activeSessionId to null when closing the only tab", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");

    store.getState().closeSession("p", "s1");

    const project = store.getState().byProject["p"];
    expect(project?.tabs).toEqual([]);
    expect(project?.activeSessionId).toBeNull();
  });

  it("is a no-op for an unknown project or session", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    const before = store.getState().byProject;

    store.getState().closeSession("missing", "s1");
    store.getState().closeSession("p", "nope");
    expect(store.getState().byProject).toBe(before);
  });
});

describe("markExited", () => {
  it("records the exit code on the matching tab, scanning across projects", () => {
    const store = createSessionsStore();
    store.getState().addSession("a", "a1");
    store.getState().addSession("b", "b1");
    // A sibling tab in the same project so the non-matching branch is exercised.
    store.getState().addSession("b", "b2");

    store.getState().markExited("b1", 130);

    const bTabs = store.getState().byProject["b"]?.tabs ?? [];
    expect(findSessionPane(bTabs.find((t) => t.sessionId === "b1")!.layout, "b1")?.exitCode).toBe(
      130,
    );
    expect(
      findSessionPane(bTabs.find((t) => t.sessionId === "b2")!.layout, "b2")?.exitCode,
    ).toBeNull();
    expect(
      findSessionPane(store.getState().byProject["a"]!.tabs[0]!.layout, "a1")?.exitCode,
    ).toBeNull();
  });

  it("records an exit on a nested split leaf without changing its sibling", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1");
    store.getState().addSplit("p", "s1", "s1", "s2", "vertical");
    store.getState().addSplit("p", "s1", "s1", "s3", "horizontal");

    store.getState().markExited("s2", 7);

    const layout = store.getState().byProject["p"]!.tabs[0]!.layout;
    expect(findSessionPane(layout, "s1")?.exitCode).toBeNull();
    expect(findSessionPane(layout, "s2")?.exitCode).toBe(7);
    expect(findSessionPane(layout, "s3")?.exitCode).toBeNull();
  });

  it("is a no-op for an unknown session", () => {
    const store = createSessionsStore();
    store.getState().addSession("a", "a1");
    const before = store.getState().byProject;

    store.getState().markExited("ghost", 0);
    expect(store.getState().byProject).toBe(before);
  });
});

describe("forgetProject", () => {
  it("drops every session for the project", () => {
    const store = createSessionsStore();
    store.getState().addSession("a", "a1");
    store.getState().addSession("b", "b1");

    store.getState().forgetProject("a");

    expect(store.getState().byProject["a"]).toBeUndefined();
    expect(store.getState().byProject["b"]?.tabs.map((t) => t.sessionId)).toEqual(["b1"]);
  });

  it("is a no-op for a project with no sessions and no starting flag", () => {
    const store = createSessionsStore();
    store.getState().addSession("a", "a1");
    const before = store.getState().byProject;
    const beforeStarting = store.getState().startingProjects;

    store.getState().forgetProject("never-added");
    expect(store.getState().byProject).toBe(before);
    expect(store.getState().startingProjects).toBe(beforeStarting);
  });

  it("clears the starting flag for a project removed mid-create", () => {
    const store = createSessionsStore();
    store.getState().setStarting("a", true);

    store.getState().forgetProject("a");

    expect(store.getState().startingProjects["a"]).toBeUndefined();
  });
});

describe("setStarting", () => {
  it("sets the flag for a project", () => {
    const store = createSessionsStore();
    store.getState().setStarting("a", true);

    expect(store.getState().startingProjects["a"]).toBe(true);
  });

  it("clears the flag for a project", () => {
    const store = createSessionsStore();
    store.getState().setStarting("a", true);

    store.getState().setStarting("a", false);

    expect(store.getState().startingProjects["a"]).toBeUndefined();
  });

  it("is a no-op when setting true on an already-starting project", () => {
    const store = createSessionsStore();
    store.getState().setStarting("a", true);
    const before = store.getState().startingProjects;

    store.getState().setStarting("a", true);

    expect(store.getState().startingProjects).toBe(before);
  });

  it("is a no-op when setting false on a project that isn't starting", () => {
    const store = createSessionsStore();
    const before = store.getState().startingProjects;

    store.getState().setStarting("a", false);

    expect(store.getState().startingProjects).toBe(before);
  });

  it("tracks the flag per project", () => {
    const store = createSessionsStore();
    store.getState().setStarting("a", true);

    expect(store.getState().startingProjects["a"]).toBe(true);
    expect(store.getState().startingProjects["b"]).toBeUndefined();
  });
});
