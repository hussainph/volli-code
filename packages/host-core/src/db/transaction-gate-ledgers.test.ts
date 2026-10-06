import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getProjectById, insertProject } from "./projects-repo";
import { openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { SqliteAutomationLedger } from "../automations/sqlite-ledger";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { SqliteOrphanCleanupLedger } from "../worktree/cleanup-ledger";

/**
 * The transaction gate's case that still needs desktop ledgers. The gate itself
 * and its Session-ledger cases live in `@volli/host-core` (`src/db/transaction-gate.test.ts`);
 * this follows them once the Automation and cleanup ledgers move there.
 */
const fixtures: TestDb[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function setup(): TestDb {
  const fixture = openTestDb();
  fixtures.push(fixture);
  return fixture;
}

describe("connection transaction ownership across ledgers", () => {
  it("shares synchronous ownership across Session, Automation, cleanup and nested repo work", async () => {
    const { db } = setup();
    const automations = new SqliteAutomationLedger(db);
    const cleanup = new SqliteOrphanCleanupLedger(db);
    const rolledBack = testProject();
    const committed = testProject();
    const first = createSqliteSessionLedger(db).transaction(() => {
      insertProject(db, rolledBack);
      throw new Error("host failed");
    });
    const second = automations.transaction((tx) => {
      expect(getProjectById(db, rolledBack.id)).toBeUndefined();
      tx.insertCommand({
        id: "automation-command",
        intent: { kind: "automation.delete", automationId: "unused" },
        createdAt: 1,
      });
      db.transaction(() => insertProject(db, committed))();
    });
    const third = cleanup.transaction((tx) =>
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
      }),
    );
    await expect(first).rejects.toThrow("host failed");
    await Promise.all([second, third]);
    expect(getProjectById(db, rolledBack.id)).toBeUndefined();
    expect(getProjectById(db, committed.id)?.id).toBe(committed.id);
    await automations.transaction((tx) =>
      expect(tx.getCommand("automation-command")?.id).toBe("automation-command"),
    );
    await cleanup.transaction((tx) =>
      expect(tx.getCommand("cleanup-command")?.id).toBe("cleanup-command"),
    );
  });
});
