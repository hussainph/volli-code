import type Database from "better-sqlite3";

/**
 * Returns the integer key for byte-exact Session event provenance JSON.
 *
 * The value index is deliberately non-unique because backup redaction can make
 * two source rows identical after stripping machine-local details. Live writes
 * reuse the oldest matching row; restored duplicate rows keep their existing
 * integer identities.
 */
export function internSessionEventProvenance(db: Database.Database, provenance: string): number {
  const existing = db
    .prepare(
      `SELECT id
         FROM session_provenances
        WHERE provenance = ?
        ORDER BY id
        LIMIT 1`,
    )
    .get(provenance) as { id: number } | undefined;
  if (existing !== undefined) return existing.id;
  const inserted = db
    .prepare("INSERT INTO session_provenances (provenance) VALUES (?)")
    .run(provenance);
  return Number(inserted.lastInsertRowid);
}
