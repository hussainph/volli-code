import { describe, expect, it } from "vite-plus/test";
import { createWorkspaceStore, DEFAULT_WORKSPACE_UI } from "./workspace";

describe("setNav", () => {
  it("tracks nav independently per project", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "files");
    store.getState().setNav("project-b", "sessions");

    expect(store.getState().byProject["project-a"]?.nav).toBe("files");
    expect(store.getState().byProject["project-b"]?.nav).toBe("sessions");
  });

  it("keeps a project's nav across changes to other projects", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "files");
    store.getState().setNav("project-b", "board");
    store.getState().setNav("project-b", "settings");

    expect(store.getState().byProject["project-a"]?.nav).toBe("files");
  });
});

describe("setDirExpanded", () => {
  it("tracks expanded directories independently per project", () => {
    const store = createWorkspaceStore();
    store.getState().setDirExpanded("project-a", "/a/src", true);
    store.getState().setDirExpanded("project-a", "/a/src/lib", true);
    store.getState().setDirExpanded("project-b", "/b/docs", true);

    expect(store.getState().byProject["project-a"]?.expandedDirs).toEqual(["/a/src", "/a/src/lib"]);
    expect(store.getState().byProject["project-b"]?.expandedDirs).toEqual(["/b/docs"]);
  });

  it("collapsing removes only that directory, keeping descendants remembered", () => {
    const store = createWorkspaceStore();
    store.getState().setDirExpanded("project-a", "/a/src", true);
    store.getState().setDirExpanded("project-a", "/a/src/lib", true);
    store.getState().setDirExpanded("project-a", "/a/src", false);

    // Descendant flags survive a parent collapse so re-expanding the parent
    // restores the deeper levels too.
    expect(store.getState().byProject["project-a"]?.expandedDirs).toEqual(["/a/src/lib"]);
  });

  it("is a no-op when the state already matches", () => {
    const store = createWorkspaceStore();
    store.getState().setDirExpanded("project-a", "/a/src", true);

    const before = store.getState().byProject;
    store.getState().setDirExpanded("project-a", "/a/src", true);
    store.getState().setDirExpanded("project-a", "/a/never-expanded", false);
    expect(store.getState().byProject).toBe(before);
  });

  it("leaves nav untouched", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "files");
    store.getState().setDirExpanded("project-a", "/a/src", true);

    expect(store.getState().byProject["project-a"]?.nav).toBe("files");
  });
});

describe("forget", () => {
  it("drops the project's record so a re-add starts at the defaults", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "files");
    store.getState().setDirExpanded("project-a", "/a/src", true);
    store.getState().forget("project-a");

    expect(store.getState().byProject["project-a"]).toBeUndefined();
    expect(store.getState().byProject["project-a"] ?? DEFAULT_WORKSPACE_UI).toEqual({
      nav: "board",
      expandedDirs: [],
    });
  });

  it("leaves other projects untouched and is a no-op for unknown ids", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "sessions");

    const before = store.getState().byProject;
    store.getState().forget("never-added");
    expect(store.getState().byProject).toBe(before);

    store.getState().forget("project-b");
    expect(store.getState().byProject["project-a"]?.nav).toBe("sessions");
  });
});
