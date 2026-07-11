import { DEFAULT_TICKET_SORT } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { createWorkspaceStore, DEFAULT_WORKSPACE_UI } from "./workspace";

function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => {
      data.set(name, value);
    },
    removeItem: (name: string) => {
      data.delete(name);
    },
  };
}

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
    store.getState().setNav("project-b", "sessions");

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

describe("setBoardView", () => {
  it("tracks the board/list view independently per project", () => {
    const store = createWorkspaceStore();
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardView("project-b", "board");

    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
    expect(store.getState().byProject["project-b"]?.boardView).toBe("board");
  });

  it("leaves nav and sort untouched", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "files");
    store.getState().setBoardView("project-a", "list");

    expect(store.getState().byProject["project-a"]?.nav).toBe("files");
    expect(store.getState().byProject["project-a"]?.boardSort).toBe(DEFAULT_TICKET_SORT);
  });
});

describe("setBoardSort", () => {
  it("tracks the sort independently per project", () => {
    const store = createWorkspaceStore();
    store.getState().setBoardSort("project-a", { key: "priority", direction: "desc" });
    store.getState().setBoardSort("project-b", { key: "title", direction: "asc" });

    expect(store.getState().byProject["project-a"]?.boardSort).toEqual({
      key: "priority",
      direction: "desc",
    });
    expect(store.getState().byProject["project-b"]?.boardSort).toEqual({
      key: "title",
      direction: "asc",
    });
  });

  it("leaves the view untouched", () => {
    const store = createWorkspaceStore();
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardSort("project-a", { key: "updated", direction: "desc" });

    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
  });
});

describe("forget", () => {
  it("drops the project's record so a re-add starts at the defaults", () => {
    const store = createWorkspaceStore();
    store.getState().setNav("project-a", "files");
    store.getState().setDirExpanded("project-a", "/a/src", true);
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardSort("project-a", { key: "priority", direction: "desc" });
    store.getState().forget("project-a");

    expect(store.getState().byProject["project-a"]).toBeUndefined();
    expect(store.getState().byProject["project-a"] ?? DEFAULT_WORKSPACE_UI).toEqual({
      nav: "board",
      expandedDirs: [],
      boardView: "board",
      boardSort: DEFAULT_TICKET_SORT,
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

describe("persistence", () => {
  it("persists only non-default boardView/boardSort pairs under 'volli:workspace'", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().setBoardView("project-a", "list");
    store.getState().setNav("project-b", "files"); // session-only change → record stays default-valued

    const raw = storage.getItem("volli:workspace");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      state: { byProject: Record<string, Record<string, unknown>> };
    };
    expect(Object.keys(parsed.state.byProject)).toEqual(["project-a"]);
    expect(Object.keys(parsed.state.byProject["project-a"]!).toSorted()).toEqual([
      "boardSort",
      "boardView",
    ]);
  });

  it("rehydrates view + sort while nav and expandedDirs reset to the defaults", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardSort("project-a", { key: "priority", direction: "desc" });
    store.getState().setNav("project-a", "files");
    store.getState().setDirExpanded("project-a", "/a/src", true);

    const rehydrated = createWorkspaceStore(storage);
    const ui = rehydrated.getState().byProject["project-a"];
    expect(ui?.boardView).toBe("list");
    expect(ui?.boardSort).toEqual({ key: "priority", direction: "desc" });
    expect(ui?.nav).toBe("board");
    expect(ui?.expandedDirs).toEqual([]);
  });

  it("sanitizes stale persisted values back to the defaults", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": { boardView: "spreadsheet", boardSort: { key: "gone", direction: "up" } },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    const ui = store.getState().byProject["project-a"];
    expect(ui?.boardView).toBe("board");
    expect(ui?.boardSort).toEqual(DEFAULT_TICKET_SORT);
  });

  it("a forgotten project's persisted prefs do not survive the next write", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().setBoardView("project-a", "list");
    store.getState().forget("project-a");

    const rehydrated = createWorkspaceStore(storage);
    expect(rehydrated.getState().byProject["project-a"]).toBeUndefined();
  });
});
