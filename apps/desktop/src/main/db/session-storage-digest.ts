import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

type DigestValue = string | number | bigint | null;
type DigestRow = Record<string, DigestValue>;

export interface TableContentDigest {
  rows: number;
  sha256: string;
}

/** Logical Session storage content protected by migration 42. */
export interface SessionStorageContentDigest {
  sessionEvents: TableContentDigest;
  sessionUsage: TableContentDigest;
  sessionCommandReceipts: TableContentDigest;
}

function hasColumn(db: BetterSqlite3.Database, table: string, column: string): boolean {
  const columns = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{
    name: string;
  }>;
  return columns.some(({ name }) => name === column);
}

/**
 * Hashes typed, length-framed SQL values so neither column nor row boundaries
 * can collide. The caller's ORDER BY is part of the digest contract.
 */
function digestRows(
  rows: Iterable<DigestRow>,
  columns: readonly string[],
  domain: string,
): TableContentDigest {
  const hash = createHash("sha256");
  hash.update(`volli:${domain}:v1\0`, "utf8");
  let count = 0;
  for (const row of rows) {
    hash.update("row\0", "utf8");
    for (const column of columns) {
      const value = row[column];
      if (value === null) {
        hash.update("null\0", "utf8");
        continue;
      }
      const type = typeof value;
      const text = type === "bigint" ? value.toString() : String(value);
      hash.update(`${type}:${Buffer.byteLength(text, "utf8")}:`, "utf8");
      hash.update(text, "utf8");
      hash.update("\0", "utf8");
    }
    count += 1;
  }
  return { rows: count, sha256: hash.digest("hex") };
}

const EVENT_COLUMNS = [
  "session_id",
  "sequence",
  "occurred_at",
  "recorded_at",
  "provenance",
  "attachment_id",
  "command_id",
  "payload",
] as const;

function digestSessionEvents(db: BetterSqlite3.Database): TableContentDigest {
  const provenance = hasColumn(db, "session_events", "provenance")
    ? "e.provenance"
    : "p.provenance";
  const join =
    provenance === "e.provenance"
      ? ""
      : " JOIN session_provenances p ON p.id = e.provenance_id";
  const rows = db
    .prepare(
      `SELECT e.session_id, e.sequence, e.occurred_at, e.recorded_at,
              ${provenance} AS provenance, e.attachment_id, e.command_id, e.payload
         FROM session_events e${join}
        ORDER BY e.session_id COLLATE BINARY, e.sequence`,
    )
    .iterate() as Iterable<DigestRow>;
  return digestRows(rows, EVENT_COLUMNS, "session-events-content");
}

const USAGE_COLUMNS = [
  "session_id",
  "project_id",
  "ticket_id",
  "occurred_at",
  "cause",
  "provider_id",
  "model_id",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_usd",
  "cost_basis",
] as const;

function digestSessionUsage(db: BetterSqlite3.Database): TableContentDigest {
  const rows = db
    .prepare(
      `SELECT ${USAGE_COLUMNS.join(", ")}
         FROM session_usage
        ORDER BY session_id COLLATE BINARY, project_id COLLATE BINARY,
                 ticket_id COLLATE BINARY, occurred_at, cause COLLATE BINARY,
                 provider_id COLLATE BINARY, model_id COLLATE BINARY,
                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                 cost_usd, cost_basis COLLATE BINARY`,
    )
    .iterate() as Iterable<DigestRow>;
  return digestRows(rows, USAGE_COLUMNS, "session-usage-content");
}

const RECEIPT_COLUMNS = ["session_id", "command_id", "sequence", "recorded_at", "receipt"] as const;

function digestSessionCommandReceipts(db: BetterSqlite3.Database): TableContentDigest {
  const rows = db
    .prepare(
      `SELECT ${RECEIPT_COLUMNS.join(", ")}
         FROM session_command_receipts
        ORDER BY session_id COLLATE BINARY, command_id COLLATE BINARY,
                 sequence, recorded_at, receipt COLLATE BINARY`,
    )
    .iterate() as Iterable<DigestRow>;
  return digestRows(rows, RECEIPT_COLUMNS, "session-command-receipts-content");
}

/**
 * Computes the migration's logical before/after digest on an open v41-or-newer
 * database. Event ids, usage event ids, and receipt row/event ids are omitted;
 * every value migration 42 must preserve is hashed in a deterministic order.
 * Receipt JSON stays byte-for-byte protected because native receipt ids are not
 * in migration 42's narrowed rewrite scope.
 */
export function computeSessionStorageContentDigest(
  db: BetterSqlite3.Database,
): SessionStorageContentDigest {
  return {
    sessionEvents: digestSessionEvents(db),
    sessionUsage: digestSessionUsage(db),
    sessionCommandReceipts: digestSessionCommandReceipts(db),
  };
}

/** Opens any database path read-only and computes its logical Session digest. */
export function computeSessionStorageContentDigestAtPath(
  dbPath: string,
): SessionStorageContentDigest {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return computeSessionStorageContentDigest(db);
  } finally {
    db.close();
  }
}

/** Throws inside migration 42's transaction if any protected content changed. */
export function assertSessionStorageContentUnchanged(
  before: SessionStorageContentDigest,
  after: SessionStorageContentDigest,
): void {
  const mismatches = (Object.keys(before) as Array<keyof SessionStorageContentDigest>).filter(
    (table) =>
      before[table].rows !== after[table].rows ||
      before[table].sha256 !== after[table].sha256,
  );
  if (mismatches.length > 0) {
    throw new Error(`Session storage content changed during migration: ${mismatches.join(", ")}`);
  }
}
