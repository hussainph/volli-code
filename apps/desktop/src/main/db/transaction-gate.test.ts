import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SqliteAutomationLedger } from "../automations/sqlite-ledger";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { SqliteOrphanCleanupLedger } from "../worktree/cleanup-ledger";
import { prepared } from "./prepared";
import { getProjectById, insertProject } from "./projects-repo";
import { openRawDb, openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import {
  guardTransactionOwnership,
  logTransactionViolation,
  settleTransaction,
  throwTransactionViolation,
  withTransaction,
} from "./transaction-gate";

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

describe("connection transaction ownership", () => {
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

  it("does not serialize independent handles through a global queue", () => {
    const { db } = setup();
    const other = setup().db;
    expect(withTransaction(db, () => withTransaction(other, () => 42))).toBe(42);
    expect(db.inTransaction).toBe(false);
    expect(other.inTransaction).toBe(false);
  });

  it("nests with savepoints and rolls back only the failed inner work", () => {
    const { db } = setup();
    const outer = testProject();
    const inner = testProject();
    withTransaction(db, () => {
      insertProject(db, outer);
      expect(() =>
        withTransaction(db, () => {
          insertProject(db, inner);
          throw new Error("inner failed");
        }),
      ).toThrow("inner failed");
      expect(getProjectById(db, inner.id)).toBeUndefined();
      expect(getProjectById(db, outer.id)?.id).toBe(outer.id);
    });
    expect(getProjectById(db, outer.id)?.id).toBe(outer.id);
  });

  it("does not roll back somebody else's work when BEGIN fails on an unguarded boot handle", () => {
    const db = openRawDb(":memory:");
    try {
      db.exec("BEGIN IMMEDIATE");
      const work = vi.fn();
      // A failed savepoint (for example, a disk or authorization error).
      vi.spyOn(db, "exec").mockImplementation(() => {
        throw new Error("begin failed");
      });
      expect(() => withTransaction(db, work)).toThrow("begin failed");
      expect(work).not.toHaveBeenCalled();
      expect(db.inTransaction).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rolls back a failed COMMIT and lets the next transaction continue", async () => {
    const { db } = setup();
    const project = testProject();
    const failure = new Error("commit failed");
    const exec = db.exec.bind(db);
    let failCommit = true;
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT" && failCommit) {
        failCommit = false;
        throw failure;
      }
      return exec(sql);
    });
    const first = settleTransaction(db, () => insertProject(db, project));
    const second = settleTransaction(db, () => getProjectById(db, project.id));
    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBeUndefined();
    expect(db.inTransaction).toBe(false);
  });

  it("preserves the work error when ROLLBACK also fails", async () => {
    const { db } = setup();
    const failure = new Error("work failed");
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      const result = exec(sql);
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return result;
    });
    await expect(
      settleTransaction(db, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(settleTransaction(db, () => 42)).resolves.toBe(42);
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

  it.each(["BEGIN IMMEDIATE", "/* comment */ BEGIN", "SAVEPOINT unsafe", "SELECT 1; BEGIN"])(
    "fails closed synchronously on raw exec %s, before another write can join",
    (sql) => {
      const { db } = setup();
      expect(() => db.exec(sql)).toThrow("transaction ownership");
      expect(db.inTransaction).toBe(false);
      const project = testProject();
      insertProject(db, project);
      expect(getProjectById(db, project.id)?.id).toBe(project.id);
    },
  );

  it("guards cached prepared statements at execution, not preparation", () => {
    const db = openRawDb(":memory:");
    try {
      const begin = prepared(db, "/* cached before guard */ BEGIN");
      guardTransactionOwnership(db, throwTransactionViolation);
      expect(prepared(db, "/* cached before guard */ BEGIN")).toBe(begin);
      expect(() => begin.run()).toThrow("transaction ownership");
      expect(db.inTransaction).toBe(false);
      expect(() => db.prepare("SAVEPOINT unsafe").run()).toThrow("transaction ownership");
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("rejects promises from native db.transaction callbacks too", async () => {
    const { db } = setup();
    const project = testProject();
    expect(() =>
      db.transaction(async () => {
        insertProject(db, project);
      })(),
    ).toThrow("must be synchronous");
    await Promise.resolve();
    expect(getProjectById(db, project.id)).toBeUndefined();
    expect(db.inTransaction).toBe(false);
  });

  it("checks reads and writes when a transaction was opened through an older raw statement", () => {
    const db = openRawDb(":memory:");
    try {
      db.exec("CREATE TABLE example (id INTEGER)");
      const rawBegin = db.prepare("BEGIN");
      guardTransactionOwnership(db, throwTransactionViolation);
      rawBegin.run();
      expect(() => db.prepare("INSERT INTO example VALUES (1)").run()).toThrow(
        "transaction ownership",
      );
      expect(db.prepare("SELECT * FROM example").all()).toEqual([]);
      rawBegin.run();
      expect(() => db.exec("SELECT 1")).toThrow("transaction ownership");
      rawBegin.run();
      expect(() => db.pragma("user_version = 1")).toThrow("transaction ownership");
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("cannot open a transaction while a lazy reader is active", () => {
    const db = openRawDb(":memory:");
    try {
      const rawBegin = db.prepare("BEGIN");
      guardTransactionOwnership(db, throwTransactionViolation);
      const iterator = db.prepare("SELECT 42 AS value").iterate();
      try {
        expect(() => rawBegin.run()).toThrow("busy executing a query");
        expect(iterator.next()).toEqual({ done: false, value: { value: 42 } });
        expect(db.inTransaction).toBe(false);
      } finally {
        iterator.return?.();
      }
    } finally {
      db.close();
    }
  });

  it("guards cached native transaction wrappers before BEGIN and preserves every variant", () => {
    const db = openRawDb(":memory:");
    try {
      const rawBegin = db.prepare("BEGIN");
      guardTransactionOwnership(db, throwTransactionViolation);
      const work = vi.fn((value: number) => value);
      const transaction = db.transaction(work);
      expect(transaction).toHaveProperty("database", db);
      for (const mode of ["default", "deferred", "immediate", "exclusive"] as const) {
        expect(transaction[mode](42)).toBe(42);
        rawBegin.run();
        work.mockClear();
        expect(() => transaction[mode](42)).toThrow("transaction ownership");
        expect(work).not.toHaveBeenCalled();
        expect(db.inTransaction).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("keeps packaged readers native and upgrades cached reads when strict checking is selected", () => {
    const db = openRawDb(":memory:");
    try {
      const rawBegin = db.prepare("BEGIN");
      const reader = prepared(db, "SELECT 42 AS value");
      const get = reader.get;
      guardTransactionOwnership(db, logTransactionViolation);
      expect(reader.get).toBe(get);
      guardTransactionOwnership(db, throwTransactionViolation);
      expect(reader.get).not.toBe(get);
      rawBegin.run();
      expect(() => reader.get()).toThrow("transaction ownership");
    } finally {
      db.close();
    }
  });

  it.each(["helper", "native"])(
    "poisons %s work after a raw rollback, preventing later autocommit writes",
    (mode) => {
      const { db } = setup();
      const first = testProject();
      const later = testProject();
      const work = () => {
        insertProject(db, first);
        expect(() => db.exec("ROLLBACK")).toThrow("ended inside its work body");
        expect(() => insertProject(db, later)).toThrow("ended inside its work body");
      };
      expect(() =>
        mode === "helper" ? withTransaction(db, work) : db.transaction(work)(),
      ).toThrow("ended inside its work body");
      expect(getProjectById(db, first.id)).toBeUndefined();
      expect(getProjectById(db, later.id)).toBeUndefined();
      insertProject(db, later);
      expect(getProjectById(db, later.id)?.id).toBe(later.id);
    },
  );

  it("logs only with the packaged handler, without throwing or changing transaction behavior", () => {
    const { db } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    guardTransactionOwnership(db, logTransactionViolation);
    expect(() => db.exec("BEGIN")).not.toThrow();
    const project = testProject();
    expect(() => insertProject(db, project)).not.toThrow();
    expect(() => db.exec("ROLLBACK")).not.toThrow();
    expect(getProjectById(db, project.id)).toBeUndefined();
    expect(log).toHaveBeenCalled();
  });
});
