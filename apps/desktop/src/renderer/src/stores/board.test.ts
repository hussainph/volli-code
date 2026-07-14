import {
  EMPTY_TICKET_FILTER,
  type ArchivedTicket,
  type Label,
  type Ticket,
  type TicketPriority,
  type TicketResult,
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
    worktreePath: overrides.worktreePath ?? null,
    branch: overrides.branch ?? null,
    baseBranch: overrides.baseBranch ?? null,
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
  };
}

/** An archived ticket fixture: a live ticket plus its `archivedAt` stamp. */
function archivedTicket(
  overrides: Partial<ArchivedTicket> & { status: TicketStatus },
): ArchivedTicket {
  return { ...ticket(overrides), archivedAt: overrides.archivedAt ?? 0 };
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
  const updateTicket = vi.fn<BoardGateway["updateTicket"]>(async (input) => ({
    ok: true,
    ticket: ticket({
      id: input.ticketId,
      status: "backlog",
      title: input.title,
      body: input.body,
      worktreePath: input.worktreePath,
      branch: input.branch,
      baseBranch: input.baseBranch,
    }),
  }));
  const setLabels = vi.fn<BoardGateway["setLabels"]>(async (input) => ({
    ok: true,
    ticket: ticket({ id: input.ticketId, status: "backlog", labels: input.labels }),
  }));
  const archiveTicket = vi.fn<BoardGateway["archiveTicket"]>(async () => ({ ok: true }));
  const unarchiveTicket = vi.fn<BoardGateway["unarchiveTicket"]>(async (input) => ({
    ok: true,
    ticket: ticket({ id: input.ticketId, status: "backlog" }),
  }));
  const deleteTicket = vi.fn<BoardGateway["deleteTicket"]>(async () => ({ ok: true }));
  const listArchived = vi.fn<BoardGateway["listArchived"]>(async () => ({ ok: true, tickets: [] }));
  return {
    createTicket,
    moveTicket,
    setTicketPriority,
    updateTicket,
    setLabels,
    archiveTicket,
    unarchiveTicket,
    deleteTicket,
    listArchived,
    ...overrides,
  };
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

  it("does not resurrect a project slice forgotten while the create IPC was in flight", async () => {
    let resolveCreate!: (result: { ok: true; ticket: Ticket }) => void;
    const gateway = fakeGateway({
      createTicket: vi.fn<BoardGateway["createTicket"]>(
        () => new Promise((resolve) => (resolveCreate = resolve)),
      ),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [] }, {});

    const pending = store.getState().addTicket("p1", "todo", "New");
    store.getState().forget("p1"); // project removed mid-flight (row cascade-deleted)
    resolveCreate({ ok: true, ticket: ticket({ id: "new-1", status: "todo" }) });
    await pending;

    expect("p1" in store.getState().ticketsByProject).toBe(false);
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

  it("preserves a ticket created while the move IPC was in flight when the move then fails", async () => {
    const a = ticket({ id: "a", status: "backlog", order: 0 });
    let rejectMove!: (result: { ok: false; error: string }) => void;
    const gateway = fakeGateway({
      moveTicket: vi.fn<BoardGateway["moveTicket"]>(
        () => new Promise((resolve) => (rejectMove = resolve)),
      ),
      createTicket: vi.fn<BoardGateway["createTicket"]>(async () => ({
        ok: true,
        ticket: ticket({ id: "c", status: "backlog", order: 1 }),
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    const move = store.getState().moveTicket("p1", "a", "doing", 0);
    await store.getState().addTicket("p1", "backlog", "C"); // lands mid-flight
    rejectMove({ ok: false, error: "conflict" });
    await move;

    // The move reverted, but the concurrently-created ticket is NOT dropped —
    // the pre-fix wholesale `set(previous)` revert lost it (it exists in SQLite).
    const ids = store
      .getState()
      .ticketsByProject.p1!.map((t) => t.id)
      .toSorted();
    expect(ids).toEqual(["a", "c"]);
  });

  it("does not resurrect a project slice forgotten while the move IPC was in flight", async () => {
    const a = ticket({ id: "a", status: "backlog", order: 0 });
    let resolveMove!: (result: { ok: true; tickets: Ticket[] }) => void;
    const gateway = fakeGateway({
      moveTicket: vi.fn<BoardGateway["moveTicket"]>(
        () => new Promise((resolve) => (resolveMove = resolve)),
      ),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a, ticket({ id: "b", status: "backlog", order: 1 })] }, {});

    const move = store.getState().moveTicket("p1", "a", "doing", 0);
    store.getState().forget("p1"); // project removed mid-flight
    resolveMove({ ok: true, tickets: [{ ...a, status: "doing", order: 0 }] });
    await move;

    expect("p1" in store.getState().ticketsByProject).toBe(false);
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

describe("updateTicket", () => {
  it("locates the ticket's project without being told it, optimistically patches only the given fields, then reconciles with the gateway's ticket", async () => {
    const a = ticket({
      id: "a",
      projectId: "p1",
      status: "backlog",
      title: "Old",
      body: "old body",
    });
    const b = ticket({ id: "b", projectId: "p1", status: "backlog", order: 1 });
    const authoritative = { ...a, branch: "volli/VC-1-thing", updatedAt: 999 };
    const gateway = fakeGateway({
      updateTicket: vi.fn<BoardGateway["updateTicket"]>(async () => ({
        ok: true,
        ticket: authoritative,
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a, b] }, {});

    await store.getState().updateTicket({ ticketId: "a", branch: "volli/VC-1-thing" });

    expect(gateway.updateTicket).toHaveBeenCalledWith({
      ticketId: "a",
      branch: "volli/VC-1-thing",
    });
    const result = store.getState().ticketsByProject.p1!;
    expect(result).toContainEqual(authoritative);
    // The sibling card is untouched — same reference, not clobbered by a
    // wholesale slice replace.
    expect(result.find((t) => t.id === "b")).toBe(b);
  });

  it("optimistically clears a field when explicitly passed null", () => {
    const a = ticket({ id: "a", projectId: "p1", status: "backlog", branch: "volli/VC-1-thing" });
    const gateway = fakeGateway({
      // Never resolves — these tests inspect only the synchronous optimistic
      // patch, which runs before the gateway call's `await` (same trick as
      // `setTicketPriority`'s own pre-await `set()`).
      updateTicket: vi.fn<BoardGateway["updateTicket"]>(() => new Promise<TicketResult>(() => {})),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    void store.getState().updateTicket({ ticketId: "a", branch: null });

    expect(store.getState().ticketsByProject.p1?.[0]?.branch).toBeNull();
  });

  it("leaves fields the caller didn't pass untouched in the optimistic patch", () => {
    const a = ticket({
      id: "a",
      projectId: "p1",
      status: "backlog",
      title: "Old",
      body: "keep me",
    });
    const gateway = fakeGateway({
      updateTicket: vi.fn<BoardGateway["updateTicket"]>(() => new Promise<TicketResult>(() => {})),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    void store.getState().updateTicket({ ticketId: "a", title: "New" });

    const patched = store.getState().ticketsByProject.p1?.[0];
    expect(patched?.title).toBe("New");
    expect(patched?.body).toBe("keep me");
  });

  it("is a no-op (no IPC call) for an unknown ticket id", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [ticket({ id: "a", status: "backlog" })] }, {});

    await store.getState().updateTicket({ ticketId: "does-not-exist", title: "New" });

    expect(gateway.updateTicket).not.toHaveBeenCalled();
  });

  it("reverts to the original ticket and toasts on a typed failure", async () => {
    const a = ticket({ id: "a", projectId: "p1", status: "backlog", title: "Old" });
    const gateway = fakeGateway({
      updateTicket: vi.fn<BoardGateway["updateTicket"]>(async () => ({
        ok: false,
        error: "conflict",
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().updateTicket({ ticketId: "a", title: "New" });

    expect(store.getState().ticketsByProject.p1?.[0]).toEqual(a);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not update ticket: conflict");
  });

  it("reverts to the original ticket and toasts when the gateway call rejects", async () => {
    const a = ticket({ id: "a", projectId: "p1", status: "backlog", title: "Old" });
    const gateway = fakeGateway({
      updateTicket: vi.fn<BoardGateway["updateTicket"]>(async () => {
        throw new Error("ipc gone");
      }),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().updateTicket({ ticketId: "a", title: "New" });

    expect(store.getState().ticketsByProject.p1?.[0]).toEqual(a);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not update ticket: ipc gone");
  });

  it("does not resurrect a project slice forgotten while the update IPC was in flight", async () => {
    let resolveUpdate!: (result: { ok: true; ticket: Ticket }) => void;
    const a = ticket({ id: "a", projectId: "p1", status: "backlog" });
    const gateway = fakeGateway({
      updateTicket: vi.fn<BoardGateway["updateTicket"]>(
        () => new Promise((resolve) => (resolveUpdate = resolve)),
      ),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    const pending = store.getState().updateTicket({ ticketId: "a", title: "New" });
    store.getState().forget("p1"); // project removed mid-flight
    resolveUpdate({ ok: true, ticket: { ...a, title: "New" } });
    await pending;

    expect("p1" in store.getState().ticketsByProject).toBe(false);
  });
});

describe("setLabels", () => {
  it("locates the ticket's project without being told it, optimistically replaces the label set, then reconciles with the gateway's ticket", async () => {
    const a = ticket({ id: "a", projectId: "p1", status: "backlog", labels: ["bug"] });
    const b = ticket({ id: "b", projectId: "p1", status: "backlog", order: 1 });
    const authoritative = { ...a, labels: ["bug", "urgent"], updatedAt: 999 };
    const gateway = fakeGateway({
      setLabels: vi.fn<BoardGateway["setLabels"]>(async () => ({
        ok: true,
        ticket: authoritative,
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a, b] }, {});

    await store.getState().setLabels("a", ["bug", "urgent"]);

    expect(gateway.setLabels).toHaveBeenCalledWith({ ticketId: "a", labels: ["bug", "urgent"] });
    const result = store.getState().ticketsByProject.p1!;
    expect(result).toContainEqual(authoritative);
    expect(result.find((t) => t.id === "b")).toBe(b);
  });

  it("is a no-op (no IPC call) for an unknown ticket id", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [ticket({ id: "a", status: "backlog" })] }, {});

    await store.getState().setLabels("does-not-exist", ["bug"]);

    expect(gateway.setLabels).not.toHaveBeenCalled();
  });

  it("reverts to the original labels and toasts on a typed failure", async () => {
    const a = ticket({ id: "a", projectId: "p1", status: "backlog", labels: ["bug"] });
    const gateway = fakeGateway({
      setLabels: vi.fn<BoardGateway["setLabels"]>(async () => ({ ok: false, error: "conflict" })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().setLabels("a", ["bug", "urgent"]);

    expect(store.getState().ticketsByProject.p1?.[0]?.labels).toEqual(["bug"]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not update labels: conflict");
  });

  it("reverts to the original labels and toasts when the gateway call rejects", async () => {
    const a = ticket({ id: "a", projectId: "p1", status: "backlog", labels: ["bug"] });
    const gateway = fakeGateway({
      setLabels: vi.fn<BoardGateway["setLabels"]>(async () => {
        throw new Error("ipc gone");
      }),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().setLabels("a", ["bug", "urgent"]);

    expect(store.getState().ticketsByProject.p1?.[0]?.labels).toEqual(["bug"]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not update labels: ipc gone");
  });
});

describe("loadArchived", () => {
  it("fetches the project's archived tickets into archivedByProject", async () => {
    const archived = [archivedTicket({ id: "a", status: "done", archivedAt: 5 })];
    const gateway = fakeGateway({
      listArchived: vi.fn<BoardGateway["listArchived"]>(async () => ({
        ok: true,
        tickets: archived,
      })),
    });
    const store = createBoardStore(gateway);

    const ok = await store.getState().loadArchived("p1");

    expect(ok).toBe(true);
    expect(gateway.listArchived).toHaveBeenCalledWith("p1");
    expect(store.getState().archivedByProject.p1).toBe(archived);
  });

  it("resolves false, toasts, and leaves the slice unset on a typed failure", async () => {
    const gateway = fakeGateway({
      listArchived: vi.fn<BoardGateway["listArchived"]>(async () => ({
        ok: false,
        error: "db locked",
      })),
    });
    const store = createBoardStore(gateway);

    const ok = await store.getState().loadArchived("p1");

    expect(ok).toBe(false);
    expect(store.getState().archivedByProject.p1).toBeUndefined();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not load archive: db locked");
  });
});

describe("archiveTicket", () => {
  it("optimistically removes the card from the board", async () => {
    const a = ticket({ id: "a", status: "doing" });
    const b = ticket({ id: "b", status: "doing", order: 1 });
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a, b] }, {});

    await store.getState().archiveTicket("p1", "a");

    expect(gateway.archiveTicket).toHaveBeenCalledWith({ ticketId: "a" });
    expect(store.getState().ticketsByProject.p1!.map((t) => t.id)).toEqual(["b"]);
  });

  it("drops any cached Archive slice so it refetches fresh on next open", async () => {
    const a = ticket({ id: "a", status: "done" });
    const store = createBoardStore(fakeGateway());
    store.getState().hydrate({ p1: [a] }, {});
    // Pretend the Archive view was opened earlier and cached a (now-stale) slice.
    store.setState({ archivedByProject: { p1: [] } });

    await store.getState().archiveTicket("p1", "a");

    expect("p1" in store.getState().archivedByProject).toBe(false);
  });

  it("is a no-op for an unknown ticket id (no IPC call)", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [ticket({ id: "a", status: "doing" })] }, {});

    await store.getState().archiveTicket("p1", "does-not-exist");

    expect(gateway.archiveTicket).not.toHaveBeenCalled();
  });

  it("reverts the card onto the board and toasts on a typed failure", async () => {
    const a = ticket({ id: "a", status: "doing" });
    const gateway = fakeGateway({
      archiveTicket: vi.fn<BoardGateway["archiveTicket"]>(async () => ({
        ok: false,
        error: "conflict",
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().archiveTicket("p1", "a");

    expect(store.getState().ticketsByProject.p1!.map((t) => t.id)).toEqual(["a"]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not archive ticket: conflict");
  });

  it("clears the selection when the archived card was selected", async () => {
    const a = ticket({ id: "a", status: "doing" });
    const b = ticket({ id: "b", status: "doing", order: 1 });
    const store = createBoardStore(fakeGateway());
    store.getState().hydrate({ p1: [a, b] }, {});
    store.getState().selectTicket("p1", "a");

    await store.getState().archiveTicket("p1", "a");

    expect(store.getState().selectedByProject.p1).toBeNull();
  });

  it("keeps the selection when a different card is archived", async () => {
    const a = ticket({ id: "a", status: "doing" });
    const b = ticket({ id: "b", status: "doing", order: 1 });
    const store = createBoardStore(fakeGateway());
    store.getState().hydrate({ p1: [a, b] }, {});
    store.getState().selectTicket("p1", "b");

    await store.getState().archiveTicket("p1", "a");

    expect(store.getState().selectedByProject.p1).toBe("b");
  });

  it("re-drops the card when a concurrent move's authoritative list resurrected it mid-flight", async () => {
    const a = ticket({ id: "a", status: "doing" });
    const b = ticket({ id: "b", status: "doing", order: 1 });
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a, b] }, {});
    // A move IPC snapshotted while `a` was still live lands between the
    // optimistic drop and the archive ack — mergeAuthoritative puts `a` back.
    vi.mocked(gateway.archiveTicket).mockImplementation(async () => {
      store.setState({ ticketsByProject: { p1: [a, b] } });
      return { ok: true };
    });

    await store.getState().archiveTicket("p1", "a");

    expect(store.getState().ticketsByProject.p1!.map((t) => t.id)).toEqual(["b"]);
  });

  it("does not duplicate the card when a concurrent mutation already restored it before a failed archive", async () => {
    const a = ticket({ id: "a", status: "doing" });
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [a] }, {});
    // A concurrent authoritative merge put `a` back before the failure lands —
    // the revert must be a no-op, not a second copy.
    vi.mocked(gateway.archiveTicket).mockImplementation(async () => {
      store.setState({ ticketsByProject: { p1: [a] } });
      return { ok: false, error: "conflict" };
    });

    await store.getState().archiveTicket("p1", "a");

    expect(store.getState().ticketsByProject.p1!.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("unarchiveTicket", () => {
  it("drops the ticket from the Archive slice and appends the revived live ticket to the board", async () => {
    const revived = ticket({ id: "a", status: "done", title: "Revived" });
    const gateway = fakeGateway({
      unarchiveTicket: vi.fn<BoardGateway["unarchiveTicket"]>(async () => ({
        ok: true,
        ticket: revived,
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [] }, {});
    store.setState({ archivedByProject: { p1: [archivedTicket({ id: "a", status: "done" })] } });

    await store.getState().unarchiveTicket("p1", "a");

    expect(gateway.unarchiveTicket).toHaveBeenCalledWith({ ticketId: "a" });
    expect(store.getState().archivedByProject.p1).toEqual([]);
    expect(store.getState().ticketsByProject.p1).toContain(revived);
  });

  it("restores the ticket to the Archive slice and toasts on a typed failure", async () => {
    const archived = archivedTicket({ id: "a", status: "done" });
    const gateway = fakeGateway({
      unarchiveTicket: vi.fn<BoardGateway["unarchiveTicket"]>(async () => ({
        ok: false,
        error: "conflict",
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [] }, {});
    store.setState({ archivedByProject: { p1: [archived] } });

    await store.getState().unarchiveTicket("p1", "a");

    expect(store.getState().archivedByProject.p1!.map((t) => t.id)).toEqual(["a"]);
    expect(store.getState().ticketsByProject.p1).toEqual([]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not unarchive ticket: conflict");
  });

  it("restores the ticket at its original slot on failure (newest-first order kept)", async () => {
    const x = archivedTicket({ id: "x", status: "done", archivedAt: 3 });
    const y = archivedTicket({ id: "y", status: "done", archivedAt: 2 });
    const z = archivedTicket({ id: "z", status: "done", archivedAt: 1 });
    const gateway = fakeGateway({
      unarchiveTicket: vi.fn<BoardGateway["unarchiveTicket"]>(async () => ({
        ok: false,
        error: "conflict",
      })),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [] }, {});
    store.setState({ archivedByProject: { p1: [x, y, z] } });

    await store.getState().unarchiveTicket("p1", "y");

    expect(store.getState().archivedByProject.p1!.map((t) => t.id)).toEqual(["x", "y", "z"]);
  });

  it("re-drops the ticket when an in-flight Archive refetch re-listed it mid-flight", async () => {
    const archived = archivedTicket({ id: "a", status: "done" });
    const revived = ticket({ id: "a", status: "done" });
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    // The board already holds the revived ticket (e.g. the same race healed a
    // moment earlier) — the success append must dedupe, not double it.
    store.getState().hydrate({ p1: [revived] }, {});
    store.setState({ archivedByProject: { p1: [archived] } });
    // A loadArchived refetch snapshotted before the unarchive committed lands
    // between the optimistic drop and the ack, wholesale-setting the stale list.
    vi.mocked(gateway.unarchiveTicket).mockImplementation(async () => {
      store.setState({ archivedByProject: { p1: [archived] } });
      return { ok: true, ticket: revived };
    });

    await store.getState().unarchiveTicket("p1", "a");

    expect(store.getState().archivedByProject.p1).toEqual([]);
    expect(store.getState().ticketsByProject.p1!.map((t) => t.id)).toEqual(["a"]);
  });

  it("is a no-op for a ticket not in the loaded Archive slice (no IPC call)", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.setState({ archivedByProject: { p1: [archivedTicket({ id: "a", status: "done" })] } });

    await store.getState().unarchiveTicket("p1", "does-not-exist");

    expect(gateway.unarchiveTicket).not.toHaveBeenCalled();
  });

  it("does not resurrect an Archive slice forgotten while the unarchive was in flight", async () => {
    let settle!: (result: { ok: false; error: string }) => void;
    const gateway = fakeGateway({
      unarchiveTicket: vi.fn<BoardGateway["unarchiveTicket"]>(
        () => new Promise((resolve) => (settle = resolve)),
      ),
    });
    const store = createBoardStore(gateway);
    store.getState().hydrate({ p1: [] }, {});
    store.setState({ archivedByProject: { p1: [archivedTicket({ id: "a", status: "done" })] } });

    const pending = store.getState().unarchiveTicket("p1", "a");
    store.getState().forget("p1"); // project removed mid-flight
    settle({ ok: false, error: "conflict" });
    await pending;

    expect("p1" in store.getState().archivedByProject).toBe(false);
  });
});

describe("deleteArchivedTicket", () => {
  it("optimistically removes the ticket from the Archive slice", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.setState({
      archivedByProject: {
        p1: [
          archivedTicket({ id: "a", status: "done" }),
          archivedTicket({ id: "b", status: "done" }),
        ],
      },
    });

    await store.getState().deleteArchivedTicket("p1", "a");

    expect(gateway.deleteTicket).toHaveBeenCalledWith({ ticketId: "a" });
    expect(store.getState().archivedByProject.p1!.map((t) => t.id)).toEqual(["b"]);
  });

  it("restores the ticket to the Archive slice and toasts on a typed failure", async () => {
    const gateway = fakeGateway({
      deleteTicket: vi.fn<BoardGateway["deleteTicket"]>(async () => ({
        ok: false,
        error: "db locked",
      })),
    });
    const store = createBoardStore(gateway);
    store.setState({ archivedByProject: { p1: [archivedTicket({ id: "a", status: "done" })] } });

    await store.getState().deleteArchivedTicket("p1", "a");

    expect(store.getState().archivedByProject.p1!.map((t) => t.id)).toEqual(["a"]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Could not delete ticket: db locked");
  });

  it("is a no-op for a ticket not in the loaded Archive slice (no second IPC on a double-fire)", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);
    store.setState({ archivedByProject: { p1: [archivedTicket({ id: "a", status: "done" })] } });

    await store.getState().deleteArchivedTicket("p1", "does-not-exist");

    expect(gateway.deleteTicket).not.toHaveBeenCalled();
  });
});

describe("archive lifecycle on a project with no loaded state", () => {
  it("archive/unarchive/delete all no-op without an IPC call", async () => {
    const gateway = fakeGateway();
    const store = createBoardStore(gateway);

    await store.getState().archiveTicket("nope", "a");
    await store.getState().unarchiveTicket("nope", "a");
    await store.getState().deleteArchivedTicket("nope", "a");

    expect(gateway.archiveTicket).not.toHaveBeenCalled();
    expect(gateway.unarchiveTicket).not.toHaveBeenCalled();
    expect(gateway.deleteTicket).not.toHaveBeenCalled();
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

  it("drops a loaded Archive slice too", () => {
    const store = createBoardStore(fakeGateway());
    store.setState({ archivedByProject: { p1: [archivedTicket({ id: "a", status: "done" })] } });

    store.getState().forget("p1");

    expect(store.getState().archivedByProject.p1).toBeUndefined();
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

  it("updateTicket calls window.api.tickets.update", async () => {
    const update = vi.fn(async () => ({
      ok: true as const,
      ticket: ticket({ id: "a", status: "backlog", branch: "volli/VC-1-thing" }),
    }));
    vi.stubGlobal("window", { api: { tickets: { update } } });
    const store = createBoardStore();
    const a = ticket({ id: "a", projectId: "p1", status: "backlog" });
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().updateTicket({ ticketId: "a", branch: "volli/VC-1-thing" });

    expect(update).toHaveBeenCalledWith({ ticketId: "a", branch: "volli/VC-1-thing" });
  });

  it("setLabels calls window.api.tickets.setLabels", async () => {
    const setLabels = vi.fn(async () => ({
      ok: true as const,
      ticket: ticket({ id: "a", status: "backlog", labels: ["bug"] }),
    }));
    vi.stubGlobal("window", { api: { tickets: { setLabels } } });
    const store = createBoardStore();
    const a = ticket({ id: "a", projectId: "p1", status: "backlog" });
    store.getState().hydrate({ p1: [a] }, {});

    await store.getState().setLabels("a", ["bug"]);

    expect(setLabels).toHaveBeenCalledWith({ ticketId: "a", labels: ["bug"] });
  });

  it("archiveTicket calls window.api.tickets.archive", async () => {
    const archive = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { api: { tickets: { archive } } });
    const store = createBoardStore();
    store.getState().hydrate({ p1: [ticket({ id: "a", status: "doing" })] }, {});

    await store.getState().archiveTicket("p1", "a");

    expect(archive).toHaveBeenCalledWith({ ticketId: "a" });
  });

  it("unarchiveTicket calls window.api.tickets.unarchive", async () => {
    const unarchive = vi.fn(async () => ({
      ok: true as const,
      ticket: ticket({ id: "a", status: "done" }),
    }));
    vi.stubGlobal("window", { api: { tickets: { unarchive } } });
    const store = createBoardStore();
    store.getState().hydrate({ p1: [] }, {});
    store.setState({ archivedByProject: { p1: [archivedTicket({ id: "a", status: "done" })] } });

    await store.getState().unarchiveTicket("p1", "a");

    expect(unarchive).toHaveBeenCalledWith({ ticketId: "a" });
  });

  it("deleteArchivedTicket calls window.api.tickets.delete", async () => {
    const del = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { api: { tickets: { delete: del } } });
    const store = createBoardStore();
    store.setState({ archivedByProject: { p1: [archivedTicket({ id: "a", status: "done" })] } });

    await store.getState().deleteArchivedTicket("p1", "a");

    expect(del).toHaveBeenCalledWith({ ticketId: "a" });
  });

  it("loadArchived calls window.api.tickets.listArchived", async () => {
    const listArchived = vi.fn(async () => ({ ok: true as const, tickets: [] }));
    vi.stubGlobal("window", { api: { tickets: { listArchived } } });
    const store = createBoardStore();

    await store.getState().loadArchived("p1");

    expect(listArchived).toHaveBeenCalledWith("p1");
  });
});
