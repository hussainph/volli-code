import type Database from "better-sqlite3";
import { prepared } from "./prepared";

/**
 * Returns the integer key for byte-exact Session event provenance JSON.
 *
 * The value index is deliberately non-unique because backup redaction can make
 * two source rows identical after stripping machine-local details. Live writes
 * reuse the oldest matching row; restored duplicate rows keep their existing
 * integer identities.
 *
 * Both statements go through the per-handle prepared cache (VC-355): this runs
 * once per appended event, which makes it one of the hottest write statements
 * in the Session ledger, and better-sqlite3 re-parses and re-plans every
 * uncached `db.prepare`.
 */
export function internSessionEventProvenance(db: Database.Database, provenance: string): number {
  const existing = prepared(
    db,
    `SELECT id
         FROM session_provenances
        WHERE provenance = ?
        ORDER BY id
        LIMIT 1`,
  ).get(provenance) as { id: number } | undefined;
  if (existing !== undefined) return existing.id;
  const inserted = prepared(db, "INSERT INTO session_provenances (provenance) VALUES (?)").run(
    provenance,
  );
  return Number(inserted.lastInsertRowid);
}
