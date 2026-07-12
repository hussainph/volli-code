import {
  EMPTY_TICKET_FILTER,
  type Label,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";
import { type BoardGateway, createBoardStore } from "./board";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

let nextId = 1;

/** A minimal, deterministic ticket for hydrate() seeding and gateway stubs. */
function ticket(overrides: Partial<Ticket> & { status: TicketStatus }): Ticket {
  return {
    id: overrides.id ?? `t${nextId++}`,
    projectId: overrides.projectId ?? "p1",
    ticketNumber: overrides.ticketNumber ?? nextId,
    title: overrides.title ?? "Ticket",
    body: overrides.body ?? "",
    status: overrides.status,
    priority: overrides.priority ?? "medium",
    labels: overrides.labels ?? [],
    usesWorktree: overrides.usesWorktree ?? true,
    harnessId: overrides.harnessId ?? "claude-code",
    order: overrides.order ?? 0,
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
  };
}

/** A fake in-memory gateway implementing BoardGateway's result unions, controllable per test. */
function fakeGateway(overrides: Partial<BoardGateway> = {}): BoardGateway {
  const createTicket = vi.fn<BoardGateway["createTicket"]>(async (input) => ({
    ok: true,
    ticket: ticket({
      projectId: input.projectId,
      status: input.status,
      title: input.title,
      priority: input.priority,
    }),
  }));
  const moveTicket = vi.fn<BoardGateway["moveTicket"]>(async () => ({ ok: true, tickets: [] }));
  const setTicketPriority = vi.fn<BoardGateway["setTicketPriority"]>(async (input) => ({
    ok: true,
    ticket: ticket({ id: input.ticketId, status: "backlog", priority: input.priority }),
  }));
  return { createTicket, moveTicket, setTicketPriority, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("hydrate", () => {
  it("seeds ticketsByProject and labelsByProject wholesale", () => {
    const store = createBoardStore(fakeGateway());
    const tickets = [ticket({ status: "backlog" })];
    const labels: Label[] = [{ id: "l1", projectId: "p1", name: "bug", color: null }];

    store.getState().hydrate({ p1: tickets }, { p1: labels });

    expect(store.getState().ticketsByProject.p1).toBe(tickets);
    expect(store.getState().labelsByProject.p1).toBe(labels);
  });
});

describe("addTicket", () => {
  it("is a no-op (no IPC call) when the trimmed title is empty", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);

    const result = await store.getState().addTicket("p1", "backlog", "   ");

    expect(result).toBeNull();
    expect(gateway.createTicket).not.toHaveBeenCalled();
    expect(store.getState().ticketsByProject.p1).toBeUndefined();
  });

  it("trims the title before sending it to the gateway", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);

    await store.getState().addTicket("p1", "backlog", "  Padded  ");

    expect(gateway.createTicket).toHaveBeenCalledWith(expect.objectContaining({ title: "Padded" }));
  });

  it("appends the gateway's created ticket and returns it", async () => {
    const created = ticket({ id: "new-1", projectId: "p1", status: "todo", title: "New" });
    const gateway = fakeGateway({
      createTicket: vi.fn<BoardGateway["createTicket"]>(async () => ({
        ok: true,
        ticket: created,
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [ticket({ status: "backlog" })] }, {});

    const result = await store.getState().addTicket("p1", "todo", "New", { priority: "high" });

    expect(result).toBe(created);
    expect(store.getState().ticketsByProject.p1).toHaveLength(2);
    expect(store.getState().ticketsByProject.p1).toContain(created);
  });

  it("toasts and returns null on a typed gateway failure", async () => {
    const gateway = fakeGateway({
      createTicket: vi.fn<BoardGateway["createTicket"]>(async () => ({
        ok: false,
        error: "db locked",
      })),
    });
    const store = createBoardStore(gateway);

    const result = await store.getState().addTicket("p1", "todo", "New");

    expect(result).toBeNull();
    expect(store.getState().ticketsByProject.p1).toBeUndefined();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not create ticket: db locked");
  });

  it("toasts and returns null when the gateway call rejects", async () => {
    const gateway = fakeGateway({
      createTicket: vi.fn<BoardGateway["createTicket"]>(async () => {
        throw new Error("ipc gone");
      }),
    });
    const store = createBoardStore(gateway);

    const result = await store.getState().addTicket("p1", "todo", "New");

    expect(result).toBeNull();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not create ticket: ipc gone");
  });
});

describe("moveTicket", () => {
  it("optimistically moves, then reconciles with the gateway's authoritative list", async () => {
    const a = ticket({ id: "a", status: "backlog", order: 0 });
    const b = ticket({ id: "b", status: "backlog", order: 1 });
    const authoritative = [
      { ...a, status: "doing" as const, order: 0 },
      { ...b, status: "backlog" as const, order: 0 },
    ];
    const gateway = fakeGateway({
      moveTicket: vi.fn<BoardGateway["moveTicket"]>(async () => ({
        ok: true,
        tickets: authoritative,
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a, b] }, {});

    await store.getState().moveTicket("p1", "a", "doing", 0);

    expect(gateway.moveTicket).toHaveBeenCalledWith({
      projectId: "p1",
      ticketId: "a",
      toStatus: "doing",
      toIndex: 0,
    });
    expect(store.getState().ticketsByProject.p1).toBe(authoritative);
  });

  it("is a no-op when the shared op reports an unchanged position", async () => {
    const a = ticket({ id: "a", status: "backlog", order: 0 });
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().moveTicket("p1", "a", "backlog", 0);

    expect(gateway.moveTicket).not.toHaveBeenCalled();
  });

  it("reverts to the pre-move snapshot and toasts on a typed failure", async () => {
    const a = ticket({ id: "a", status: "backlog", order: 0 });
    const b = ticket({ id: "b", status: "backlog", order: 1 });
    const before = [a, b];
    const gateway = fakeGateway({
      moveTicket: vi.fn<BoardGateway["moveTicket"]>(async () => ({ ok: false, error: "conflict" })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: before }, {});

    await store.getState().moveTicket("p1", "a", "doing", 0);

    expect(store.getState().ticketsByProject.p1).toEqual(before);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not move ticket: conflict");
  });

  it("reverts to the pre-move snapshot and toasts when the gateway call rejects", async () => {
    const a = ticket({ id: "a", status: "backlog", order: 0 });
    const before = [a];
    const gateway = fakeGateway({
      moveTicket: vi.fn<BoardGateway["moveTicket"]>(async () => {
        throw new Error("ipc gone");
      }),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: before }, {});

    await store.getState().moveTicket("p1", "a", "doing", 0);

    expect(store.getState().ticketsByProject.p1).toEqual(before);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not move ticket: ipc gone");
  });

  it("is a no-op for an unknown ticket id on an unhydrated project", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);

    await store.getState().moveTicket("p1", "does-not-exist", "doing", 0);

    expect(gateway.moveTicket).not.toHaveBeenCalled();
    expect(store.getState().ticketsByProject.p1).toBeUndefined();
  });
});

describe("setTicketPriority", () => {
  it("optimistically updates, then patches in the gateway's returned ticket by id", async () => {
    const a = ticket({ id: "a", status: "backlog", priority: "low" });
    const b = ticket({ id: "b", status: "backlog", priority: "low", order: 1 });
    const authoritative = { ...a, priority: "high" as const, updatedAt: 999 };
    const gateway = fakeGateway({
      setTicketPriority: vi.fn<BoardGateway["setTicketPriority"]>(async () => ({
        ok: true,
        ticket: authoritative,
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a, b] }, {});

    await store.getState().setTicketPriority("p1", "a", "high");

    expect(gateway.setTicketPriority).toHaveBeenCalledWith({ ticketId: "a", priority: "high" });
    // The returned ticket is patched in by id; the sibling card is untouched
    // (same reference — not clobbered by a wholesale slice replace).
    const result = store.getState().ticketsByProject.p1!;
    expect(result).toContainEqual(authoritative);
    expect(result.find((t) => t.id === "b")).toBe(b);
  });

  it("does not resurrect a project slice forgotten while the priority IPC is in flight", async () => {
    let resolvePriority!: (result: { ok: true; ticket: Ticket }) => void;
    const gateway = fakeGateway({
      setTicketPriority: vi.fn<BoardGateway["setTicketPriority"]>(
        () => new Promise((resolve) => (resolvePriority = resolve)),
      ),
    });
    const store = createBoardStore(gateway);
    const a = ticket({ id: "a", status: "backlog", priority: "low" });
    store.getState().hydrate({ p1: [a] }, {});

    const pending = store.getState().setTicketPriority("p1", "a", "high");
    store.getState().forget("p1"); // project removed mid-flight
    resolvePriority({ ok: true, ticket: { ...a, priority: "high" } });
    await pending;

    expect("p1" in store.getState().ticketsByProject).toBe(false);
  });

  it("is a no-op when the priority is unchanged", async () => {
    const a = ticket({ id: "a", status: "backlog", priority: "high" });
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().setTicketPriority("p1", "a", "high");

    expect(gateway.setTicketPriority).not.toHaveBeenCalled();
  });

  it("reverts and toasts on a typed failure", async () => {
    const a = ticket({ id: "a", status: "backlog", priority: "low" });
    const before = [a];
    const gateway = fakeGateway({
      setTicketPriority: vi.fn<BoardGateway["setTicketPriority"]>(async () => ({
        ok: false,
        error: "conflict",
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: before }, {});

    await store.getState().setTicketPriority("p1", "a", "high");

    expect(store.getState().ticketsByProject.p1).toEqual(before);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not update priority: conflict");
  });

  it("is a no-op for an unknown ticket id", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [ticket({ id: "a", status: "backlog" })] }, {});

    await store.getState().setTicketPriority("p1", "does-not-exist", "high");

    expect(gateway.setTicketPriority).not.toHaveBeenCalled();
  });

  it("is a no-op for an unknown ticket id on an unhydrated project", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);

    await store.getState().setTicketPriority("p1", "does-not-exist", "high");

    expect(gateway.setTicketPriority).not.toHaveBeenCalled();
    expect(store.getState().ticketsByProject.p1).toBeUndefined();
  });

  it("reverts to the pre-update snapshot and toasts when the gateway call rejects", async () => {
    const a = ticket({ id: "a", status: "backlog", priority: "low" });
    const before = [a];
    const gateway = fakeGateway({
      setTicketPriority: vi.fn<BoardGateway["setTicketPriority"]>(async () => {
        throw new Error("ipc gone");
      }),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: before }, {});

    await store.getState().setTicketPriority("p1", "a", "high");

    expect(store.getState().ticketsByProject.p1).toEqual(before);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not update priority: ipc gone");
  });
});

describe("setSearch", () => {
  it("sets the search string verbatim, initializing from EMPTY_TICKET_FILTER", () => {
    const store = createBoardStore(fakeGateway());

    store.getState().setSearch("p1", "  widget ");

    expect(store.getState().filterByProject.p1).toEqual({
      ...EMPTY_TICKET_FILTER,
      search: "  widget ",
    });
  });
});

describe("togglePriority", () => {
  it("adds then removes a priority from the facet", () => {
    const store = createBoardStore(fakeGateway());

    store.getState().togglePriority("p1", "high" as TicketPriority);
    expect(store.getState().filterByProject.p1!.priorities).toEqual(["high"]);

    store.getState().togglePriority("p1", "high" as TicketPriority);
    expect(store.getState().filterByProject.p1!.priorities).toEqual([]);
  });
});

describe("toggleLabel", () => {
  it("adds then removes a label from the facet", () => {
    const store = createBoardStore(fakeGateway());

    store.getState().toggleLabel("p1", "terminal");
    expect(store.getState().filterByProject.p1!.labels).toEqual(["terminal"]);

    store.getState().toggleLabel("p1", "terminal");
    expect(store.getState().filterByProject.p1!.labels).toEqual([]);
  });
});

describe("toggleHarness", () => {
  it("adds then removes a harness id from the facet", () => {
    const store = createBoardStore(fakeGateway());

    store.getState().toggleHarness("p1", "codex");
    expect(store.getState().filterByProject.p1!.harnessIds).toEqual(["codex"]);

    store.getState().toggleHarness("p1", "codex");
    expect(store.getState().filterByProject.p1!.harnessIds).toEqual([]);
  });
});

describe("clearFilter", () => {
  it("drops the project's filter record entirely", () => {
    const store = createBoardStore(fakeGateway());
    store.getState().togglePriority("p1", "high" as TicketPriority);

    store.getState().clearFilter("p1");

    expect(store.getState().filterByProject.p1).toBeUndefined();
  });

  it("is a no-op when there is no filter record for the project", () => {
    const store = createBoardStore(fakeGateway());
    const before = store.getState();

    store.getState().clearFilter("p1");

    expect(store.getState()).toBe(before);
  });
});

describe("selectTicket", () => {
  it("records the selected ticket id for the project", () => {
    const store = createBoardStore(fakeGateway());

    store.getState().selectTicket("p1", "t3");

    expect(store.getState().selectedByProject.p1).toBe("t3");
  });

  it("clears via null by dropping the project's record entirely", () => {
    const store = createBoardStore(fakeGateway());
    store.getState().selectTicket("p1", "t3");

    store.getState().selectTicket("p1", null);

    expect(store.getState().selectedByProject.p1).toBeUndefined();
    expect("p1" in store.getState().selectedByProject).toBe(false);
  });

  it("is a no-op (unchanged identity) when clearing with no selection", () => {
    const store = createBoardStore(fakeGateway());
    const before = store.getState();

    store.getState().selectTicket("p1", null);

    expect(store.getState()).toBe(before);
  });

  it("is a no-op (unchanged identity) when re-selecting the same ticket", () => {
    const store = createBoardStore(fakeGateway());
    store.getState().selectTicket("p1", "t3");
    const before = store.getState();

    store.getState().selectTicket("p1", "t3");

    expect(store.getState()).toBe(before);
  });

  it("keeps selections independent across projects", () => {
    const store = createBoardStore(fakeGateway());

    store.getState().selectTicket("p1", "t3");
    store.getState().selectTicket("p2", "o1");
    store.getState().selectTicket("p1", null);

    expect(store.getState().selectedByProject.p1).toBeUndefined();
    expect(store.getState().selectedByProject.p2).toBe("o1");
  });
});

describe("forget", () => {
  it("removes the ticket list, label list, filter record, and selection record", () => {
    const store = createBoardStore(fakeGateway());
    store
      .getState()
      .hydrate(
        { p1: [ticket({ id: "t1", status: "backlog" })] },
        { p1: [{ id: "l1", projectId: "p1", name: "bug", color: null }] },
      );
    store.getState().togglePriority("p1", "high" as TicketPriority);
    store.getState().selectTicket("p1", "t1");

    store.getState().forget("p1");

    expect(store.getState().ticketsByProject.p1).toBeUndefined();
    expect(store.getState().labelsByProject.p1).toBeUndefined();
    expect(store.getState().filterByProject.p1).toBeUndefined();
    expect(store.getState().selectedByProject.p1).toBeUndefined();
  });

  it("removes only the selection record when there is nothing else", () => {
    const store = createBoardStore(fakeGateway());
    store.getState().selectTicket("p1", "t1");

    store.getState().forget("p1");

    expect(store.getState().selectedByProject.p1).toBeUndefined();
  });

  it("removes only the ticket list when there is nothing else", () => {
    const store = createBoardStore(fakeGateway());
    store.getState().hydrate({ p1: [ticket({ id: "t1", status: "backlog" })] }, {});

    store.getState().forget("p1");

    expect(store.getState().ticketsByProject.p1).toBeUndefined();
  });

  it("removes only the filter record when there is no ticket list", () => {
    const store = createBoardStore(fakeGateway());
    store.getState().togglePriority("p1", "high" as TicketPriority);

    store.getState().forget("p1");

    expect(store.getState().filterByProject.p1).toBeUndefined();
  });

  it("is a no-op for a project with no tickets, labels, filter, or selection", () => {
    const store = createBoardStore(fakeGateway());
    const before = store.getState();

    store.getState().forget("p1");

    expect(store.getState()).toBe(before);
  });
});

describe("createBoardStore() with the default gateway", () => {
  // No fake gateway injected here — these exercise the real
  // `defaultGateway` wrappers (window.api.tickets.*), which every other
  // test in this file bypasses by always constructing with a fake.

  it("addTicket calls window.api.tickets.create", async () => {
    const create = vi.fn(
      async (input: { projectId: string; status: TicketStatus; title: string }) => ({
        ok: true as const,
        ticket: ticket({ projectId: input.projectId, status: input.status, title: input.title }),
      }),
    );
    vi.stubGlobal("window", {
      api: { tickets: { create, move: vi.fn(), setPriority: vi.fn() } },
    });
    const store = createBoardStore();

    await store.getState().addTicket("p1", "backlog", "New");

    expect(create).toHaveBeenCalledWith({
      projectId: "p1",
      status: "backlog",
      title: "New",
      priority: undefined,
    });
  });

  it("moveTicket calls window.api.tickets.move", async () => {
    const move = vi.fn(async () => ({ ok: true as const, tickets: [] }));
    vi.stubGlobal("window", {
      api: { tickets: { create: vi.fn(), move, setPriority: vi.fn() } },
    });
    const store = createBoardStore();
    const a = ticket({ id: "a", status: "backlog", order: 0 });
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().moveTicket("p1", "a", "doing", 0);

    expect(move).toHaveBeenCalledWith({
      projectId: "p1",
      ticketId: "a",
      toStatus: "doing",
      toIndex: 0,
    });
  });

  it("setTicketPriority calls window.api.tickets.setPriority", async () => {
    const setPriority = vi.fn(async () => ({
      ok: true as const,
      ticket: ticket({ id: "a", status: "backlog", priority: "high" as const }),
    }));
    vi.stubGlobal("window", {
      api: { tickets: { create: vi.fn(), move: vi.fn(), setPriority } },
    });
    const store = createBoardStore();
    const a = ticket({ id: "a", status: "backlog", priority: "low" });
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().setTicketPriority("p1", "a", "high");

    expect(setPriority).toHaveBeenCalledWith({ ticketId: "a", priority: "high" });
  });
});
