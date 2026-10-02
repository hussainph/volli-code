import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SqliteAutomationLedger } from "../automations/sqlite-ledger";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { SqliteOrphanCleanupLedger } from "../worktree/cleanup-ledger";
import { getProjectById, insertProject } from "./projects-repo";
import { openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { getTransactionGate } from "./transaction-gate";

const fixtures: TestDb[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup(): TestDb {
  const fixture = openTestDb();
  fixtures.push(fixture);
  return fixture;
}

describe("connection transaction ownership", () => {
  it("shares ownership across ledger instances and independently queued repo work", async () => {
    const { db } = setup();
    expect(getTransactionGate(db)).toBe(getTransactionGate(db));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = createSqliteSessionLedger(db).transaction(async () => {
      order.push("first session");
      entered.resolve();
      await release.promise;
      return "committed";
    });
    await entered.promise;
    const second = createSqliteSessionLedger(db).transaction(() => {
      order.push("second session");
    });
    const project = testProject();
    const repo = getTransactionGate(db).transaction(() => {
      order.push("repo");
      insertProject(db, project);
    });
    try {
      await Promise.resolve();
      expect(order).toEqual(["first session"]);
      expect(getProjectById(db, project.id)).toBeUndefined();
    } finally {
      release.resolve();
      expect(await first).toBe("committed");
      await Promise.all([second, repo]);
    }
    expect(order).toEqual(["first session", "second session", "repo"]);
    expect(getProjectById(db, project.id)?.id).toBe(project.id);
  });

  it("does not serialize independent handles through a global queue", async () => {
    const { db } = setup();
    const other = setup().db;
    expect(getTransactionGate(db)).not.toBe(getTransactionGate(other));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = getTransactionGate(db).transaction(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      await expect(getTransactionGate(other).transaction(() => 42)).resolves.toBe(42);
    } finally {
      release.resolve();
      await first;
    }
  });

  it("recovers after a failed BEGIN without rolling back somebody else's transaction", async () => {
    const { db } = setup();
    const gate = getTransactionGate(db);
    const work = vi.fn();
    const project = testProject();
    db.exec("BEGIN IMMEDIATE");
    insertProject(db, project);
    await expect(gate.transaction(work)).rejects.toThrow("within a transaction");
    expect(work).not.toHaveBeenCalled();
    expect(db.inTransaction).toBe(true);
    db.exec("COMMIT");
    await expect(gate.transaction(() => getProjectById(db, project.id)?.id)).resolves.toBe(
      project.id,
    );
  });

  it("rolls back a failed COMMIT and lets already queued work continue", async () => {
    const { db } = setup();
    const gate = getTransactionGate(db);
    const project = testProject();
    const originalExec = db.exec.bind(db);
    const failure = new Error("commit failed");
    let failCommit = true;
    const exec = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT" && failCommit) {
        failCommit = false;
        throw failure;
      }
      return originalExec(sql);
    });
    try {
      const first = gate.transaction(() => insertProject(db, project));
      const second = gate.transaction(() => getProjectById(db, project.id));
      await expect(first).rejects.toBe(failure);
      await expect(second).resolves.toBeUndefined();
      expect(db.inTransaction).toBe(false);
    } finally {
      exec.mockRestore();
    }
  });

  it("preserves the work error when ROLLBACK also fails and releases the queue", async () => {
    const { db } = setup();
    const gate = getTransactionGate(db);
    const failure = new Error("work failed");
    const originalExec = db.exec.bind(db);
    const exec = vi.spyOn(db, "exec").mockImplementation((sql) => {
      const result = originalExec(sql);
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return result;
    });
    try {
      const first = gate.transaction(() => {
        throw failure;
      });
      const second = gate.transaction(() => 42);
      await expect(first).rejects.toBe(failure);
      await expect(second).resolves.toBe(42);
      expect(db.inTransaction).toBe(false);
    } finally {
      exec.mockRestore();
    }
  });

  it("queues Automation and cleanup behind an awaited Session rollback, including repo writes", async () => {
    const { db } = setup();
    const sessions = createSqliteSessionLedger(db);
    const automations = new SqliteAutomationLedger(db);
    const cleanup = new SqliteOrphanCleanupLedger(db);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const rolledBack = testProject({ id: "rolled-back" });
    const committed = testProject({ id: "committed" });
    const first = sessions.transaction(async () => {
      insertProject(db, rolledBack);
      order.push("session");
      entered.resolve();
      await release.promise;
      throw new Error("host failed");
    });
    const failure = expect(first).rejects.toThrow("host failed");
    await entered.promise;

    const second = automations.transaction((tx) => {
      order.push("automation");
      expect(getProjectById(db, rolledBack.id)).toBeUndefined();
      tx.insertCommand({
        id: "automation-command",
        intent: { kind: "automation.delete", automationId: "unused" },
        createdAt: 1,
      });
      // A plain repo write is safe when its caller participates in the gate.
      insertProject(db, committed);
    });
    const third = cleanup.transaction((tx) => {
      order.push("cleanup");
      tx.insertCommand({
        id: "cleanup-command",
        intent: {
          kind: "orphan.cleanup",
          source: "settings",
          scanRevision: "revision",
          requestedItemIds: [],
          retentionDays: 14,
          preservation: [],
          items: [],
        },
        createdAt: 2,
      });
    });
    // Attach handlers before yielding, so the baseline's nested BEGIN errors
    // are reported as assertions rather than unhandled rejections.
    const results = Promise.allSettled([second, third]);
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual(["session"]);
    } finally {
      release.resolve();
      await failure;
    }
    expect(await results).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
    expect(order).toEqual(["session", "automation", "cleanup"]);
    expect(getProjectById(db, rolledBack.id)).toBeUndefined();
    expect(getProjectById(db, committed.id)?.id).toBe(committed.id);
    await automations.transaction(async (tx) => {
      expect((await tx.getCommand("automation-command"))?.id).toBe("automation-command");
    });
    await cleanup.transaction(async (tx) => {
      expect((await tx.getCommand("cleanup-command"))?.id).toBe("cleanup-command");
    });
  });

  it("documents the limit: an ungated synchronous repo write joins the open async transaction", async () => {
    const { db } = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const project = testProject({ id: "ungated" });
    const first = createSqliteSessionLedger(db).transaction(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("host failed");
    });
    const failure = expect(first).rejects.toThrow("host failed");
    await entered.promise;
    try {
      insertProject(db, project);
      expect(getProjectById(db, project.id)?.id).toBe(project.id);
    } finally {
      release.resolve();
      await failure;
    }
    expect(getProjectById(db, project.id)).toBeUndefined();
  });
});
