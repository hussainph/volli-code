import type Database from "better-sqlite3";

/**
 * One async transaction owner per SQLite connection, shared by every ledger.
 * A WeakMap keeps ownership tied to the handle's lifetime, not the database
 * path: a different handle has its own queue and SQLite arbitrates its locks.
 *
 * This is cooperative, not an interceptor of db.prepare/exec or repo calls.
 * Independent repo work must use getTransactionGate(db).transaction(() =>
 * repoWrite(db)); direct synchronous work during an awaited transaction joins
 * that transaction (including its rollback). Existing ungated repo callers
 * remain a known limit; see docs/BOUNDARIES.md, "SQLite transaction ownership".
 * Work already inside a transaction calls repos directly and must not await
 * another transaction on the same gate: it would queue behind itself.
 */
export interface SqliteTransactionGate {
  transaction<T>(work: () => T | Promise<T>): Promise<T>;
}

const gates = new WeakMap<Database.Database, SqliteTransactionGate>();

export function getTransactionGate(db: Database.Database): SqliteTransactionGate {
  let gate = gates.get(db);
  if (gate === undefined) {
    gate = new ConnectionTransactionGate(db);
    gates.set(db, gate);
  }
  return gate;
}

class ConnectionTransactionGate implements SqliteTransactionGate {
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly db: Database.Database) {}

  transaction<T>(work: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      // Outside the try: a failed BEGIN never owns the transaction and must
      // not roll back a transaction somebody else opened on this handle.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const value = await work();
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the useful original error if SQLite already aborted.
        }
        throw error;
      }
    };
    const queued = this.#tail.then(run);
    // Neither BEGIN, work, COMMIT nor ROLLBACK failures poison the queue.
    this.#tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}
