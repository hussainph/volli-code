import { describe, expect, it } from "vite-plus/test";
import { createWorkspaceStore, DEFAULT_NAV } from "./workspace";

describe("setNav", () => {
  it("tracks nav independently per project", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "files");
    store.getState().setNav("project-b", "sessions");

    expect(store.getState().navByProject["project-a"]).toBe("files");
    expect(store.getState().navByProject["project-b"]).toBe("sessions");
  });

  it("keeps a project's nav across changes to other projects", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "files");
    store.getState().setNav("project-b", "board");
    store.getState().setNav("project-b", "settings");

    expect(store.getState().navByProject["project-a"]).toBe("files");
  });
});

describe("forget", () => {
  it("drops the project's entry so a re-add starts at the default", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "files");
    store.getState().forget("project-a");

    expect(store.getState().navByProject["project-a"]).toBeUndefined();
    expect(store.getState().navByProject["project-a"] ?? DEFAULT_NAV).toBe(DEFAULT_NAV);
  });

  it("leaves other projects untouched and is a no-op for unknown ids", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "sessions");

    const before = store.getState().navByProject;
    store.getState().forget("never-added");
    expect(store.getState().navByProject).toBe(before);

    store.getState().forget("project-b");
    expect(store.getState().navByProject["project-a"]).toBe("sessions");
  });
});
