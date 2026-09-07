import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { setAppState } from "../db/app-state-repo";
import { openTestDb, type TestDb } from "../db/test-helpers";

import {
  CLEANUP_RUNS_KEY,
  MAX_CLEANUP_RUNS,
  readCleanupRuns,
  reconcileInterruptedCleanupRuns,
  saveCleanupRun,
} from "./cleanup-log";
import type { OrphanCleanupRun } from "../../ipc/contract";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

function run(overrides: Partial<OrphanCleanupRun> = {}): OrphanCleanupRun {
  return {
    id: "run-1",
    source: "settings",
    startedAt: 1_000,
    finishedAt: 2_000,
    interruptedAt: null,
    preservation: ["Branches are kept."],
    items: [
      {
        kind: "worktree",
        path: "/wt/one",
        projectId: "proj-1",
        branch: "volli/VC-1-x",
        status: "completed",
        detail: "Removed the folder.",
        finishedAt: 2_000,
      },
    ],
    ...overrides,
  };
}

describe("cleanup log", () => {
  it("has no history before anything has been cleaned up", () => {
    expect(readCleanupRuns(ctx.db)).toEqual([]);
  });

  it("persists a run and reads it back whole", () => {
    saveCleanupRun(ctx.db, run(), 2_000);
    expect(readCleanupRuns(ctx.db)).toEqual([run()]);
  });

  it("updates a run in place rather than appending a second copy of it", () => {
    saveCleanupRun(ctx.db, run({ finishedAt: null }), 1_000);
    saveCleanupRun(ctx.db, run(), 2_000);

    expect(readCleanupRuns(ctx.db)).toEqual([run()]);
  });

  it("keeps the newest runs and drops the oldest past the cap", () => {
    for (let index = 0; index < MAX_CLEANUP_RUNS + 3; index += 1) {
      saveCleanupRun(ctx.db, run({ id: `run-${index}`, startedAt: index }), index);
    }

    const stored = readCleanupRuns(ctx.db);
    expect(stored).toHaveLength(MAX_CLEANUP_RUNS);
    // Newest first, and the three oldest are gone.
    expect(stored[0]?.id).toBe(`run-${MAX_CLEANUP_RUNS + 2}`);
    expect(stored.map((entry) => entry.id)).not.toContain("run-0");
  });

  it("treats an unreadable history as no history rather than throwing into the caller", () => {
    setAppState(ctx.db, CLEANUP_RUNS_KEY, "{not json", 1);
    expect(readCleanupRuns(ctx.db)).toEqual([]);

    setAppState(ctx.db, CLEANUP_RUNS_KEY, JSON.stringify({ runs: "nope" }), 1);
    expect(readCleanupRuns(ctx.db)).toEqual([]);
  });

  // What a later launch does with a run the app never finished: it says so,
  // and it does NOT re-describe the items that already completed as pending.
  it("stamps an unfinished run as interrupted on the next launch, once", () => {
    saveCleanupRun(
      ctx.db,
      run({
        finishedAt: null,
        items: [
          run().items[0]!,
          {
            kind: "worktree",
            path: "/wt/two",
            projectId: "proj-1",
            branch: null,
            status: "pending",
            detail: null,
            finishedAt: null,
          },
        ],
      }),
      1_000,
    );

    const reconciled = reconcileInterruptedCleanupRuns(ctx.db, 5_000);

    expect(reconciled.map((entry) => entry.id)).toEqual(["run-1"]);
    const [stored] = readCleanupRuns(ctx.db);
    expect(stored?.interruptedAt).toBe(5_000);
    expect(stored?.finishedAt).toBeNull();
    expect(stored?.items.map((item) => item.status)).toEqual(["completed", "pending"]);

    // A second launch finds nothing new to stamp and leaves the timestamp alone.
    expect(reconcileInterruptedCleanupRuns(ctx.db, 9_000)).toEqual([]);
    expect(readCleanupRuns(ctx.db)[0]?.interruptedAt).toBe(5_000);
  });

  it("leaves a finished run alone", () => {
    saveCleanupRun(ctx.db, run(), 2_000);
    expect(reconcileInterruptedCleanupRuns(ctx.db, 5_000)).toEqual([]);
    expect(readCleanupRuns(ctx.db)).toEqual([run()]);
  });
});
