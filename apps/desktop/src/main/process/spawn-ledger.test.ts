import { afterEach, describe, expect, it } from "vite-plus/test";

import { openTestDb } from "../db/test-helpers";
import { NO_SPAWN_LEDGER, SpawnLedger } from "./spawn-ledger";

const NOW = 1_800_000_000_000;

const handles: ReturnType<typeof openTestDb>[] = [];

function testDb(): ReturnType<typeof openTestDb> {
  const handle = openTestDb();
  handles.push(handle);
  return handle;
}

afterEach(() => {
  while (handles.length > 0) handles.pop()!.cleanup();
});

const spawn = {
  sessionId: "session-1",
  ticketId: "ticket-1",
  projectId: "project-1",
  kind: "execute" as const,
  pid: 321,
  pgid: 321,
  startedAt: NOW,
  cwd: "/home/.volli/worktrees/p/VC-341",
  command: "pnpm dev",
};

describe("SpawnLedger", () => {
  it("records a spawn, closes it, and reads what is still open", () => {
    const { db } = testDb();
    const ledger = new SpawnLedger(db, { now: () => NOW + 5, createId: () => "row-1" });

    expect(ledger.recordSpawn(spawn)).toBe("row-1");
    expect(ledger.listOpen()).toEqual([{ id: "row-1", ...spawn }]);

    ledger.markExited("row-1");
    expect(ledger.listOpen()).toEqual([]);
  });

  it("prunes with its own clock", () => {
    const { db } = testDb();
    const ledger = new SpawnLedger(db, {
      now: () => NOW + 90 * 24 * 60 * 60 * 1000,
      createId: () => "row-1",
    });
    ledger.recordSpawn(spawn);
    expect(ledger.prune()).toBe(1);
    expect(ledger.listOpen()).toEqual([]);
  });

  it("is a no-op with no database, so a launch that lost SQLite still spawns", () => {
    const ledger = new SpawnLedger(null);
    expect(ledger.recordSpawn(spawn)).toBeNull();
    expect(ledger.listOpen()).toEqual([]);
    expect(ledger.prune()).toBe(0);
    expect(() => ledger.markExited("row-1")).not.toThrow();
  });

  it("reports a failed write instead of failing the spawn that asked for it", () => {
    const { db } = testDb();
    const errors: string[] = [];
    const ledger = new SpawnLedger(db, { createId: () => "row-1", onError: (m) => errors.push(m) });
    ledger.recordSpawn(spawn);
    // A duplicate id is the cheapest real write failure; every door behaves the
    // same way when SQLite refuses.
    expect(ledger.recordSpawn(spawn)).toBeNull();
    db.close();
    ledger.markExited("row-1");
    expect(ledger.listOpen()).toEqual([]);
    expect(ledger.prune()).toBe(0);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toContain("pid 321");
  });

  it("has a null object for the callers that have no ledger", () => {
    expect(NO_SPAWN_LEDGER.recordSpawn(spawn)).toBeNull();
    expect(() => NO_SPAWN_LEDGER.markExited("row-1")).not.toThrow();
  });
});
