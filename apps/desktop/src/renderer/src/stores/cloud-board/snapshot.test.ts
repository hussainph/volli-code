import type { Label, Project, Ticket } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BOARD_SNAPSHOT_DEBOUNCE_MS,
  BOARD_SNAPSHOT_VERSION,
  createSnapshotWriter,
  decodeBoardSnapshot,
  encodeBoardSnapshot,
  liveBoardSnapshot,
  type BoardSnapshot,
} from "./snapshot";

const PROJECT: Project = {
  id: "p1",
  name: "Volli",
  path: "",
  ticketPrefix: "VC",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const TICKET: Ticket = {
  id: "t1",
  projectId: "p1",
  ticketNumber: 1,
  title: "First",
  body: "a body the snapshot never keeps",
  status: "todo",
  priority: "medium",
  labels: ["l1"],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

const LABEL: Label = { id: "l1", projectId: "p1", name: "bug", color: null };

function snapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    version: BOARD_SNAPSHOT_VERSION,
    userId: "user-1",
    savedAt: 42,
    workspace: { id: "w1", name: "Team" },
    projects: [PROJECT],
    boards: { p1: { tickets: [TICKET], labels: [LABEL] } },
    ...overrides,
  };
}

describe("the last-seen cloud board's format (VC-889, D3)", () => {
  it("round-trips a board, leaving every body out", () => {
    const text = encodeBoardSnapshot(snapshot());
    expect(text).not.toContain("a body the snapshot never keeps");
    expect(decodeBoardSnapshot(text, "user-1")).toEqual(
      snapshot({ boards: { p1: { tickets: [{ ...TICKET, body: "" }], labels: [LABEL] } } }),
    );
  });

  it("reads nothing kept, another account's, another version's, or a broken one as none", () => {
    const good = JSON.parse(encodeBoardSnapshot(snapshot())) as Record<string, unknown>;
    const variant = (patch: Record<string, unknown>) => JSON.stringify({ ...good, ...patch });
    const broken = [
      null,
      "{not json",
      "[]",
      "null",
      variant({ version: 2 }),
      variant({ userId: "user-2" }),
      variant({ savedAt: "now" }),
      variant({ workspace: null }),
      variant({ workspace: { id: 1, name: "Team" } }),
      variant({ workspace: { id: "w1" } }),
      variant({ projects: {} }),
      variant({ projects: [{ id: "p1" }] }),
      variant({ projects: [null] }),
      variant({ boards: [] }),
      variant({ boards: { p1: null } }),
      variant({ boards: { p1: { tickets: {}, labels: [] } } }),
      variant({ boards: { p1: { tickets: [{ id: "t1" }], labels: [] } } }),
      variant({ boards: { p1: { tickets: [], labels: {} } } }),
      variant({ boards: { p1: { tickets: [], labels: [{ id: "l1" }] } } }),
    ];
    for (const text of broken) expect(decodeBoardSnapshot(text, "user-1")).toBeNull();
  });
});

describe("the board a cloud launch keeps (VC-889, D3)", () => {
  const input = {
    userId: "user-1",
    savedAt: 42,
    showingSnapshot: false,
    workspace: { id: "w1", name: "Team" },
    projects: [PROJECT, { ...PROJECT, id: "p2" }],
    ticketsByProject: { p1: [TICKET] },
    labelsByProject: { p1: [LABEL] },
    painted: () => true,
  };

  it("keeps the live board, every project's cards and labels", () => {
    expect(liveBoardSnapshot(input)).toEqual(
      snapshot({
        projects: input.projects,
        boards: {
          p1: { tickets: [TICKET], labels: [LABEL] },
          p2: { tickets: [], labels: [] },
        },
      }),
    );
  });

  it("keeps nothing while the snapshot is on screen, before a Workspace, or a board has painted", () => {
    expect(liveBoardSnapshot({ ...input, showingSnapshot: true })).toBeNull();
    expect(liveBoardSnapshot({ ...input, workspace: null })).toBeNull();
    expect(liveBoardSnapshot({ ...input, painted: (id) => id === "p1" })).toBeNull();
  });
});

/** A snapshot writer over a hand-run timer. */
function writer(read: (savedAt: number) => BoardSnapshot | null) {
  const timers: { run: () => void; ms: number }[] = [];
  const clock = {
    now: () => 7,
    setTimeout: vi.fn((run: () => void, ms: number) => {
      timers.push({ run, ms });
      return timers.length - 1;
    }),
    clearTimeout: vi.fn(),
  };
  const save = vi.fn((_text: string) => Promise.resolve(null));
  const warn = vi.fn();
  const write = createSnapshotWriter({ read, save, clock, warn });
  return { write, timers, clock, save, warn };
}

describe("writing the snapshot when the board settles (VC-889, D3)", () => {
  it("writes once the board has been quiet, a burst as one write", async () => {
    const read = vi.fn((savedAt: number) => snapshot({ savedAt }));
    const { write, timers, clock, save } = writer(read);
    write.schedule();
    write.schedule();
    expect(clock.clearTimeout).toHaveBeenCalledWith(0);
    expect(timers.map(({ ms }) => ms)).toEqual([
      BOARD_SNAPSHOT_DEBOUNCE_MS,
      BOARD_SNAPSHOT_DEBOUNCE_MS,
    ]);
    timers[1]!.run();
    expect(read).toHaveBeenCalledWith(7);
    expect(save).toHaveBeenCalledWith(encodeBoardSnapshot(snapshot({ savedAt: 7 })));
    // The timer has run: the next change starts afresh, nothing to clear.
    write.schedule();
    expect(clock.clearTimeout).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when there is no live board to keep", () => {
    const { write, timers, save } = writer(() => null);
    write.schedule();
    timers[0]!.run();
    expect(save).not.toHaveBeenCalled();
  });

  it("logs a failed write, and the next change tries again", async () => {
    const { write, timers, save, warn } = writer(() => snapshot());
    const failure = new Error("disk full");
    save.mockRejectedValueOnce(failure);
    write.schedule();
    timers[0]!.run();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), failure));
    write.schedule();
    timers[1]!.run();
    expect(save).toHaveBeenCalledTimes(2);
  });
});
