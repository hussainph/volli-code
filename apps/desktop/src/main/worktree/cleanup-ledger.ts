/**
 * The SQLite adapter behind the orphan-cleanup command core (VC-284 review S1).
 *
 * Three append-only tables — commands, facts, receipts — and nothing that is
 * ever updated in place. That is the whole point: the previous design replaced
 * one JSON blob after every item, so the last write to land decided what the
 * app believed had happened, and a write that never landed turned a deleted
 * directory back into work nobody had attempted.
 *
 * Ordering inside one command is `rowid`, this ledger's provisional local order
 * (docs/BOUNDARIES.md rule 2): every append goes through the single writer
 * below, and nothing outside reads it as global order. Durable IDs are UUIDs
 * minted by the core, never rowids.
 *
 * The transaction is serialized the way the Automations ledger serializes its
 * own — a promise tail plus an explicit `BEGIN IMMEDIATE` — because
 * better-sqlite3 transactions are synchronous and the core's work functions are
 * async. Reads are transactional too, so a projection can never observe a half
 * written run.
 */
import type Database from "better-sqlite3";
import type { OrphanCleanupReceipt, OrphanCleanupRejectionCode } from "@volli/shared";

import { prepared } from "../db/prepared";
import type {
  OrphanCleanupCommand,
  OrphanCleanupFact,
  OrphanCleanupFactKind,
  OrphanCleanupIntent,
  OrphanCleanupLedger,
  OrphanCleanupLedgerTransaction,
} from "./cleanup-engine";

interface CommandRow {
  id: string;
  intent: string;
  created_at: number;
}

interface FactRow {
  id: string;
  command_id: string;
  kind: string;
  payload: string;
  created_at: number;
}

interface ReceiptRow {
  id: string;
  command_id: string;
  status: OrphanCleanupReceipt["status"];
  code: string | null;
  detail: string | null;
  recorded_at: number;
}

/**
 * A stored JSON column, or a thrown error naming the row. A cleanup record that
 * cannot be parsed is a real fault — unlike the old blob, which answered "no
 * history" and made a corrupted record indistinguishable from an app that had
 * never deleted anything.
 */
function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${what} is not readable JSON`, { cause: error });
  }
}

class SqliteOrphanCleanupTransaction implements OrphanCleanupLedgerTransaction {
  constructor(private readonly db: Database.Database) {}

  getCommand(commandId: string): OrphanCleanupCommand | null {
    const row = prepared<[string], CommandRow>(
      this.db,
      "SELECT id, intent, created_at FROM worktree_cleanup_commands WHERE id = ?",
    ).get(commandId);
    if (row === undefined) return null;
    return {
      id: row.id,
      intent: parseJson(row.intent, `Cleanup command ${row.id} intent`) as OrphanCleanupIntent,
      createdAt: row.created_at,
    };
  }

  insertCommand(command: OrphanCleanupCommand): void {
    prepared(
      this.db,
      "INSERT INTO worktree_cleanup_commands (id, intent, created_at) VALUES (?, ?, ?)",
    ).run(command.id, JSON.stringify(command.intent), command.createdAt);
  }

  appendFact(fact: OrphanCleanupFact): void {
    prepared(
      this.db,
      `INSERT INTO worktree_cleanup_facts (id, command_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(fact.id, fact.commandId, fact.kind, JSON.stringify(fact.payload ?? null), fact.createdAt);
  }

  listFacts(commandId: string): readonly OrphanCleanupFact[] {
    const rows = prepared<[string], FactRow>(
      this.db,
      `SELECT id, command_id, kind, payload, created_at
         FROM worktree_cleanup_facts
        WHERE command_id = ?
        ORDER BY rowid ASC`,
    ).all(commandId);
    return rows.map((row) => ({
      id: row.id,
      commandId: row.command_id,
      kind: row.kind as OrphanCleanupFactKind,
      payload: parseJson(row.payload, `Cleanup fact ${row.id} payload`),
      createdAt: row.created_at,
    }));
  }

  listReceipts(commandId: string): readonly OrphanCleanupReceipt[] {
    const rows = prepared<[string], ReceiptRow>(
      this.db,
      `SELECT id, command_id, status, code, detail, recorded_at
         FROM worktree_cleanup_receipts
        WHERE command_id = ?
        ORDER BY rowid ASC`,
    ).all(commandId);
    return rows.map((row) => ({
      id: row.id,
      commandId: row.command_id,
      status: row.status,
      code: row.code === null ? null : (row.code as OrphanCleanupRejectionCode),
      detail: row.detail,
      recordedAt: row.recorded_at,
    }));
  }

  appendReceipt(receipt: OrphanCleanupReceipt): void {
    prepared(
      this.db,
      `INSERT INTO worktree_cleanup_receipts (id, command_id, status, code, detail, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.id,
      receipt.commandId,
      receipt.status,
      receipt.code,
      receipt.detail,
      receipt.recordedAt,
    );
  }

  recentCommandIds(limit: number): readonly string[] {
    const rows = prepared<[number], { id: string }>(
      this.db,
      `SELECT id FROM worktree_cleanup_commands ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(limit);
    return rows.map((row) => row.id);
  }
}

/** The single-writer, serialized SQLite ledger the desktop composition uses. */
export class SqliteOrphanCleanupLedger implements OrphanCleanupLedger {
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly db: Database.Database) {}

  async transaction<T>(
    work: (transaction: OrphanCleanupLedgerTransaction) => T | Promise<T>,
  ): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let began = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = await work(new SqliteOrphanCleanupTransaction(this.db));
      this.db.exec("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      // A failed BEGIN must not strand every later command behind this queue.
      release();
    }
  }
}
