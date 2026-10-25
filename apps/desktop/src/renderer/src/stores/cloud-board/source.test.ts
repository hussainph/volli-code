import { describe, expect, it, vi } from "vite-plus/test";

import { fakeCloud, refusal } from "./fake-cloud.test-support";
import {
  ARCHIVE_PAGES_MAX,
  CLOUD_WRITES_UNAVAILABLE,
  ConvexBoardSource,
  cloudFailure,
  type CloudBoardView,
} from "./source";
import type { CloudTicketRow } from "./projection";

const P = "p1";

function row(n: number, overrides: Partial<CloudTicketRow> = {}): CloudTicketRow {
  return {
    id: `t${n}`,
    projectId: P,
    number: n,
    title: `T${n}`,
    status: "todo",
    priority: "medium",
    position: `a${n}`,
    labelIds: [],
    checkoutMode: "worktree",
    preferredHarnessId: "claude-code",
    branch: null,
    baseBranch: null,
    pullRequests: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function view() {
  return {
    paint: vi.fn<CloudBoardView["paint"]>(),
    notePlanningChange: vi.fn<CloudBoardView["notePlanningChange"]>(),
    failed: vi.fn<CloudBoardView["failed"]>(),
    refused: vi.fn<CloudBoardView["refused"]>(),
    dropped: vi.fn<CloudBoardView["dropped"]>(),
  };
}

function setup() {
  const cloud = fakeCloud();
  const screen = view();
  const source = new ConvexBoardSource(screen);
  return { cloud, screen, source };
}

describe("the cloud board source (VC-889)", () => {
  it("watches a board opened before the client arrives, and paints each answer", async () => {
    const { cloud, screen, source } = setup();
    await source.open(P);
    await source.open(P);
    expect(source.follows(P)).toBe(true);
    expect(cloud.watchers("board:roster", { projectId: P })).toBe(0);
    source.attach(cloud.session);
    expect(cloud.watchers("board:roster", { projectId: P })).toBe(1);
    expect(screen.paint).not.toHaveBeenCalled();

    cloud.answer("board:roster", { projectId: P }, { tickets: [row(1)], labels: [] });
    expect(screen.paint).toHaveBeenCalledOnce();
    const [projectId, tickets, labels, unloaded] = screen.paint.mock.calls[0]!;
    expect(projectId).toBe(P);
    expect(tickets).toMatchObject([{ id: "t1", body: "" }]);
    expect(labels).toEqual([]);
    expect(unloaded).toEqual(new Set(["t1"]));
    expect(source.projectOf("t1")).toBe(P);
    // The first paint announces nothing: every surface mounted fresh.
    expect(screen.notePlanningChange).not.toHaveBeenCalled();
  });

  it("keeps a body it was handed, and announces only the tickets whose rows changed", async () => {
    const { cloud, screen, source } = setup();
    source.attach(cloud.session);
    await source.open(P);
    cloud.answer("board:roster", { projectId: P }, { tickets: [row(1), row(2)], labels: [] });
    source.adoptBody("t1", "# One");
    source.adoptBody("unknown", "ignored");
    cloud.answer(
      "board:roster",
      { projectId: P },
      { tickets: [row(1), row(2, { updatedAt: 9 }), row(3)], labels: [] },
    );
    const [, tickets, , unloaded] = screen.paint.mock.calls[1]!;
    expect(tickets.find((ticket) => ticket.id === "t1")?.body).toBe("# One");
    expect(unloaded).toEqual(new Set(["t2", "t3"]));
    expect(screen.notePlanningChange.mock.calls).toEqual([
      [{ ticketId: "t2", projectId: P }],
      [{ ticketId: "t3", projectId: P }],
    ]);
    // A ticket that leaves takes its body and its project with it.
    cloud.answer(
      "board:roster",
      { projectId: P },
      { tickets: [row(2, { updatedAt: 9 })], labels: [] },
    );
    expect(source.projectOf("t1")).toBeUndefined();
    source.adoptBody("t1", "late");
    cloud.answer(
      "board:roster",
      { projectId: P },
      { tickets: [row(1), row(2, { updatedAt: 9 })], labels: [] },
    );
    // Its body is not kept for a return: it is read again when opened.
    expect(screen.paint.mock.calls.at(-1)![3]).toEqual(new Set(["t1", "t2"]));
  });

  it("says once that a board could not be read, until a read lands", async () => {
    const { cloud, screen, source } = setup();
    source.attach(cloud.session);
    await source.open(P);
    cloud.fail("board:roster", { projectId: P }, new Error("Server Error"));
    cloud.fail("board:roster", { projectId: P }, new Error("Server Error"));
    expect(screen.failed.mock.calls).toEqual([["Couldn’t read the board: Server Error"]]);
    cloud.answer("board:roster", { projectId: P }, { tickets: [], labels: [] });
    cloud.fail("board:roster", { projectId: P }, new Error("again"));
    expect(screen.failed).toHaveBeenCalledTimes(2);
  });

  it("drops a project the person can no longer read, saying why", async () => {
    const { cloud, screen, source } = setup();
    source.attach(cloud.session);
    await source.open(P);
    cloud.answer("board:roster", { projectId: P }, { tickets: [row(1)], labels: [] });
    cloud.fail("board:roster", { projectId: P }, refusal("not_a_member", "Not a Member."));
    expect(screen.dropped).toHaveBeenCalledWith(P, "Not a Member.");
    expect(source.follows(P)).toBe(false);
    expect(source.projectOf("t1")).toBeUndefined();
    expect(cloud.watchers("board:roster", { projectId: P })).toBe(0);
  });

  it("stops every watch when the client closes, and closes boards one by one or all", async () => {
    const { cloud, source } = setup();
    source.attach(cloud.session);
    await source.open(P);
    await source.open("p2");
    source.attach(null);
    expect(cloud.watchers("board:roster", { projectId: P })).toBe(0);
    source.attach(cloud.session);
    source.close(P);
    source.close("never");
    expect(source.follows(P)).toBe(false);
    source.closeAll();
    expect(source.follows("p2")).toBe(false);
    expect(cloud.watchers("board:roster", { projectId: "p2" })).toBe(0);
  });

  it("follows the open ticket's body, and announces its history and comments after the first answer", async () => {
    const { cloud, screen, source } = setup();
    const onBody = vi.fn();
    const onError = vi.fn();
    source.followTicket("t1", { onBody, onError })();
    expect(onError).toHaveBeenCalledWith("Volli Cloud isn’t connected yet.");

    source.attach(cloud.session);
    await source.open(P);
    cloud.answer("board:roster", { projectId: P }, { tickets: [row(1)], labels: [] });
    // Comments already cached; history not yet answered.
    cloud.answer("board:comments", { ticketId: "t1" }, []);
    cloud.answer("board:getTicket", { ticketId: "t1" }, { body: "# Cached" });
    const stop = source.followTicket("t1", { onBody, onError });
    expect(onBody).toHaveBeenCalledWith("# Cached");
    cloud.answer("board:getTicket", { ticketId: "t1" }, { body: "# Edited" });
    expect(onBody).toHaveBeenLastCalledWith("# Edited");
    cloud.fail("board:getTicket", { ticketId: "t1" }, new Error("gone"));
    expect(onError).toHaveBeenLastCalledWith("gone");

    cloud.answer("board:ticketEvents", { ticketId: "t1" }, []);
    expect(screen.notePlanningChange).not.toHaveBeenCalled();
    cloud.answer("board:ticketEvents", { ticketId: "t1" }, [{}]);
    cloud.answer("board:comments", { ticketId: "t1" }, [{}]);
    expect(screen.notePlanningChange.mock.calls).toEqual([
      [{ ticketId: "t1", projectId: P }],
      [{ ticketId: "t1", projectId: P }],
    ]);
    stop();
    expect(cloud.watchers("board:getTicket", { ticketId: "t1" })).toBe(0);
    expect(cloud.watchers("board:comments", { ticketId: "t1" })).toBe(0);
  });

  it("starts a ticket's history unanswered when its cached read failed", () => {
    const { cloud, screen, source } = setup();
    source.attach(cloud.session);
    cloud.fail("board:ticketEvents", { ticketId: "t9" }, new Error("no"));
    const onBody = vi.fn();
    source.followTicket("t9", { onBody, onError: vi.fn() });
    cloud.answer("board:ticketEvents", { ticketId: "t9" }, []);
    expect(screen.notePlanningChange).not.toHaveBeenCalled();
    expect(onBody).not.toHaveBeenCalled();
  });

  it("refuses every write in this release with the board's words", async () => {
    const { screen, source } = setup();
    expect(await source.createTicket(P, { status: "todo", title: "T" })).toBeNull();
    await source.moveTickets(P, ["t1"], "doing", 0);
    await source.setPriority(P, "t1", "high");
    expect(await source.updateTicket(P, { ticketId: "t1", title: "x" })).toBeNull();
    await source.setLabels(P, "t1", ["bug"]);
    await source.setLabelColor(P, "l1", null);
    expect(await source.archiveTicket(P, "t1")).toBe(false);
    expect(await source.unarchiveTicket(P, {} as never)).toBeNull();
    expect(await source.deleteTicket(P, "t1")).toBe(false);
    expect(screen.refused).toHaveBeenCalledTimes(9);
    expect(screen.refused).toHaveBeenCalledWith(CLOUD_WRITES_UNAVAILABLE);
  });

  it("reads the Archive a page at a time, wearing the board's labels", async () => {
    const { cloud, screen, source } = setup();
    expect(await source.archivedTickets(P)).toBeNull();
    expect(screen.failed).toHaveBeenLastCalledWith(
      "Couldn’t load the archive: Volli Cloud isn’t connected yet.",
    );
    source.attach(cloud.session);
    await source.open(P);
    cloud.answer(
      "board:roster",
      { projectId: P },
      {
        tickets: [],
        labels: [{ id: "l1", projectId: P, name: "bug", color: null, mergedIntoId: null }],
      },
    );
    const pages: unknown[] = [];
    cloud.queries.set("board:archivedTickets", (args) => {
      pages.push(args);
      const cursor = (args as { paginationOpts: { cursor: string | null } }).paginationOpts.cursor;
      return cursor === null
        ? {
            page: [{ ...row(1, { labelIds: ["l1"] }), archivedAt: 5 }],
            isDone: false,
            continueCursor: "c1",
          }
        : { page: [{ ...row(2), archivedAt: 4 }], isDone: true, continueCursor: "end" };
    });
    const archived = await source.archivedTickets(P);
    expect(archived?.map(({ id, labels, archivedAt }) => [id, labels, archivedAt])).toEqual([
      ["t1", ["bug"], 5],
      ["t2", [], 4],
    ]);
    expect(pages).toEqual([
      { projectId: P, paginationOpts: { numItems: 100, cursor: null } },
      { projectId: P, paginationOpts: { numItems: 100, cursor: "c1" } },
    ]);
    // A project it does not follow has no labels to wear; an endless Archive stops at the bound.
    let reads = 0;
    cloud.queries.set("board:archivedTickets", () => {
      reads += 1;
      return { page: [], isDone: false, continueCursor: "more" };
    });
    expect(await source.archivedTickets("other")).toEqual([]);
    expect(reads).toBe(ARCHIVE_PAGES_MAX);
    cloud.queries.set("board:archivedTickets", () => {
      throw refusal("forbidden", "Not yours.");
    });
    expect(await source.archivedTickets(P)).toBeNull();
    expect(screen.failed).toHaveBeenLastCalledWith("Couldn’t load the archive: Not yours.");
  });

  it("reads a refusal's code and sentence, bounded, or the error's own message", () => {
    expect(cloudFailure(refusal("archived", "x".repeat(400)))).toEqual({
      code: "archived",
      message: "x".repeat(300),
    });
    expect(cloudFailure(Object.assign(new Error("plain"), { data: { code: 1 } }))).toEqual({
      code: null,
      message: "plain",
    });
    expect(cloudFailure(new Error(""))).toEqual({ code: null, message: "Unknown error" });
    expect(cloudFailure("thrown")).toEqual({ code: null, message: "Unknown error" });
    expect(cloudFailure(null)).toEqual({ code: null, message: "Unknown error" });
  });
});
