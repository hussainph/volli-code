import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  listOpenSpawns,
  markSpawnExited,
  pruneSpawnLedger,
  recordSpawn,
  SPAWN_LEDGER_COMMAND_MAX,
} from "./spawn-ledger-repo";
import { openTestDb } from "./test-helpers";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const handles: ReturnType<typeof openTestDb>[] = [];

function db(): ReturnType<typeof openTestDb> {
  const handle = openTestDb();
  handles.push(handle);
  return handle;
}

afterEach(() => {
  while (handles.length > 0) handles.pop()!.cleanup();
});

function spawn(overrides: Partial<Parameters<typeof recordSpawn>[2]> = {}) {
  return {
    sessionId: "session-1",
    ticketId: "ticket-1",
    projectId: "project-1",
    kind: "shell" as const,
    pid: 4242,
    pgid: 4242,
    startedAt: NOW,
    cwd: "/home/.volli/worktrees/p/VC-341",
    command: "pnpm dev",
    ...overrides,
  };
}

describe("the spawn ledger's storage", () => {
  it("keeps an open row until an exit is marked", () => {
    const { db: handle } = db();
    recordSpawn(handle, "row-1", spawn());
    expect(listOpenSpawns(handle)).toEqual([{ id: "row-1", ...spawn() }]);

    markSpawnExited(handle, "row-1", NOW + 1000);
    expect(listOpenSpawns(handle)).toEqual([]);
  });

  it("keeps the first exit it saw", () => {
    const { db: handle } = db();
    recordSpawn(handle, "row-1", spawn());
    markSpawnExited(handle, "row-1", NOW + 1000);
    markSpawnExited(handle, "row-1", NOW + 9000);
    const row = handle.prepare("SELECT exited_at FROM spawned_processes").get() as {
      exited_at: number;
    };
    expect(row.exited_at).toBe(NOW + 1000);
  });

  it("orders open rows oldest first", () => {
    const { db: handle } = db();
    recordSpawn(handle, "young", spawn({ pid: 2, startedAt: NOW }));
    recordSpawn(handle, "old", spawn({ pid: 1, startedAt: NOW - DAY }));
    expect(listOpenSpawns(handle).map((entry) => entry.id)).toEqual(["old", "young"]);
  });

  it("bounds a pathological command line", () => {
    const { db: handle } = db();
    recordSpawn(handle, "row-1", spawn({ command: "x".repeat(SPAWN_LEDGER_COMMAND_MAX + 500) }));
    const [entry] = listOpenSpawns(handle);
    expect(entry?.command).toHaveLength(SPAWN_LEDGER_COMMAND_MAX + 1);
    expect(entry?.command.endsWith("…")).toBe(true);
  });

  it("refuses a row whose kind or pid a hand edit made unreadable", () => {
    const { db: handle } = db();
    recordSpawn(handle, "good", spawn());
    recordSpawn(handle, "bad-pid", spawn({ pid: 7 }));
    handle.prepare("UPDATE spawned_processes SET pid = -1 WHERE id = 'bad-pid'").run();
    // The CHECK constraint is what stops an unknown kind arriving through this
    // app at all; the mapper is the second line for a row edited underneath it.
    expect(() =>
      handle.prepare("UPDATE spawned_processes SET kind = 'daemon' WHERE id = 'good'").run(),
    ).toThrow();
    expect(listOpenSpawns(handle).map((entry) => entry.id)).toEqual(["good"]);
  });

  it("prunes old exits and rows past the horizon, keeping what still describes something", () => {
    const { db: handle } = db();
    recordSpawn(handle, "recent-open", spawn({ pid: 1, startedAt: NOW - DAY }));
    recordSpawn(handle, "recent-exit", spawn({ pid: 2, startedAt: NOW - DAY }));
    markSpawnExited(handle, "recent-exit", NOW - DAY);
    recordSpawn(handle, "ancient-open", spawn({ pid: 3, startedAt: NOW - 30 * DAY }));
    recordSpawn(handle, "ancient-exit", spawn({ pid: 4, startedAt: NOW - 30 * DAY }));
    markSpawnExited(handle, "ancient-exit", NOW - 29 * DAY);

    expect(pruneSpawnLedger(handle, NOW)).toBe(2);
    expect(listOpenSpawns(handle).map((entry) => entry.id)).toEqual(["recent-open"]);
  });
});
