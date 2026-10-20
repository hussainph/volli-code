import { afterEach, describe, expect, it } from "vite-plus/test";

import { SPAWN_LEDGER_PARKED_COLUMN_MIGRATION } from "./spawn-ledger-parked-migration";
import { MIGRATIONS } from "./migrations";
import {
  listOpenSpawns,
  listParkedTerminalSpawns,
  markSpawnExited,
  markSpawnParked,
  pruneSpawnLedger,
  recordSpawn,
  SPAWN_LEDGER_COMMAND_MAX,
  spawnLedgerEntryFrom,
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

  it("reads back a stored row, and nothing whose kind this build does not know", () => {
    // The CHECK constraint stops a bad `kind` being written through this app,
    // so the mapper's own refusal is only reachable directly — which is where
    // a rule with two lines of defence has to be tested from.
    const row = {
      id: "row-1",
      session_id: "session-1",
      ticket_id: null,
      project_id: null,
      kind: "shell",
      pid: 4242,
      pgid: 4242,
      started_at: NOW,
      cwd: "/w",
      command: "pnpm dev",
    };
    expect(spawnLedgerEntryFrom(row)).toMatchObject({ kind: "shell", pid: 4242 });
    // `browser` was never a kind this ledger writes: a Browser Tab is a
    // WebContentsView with no child process (VC-341).
    expect(spawnLedgerEntryFrom({ ...row, kind: "browser" })).toBeNull();
    expect(spawnLedgerEntryFrom({ ...row, pid: 0 })).toBeNull();
  });

  it("lists only open terminal rows an earlier launch left parked (VC-833)", () => {
    const { db: handle } = db();
    const BOOT = NOW + DAY;
    recordSpawn(handle, "parked", spawn({ kind: "terminal", pid: 1 }));
    recordSpawn(handle, "woken", spawn({ kind: "terminal", pid: 2 }));
    recordSpawn(handle, "never-parked", spawn({ kind: "terminal", pid: 3 }));
    recordSpawn(handle, "exited", spawn({ kind: "terminal", pid: 4 }));
    recordSpawn(handle, "this-launch", spawn({ kind: "terminal", pid: 5 }));
    recordSpawn(handle, "a-shell", spawn({ kind: "shell", pid: 6 }));
    for (const id of ["parked", "woken", "exited", "a-shell"]) markSpawnParked(handle, id, NOW);
    markSpawnParked(handle, "woken", null);
    markSpawnExited(handle, "exited", NOW + 1);
    // Parked after this launch began: its own, not a stranded one.
    markSpawnParked(handle, "this-launch", BOOT);
    // A hand edit that made the pid unreadable must never name a signal.
    recordSpawn(handle, "bad-pid", spawn({ kind: "terminal", pid: 7 }));
    markSpawnParked(handle, "bad-pid", NOW);
    handle.prepare("UPDATE spawned_processes SET pid = -1 WHERE id = 'bad-pid'").run();

    expect(listParkedTerminalSpawns(handle, BOOT)).toEqual([
      { id: "parked", ...spawn({ kind: "terminal", pid: 1 }) },
    ]);
  });

  it("keeps the first park time while the mark stands, and clears it on wake", () => {
    const { db: handle } = db();
    recordSpawn(handle, "row-1", spawn({ kind: "terminal" }));
    const parkedAt = () =>
      (handle.prepare("SELECT parked_at FROM spawned_processes").get() as { parked_at: unknown })
        .parked_at;
    markSpawnParked(handle, "row-1", NOW);
    markSpawnParked(handle, "row-1", NOW + 60_000);
    expect(parkedAt()).toBe(NOW);
    markSpawnParked(handle, "row-1", null);
    expect(parkedAt()).toBeNull();
    markSpawnParked(handle, "row-1", NOW + 120_000);
    expect(parkedAt()).toBe(NOW + 120_000);
  });

  it("adds the parked column once, however often migration 063 is offered", () => {
    const { db: handle } = db();
    const migration = MIGRATIONS.find((entry) => entry.version === 63);
    expect(migration?.sql).toBe(SPAWN_LEDGER_PARKED_COLUMN_MIGRATION);
    // The test database already ran it; a re-offer must converge, not throw.
    expect(() => migration?.apply?.(handle)).not.toThrow();
    handle.exec("ALTER TABLE spawned_processes DROP COLUMN parked_at");
    migration?.apply?.(handle);
    const columns = handle.pragma("table_info(spawned_processes)") as { name: string }[];
    expect(columns.filter(({ name }) => name === "parked_at")).toHaveLength(1);
  });

  it("prunes old exits but keeps open rows through the window the orphans live in", () => {
    const { db: handle } = db();
    recordSpawn(handle, "recent-open", spawn({ pid: 1, startedAt: NOW - DAY }));
    recordSpawn(handle, "recent-exit", spawn({ pid: 2, startedAt: NOW - DAY }));
    markSpawnExited(handle, "recent-exit", NOW - DAY);
    // The load audit's own offenders: 3 to 18 days old and still running. An
    // open row inside that window is the evidence, not the litter.
    recordSpawn(handle, "eighteen-day-open", spawn({ pid: 3, startedAt: NOW - 18 * DAY }));
    recordSpawn(handle, "ancient-exit", spawn({ pid: 4, startedAt: NOW - 30 * DAY }));
    markSpawnExited(handle, "ancient-exit", NOW - 29 * DAY);
    recordSpawn(handle, "forgotten-open", spawn({ pid: 5, startedAt: NOW - 200 * DAY }));

    expect(pruneSpawnLedger(handle, NOW)).toBe(2);
    expect(listOpenSpawns(handle).map((entry) => entry.id)).toEqual([
      "eighteen-day-open",
      "recent-open",
    ]);
  });
});
