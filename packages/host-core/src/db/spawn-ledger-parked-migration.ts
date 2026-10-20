import type Database from "better-sqlite3";

/**
 * VC-833: expand-only. `spawned_processes.parked_at` — when Volli SIGSTOPped
 * the terminal tree a row names, or NULL while it runs.
 *
 * Which terminals are parked used to live only in memory. When the host dies
 * without waking them (a crash, `kill -9`, a force quit), the PTY's hangup
 * SIGHUP pends on the stopped shell and the whole tree stays frozen with its
 * memory and file locks. The next launch reads this column to find those
 * rows and SIGCONT them, which delivers the pending SIGHUP.
 *
 * A nullable column with no default: every existing row reads as "not
 * parked", and an older build — which names its columns in every INSERT and
 * SELECT on this table — neither reads nor writes it. A row an older build
 * writes stays NULL, which is the truth, because an older build's parks are
 * not recorded. The table is excluded from backups, so no bundle carries it.
 */
export const SPAWN_LEDGER_PARKED_COLUMN_MIGRATION = `
ALTER TABLE spawned_processes ADD COLUMN parked_at INTEGER;
`;

/**
 * Probe-gated like 053's column addition: `ADD COLUMN` throws on a column that
 * is already there, and a lineage can be re-offered a version it already ran.
 */
export function applySpawnLedgerParkedColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(spawned_processes)") as { name: string }[];
  if (columns.some(({ name }) => name === "parked_at")) return;
  db.exec(SPAWN_LEDGER_PARKED_COLUMN_MIGRATION);
}
