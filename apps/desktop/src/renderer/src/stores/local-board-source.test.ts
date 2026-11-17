/**
 * This Mac's board behind the board-source interface (VC-1260): the local IPC
 * adapter. Its writes' optimistic paint, reconcile and revert are exercised
 * through a real board store in `board.test.ts`; these are its own seams.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Label, Ticket } from "@volli/shared";

import { LocalBoardSource, restoreAt, type LocalBoardView } from "./local-board-source";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
});

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    projectId: "p1",
    ticketNumber: 1,
    title: id,
    body: "",
    status: "todo",
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

/** A view over one in-memory board of `p1`. */
function memoryView(
  tickets: Ticket[],
  labels: Label[] = [],
): LocalBoardView & {
  board: { tickets: Ticket[]; labels: Label[] };
} {
  const board = { tickets, labels };
  return {
    board,
    tickets: (projectId) => (projectId === "p1" ? board.tickets : undefined),
    setTickets: (_projectId, next) => void (board.tickets = next),
    reconcileTickets: (projectId, update) => {
      if (projectId === "p1") board.tickets = update(board.tickets);
    },
    labels: (projectId) => (projectId === "p1" ? board.labels : undefined),
    reconcileLabels: (projectId, update) => {
      if (projectId === "p1") board.labels = update(board.labels);
    },
    findTicket: (ticketId) => {
      const found = board.tickets.find(({ id }) => id === ticketId);
      return found === undefined ? undefined : { projectId: "p1", ticket: found };
    },
    markBodyLoaded: vi.fn(),
  };
}

describe("this Mac's board source", () => {
  it("holds no rows of its own: nothing to follow, open, close or adopt", async () => {
    const view = memoryView([ticket("a")]);
    const source = new LocalBoardSource(view);
    expect(source.deliversOwnRows).toBe(false);
    expect(source.follows("p1")).toBe(true);
    expect(source.projectOf("a")).toBe("p1");
    expect(source.projectOf("nowhere")).toBeUndefined();
    await expect(source.open("p1")).resolves.toBeUndefined();
    source.close("p1");
    source.closeAll();
    source.adoptBody("a", "body");
    expect(view.board.tickets).toEqual([ticket("a")]);
  });

  it("writes over window.api's own board channels, read when called", async () => {
    const answer = { ok: true, tickets: [] };
    const tickets = {
      create: vi.fn(async () => ({ ok: true, ticket: ticket("n") })),
      move: vi.fn(async () => answer),
      moveMany: vi.fn(async () => answer),
      setPriority: vi.fn(async () => ({ ok: true, ticket: ticket("a", { priority: "high" }) })),
      update: vi.fn(async () => ({ ok: true, ticket: ticket("a") })),
      setLabels: vi.fn(async () => ({ ok: true, ticket: ticket("a") })),
      archive: vi.fn(async () => ({ ok: true })),
      unarchive: vi.fn(async () => ({ ok: true, ticket: ticket("z") })),
      delete: vi.fn(async () => ({ ok: true })),
      listArchived: vi.fn(async () => ({ ok: true, tickets: [] })),
    };
    const labels = {
      setColor: vi.fn(async () => ({ ok: true, label: { id: "l", color: "red" } })),
    };
    const source = new LocalBoardSource(
      memoryView(
        [ticket("a"), ticket("b")],
        [{ id: "l", projectId: "p1", name: "x", color: null }],
      ),
    );
    vi.stubGlobal("window", { api: { tickets, labels } });

    await source.createTicket("p1", { status: "todo", title: "N" });
    await source.moveTicket("p1", "a", "doing", 0);
    // A group of one is still a group: the many-card channel, as ever.
    await source.moveTickets("p1", ["b"], "done", 0, "plain" as never);
    await source.setPriority("p1", "a", "high");
    await source.updateTicket("p1", { ticketId: "a", title: "T" });
    await source.setLabels("p1", "a", ["bug"]);
    await source.setLabelColor("p1", "l", "red");
    await source.archiveTicket("p1", "a");
    await source.unarchiveTicket("p1", { ...ticket("z"), archivedAt: 1 });
    await source.deleteTicket("p1", "z");
    await source.archivedTickets("p1");

    expect(tickets.create).toHaveBeenCalledOnce();
    expect(tickets.move).toHaveBeenCalledWith({
      projectId: "p1",
      ticketId: "a",
      toStatus: "doing",
      toIndex: 0,
    });
    expect(tickets.moveMany).toHaveBeenCalledWith({
      projectId: "p1",
      ticketIds: ["b"],
      toStatus: "done",
      toIndex: 0,
      choice: "plain",
    });
    expect(tickets.setPriority).toHaveBeenCalledWith({ ticketId: "a", priority: "high" });
    expect(tickets.update).toHaveBeenCalledWith({ ticketId: "a", title: "T" });
    expect(tickets.setLabels).toHaveBeenCalledWith({ ticketId: "a", labels: ["bug"] });
    expect(labels.setColor).toHaveBeenCalledWith({ labelId: "l", color: "red" });
    expect(tickets.archive).toHaveBeenCalledWith({ ticketId: "a" });
    expect(tickets.unarchive).toHaveBeenCalledWith({ ticketId: "z" });
    expect(tickets.delete).toHaveBeenCalledWith({ ticketId: "z" });
    expect(tickets.listArchived).toHaveBeenCalledWith("p1");
  });

  it("answers the board surfaces through window.api's own functions", async () => {
    const events = vi.fn(async () => "events");
    const body = vi.fn(async () => "body");
    const latestSignals = vi.fn(async () => "signals");
    const statusEntries = vi.fn(async () => "entries");
    const list = vi.fn(async () => "list");
    const create = vi.fn(async () => "create");
    const update = vi.fn(async () => "update");
    const remove = vi.fn(async () => "remove");
    const projectUpdate = vi.fn(async () => "project");
    const setSkillModes = vi.fn(async () => "modes");
    const setSessionDefaults = vi.fn(async () => "defaults");
    const checkFolder = vi.fn(async () => "folder");
    vi.stubGlobal("window", {
      api: {
        tickets: { events, body, latestSignals, statusEntries },
        comments: { list, create, update, remove },
        projects: { update: projectUpdate, setSkillModes, setSessionDefaults, checkFolder },
      },
    });
    const { api } = new LocalBoardSource(memoryView([]));
    expect(
      await Promise.all([
        api.tickets.events({ ticketId: "a" }),
        api.tickets.body({ ticketId: "a" }),
        api.tickets.latestSignals({ projectId: "p1" }),
        api.tickets.statusEntries({ projectId: "p1" }),
        api.comments.list({ ticketId: "a" }),
        api.comments.create({ ticketId: "a", body: "hi" }),
        api.comments.update({ commentId: "c", body: "edit" }),
        api.comments.remove({ commentId: "c" }),
        api.projects.update({ id: "p1", baseBranch: "main" }),
        api.projects.setSkillModes({ id: "p1", modes: {} }),
        api.projects.setSessionDefaults({ id: "p1", model: null }),
        api.projects.checkFolder("p1"),
      ]),
    ).toEqual([
      "events",
      "body",
      "signals",
      "entries",
      "list",
      "create",
      "update",
      "remove",
      "project",
      "modes",
      "defaults",
      "folder",
    ]);
    expect(projectUpdate).toHaveBeenCalledWith({ id: "p1", baseBranch: "main" });
    expect(checkFolder).toHaveBeenCalledWith("p1");
  });

  it("writes nothing for a ticket or label it cannot find, or a change that changes nothing", async () => {
    const gateway = {
      setPriority: vi.fn(),
      setColor: vi.fn(),
      archive: vi.fn(),
      update: vi.fn(),
    };
    vi.stubGlobal("window", {
      api: {
        tickets: {
          setPriority: gateway.setPriority,
          archive: gateway.archive,
          update: gateway.update,
        },
        labels: { setColor: gateway.setColor },
      },
    });
    const source = new LocalBoardSource(memoryView([ticket("a")]));
    await source.setPriority("p1", "nowhere", "high");
    await source.setPriority("p1", "a", "medium");
    await source.setPriority("gone", "a", "high");
    await source.setLabelColor("p1", "nope", "red");
    await source.setLabelColor("gone", "nope", "red");
    expect(await source.archiveTicket("p1", "nowhere")).toBe(false);
    expect(await source.archiveTicket("gone", "a")).toBe(false);
    expect(await source.updateTicket("p1", { ticketId: "nowhere", title: "T" })).toBeNull();
    for (const call of Object.values(gateway)) expect(call).not.toHaveBeenCalled();
  });
});

describe("restoreAt", () => {
  it("puts a ticket back at its index, clamped, unless it is already back", () => {
    const [a, b, c] = [ticket("a"), ticket("b"), ticket("c")];
    expect(restoreAt([a, c], b, 1)).toEqual([a, b, c]);
    expect(restoreAt([a], b, 9)).toEqual([a, b]);
    expect(restoreAt([a], b, -1)).toEqual([b, a]);
    const slice = [a, b];
    expect(restoreAt(slice, b, 0)).toBe(slice);
  });
});
