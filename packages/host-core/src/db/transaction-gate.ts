import type Database from "better-sqlite3";
import type { Synchronous } from "@volli/shared";
import { guardCachedStatements } from "./prepared";
import { hostLogger } from "../log/root";

const log = hostLogger("db");

/**
 * One JS thread, no transaction across an await (VC-551). Independent writes
 * autocommit; multi-statement writes/consistent reads use this synchronous
 * helper. Async host work belongs before or after the atomic boundary.
 */
export function withTransaction<T>(db: Database.Database, work: () => Synchronous<T>): T {
  const owner = ownership(db);
  owner?.check();
  if (owner) owner.depth += 1;
  const nested = db.inTransaction;
  const statements = nested ? SAVEPOINT : TOP_LEVEL;
  try {
    // A failed BEGIN owns nothing and must not roll back somebody else's work.
    boundary(db, owner, statements.begin);
    try {
      const value = work();
      assertSynchronous(value);
      owner?.check();
      boundary(db, owner, statements.end);
      return value;
    } catch (error) {
      if (db.inTransaction) {
        try {
          boundary(db, owner, statements.undo);
          if (nested) boundary(db, owner, SAVEPOINT.end);
        } catch {
          // Preserve the original error if SQLite already aborted.
        }
      }
      throw error;
    }
  } finally {
    if (owner) owner.depth -= 1;
  }
}

/** Promise-shaped ledger port; the entire transaction runs before returning. */
export function settleTransaction<T>(
  db: Database.Database,
  work: () => Synchronous<T>,
): Promise<T> {
  try {
    return Promise.resolve(withTransaction(db, work));
  } catch (error) {
    return Promise.reject(error);
  }
}

export type TransactionViolationHandler = (violation: Error) => void;

export const throwTransactionViolation: TransactionViolationHandler = (violation) => {
  throw violation;
};

/** Composition selects this explicitly for packaged builds, never from NODE_ENV. */
export const logTransactionViolation: TransactionViolationHandler = (violation) => {
  log.error("sqlite transaction ownership violation", { error: violation });
};

/**
 * Fail tests on an unowned transaction BEFORE another read/write can join it.
 * Raw exec/prepared BEGIN or SAVEPOINT cannot leave a transaction open between
 * calls. Native db.transaction callbacks own the synchronous stack too (and
 * better-sqlite3 rejects promises). Cached repo statements are wrapped in place,
 * not just newly prepared ones. Boot/migration/recovery connections stay direct.
 *
 * With a throwing handler, roll back an unowned transaction and fail at its
 * source, synchronously. The packaged handler only logs: no throw or rollback,
 * preserving release behavior if a programming error ever escapes the tests.
 */
export function guardTransactionOwnership(
  db: Database.Database,
  onViolation: TransactionViolationHandler,
): void {
  const existing = ownership(db);
  if (existing) {
    existing.onViolation = onViolation;
    existing.refreshStatements?.();
    return;
  }
  const exec = db.exec.bind(db);
  const owner: Ownership = {
    depth: 0,
    boundaryDepth: 0,
    onViolation,
    check() {
      if (owner.boundaryDepth !== 0) return;
      const open = db.inTransaction;
      if (open === (owner.depth !== 0)) return;
      const error = new Error(
        owner.depth === 0
          ? "SQLite transaction ownership: an unowned transaction is open; use withTransaction with synchronous work"
          : "SQLite transaction ownership: an owned transaction ended inside its work body",
      );
      try {
        owner.onViolation(error);
      } catch (violation) {
        // Tests/dev fail closed; a subsequent command cannot join this work.
        try {
          exec("ROLLBACK");
        } catch {
          // Preserve the ownership violation.
        }
        throw violation;
      }
    },
  };
  Object.defineProperty(db, OWNERSHIP, { value: owner });
  const checked = <T>(work: () => T): T => {
    owner.check();
    try {
      return work();
    } finally {
      owner.check();
    }
  };
  db.exec = (sql) => checked(() => exec(sql));
  const pragma = db.pragma.bind(db);
  db.pragma = ((sql: string, options?: Database.PragmaOptions) =>
    checked(() => pragma(sql, options))) as Database.Database["pragma"];
  const wrapped = new WeakSet<Database.Statement>();
  const guardStatement = (statement: Database.Statement): void => {
    if (wrapped.has(statement)) return;
    // Packaged builds diagnose transaction openings/writes, not every row read.
    // SELECT/RETURNING readers cannot open an explicit SQLite transaction.
    // Tests/dev still check every read, including iterator stepping.
    if (statement.reader && owner.onViolation === logTransactionViolation) return;
    wrapped.add(statement);
    for (const method of ["run", "get", "all"] as const) {
      const original = statement[method].bind(statement);
      Object.defineProperty(statement, method, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => checked(() => original(...args)),
      });
    }
    const iterate = statement.iterate.bind(statement);
    statement.iterate = (...args) => {
      const iterator = checked(() => iterate(...args));
      const next = iterator.next.bind(iterator);
      // iterate is lazy: check at stepping, not just cursor creation.
      iterator.next = (...values) => checked(() => next(...values));
      return iterator;
    };
  };
  owner.refreshStatements = () => guardCachedStatements(db, guardStatement);
  owner.refreshStatements();
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = checked(() => prepare(sql));
    guardStatement(statement);
    return statement;
  }) as Database.Database["prepare"];
  const transaction = db.transaction.bind(db);
  db.transaction = ((work: (...args: unknown[]) => unknown) => {
    const native = transaction(function (this: unknown, ...args: unknown[]) {
      const value = work.apply(this, args);
      assertSynchronous(value);
      owner.check();
      return value;
    });
    const properties: PropertyDescriptorMap = { database: { value: db, enumerable: true } };
    for (const mode of ["default", "deferred", "immediate", "exclusive"] as const) {
      properties[mode] = {
        value: function (this: unknown, ...args: unknown[]) {
          // Check before native BEGIN/SAVEPOINT, including cached tx wrappers.
          owner.check();
          owner.depth += 1;
          try {
            return native[mode].apply(this, args);
          } finally {
            owner.depth -= 1;
          }
        },
      };
    }
    for (const mode of ["default", "deferred", "immediate", "exclusive"] as const) {
      Object.defineProperties(properties[mode]!.value, properties);
    }
    return properties.default!.value;
  }) as Database.Database["transaction"];
}

interface Ownership {
  depth: number;
  boundaryDepth: number;
  onViolation: TransactionViolationHandler;
  check(): void;
  refreshStatements?: () => void;
}
// A property, not a WeakMap: instrumentation proxies that forward handle
// properties must share the underlying connection's ownership too.
const OWNERSHIP = Symbol("SQLite transaction ownership");
function ownership(db: Database.Database): Ownership | undefined {
  return (db as Database.Database & { [OWNERSHIP]?: Ownership })[OWNERSHIP];
}
function boundary(db: Database.Database, owner: Ownership | undefined, sql: string): void {
  if (owner) owner.boundaryDepth += 1;
  try {
    db.exec(sql);
  } finally {
    if (owner) owner.boundaryDepth -= 1;
  }
}
const TOP_LEVEL = { begin: "BEGIN IMMEDIATE", end: "COMMIT", undo: "ROLLBACK" } as const;
const SAVEPOINT = {
  begin: "SAVEPOINT volli_tx",
  end: "RELEASE volli_tx",
  undo: "ROLLBACK TO volli_tx",
} as const;

function assertSynchronous(value: unknown): void {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    // The invalid async body may reject after we roll back. Observe it rather
    // than adding an unhandled rejection to the useful synchronous error.
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError("SQLite transaction work must be synchronous");
  }
}
