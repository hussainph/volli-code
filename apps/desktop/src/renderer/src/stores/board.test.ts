import { EMPTY_TICKET_FILTER, type Ticket } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { createBoardStore } from "./board";

/** Simple in-memory `StateStorage` so each test gets its own isolated backing. */
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

/** Fresh store over fresh, isolated storage — never shared across tests. */
function freshStore() {
  return createBoardStore(createMemoryStorage());
}

function byStatus(tickets: Ticket[], status: Ticket["status"]) {
  return tickets.filter((ticket) => ticket.status === status);
}

describe("ensureSeeded", () => {
  it("seeds the demo board for a project not yet in ticketsByProject", () => {
    const store = freshStore();

    store.getState().ensureSeeded("p1", "TST");

    const tickets = store.getState().ticketsByProject.p1!;
    expect(tickets).toHaveLength(11);
    expect(byStatus(tickets, "backlog")).toHaveLength(4);
    expect(byStatus(tickets, "todo")).toHaveLength(3);
    expect(byStatus(tickets, "doing")).toHaveLength(2);
    expect(byStatus(tickets, "needs_review")).toHaveLength(2);
    expect(byStatus(tickets, "done")).toHaveLength(0);
    expect(tickets.every((t) => t.id.startsWith("TST-"))).toBe(true);
  });

  it("is idempotent — a second call does not reseed or change identity", () => {
    const store = freshStore();
    store.getState().ensureSeeded("p1", "TST");
    const before = store.getState().ticketsByProject.p1;

    store.getState().ensureSeeded("p1", "TST");

    expect(store.getState().ticketsByProject.p1).toBe(before);
  });

  it("treats an already-empty ticket array as seeded", () => {
    const store = freshStore();
    store.setState({ ticketsByProject: { p1: [] } });

    store.getState().ensureSeeded("p1", "TST");

    expect(store.getState().ticketsByProject.p1).toEqual([]);
  });
});

describe("moveTicket", () => {
  it("moves a ticket to a new status and index", () => {
    const store = freshStore();
    store.getState().ensureSeeded("p1", "TST");
    const backlogFirst = byStatus(store.getState().ticketsByProject.p1!, "backlog")[0]!;

    store.getState().moveTicket("p1", backlogFirst.id, "doing", 0);

    const moved = store.getState().ticketsByProject.p1!.find((t) => t.id === backlogFirst.id)!;
    expect(moved.status).toBe("doing");
    expect(moved.order).toBe(0);
  });

  it("is a no-op (unchanged identity) when the shared op reports unchanged position", () => {
    const store = freshStore();
    store.getState().ensureSeeded("p1", "TST");
    const backlogFirst = byStatus(store.getState().ticketsByProject.p1!, "backlog")[0]!;
    const before = store.getState();

    store.getState().moveTicket("p1", backlogFirst.id, "backlog", 0);

    expect(store.getState()).toBe(before);
  });

  it("is a no-op for an unknown ticket id on an unseeded project", () => {
    const store = freshStore();
    const before = store.getState();

    store.getState().moveTicket("p1", "does-not-exist", "doing", 0);

    expect(store.getState()).toBe(before);
    expect(store.getState().ticketsByProject.p1).toBeUndefined();
  });
});

describe("addTicket", () => {
  it("appends a ticket with the next ticket number and end-of-column order", () => {
    const store = freshStore();
    store.getState().ensureSeeded("p1", "TST");

    store.getState().addTicket("p1", "TST", "backlog", "Ship the widget");

    const tickets = store.getState().ticketsByProject.p1!;
    expect(tickets).toHaveLength(12);
    const added = tickets.find((t) => t.title === "Ship the widget")!;
    expect(added.id).toBe("TST-12");
    expect(added.ticketNumber).toBe(12);
    expect(added.status).toBe("backlog");
    expect(added.order).toBe(4); // 4 existing backlog tickets, 0-indexed end
  });

  it("adds the first ticket to an unseeded project at order 0, number 1", () => {
    const store = freshStore();

    store.getState().addTicket("p1", "TST", "todo", "First ticket");

    const tickets = store.getState().ticketsByProject.p1!;
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.id).toBe("TST-1");
    expect(tickets[0]!.order).toBe(0);
  });

  it("trims the title before storing it", () => {
    const store = freshStore();

    store.getState().addTicket("p1", "TST", "todo", "  Padded title  ");

    expect(store.getState().ticketsByProject.p1![0]!.title).toBe("Padded title");
  });

  it("is a no-op when the trimmed title is empty", () => {
    const store = freshStore();
    const before = store.getState();

    store.getState().addTicket("p1", "TST", "todo", "   ");

    expect(store.getState()).toBe(before);
    expect(store.getState().ticketsByProject.p1).toBeUndefined();
  });
});

describe("setTicketPriority", () => {
  it("updates a ticket's priority", () => {
    const store = freshStore();
    store.getState().ensureSeeded("p1", "TST");
    const ticket = store.getState().ticketsByProject.p1![0]!;
    const nextPriority = ticket.priority === "high" ? "low" : "high";

    store.getState().setTicketPriority("p1", ticket.id, nextPriority);

    expect(store.getState().ticketsByProject.p1!.find((t) => t.id === ticket.id)!.priority).toBe(
      nextPriority,
    );
  });

  it("is a no-op (unchanged identity) when the priority is unchanged", () => {
    const store = freshStore();
    store.getState().ensureSeeded("p1", "TST");
    const ticket = store.getState().ticketsByProject.p1![0]!;
    const before = store.getState();

    store.getState().setTicketPriority("p1", ticket.id, ticket.priority);

    expect(store.getState()).toBe(before);
  });

  it("is a no-op for an unknown ticket id", () => {
    const store = freshStore();
    store.getState().ensureSeeded("p1", "TST");
    const before = store.getState();

    store.getState().setTicketPriority("p1", "does-not-exist", "high");

    expect(store.getState()).toBe(before);
  });

  it("is a no-op for an unknown ticket id on an unseeded project", () => {
    const store = freshStore();
    const before = store.getState();

    store.getState().setTicketPriority("p1", "does-not-exist", "high");

    expect(store.getState()).toBe(before);
  });
});

describe("setSearch", () => {
  it("sets the search string verbatim, initializing from EMPTY_TICKET_FILTER", () => {
    const store = freshStore();

    store.getState().setSearch("p1", "  widget ");

    expect(store.getState().filterByProject.p1).toEqual({
      ...EMPTY_TICKET_FILTER,
      search: "  widget ",
    });
  });
});

describe("togglePriority", () => {
  it("adds then removes a priority from the facet", () => {
    const store = freshStore();

    store.getState().togglePriority("p1", "high");
    expect(store.getState().filterByProject.p1!.priorities).toEqual(["high"]);

    store.getState().togglePriority("p1", "high");
    expect(store.getState().filterByProject.p1!.priorities).toEqual([]);
  });
});

describe("toggleTag", () => {
  it("adds then removes a tag from the facet", () => {
    const store = freshStore();

    store.getState().toggleTag("p1", "terminal");
    expect(store.getState().filterByProject.p1!.tags).toEqual(["terminal"]);

    store.getState().toggleTag("p1", "terminal");
    expect(store.getState().filterByProject.p1!.tags).toEqual([]);
  });
});

describe("toggleHarness", () => {
  it("adds then removes a harness id from the facet", () => {
    const store = freshStore();

    store.getState().toggleHarness("p1", "codex");
    expect(store.getState().filterByProject.p1!.harnessIds).toEqual(["codex"]);

    store.getState().toggleHarness("p1", "codex");
    expect(store.getState().filterByProject.p1!.harnessIds).toEqual([]);
  });
});

describe("clearFilter", () => {
  it("drops the project's filter record entirely", () => {
    const store = freshStore();
    store.getState().togglePriority("p1", "high");

    store.getState().clearFilter("p1");

    expect(store.getState().filterByProject.p1).toBeUndefined();
  });

  it("is a no-op when there is no filter record for the project", () => {
    const store = freshStore();
    const before = store.getState();

    store.getState().clearFilter("p1");

    expect(store.getState()).toBe(before);
  });
});

describe("selectTicket", () => {
  it("records the selected ticket id for the project", () => {
    const store = freshStore();

    store.getState().selectTicket("p1", "TST-3");

    expect(store.getState().selectedByProject.p1).toBe("TST-3");
  });

  it("clears via null by dropping the project's record entirely", () => {
    const store = freshStore();
    store.getState().selectTicket("p1", "TST-3");

    store.getState().selectTicket("p1", null);

    expect(store.getState().selectedByProject.p1).toBeUndefined();
    expect("p1" in store.getState().selectedByProject).toBe(false);
  });

  it("is a no-op (unchanged identity) when clearing with no selection", () => {
    const store = freshStore();
    const before = store.getState();

    store.getState().selectTicket("p1", null);

    expect(store.getState()).toBe(before);
  });

  it("is a no-op (unchanged identity) when re-selecting the same ticket", () => {
    const store = freshStore();
    store.getState().selectTicket("p1", "TST-3");
    const before = store.getState();

    store.getState().selectTicket("p1", "TST-3");

    expect(store.getState()).toBe(before);
  });

  it("keeps selections independent across projects", () => {
    const store = freshStore();

    store.getState().selectTicket("p1", "TST-3");
    store.getState().selectTicket("p2", "OTH-1");
    store.getState().selectTicket("p1", null);

    expect(store.getState().selectedByProject.p1).toBeUndefined();
    expect(store.getState().selectedByProject.p2).toBe("OTH-1");
  });
});

describe("forget", () => {
  it("removes the ticket list, the filter record, and the selection record", () => {
    const store = freshStore();
    store.getState().ensureSeeded("p1", "TST");
    store.getState().togglePriority("p1", "high");
    store.getState().selectTicket("p1", "TST-1");

    store.getState().forget("p1");

    expect(store.getState().ticketsByProject.p1).toBeUndefined();
    expect(store.getState().filterByProject.p1).toBeUndefined();
    expect(store.getState().selectedByProject.p1).toBeUndefined();
  });

  it("removes only the selection record when there is nothing else", () => {
    const store = freshStore();
    store.getState().selectTicket("p1", "TST-1");

    store.getState().forget("p1");

    expect(store.getState().selectedByProject.p1).toBeUndefined();
  });

  it("removes only the ticket list when there is no filter record", () => {
    const store = freshStore();
    store.getState().ensureSeeded("p1", "TST");

    store.getState().forget("p1");

    expect(store.getState().ticketsByProject.p1).toBeUndefined();
  });

  it("removes only the filter record when there is no ticket list", () => {
    const store = freshStore();
    store.getState().togglePriority("p1", "high");

    store.getState().forget("p1");

    expect(store.getState().filterByProject.p1).toBeUndefined();
  });

  it("is a no-op for a project with no tickets, filter, or selection", () => {
    const store = freshStore();
    const before = store.getState();

    store.getState().forget("p1");

    expect(store.getState()).toBe(before);
  });
});

describe("persistence", () => {
  it("marks localStorage as disposable scaffold data and persists only board records", () => {
    const storage = createMemoryStorage();
    const store = createBoardStore(storage);
    store.getState().ensureSeeded("p1", "TST");
    store.getState().togglePriority("p1", "high");
    store.getState().selectTicket("p1", "TST-1");

    const raw = storage.getItem("volli:board");
    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw!) as { state: Record<string, unknown>; version: number };
    expect(Object.keys(parsed.state)).toEqual(["persistenceKind", "ticketsByProject"]);
    expect(parsed.state.persistenceKind).toBe("demo-scaffold");
    expect(parsed.state).not.toHaveProperty("filterByProject");
    expect(parsed.state).not.toHaveProperty("selectedByProject");
  });

  it("rehydrates the same tickets in a new store over the same storage, filters and selection reset", () => {
    const storage = createMemoryStorage();
    const store = createBoardStore(storage);
    store.getState().ensureSeeded("p1", "TST");
    store.getState().togglePriority("p1", "high");
    store.getState().selectTicket("p1", "TST-1");

    const rehydrated = createBoardStore(storage);

    expect(rehydrated.getState().ticketsByProject).toEqual(store.getState().ticketsByProject);
    expect(rehydrated.getState().persistenceKind).toBe("demo-scaffold");
    expect(rehydrated.getState().filterByProject).toEqual({});
    expect(rehydrated.getState().selectedByProject).toEqual({});
  });
});

describe("rehydration sanitization", () => {
  it("drops rehydrated tickets that fail validation, keeping the valid ones", () => {
    // A ticket with an unknown status would throw inside groupTicketsByStatus
    // (`groups[status].push`) on every board render — persisted JSON from a
    // different build (or a corrupt write) must never smuggle one into state.
    const valid = {
      id: "TST-1",
      projectId: "p1",
      ticketNumber: 1,
      title: "Valid",
      body: "",
      status: "todo",
      priority: "medium",
      tags: ["infra"],
      usesWorktree: true,
      harnessId: "claude-code",
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const invalid = [
      "junk",
      null,
      { ...valid, id: 7 },
      { ...valid, order: "0" },
      { ...valid, status: "in_progress" },
      { ...valid, priority: "urgent" },
      { ...valid, usesWorktree: "yes" },
      { ...valid, tags: "infra" },
      { ...valid, tags: ["infra", 7] },
    ];

    const storage = createMemoryStorage();
    storage.setItem(
      "volli:board",
      JSON.stringify({
        state: {
          persistenceKind: "demo-scaffold",
          ticketsByProject: { p1: [valid, ...invalid], p2: "not-an-array" },
        },
        version: 1,
      }),
    );

    const store = createBoardStore(storage);
    expect(store.getState().ticketsByProject.p1).toEqual([valid]);
    // A record that is not an array at all is dropped whole.
    expect(store.getState().ticketsByProject.p2).toBeUndefined();
  });

  it("rehydrates to an empty board when the persisted shape is not an object", () => {
    const storage = createMemoryStorage();
    storage.setItem("volli:board", JSON.stringify({ state: null, version: 1 }));
    expect(createBoardStore(storage).getState().ticketsByProject).toEqual({});

    const noRecordStorage = createMemoryStorage();
    noRecordStorage.setItem(
      "volli:board",
      JSON.stringify({ state: { persistenceKind: "demo-scaffold" }, version: 1 }),
    );
    expect(createBoardStore(noRecordStorage).getState().ticketsByProject).toEqual({});

    const nullRecordStorage = createMemoryStorage();
    nullRecordStorage.setItem(
      "volli:board",
      JSON.stringify({
        state: { persistenceKind: "demo-scaffold", ticketsByProject: null },
        version: 1,
      }),
    );
    expect(createBoardStore(nullRecordStorage).getState().ticketsByProject).toEqual({});
  });
});
