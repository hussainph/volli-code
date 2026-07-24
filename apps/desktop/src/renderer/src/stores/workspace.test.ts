import { DEFAULT_TICKET_SORT } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useBoardStore } from "./board";
import { ticketScope, useSessionsStore } from "./sessions";
import { createWorkspaceStore, DEFAULT_WORKSPACE_UI, type NavKey } from "./workspace";

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

  it("shows the plain board when Board is selected from an open ticket", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");

    store.getState().setNav("project-a", "board");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "board",
      openTicketId: null,
    });
  });

  it("switches to Configure without clearing the open ticket (only Board does)", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicket("project-a", "ticket-1");

    store.getState().setNav("project-a", "configure");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "configure",
      openTicketId: "ticket-1",
    });
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

describe("openTicketWorkspace", () => {
  afterEach(() => {
    useBoardStore.setState({ selectedByProject: {} });
  });

  it("switches nav to Board even when the project's nav was elsewhere (composer kickoff from Files/Sessions regression)", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    // Simulate invoking Create-&-start (or any ticket-open action) while the
    // user is on a non-Board nav — the app-wide "c" shortcut and the command
    // palette both allow this. `openTicket` alone never touched nav, so the
    // ticket detail it promises never rendered (main-content.tsx only shows
    // it under nav === "board"); `openTicketWorkspace` must always land on
    // Board regardless of the starting nav.
    store.getState().setNav("project-a", "sessions");

    store.getState().openTicketWorkspace("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "board",
      openTicketId: "ticket-1",
    });
  });

  it("selects the same ticket in the board store", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketWorkspace("project-a", "ticket-1");

    expect(useBoardStore.getState().selectedByProject["project-a"]).toBe("ticket-1");
  });

  it("activates the given tab", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketWorkspace("project-a", "ticket-1", { tabId: "doc" });

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: [],
      active: "doc",
    });
  });

  it("leaves the ticket's existing tab untouched when no tabId is given", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md"); // active: file:a.md
    store.getState().openTicketWorkspace("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.active).toBe(
      "file:a.md",
    );
  });

  it("creates no ticketTabs record when no tabId is given and none existed", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketWorkspace("project-a", "ticket-1");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toBeUndefined();
  });
});

describe("openTicketSession", () => {
  afterEach(() => {
    useBoardStore.setState({ selectedByProject: {} });
    useSessionsStore.getState().forgetOwner("ticket-1");
  });

  it("opens the ticket detail and focuses the exact tab and split pane", () => {
    useSessionsStore
      .getState()
      .addSession(ticketScope("project-a", "ticket-1"), "session-1", "Agent");
    useSessionsStore
      .getState()
      .addSplit("ticket-1", "session-1", "session-1", "session-2", "vertical");
    useSessionsStore
      .getState()
      .addSession(ticketScope("project-a", "ticket-1"), "session-3", "Checks");
    useSessionsStore.getState().setActivePane("ticket-1", "session-1", "session-1");

    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setNav("project-a", "files");
    store.getState().openTicketSession("project-a", "ticket-1", "session-1", "session-2");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "board",
      openTicketId: "ticket-1",
      ticketTabs: { "ticket-1": { files: [], active: "session-1" } },
    });
    expect(useBoardStore.getState().selectedByProject["project-a"]).toBe("ticket-1");
    expect(useSessionsStore.getState().byOwner["ticket-1"]?.activeSessionId).toBe("session-1");
    expect(useSessionsStore.getState().byOwner["ticket-1"]?.tabs[0]?.activePaneId).toBe(
      "session-2",
    );
  });

  it("creates missing workspace state and preserves the active pane when none is requested", () => {
    useSessionsStore
      .getState()
      .addSession(ticketScope("project-a", "ticket-1"), "session-1", "Agent");

    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketSession("project-a", "ticket-1", "session-1");

    expect(store.getState().byProject["project-a"]).toMatchObject({
      nav: "board",
      openTicketId: "ticket-1",
      ticketTabs: { "ticket-1": { files: [], active: "session-1" } },
    });
    expect(useSessionsStore.getState().byOwner["ticket-1"]?.tabs[0]?.activePaneId).toBe(
      "session-1",
    );
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

describe("ticket file tabs", () => {
  it("openTicketFile appends the file and makes it active", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "docs/plan.md");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: ["docs/plan.md"],
      active: "file:docs/plan.md",
    });
  });

  it("opening the same file twice keeps one entry but re-activates it", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().openTicketFile("project-a", "ticket-1", "b.md");
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: ["a.md", "b.md"],
      active: "file:a.md",
    });
  });

  it("tracks open files independently per ticket and per project", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().openTicketFile("project-a", "ticket-2", "b.md");
    store.getState().openTicketFile("project-b", "ticket-1", "c.md");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]?.files).toEqual([
      "a.md",
    ]);
    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-2"]?.files).toEqual([
      "b.md",
    ]);
    expect(store.getState().byProject["project-b"]?.ticketTabs["ticket-1"]?.files).toEqual([
      "c.md",
    ]);
  });

  it("closeTicketFile removes the file and falls back to Doc when it was active", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().openTicketFile("project-a", "ticket-1", "b.md");
    store.getState().closeTicketFile("project-a", "ticket-1", "b.md"); // b was active

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: ["a.md"],
      active: "doc",
    });
  });

  it("closeTicketFile keeps the active tab when a non-active file closes", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().openTicketFile("project-a", "ticket-1", "b.md"); // b active
    store.getState().closeTicketFile("project-a", "ticket-1", "a.md");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: ["b.md"],
      active: "file:b.md",
    });
  });

  it("closing the last file with Doc active prunes the ticket record", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().closeTicketFile("project-a", "ticket-1", "a.md");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toBeUndefined();
  });

  it("closeTicketFile is a no-op for a ticket with no record", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    const before = store.getState().byProject;
    store.getState().closeTicketFile("project-a", "ticket-1", "a.md");
    expect(store.getState().byProject).toBe(before);
  });

  it("setTicketActiveTab switches the active tab, including to a session id", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");
    store.getState().setTicketActiveTab("project-a", "ticket-1", "session-9");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: ["a.md"],
      active: "session-9",
    });
  });

  it("setTicketActiveTab to Doc on an empty ticket creates no record", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setTicketActiveTab("project-a", "ticket-1", "doc");

    expect(store.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toBeUndefined();
  });

  it("leaves board view/sort/open ticket untouched", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().setBoardView("project-a", "list");
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");

    expect(store.getState().byProject["project-a"]?.boardView).toBe("list");
    expect(store.getState().byProject["project-a"]?.boardSort).toBe(DEFAULT_TICKET_SORT);
  });
});

describe("ticket file tab persistence", () => {
  it("persists ticketTabs and rehydrates them", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().openTicketFile("project-a", "ticket-1", "docs/plan.md");
    store.getState().setTicketActiveTab("project-a", "ticket-1", "session-9");

    const rehydrated = createWorkspaceStore(storage);
    expect(rehydrated.getState().byProject["project-a"]?.ticketTabs["ticket-1"]).toEqual({
      files: ["docs/plan.md"],
      active: "session-9",
    });
  });

  it("persists a record that carries only open files (default board view)", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().openTicketFile("project-a", "ticket-1", "a.md");

    const parsed = JSON.parse(storage.getItem("volli:workspace")!) as {
      state: { byProject: Record<string, Record<string, unknown>> };
    };
    expect(Object.keys(parsed.state.byProject)).toEqual(["project-a"]);
    expect(parsed.state.byProject["project-a"]).toHaveProperty("ticketTabs");
  });

  it("sanitizes non-string files and prunes empty ticket records on rehydrate", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: {
          byProject: {
            "project-a": {
              ticketTabs: {
                "ticket-1": { files: ["ok.md", 42, null], active: "file:ok.md" },
                "ticket-2": { files: [], active: "doc" }, // nothing worth keeping
                "ticket-3": { files: "bad", active: 7 }, // wrong types
                "ticket-4": null, // corrupt write: record is not an object at all
                "ticket-5": "junk",
              },
            },
          },
        },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    const tabs = store.getState().byProject["project-a"]?.ticketTabs;
    expect(tabs?.["ticket-1"]).toEqual({ files: ["ok.md"], active: "file:ok.md" });
    expect(tabs?.["ticket-2"]).toBeUndefined();
    expect(tabs?.["ticket-3"]).toBeUndefined();
    expect(tabs?.["ticket-4"]).toBeUndefined();
    expect(tabs?.["ticket-5"]).toBeUndefined();
  });

  it("defaults ticketTabs to an empty map for a record without one", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:workspace",
      JSON.stringify({
        state: { byProject: { "project-a": { boardView: "list" } } },
        version: 1,
      }),
    );

    const store = createWorkspaceStore(storage);
    expect(store.getState().byProject["project-a"]?.ticketTabs).toEqual({});
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
      ticketTabs: {},
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
      "ticketTabs",
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

const snap = (
  projectId: string | null,
  nav: NavKey = "board",
  openTicketId: string | null = null,
) => ({
  projectId,
  nav,
  openTicketId,
});

describe("navHistory", () => {
  it("starts empty", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    expect(store.getState().navHistory).toEqual({ back: [], current: null, forward: [] });
  });

  it("records organic navigations and steps back/forward over them", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().recordNav(snap("a"));
    store.getState().recordNav(snap("a", "sessions"));
    store.getState().recordNav(snap("b"));

    expect(store.getState().stepNavBack()).toEqual(snap("a", "sessions"));
    expect(store.getState().stepNavBack()).toEqual(snap("a"));
    expect(store.getState().stepNavBack()).toBeNull();
    expect(store.getState().stepNavForward()).toEqual(snap("a", "sessions"));
  });

  it("stepNavForward returns null and leaves history unchanged when the forward stack is empty", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    const before = store.getState().navHistory;

    expect(store.getState().stepNavForward()).toBeNull();
    expect(store.getState().navHistory).toBe(before);
  });

  it("dedupes a consecutive identical snapshot without notifying", () => {
    const store = createWorkspaceStore(createMemoryStorage());
    store.getState().recordNav(snap("a"));
    const before = store.getState().navHistory;
    store.getState().recordNav(snap("a"));
    expect(store.getState().navHistory).toBe(before);
  });

  it("is never persisted (in-memory only)", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceStore(storage);
    store.getState().recordNav(snap("a"));
    store.getState().recordNav(snap("b"));

    const parsed = JSON.parse(storage.getItem("volli:workspace") ?? "{}") as {
      state?: Record<string, unknown>;
    };
    expect(parsed.state?.navHistory).toBeUndefined();

    // And a fresh (rehydrated) store starts with empty history.
    expect(createWorkspaceStore(storage).getState().navHistory).toEqual({
      back: [],
      current: null,
      forward: [],
    });
  });
});
