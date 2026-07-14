import { DEFAULT_TICKET_SORT } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useBoardStore } from "./board";
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
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "files");
    store.getState().setNav("project-b", "sessions");

    expect(store.getState().byProject["project-a"]?.nav).toBe("files");
    expect(store.getState().byProject["project-b"]?.nav).toBe("sessions");
  });

  it("keeps a project's nav across changes to other projects", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "files");
    store.getState().setNav("project-b", "board");
    store.getState().setNav("project-b", "sessions");

    expect(store.getState().byProject["project-a"]?.nav).toBe("files");
  });
});

describe("setDirExpanded", () => {
  it("tracks expanded directories independently per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setDirExpanded("project-a", "/a/src", true);
    store.getState().setDirExpanded("project-a", "/a/src/lib", true);
    store.getState().setDirExpanded("project-b", "/b/docs", true);

    expect(store.getState().byProject["project-a"]?.expandedDirs).toEqual(["/a/src", "/a/src/lib"]);
    expect(store.getState().byProject["project-b"]?.expandedDirs).toEqual(["/b/docs"]);
  });

  it("collapsing removes only that directory, keeping descendants remembered", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setDirExpanded("project-a", "/a/src", true);
    store.getState().setDirExpanded("project-a", "/a/src/lib", true);
    store.getState().setDirExpanded("project-a", "/a/src", false);

    // Descendant flags survive a parent collapse so re-expanding the parent
    // restores the deeper levels too.
    expect(store.getState().byProject["project-a"]?.expandedDirs).toEqual(["/a/src/lib"]);
  });

  it("is a no-op when the state already matches", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setDirExpanded("project-a", "/a/src", true);

    const before = store.getState().byProject;
    store.getState().setDirExpanded("project-a", "/a/src", true);
    store.getState().setDirExpanded("project-a", "/a/never-expanded", false);
    expect(store.getState().byProject).toBe(before);
  });

  it("leaves nav untouched", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "files");
    store.getState().setDirExpanded("project-a", "/a/src", true);

    expect(store.getState().byProject["project-a"]?.nav).toBe("files");
  });
});

describe("setBoardView", () => {
  it("tracks the board/list view independently per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardView("project-b", "board");

    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
    expect(store.getState().byProject["project-b"]?.boardView).toBe("board");
  });

  it("leaves nav and sort untouched", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "files");
    store.getState().setBoardView("project-a", "list");

    expect(store.getState().byProject["project-a"]?.nav).toBe("files");
    expect(store.getState().byProject["project-a"]?.boardSort).toBe(DEFAULT_TICKET_SORT);
  });
});

describe("setBoardSort", () => {
  it("tracks the sort independently per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
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
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardSort("project-a", { key: "updated", direction: "desc" });

    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
  });
});

describe("openTicket", () => {
  // openTicket also selects the ticket in the REAL board-store singleton (see
  // workspace.ts's module doc: cross-store orchestration lives in the action,
  // same precedent as projects.ts's removeProject) — reset it so a write here
  // never leaks into another test.
  afterEach(() => {
    useBoardStore.setState({ selectedByProject: {} });
  });

  it("sets the project's openTicketId", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]?.openTicketId).toBe("ticket-1");
  });

  it("selects the same ticket in the board store", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");

    expect(useBoardStore.getState().selectedByProject["project-a"]).toBe("ticket-1");
  });

  it("tracks the open ticket independently per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");
    store.getState().openTicket("project-b", "ticket-2");

    expect(store.getState().byProject["project-a"]?.openTicketId).toBe("ticket-1");
    expect(store.getState().byProject["project-b"]?.openTicketId).toBe("ticket-2");
  });

  it("leaves nav, boardView, and boardSort untouched", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "files");
    store.getState().setBoardView("project-a", "list");
    store.getState().openTicket("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]?.nav).toBe("files");
    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
  });
});

describe("closeTicket", () => {
  it("clears the project's openTicketId", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");
    store.getState().closeTicket("project-a");

    expect(store.getState().byProject["project-a"]?.openTicketId).toBeNull();
  });

  it("is safe to call on a project with no record yet", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().closeTicket("never-opened");

    expect(store.getState().byProject["never-opened"]?.openTicketId ?? null).toBeNull();
  });
});

describe("forget", () => {
  it("drops the project's record so a re-add starts at the defaults", () => {
    const store = createWorkspaceStore(createMemoryStorage());
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
      openTicketId: null,
    });
  });

  it("leaves other projects untouched and is a no-op for unknown ids", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "sessions");

    const before = store.getState().byProject;
    store.getState().forget("never-added");
    expect(store.getState().byProject).toBe(before);

    store.getState().forget("project-b");
    expect(store.getState().byProject["project-a"]?.nav).toBe("sessions");
  });
});

describe("persistence", () => {
  it("persists only non-default boardView/boardSort/openTicketId records under 'volli:workspace'", () => {
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
      "openTicketId",
    ]);
  });

  it("rehydrates view + sort + open ticket while nav and expandedDirs reset to the defaults", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().setBoardView("project-a", "list");
    store.getState().setBoardSort("project-a", { key: "priority", direction: "desc" });
    store.getState().setNav("project-a", "files");
    store.getState().setDirExpanded("project-a", "/a/src", true);
    useBoardStore.setState({ selectedByProject: {} }); // openTicket's board-store side effect, reset afterward
    store.getState().openTicket("project-a", "ticket-1");
    useBoardStore.setState({ selectedByProject: {} });

    const rehydrated = createWorkspaceStore(storage);
    const ui = rehydrated.getState().byProject["project-a"];
    expect(ui?.boardView).toBe("list");
    expect(ui?.boardSort).toEqual({ key: "priority", direction: "desc" });
    expect(ui?.openTicketId).toBe("ticket-1");
    expect(ui?.nav).toBe("board");
    expect(ui?.expandedDirs).toEqual([]);
  });

  it("restores the open ticket across a restart (openTicket → reload)", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().openTicket("project-a", "ticket-1");
    useBoardStore.setState({ selectedByProject: {} });

    const rehydrated = createWorkspaceStore(storage);
    expect(rehydrated.getState().byProject["project-a"]?.openTicketId).toBe("ticket-1");
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

  it("sanitizes a wrong-type persisted openTicketId back to null", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: { byProject: { "project-a": { openTicketId: 42 } } },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.openTicketId).toBeNull();
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

describe("rehydration sanitization (corrupt JSON)", () => {
  it("survives a persisted null boardSort and a null record without crashing", () => {
    // `null !== undefined` used to pass the guard and throw on `.key` during
    // store creation — a corrupt write bricked the renderer on every launch.
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": { boardView: "list", boardSort: null },
            "project-b": null,
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
    expect(store.getState().byProject["project-a"]?.boardSort).toEqual(DEFAULT_TICKET_SORT);
    expect(store.getState().byProject["project-a"]?.openTicketId).toBeNull();
    expect(store.getState().byProject["project-b"]).toEqual(DEFAULT_WORKSPACE_UI);
  });

  it("falls back to the default sort when only the direction is invalid", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: { byProject: { "project-a": { boardSort: { key: "priority", direction: "up" } } } },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.boardSort).toEqual(DEFAULT_TICKET_SORT);
  });

  it("strips stray keys from a persisted sort instead of spreading them into state", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": { boardSort: { key: "title", direction: "asc", stray: true } },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.boardSort).toEqual({
      key: "title",
      direction: "asc",
    });
  });
});
