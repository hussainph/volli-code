/**
 * The SQLite adapter under the cleanup core: the same rules, but proved against
 * a real, fully-migrated database — because "a completed item can never be
 * relabelled" is only worth anything if it survives the storage layer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { OrphanCleanupPlanItem } from "@volli/shared";

import { openTestDb, type TestDb } from "../db/test-helpers";
import { createOrphanCleanupEngine, type OrphanCleanupEngine } from "./cleanup-engine";
import { SqliteOrphanCleanupLedger } from "./cleanup-ledger";

let ctx: TestDb;
let engine: OrphanCleanupEngine;
let clock = 1_000;
let minted = 0;

beforeEach(() => {
  ctx = openTestDb();
  clock = 1_000;
  minted = 0;
  engine = createOrphanCleanupEngine({
    ledger: new SqliteOrphanCleanupLedger(ctx.db),
    now: () => clock,
    nextId: () => `id-${(minted += 1)}`,
  });
});

afterEach(() => {
  ctx.cleanup();
});

function planItem(overrides: Partial<OrphanCleanupPlanItem> = {}): OrphanCleanupPlanItem {
  return {
    id: "rev1:worktree:0",
    kind: "worktree",
    path: "/root/wt/VC-1",
    projectId: "p1",
    projectName: "Volli",
    projectPath: "/root/project",
    branch: "volli/VC-1",
    gitReason: null,
    ...overrides,
  };
}

const ACCEPT = {
  source: "settings" as const,
  scanRevision: "rev1",
  retentionDays: 14,
  preservation: ["branches"],
};

describe("SqliteOrphanCleanupLedger", () => {
  it("keeps the accepted plan, the receipts and every fact", async () => {
    const accepted = await engine.accept({
      commandId: "cmd-1",
      ...ACCEPT,
      items: [planItem()],
    });
    expect(accepted.ok).toBe(true);

    clock = 2_000;
    await engine.beginItem({ commandId: "cmd-1", itemId: "rev1:worktree:0" });
    clock = 3_000;
    await engine.settleItem({
      commandId: "cmd-1",
      itemId: "rev1:worktree:0",
      state: "completed",
      detail: "Removed the folder.",
    });
    clock = 4_000;
    const { run } = await engine.finish({ commandId: "cmd-1" });

    expect(run.items[0]).toMatchObject({
      state: "completed",
      startedAt: 2_000,
      settledAt: 3_000,
      projectName: "Volli",
    });
    expect(run.finishedAt).toBe(4_000);

    const facts = ctx.db
      .prepare("SELECT kind FROM worktree_cleanup_facts ORDER BY rowid")
      .all() as { kind: string }[];
    expect(facts.map((fact) => fact.kind)).toEqual([
      "command.recorded",
      "cleanup.accepted",
      "command.receipt.recorded",
      "cleanup.item.started",
      "cleanup.item.settled",
      "cleanup.run.finished",
      "command.receipt.recorded",
    ]);
    const receipts = ctx.db
      .prepare("SELECT status, code FROM worktree_cleanup_receipts ORDER BY rowid")
      .all() as { status: string; code: string | null }[];
    expect(receipts).toEqual([
      { status: "accepted", code: null },
      { status: "completed", code: null },
    ]);
  });

  it("survives a reopened database: the run reads back exactly as recorded", async () => {
    await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    await engine.beginItem({ commandId: "cmd-1", itemId: "rev1:worktree:0" });
    await engine.settleItem({
      commandId: "cmd-1",
      itemId: "rev1:worktree:0",
      state: "completed",
      detail: "Removed the folder.",
    });

    // A brand-new engine over the same file, as the next launch has.
    const relaunched = createOrphanCleanupEngine({
      ledger: new SqliteOrphanCleanupLedger(ctx.db),
      now: () => 9_000,
      nextId: () => "later",
    });
    const open = await relaunched.openRuns();
    expect(open).toHaveLength(1);
    expect(open[0]?.items[0]?.state).toBe("completed");

    // The launch stamp records the interruption WITHOUT touching the outcome.
    await relaunched.markInterrupted({ commandId: "cmd-1" });
    const after = await relaunched.run("cmd-1");
    expect(after?.interruptedAt).toBe(9_000);
    expect(after?.items[0]?.state).toBe("completed");
    expect(
      (ctx.db.prepare("SELECT COUNT(*) AS n FROM worktree_cleanup_facts").get() as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it("stores a rejected command as evidence, with no run", async () => {
    await engine.reject({
      commandId: "cmd-9",
      scanRevision: "stale-revision",
      code: "scan-superseded",
      error: "That scan has been superseded.",
    });
    expect(await engine.run("cmd-9")).toBeNull();
    expect(await engine.recentRuns()).toEqual([]);
    const row = ctx.db
      .prepare("SELECT status, code, detail FROM worktree_cleanup_receipts WHERE command_id = ?")
      .get("cmd-9") as { status: string; code: string; detail: string };
    expect(row).toEqual({
      status: "rejected",
      code: "scan-superseded",
      detail: "That scan has been superseded.",
    });
  });

  it("rolls back a transaction that throws, leaving no half-written command", async () => {
    const ledger = new SqliteOrphanCleanupLedger(ctx.db);
    await expect(
      ledger.transaction(async (tx) => {
        tx.insertCommand({
          id: "cmd-x",
          intent: {
            kind: "orphan.cleanup",
            source: "settings",
            scanRevision: "rev1",
            retentionDays: 14,
            preservation: [],
            items: [],
          },
          createdAt: 1,
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM worktree_cleanup_commands").get()).toEqual({
      n: 0,
    });
  });

  it("refuses to erase a command that still has facts", async () => {
    await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    expect(() =>
      ctx.db.prepare("DELETE FROM worktree_cleanup_commands WHERE id = ?").run("cmd-1"),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("caps the history it reads back, newest first", async () => {
    for (const id of ["cmd-1", "cmd-2", "cmd-3"]) {
      clock += 10;
      await engine.accept({ commandId: id, ...ACCEPT, items: [planItem()] });
    }
    expect((await engine.recentRuns(2)).map((run) => run.id)).toEqual(["cmd-3", "cmd-2"]);
  });
});
