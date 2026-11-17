import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";

import { startBoardProtocol, stopBoardProtocol } from "@renderer/lib/board-protocol";

import {
  boardSourceFor,
  boardSourceForComment,
  boardSourceForTicket,
  cloudBoardSource,
  deliveringBoardSource,
  installCloudBoardSource,
  installLocalBoardSource,
  type BoardRowSource,
} from "./board-source";
import { ConvexBoardSource } from "./cloud-board/source";
import { adoptLaunch } from "./launch";
import { LocalBoardSource } from "./local-board-source";
import { remoteProject } from "./remote-project.test-support";

let local: LocalBoardSource;

beforeEach(() => {
  local = new LocalBoardSource({} as never);
  installLocalBoardSource(local);
});

afterEach(() => {
  stopBoardProtocol();
  adoptLaunch(LOCAL_LAUNCH);
  installCloudBoardSource(null);
});

function silentView() {
  return {
    paint: vi.fn(),
    adoptProject: vi.fn(),
    notePlanningChange: vi.fn(),
    checkoutMoved: vi.fn(),
    failed: vi.fn(),
  };
}

function cloudSource() {
  return new ConvexBoardSource(
    {
      paint: vi.fn(),
      notePlanningChange: vi.fn(),
      failed: vi.fn(),
      refused: vi.fn(),
      unconfirmed: vi.fn(),
      readOnly: () => null,
      dropped: vi.fn(),
    },
    "user-1",
  );
}

describe("where a project's board goes (VC-889, VC-1260)", () => {
  it("is this Mac's for every project of a local launch with the flag off", () => {
    expect(boardSourceFor("p1")).toBe(local);
    expect(boardSourceFor(null)).toBe(local);
    expect(boardSourceForTicket("t")).toBe(local);
    expect(boardSourceForComment("c")).toBe(local);
  });

  it("answers this Mac's door before the board store loads, and refuses its writes loudly", async () => {
    vi.resetModules();
    const fresh = await import("./board-source");
    const source = fresh.boardSourceFor("p1");
    expect(source).toBeInstanceOf((await import("./local-board-source")).LocalBoardSource);
    expect(fresh.boardSourceFor("p2")).toBe(source);
    expect(() => source.projectOf("t")).toThrow("The board store has not loaded");
    await expect(source.archiveTicket("p1", "t")).rejects.toThrow("The board store has not loaded");
  });

  it("is the protocol engine's for a remote host's project, or one it still follows", () => {
    const { sync, source, commentTickets } = startBoardProtocol({
      view: silentView(),
      client: {} as never,
    });
    expect(boardSourceFor("mine")).toBe(local);
    expect(boardSourceFor(undefined)).toBe(local);
    const undo = remoteProject("remote");
    expect(boardSourceFor("remote")).toBe(source);
    undo();
    vi.spyOn(sync, "follows").mockImplementation((id) => id === "left");
    expect(boardSourceFor("left")).toBe(source);
    expect(boardSourceFor("remote")).toBe(local);

    vi.spyOn(sync, "projectOf").mockImplementation((id) => (id === "rt" ? "left" : undefined));
    expect(boardSourceForTicket("rt")).toBe(source);
    expect(boardSourceForTicket("lt")).toBe(local);
    commentTickets.note("rc", "rt");
    commentTickets.note("lc", "lt");
    expect(boardSourceForComment("rc")).toBe(source);
    expect(boardSourceForComment("lc")).toBe(local);
    expect(boardSourceForComment("unseen")).toBe(local);
  });

  it("is Volli Cloud's source for every project of a cloud launch", () => {
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "http://127.0.0.1:1" });
    // Before boot installs it: this Mac's rows, as before, under Volli Cloud's door.
    const awaiting = boardSourceFor("any");
    expect(awaiting).not.toBe(local);
    expect(awaiting.deliversOwnRows).toBe(false);
    expect(awaiting.api).not.toBe(local.api);
    expect(boardSourceFor("other")).toBe(awaiting);
    const move = vi.spyOn(local, "moveTicket").mockResolvedValue();
    void awaiting.moveTicket("any", "a", "doing", 0);
    expect(move).toHaveBeenCalledWith("any", "a", "doing", 0, undefined);

    const source = cloudSource();
    installCloudBoardSource(source);
    expect(cloudBoardSource()).toBe(source);
    const board = boardSourceFor("any");
    expect(board.deliversOwnRows).toBe(true);
    expect(boardSourceFor(null)).toBe(board);
    expect(boardSourceForTicket("t")).toBe(board);
    expect(boardSourceForComment("c")).toBe(board);
  });
});

describe("a source that delivers its own rows", () => {
  it("hands every row call to its row source as made, and moves one card as a one-card group", async () => {
    const calls: unknown[][] = [];
    const rows = new Proxy({} as BoardRowSource, {
      get:
        (_target, name) =>
        (...args: unknown[]) => {
          calls.push([name, ...args]);
          return name === "follows" ? true : undefined;
        },
    });
    const api = {} as never;
    const source = deliveringBoardSource(rows, api);
    expect(source.deliversOwnRows).toBe(true);
    expect(source.api).toBe(api);

    const archived = { id: "a" } as never;
    expect(source.follows("p")).toBe(true);
    source.projectOf("t");
    void source.open("p");
    source.close("p");
    source.closeAll();
    source.adoptBody("t", "b");
    void source.createTicket("p", { status: "todo", title: "T" });
    void source.moveTicket("p", "t", "doing", 1, "plain" as never);
    void source.moveTickets("p", ["t", "u"], "done", 0);
    void source.setPriority("p", "t", "high");
    void source.updateTicket("p", { ticketId: "t", title: "T" });
    void source.setLabels("p", "t", ["bug"]);
    void source.setLabelColor("p", "l", null);
    void source.archiveTicket("p", "t");
    void source.unarchiveTicket("p", archived);
    void source.deleteTicket("p", "t");
    void source.archivedTickets("p");

    expect(calls).toEqual([
      ["follows", "p"],
      ["projectOf", "t"],
      ["open", "p"],
      ["close", "p"],
      ["closeAll"],
      ["adoptBody", "t", "b"],
      ["createTicket", "p", { status: "todo", title: "T" }],
      ["moveTickets", "p", ["t"], "doing", 1, "plain"],
      ["moveTickets", "p", ["t", "u"], "done", 0, undefined],
      ["setPriority", "p", "t", "high"],
      ["updateTicket", "p", { ticketId: "t", title: "T" }],
      ["setLabels", "p", "t", ["bug"]],
      ["setLabelColor", "p", "l", null],
      ["archiveTicket", "p", "t"],
      ["unarchiveTicket", "p", archived],
      ["deleteTicket", "p", "t"],
      ["archivedTickets", "p"],
    ]);
  });
});
