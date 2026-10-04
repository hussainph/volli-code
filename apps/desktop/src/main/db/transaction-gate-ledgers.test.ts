import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { getProjectById, insertProject } from "@volli/host-core/db/projects-repo";
import { openTestDb, testProject } from "@volli/host-core/db/test-helpers";
import type { TestDb } from "@volli/host-core/db/test-helpers";
import { SqliteAutomationLedger } from "../automations/sqlite-ledger";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { SqliteOrphanCleanupLedger } from "../worktree/cleanup-ledger";

/**
 * The transaction gate's cases that need desktop ledgers. The gate itself and
 * the rest of its suite live in `@volli/host-core` (`src/db/transaction-gate.test.ts`);
 * these follow it once the Session, Automation and cleanup ledgers move there.
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
  it("commits ledger and independent repo work before returning their promises", async () => {
    const { db } = setup();
    const order: string[] = [];
    const first = createSqliteSessionLedger(db).transaction(() => {
      order.push("first session");
      return "committed";
    });
    const second = createSqliteSessionLedger(db).transaction(() => order.push("second session"));
    const project = testProject();
    insertProject(db, project);
    order.push("repo");
    expect(db.inTransaction).toBe(false);
    expect(order).toEqual(["first session", "second session", "repo"]);
    expect(getProjectById(db, project.id)?.id).toBe(project.id);
    expect(await first).toBe("committed");
    await second;
  });

  it("shares ownership with instrumentation proxies of the same handle", async () => {
    const { db } = setup();
    const proxy = new Proxy(db, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const project = testProject();
    await createSqliteSessionLedger(proxy).transaction(() => insertProject(proxy, project));
    expect(getProjectById(db, project.id)?.id).toBe(project.id);
    expect(db.inTransaction).toBe(false);
  });

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

  it("cannot lose an independent synchronous repo write to an awaited transaction rollback", async () => {
    const { db } = setup();
    const release = Promise.withResolvers<void>();
    const project = testProject({ id: "independent" });
    // Deliberately bypass the compile-time contract to prove runtime safety.
    // @ts-expect-error Async transaction bodies are forbidden.
    const first = createSqliteSessionLedger(db).transaction(async () => {
      await release.promise;
      throw new Error("host failed");
    });
    const failure = expect(first).rejects.toThrow("must be synchronous");
    expect(db.inTransaction).toBe(false);
    insertProject(db, project);
    release.resolve();
    await failure;
    expect(getProjectById(db, project.id)?.id).toBe(project.id);
  });
});
