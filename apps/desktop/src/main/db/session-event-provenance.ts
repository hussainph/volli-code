import type Database from "better-sqlite3";
// Explicit `.ts`, unlike the extensionless imports elsewhere in this directory:
// `automations-notification-smoke.mjs` loads THIS module directly through Node's
// native TypeScript ESM, which resolves specifiers literally and cannot find an
// extensionless one. Bundled and test builds accept either form.
import { prepared } from "./prepared.ts";

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
