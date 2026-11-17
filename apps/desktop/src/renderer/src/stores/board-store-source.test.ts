/**
 * The board store across the {@link BoardSource} interface (VC-1260): every
 * write goes to the project's source, and the store keeps only what holds on
 * every source — its guards, the Archive slice, the selection, the terminals
 * an archive ends, and the placeholder-body marks. Each source's own
 * behaviour is tested beside it (`local-board-source`, `board-sync`,
 * `cloud-board/source`).
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ArchivedTicket, Label, Ticket, TicketStatus } from "@volli/shared";
import { toast } from "sonner";

import { killTicketSessions } from "@renderer/terminal/session-lifecycle";

import { createBoardStore } from "./board";
import type { BoardSource } from "./board-source";
import { useChatSessionsStore } from "./chat-sessions";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@renderer/terminal/session-lifecycle", () => ({ killTicketSessions: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function ticket(
  id: string,
  status: TicketStatus = "todo",
  overrides: Partial<Ticket> = {},
): Ticket {
  return {
    id,
    projectId: "p1",
    ticketNumber: 1,
    title: id,
    body: "",
    status,
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function archived(id: string): ArchivedTicket {
  return { ...ticket(id, "done"), archivedAt: 1 };
}

const bug: Label = { id: "l1", projectId: "p1", name: "bug", color: null };

/** An in-memory board source: answers each write as told, and records it. */
function memorySource(overrides: Partial<BoardSource> = {}): BoardSource {
  return {
    deliversOwnRows: false,
    api: {} as never,
    follows: vi.fn(() => true),
    projectOf: vi.fn(() => undefined),
    open: vi.fn(async () => {}),
    close: vi.fn(),
    closeAll: vi.fn(),
    adoptBody: vi.fn(),
    createTicket: vi.fn(async (_projectId, fields) => ticket("new", fields.status)),
    moveTicket: vi.fn(async () => {}),
    moveTickets: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    updateTicket: vi.fn(async (_projectId, input) => ticket(input.ticketId)),
    setLabels: vi.fn(async () => {}),
    setLabelColor: vi.fn(async () => {}),
    archiveTicket: vi.fn(async () => true),
    unarchiveTicket: vi.fn(async (_projectId, row) => ticket(row.id)),
    deleteTicket: vi.fn(async () => true),
    archivedTickets: vi.fn(async () => [archived("x")]),
    ...overrides,
  };
}

function storeOver(source: BoardSource) {
  const sourceFor = vi.fn((_projectId: string) => source);
  const store = createBoardStore(sourceFor);
  store.getState().hydrate({ p1: [ticket("a"), ticket("b", "doing")] }, { p1: [bug] });
  return { store, sourceFor };
}

describe("the board store's writes, through the project's source", () => {
  it("creates a trimmed ticket with only the options supplied, and none for a blank title", async () => {
    const source = memorySource();
    const { store } = storeOver(source);
    expect(await store.getState().addTicket("p1", "todo", "  ")).toBeNull();
    expect(source.createTicket).not.toHaveBeenCalled();

    const created = await store
      .getState()
      .addTicket("p1", "todo", "  Title ", { priority: "high", body: undefined });
    expect(created?.id).toBe("new");
    expect(source.createTicket).toHaveBeenCalledWith("p1", {
      status: "todo",
      title: "Title",
      priority: "high",
    });
  });

  it("moves one card as one card, and a group de-duplicated", async () => {
    const source = memorySource();
    const { store } = storeOver(source);
    await store.getState().moveTicket("p1", "a", "doing", 0, "plain" as never);
    await store.getState().moveTickets("p1", ["a", "b", "a"], "done", 1);
    expect(source.moveTicket).toHaveBeenCalledWith("p1", "a", "doing", 0, "plain");
    expect(source.moveTickets).toHaveBeenCalledWith("p1", ["a", "b"], "done", 1, undefined);
  });

  it("sets a priority only for a known ticket whose priority changes", async () => {
    const source = memorySource();
    const { store } = storeOver(source);
    await store.getState().setTicketPriority("p1", "nowhere", "high");
    await store.getState().setTicketPriority("p1", "a", "medium");
    expect(source.setPriority).not.toHaveBeenCalled();
    await store.getState().setTicketPriority("p1", "a", "high");
    expect(source.setPriority).toHaveBeenCalledWith("p1", "a", "high");
  });

  it("updates a known ticket by its project, and retires its placeholder mark once confirmed", async () => {
    const updateTicket = vi.fn<BoardSource["updateTicket"]>(async () => null);
    const source = memorySource({ updateTicket });
    const { store } = storeOver(source);
    store.setState({ unloadedTicketBodies: { a: true } });

    await store.getState().updateTicket({ ticketId: "nowhere", title: "No" });
    expect(updateTicket).not.toHaveBeenCalled();

    await store.getState().updateTicket({ ticketId: "a", title: "Refused" });
    expect(store.getState().unloadedTicketBodies).toEqual({ a: true });

    updateTicket.mockResolvedValueOnce(ticket("a"));
    await store.getState().updateTicket({ ticketId: "a", title: "T" });
    expect(store.getState().unloadedTicketBodies).toEqual({});
    expect(updateTicket.mock.calls).toEqual([
      ["p1", { ticketId: "a", title: "Refused" }],
      ["p1", { ticketId: "a", title: "T" }],
    ]);
  });

  it("sets a known ticket's labels by its project", async () => {
    const source = memorySource();
    const { store } = storeOver(source);
    await store.getState().setLabels("nowhere", ["bug"]);
    expect(source.setLabels).not.toHaveBeenCalled();
    await store.getState().setLabels("b", ["bug"]);
    expect(source.setLabels).toHaveBeenCalledWith("p1", "b", ["bug"]);
  });

  it("sets a known label's color only when it changes", async () => {
    const source = memorySource();
    const { store } = storeOver(source);
    await store.getState().setLabelColor("p1", "nope", "red");
    await store.getState().setLabelColor("p1", "l1", null);
    expect(source.setLabelColor).not.toHaveBeenCalled();
    await store.getState().setLabelColor("p1", "l1", "red");
    expect(source.setLabelColor).toHaveBeenCalledWith("p1", "l1", "red");
  });
});

describe("the archive, through the project's source", () => {
  it("loads a project's archive, unless the read failed or the project went meanwhile", async () => {
    const archivedTickets = vi.fn<BoardSource["archivedTickets"]>(async () => null);
    const { store } = storeOver(memorySource({ archivedTickets }));
    expect(await store.getState().loadArchived("p1")).toBe(false);
    expect(await store.getState().loadArchived("gone")).toBe(false);
    archivedTickets.mockResolvedValue([archived("x")]);
    expect(await store.getState().loadArchived("gone")).toBe(false);
    expect(await store.getState().loadArchived("p1")).toBe(true);
    expect(store.getState().archivedByProject).toEqual({ p1: [archived("x")] });
  });

  it("ends an archived ticket's terminals and selection only once its source confirms", async () => {
    const archiveTicket = vi.fn<BoardSource["archiveTicket"]>(async () => false);
    const { store } = storeOver(memorySource({ archiveTicket }));
    store.setState({
      archivedByProject: { p1: [archived("x")] },
      selectedByProject: { p1: ["a", "b"] },
    });

    await store.getState().archiveTicket("p1", "nowhere");
    expect(archiveTicket).not.toHaveBeenCalled();

    await store.getState().archiveTicket("p1", "a");
    expect(killTicketSessions).not.toHaveBeenCalled();
    expect(store.getState().selectedByProject).toEqual({ p1: ["a", "b"] });

    archiveTicket.mockResolvedValue(true);
    await store.getState().archiveTicket("p1", "a");
    expect(killTicketSessions).toHaveBeenCalledWith("a");
    // The cached archive is stale now, and the card leaves the selection.
    expect(store.getState().archivedByProject).toEqual({});
    expect(store.getState().selectedByProject).toEqual({ p1: ["b"] });
    await store.getState().archiveTicket("p1", "b");
    expect(store.getState().selectedByProject).toEqual({});
  });

  it("restores an archived ticket, putting it back in its archive slot when refused", async () => {
    const unarchiveTicket = vi.fn<BoardSource["unarchiveTicket"]>(async () => null);
    const { store } = storeOver(memorySource({ unarchiveTicket }));
    store.setState({ archivedByProject: { p1: [archived("w"), archived("x"), archived("y")] } });

    await store.getState().unarchiveTicket("p1", "nowhere");
    expect(unarchiveTicket).not.toHaveBeenCalled();

    const pending = store.getState().unarchiveTicket("p1", "x");
    expect(store.getState().archivedByProject.p1?.map(({ id }) => id)).toEqual(["w", "y"]);
    await pending;
    expect(unarchiveTicket).toHaveBeenCalledWith("p1", archived("x"));
    expect(store.getState().archivedByProject.p1?.map(({ id }) => id)).toEqual(["w", "x", "y"]);

    // A refetch that re-listed it while the restore was in flight loses to the confirmation.
    unarchiveTicket.mockImplementationOnce(async () => {
      store.setState({ archivedByProject: { p1: [archived("w"), archived("x"), archived("y")] } });
      return ticket("x");
    });
    await store.getState().unarchiveTicket("p1", "x");
    expect(store.getState().archivedByProject.p1?.map(({ id }) => id)).toEqual(["w", "y"]);
  });

  it("deletes an archived ticket for good, and its terminals and chat provenance with it", async () => {
    const deleteTicket = vi.fn<BoardSource["deleteTicket"]>(async () => false);
    const { store } = storeOver(memorySource({ deleteTicket }));
    const clear = vi.spyOn(useChatSessionsStore.getState(), "clearRehomedTicketProvenance");
    store.setState({ archivedByProject: { p1: [archived("w"), archived("x")] } });

    await store.getState().deleteArchivedTicket("p1", "nowhere");
    expect(deleteTicket).not.toHaveBeenCalled();

    await store.getState().deleteArchivedTicket("p1", "w");
    expect(store.getState().archivedByProject.p1?.map(({ id }) => id)).toEqual(["w", "x"]);
    expect(killTicketSessions).not.toHaveBeenCalled();

    deleteTicket.mockImplementationOnce(async () => {
      store.setState({ archivedByProject: { p1: [archived("w"), archived("x")] } });
      return true;
    });
    await store.getState().deleteArchivedTicket("p1", "w");
    expect(store.getState().archivedByProject.p1?.map(({ id }) => id)).toEqual(["x"]);
    expect(killTicketSessions).toHaveBeenCalledWith("w");
    expect(clear).toHaveBeenCalledWith("w");
  });
});

describe("following a project's board through its source", () => {
  it("keeps on a wholesale hydrate only the boards whose source delivers its own rows", () => {
    const own = memorySource({ deliversOwnRows: true });
    const mine = memorySource();
    const store = createBoardStore((projectId) => (projectId === "remote" ? own : mine));
    const remote = ticket("r");
    store.getState().paintBoard("remote", [remote], [], new Set());
    store.getState().paintBoard("forgotten", [ticket("f")], [], new Set());
    store.getState().hydrate({ p1: [] }, { p1: [] });
    expect(store.getState().ticketsByProject).toEqual({ p1: [], remote: [remote] });
  });

  it("opens a new project's board on a source not following it yet, and says when it cannot", async () => {
    const open = vi.fn<BoardSource["open"]>(async () => {
      throw new Error("host gone");
    });
    const source = memorySource({ follows: vi.fn((projectId) => projectId === "followed"), open });
    const { store } = storeOver(source);
    store.getState().seedProject("followed");
    store.getState().seedProject("p1");
    expect(open).not.toHaveBeenCalled();
    store.getState().seedProject("fresh");
    expect(open).toHaveBeenCalledWith("fresh");
    await vi.waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Couldn't open the board: host gone",
        expect.anything(),
      ),
    );
  });

  it("hands a body read on its own to the source, and closes a forgotten project's board", () => {
    const source = memorySource();
    const { store } = storeOver(source);
    store.getState().adoptTicketBody("p1", "a", "body");
    expect(source.adoptBody).toHaveBeenCalledWith("a", "body");
    store.getState().forget("p1");
    expect(source.close).toHaveBeenCalledWith("p1");
  });
});
