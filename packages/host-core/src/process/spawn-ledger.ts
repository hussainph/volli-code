/**
 * The spawn ledger as the spawn sites see it (VC-341): a port they can call on
 * the way to `spawn`, backed by SQLite, that cannot fail loudly enough to cost
 * anyone a process.
 *
 * WHY A PORT. Three different doors start children on a Session's behalf — the
 * `execute` tool inside `@volli/agent-runtime`, the background shell host, and
 * the terminal PTY manager — and only one of them lives near the database. They
 * depend on {@link SpawnLedgerPort}, which is vocabulary in `@volli/shared`, so
 * none of them acquires a SQLite dependency and every one of them is testable
 * with an array.
 *
 * WHY IT SWALLOWS ITS OWN FAILURES. A ledger write is bookkeeping about work a
 * person asked for; it is not the work. A failed INSERT must not turn a
 * requested command into an error, and there is no action a person could take
 * about it in the moment — so it logs and the spawn proceeds. What that costs
 * is precision, not safety: a child with no row is exactly the case the cwd
 * sweep exists to catch, and the reader never trusts a row it does have.
 */
import { randomUUID } from "node:crypto";

import {
  errorMessage,
  type SpawnLedgerEntry,
  type SpawnLedgerPort,
  type SpawnLedgerSpawn,
} from "@volli/shared";
import type Database from "better-sqlite3";

import {
  listOpenSpawns,
  markSpawnExited,
  pruneSpawnLedger,
  recordSpawn,
} from "../db/spawn-ledger-repo";

export interface SpawnLedgerOptions {
  now?: () => number;
  createId?: () => string;
  /** Where a failed write is reported; defaults to a warning on the main log. */
  onError?: (message: string) => void;
}

export class SpawnLedger implements SpawnLedgerPort {
  readonly #db: Database.Database | null;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #onError: (message: string) => void;

  /** `null` for a launch whose database never opened: every call becomes a no-op. */
  constructor(db: Database.Database | null, options: SpawnLedgerOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#onError =
      options.onError ?? ((message: string) => console.warn(`[spawn-ledger] ${message}`));
  }

  /** The row's id, or `null` when nothing was written — the caller then has nothing to mark. */
  recordSpawn(spawn: SpawnLedgerSpawn): string | null {
    if (this.#db === null) return null;
    const id = this.#createId();
    try {
      recordSpawn(this.#db, id, spawn);
      return id;
    } catch (error) {
      this.#onError(`could not record pid ${spawn.pid}: ${errorMessage(error)}`);
      return null;
    }
  }

  markExited(id: string, exitedAt: number = this.#now()): void {
    if (this.#db === null) return;
    try {
      markSpawnExited(this.#db, id, exitedAt);
    } catch (error) {
      this.#onError(`could not close row ${id}: ${errorMessage(error)}`);
    }
  }

  /** Every child Volli believes is still running. */
  listOpen(): SpawnLedgerEntry[] {
    if (this.#db === null) return [];
    try {
      return listOpenSpawns(this.#db);
    } catch (error) {
      this.#onError(`could not read the ledger: ${errorMessage(error)}`);
      return [];
    }
  }

  /** Retention, run beside a scan rather than on a timer of its own. */
  prune(): number {
    if (this.#db === null) return 0;
    try {
      return pruneSpawnLedger(this.#db, this.#now());
    } catch (error) {
      this.#onError(`could not prune: ${errorMessage(error)}`);
      return 0;
    }
  }
}

/**
 * A ledger that remembers nothing, for callers with no database and for tests
 * that are not about the ledger. Named rather than an inline object literal so
 * a reader of a spawn site can see that "no ledger" is a supported state.
 */
export const NO_SPAWN_LEDGER: SpawnLedgerPort = {
  recordSpawn: () => null,
  markExited: () => {},
};
