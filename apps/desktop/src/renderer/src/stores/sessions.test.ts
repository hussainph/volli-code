import { describe, expect, it } from "vite-plus/test";
import { createSessionsStore } from "./sessions";

describe("addSession", () => {
  it("appends a tab and makes it active", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "Session 1");

    const project = store.getState().byProject["p"];
    expect(project?.tabs).toEqual([{ sessionId: "s1", title: "Session 1", exitCode: null }]);
    expect(project?.activeSessionId).toBe("s1");
  });

  it("keeps insertion order and activates each newly added session", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");
    store.getState().addSession("p", "s2", "Two");
    store.getState().addSession("p", "s3", "Three");

    const project = store.getState().byProject["p"];
    expect(project?.tabs.map((t) => t.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(project?.activeSessionId).toBe("s3");
  });

  it("scopes sessions per project", () => {
    const store = createSessionsStore();
    store.getState().addSession("a", "a1", "A1");
    store.getState().addSession("b", "b1", "B1");

    expect(store.getState().byProject["a"]?.tabs.map((t) => t.sessionId)).toEqual(["a1"]);
    expect(store.getState().byProject["b"]?.tabs.map((t) => t.sessionId)).toEqual(["b1"]);
  });

  it("ignores a duplicate sessionId in the same project", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");
    const before = store.getState().byProject;
    store.getState().addSession("p", "s1", "One again");

    expect(store.getState().byProject).toBe(before);
  });
});

describe("setActiveSession", () => {
  it("activates an existing session", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");
    store.getState().addSession("p", "s2", "Two");

    store.getState().setActiveSession("p", "s1");
    expect(store.getState().byProject["p"]?.activeSessionId).toBe("s1");
  });

  it("is a no-op for an unknown project or session", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");
    const before = store.getState().byProject;

    store.getState().setActiveSession("missing", "s1");
    store.getState().setActiveSession("p", "nope");
    expect(store.getState().byProject).toBe(before);
  });
});

describe("closeSession", () => {
  it("removes the tab and selects the neighbor now at the removed index", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");
    store.getState().addSession("p", "s2", "Two");
    store.getState().addSession("p", "s3", "Three");
    store.getState().setActiveSession("p", "s2");

    store.getState().closeSession("p", "s2");

    const project = store.getState().byProject["p"];
    expect(project?.tabs.map((t) => t.sessionId)).toEqual(["s1", "s3"]);
    expect(project?.activeSessionId).toBe("s3");
  });

  it("selects the new last tab when closing the active last tab", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");
    store.getState().addSession("p", "s2", "Two");
    store.getState().setActiveSession("p", "s2");

    store.getState().closeSession("p", "s2");

    expect(store.getState().byProject["p"]?.activeSessionId).toBe("s1");
  });

  it("leaves the active selection untouched when closing a non-active tab", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");
    store.getState().addSession("p", "s2", "Two");
    store.getState().setActiveSession("p", "s1");

    store.getState().closeSession("p", "s2");

    expect(store.getState().byProject["p"]?.activeSessionId).toBe("s1");
    expect(store.getState().byProject["p"]?.tabs.map((t) => t.sessionId)).toEqual(["s1"]);
  });

  it("sets activeSessionId to null when closing the only tab", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");

    store.getState().closeSession("p", "s1");

    const project = store.getState().byProject["p"];
    expect(project?.tabs).toEqual([]);
    expect(project?.activeSessionId).toBeNull();
  });

  it("is a no-op for an unknown project or session", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");
    const before = store.getState().byProject;

    store.getState().closeSession("missing", "s1");
    store.getState().closeSession("p", "nope");
    expect(store.getState().byProject).toBe(before);
  });
});

describe("renameSession", () => {
  it("updates only the matching tab, leaving siblings untouched", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");
    store.getState().addSession("p", "s2", "Two");

    store.getState().renameSession("p", "s1", "Renamed");

    expect(store.getState().byProject["p"]?.tabs.map((t) => t.title)).toEqual(["Renamed", "Two"]);
  });

  it("is a no-op for an unknown project or session", () => {
    const store = createSessionsStore();
    store.getState().addSession("p", "s1", "One");
    const before = store.getState().byProject;

    store.getState().renameSession("missing", "s1", "x");
    store.getState().renameSession("p", "nope", "x");
    expect(store.getState().byProject).toBe(before);
  });
});

describe("markExited", () => {
  it("records the exit code on the matching tab, scanning across projects", () => {
    const store = createSessionsStore();
    store.getState().addSession("a", "a1", "A1");
    store.getState().addSession("b", "b1", "B1");
    // A sibling tab in the same project so the non-matching branch is exercised.
    store.getState().addSession("b", "b2", "B2");

    store.getState().markExited("b1", 130);

    const bTabs = store.getState().byProject["b"]?.tabs ?? [];
    expect(bTabs.find((t) => t.sessionId === "b1")?.exitCode).toBe(130);
    expect(bTabs.find((t) => t.sessionId === "b2")?.exitCode).toBeNull();
    expect(store.getState().byProject["a"]?.tabs[0]?.exitCode).toBeNull();
  });

  it("is a no-op for an unknown session", () => {
    const store = createSessionsStore();
    store.getState().addSession("a", "a1", "A1");
    const before = store.getState().byProject;

    store.getState().markExited("ghost", 0);
    expect(store.getState().byProject).toBe(before);
  });
});

describe("forgetProject", () => {
  it("drops every session for the project", () => {
    const store = createSessionsStore();
    store.getState().addSession("a", "a1", "A1");
    store.getState().addSession("b", "b1", "B1");

    store.getState().forgetProject("a");

    expect(store.getState().byProject["a"]).toBeUndefined();
    expect(store.getState().byProject["b"]?.tabs.map((t) => t.sessionId)).toEqual(["b1"]);
  });

  it("is a no-op for a project with no sessions", () => {
    const store = createSessionsStore();
    store.getState().addSession("a", "a1", "A1");
    const before = store.getState().byProject;

    store.getState().forgetProject("never-added");
    expect(store.getState().byProject).toBe(before);
  });
});
