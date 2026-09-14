import Database from "better-sqlite3";
import { migrate } from "./migrations";

/**
 * Opens (creating if absent) the Volli SQLite database at `dbPath`, applies
 * the pragmas migration 001 assumes — WAL journaling, foreign keys ON, a
 * busy timeout so a brief writer/reader overlap blocks instead of erroring,
 * NORMAL synchronous (safe under WAL) — plus the read-tuning pragmas
 * (VC-355): a 64 MB page cache, 256 MB of memory-mapped I/O, and in-memory
 * temp storage, so reads over a large history avoid the OS round-trip and
 * sorts/hashes stay off disk. The WAL itself is bounded by an aggressive
 * `wal_autocheckpoint` (see below) and, when migrations run, a bounded ANALYZE
 * refreshes the planner statistics without making routine opens write.
 *
 * Runs any pending migrations.
 * The parent directory must already exist; `src/main/index.ts` creates it
 * (and catches everything this throws) before calling in, since that's also
 * where the open+migrate failure is turned into the degraded IPC story.
 */
export function openVolliDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  // VC-355 read tuning. `cache_size` is negative = KiB (64 MB); `mmap_size`
  // lets SQLite read pages straight from the page cache of the OS. Both are
  // per-handle and harmless on a small database — they only set ceilings.
  db.pragma("cache_size = -64000");
  db.pragma("mmap_size = 268435456");
  db.pragma("temp_store = MEMORY");
  // Bound the WAL: checkpoint (and restart from zero) once it passes 400
  // pages (~1.6 MB at the 4 KiB page size migration 001 assumes). The default
  // 1000 already exists, but the session ledger appends densely and a smaller
  // ceiling keeps the WAL file itself from dominating a 260k-event history's
  // disk footprint while the automatic checkpoint still amortizes to a page
  // or two per commit.
  db.pragma("wal_autocheckpoint = 400");
  const migrated = migrate(db, dbPath);
  // Post-migration, so it sees the final schema. A bounded ANALYZE
  // (`analysis_limit` keeps each table's scan proportional — SQLite's own
  // recommendation for routine maintenance) keeps a migration from leaving
  // the planner blind. Do not repeat it on a routine open: ANALYZE takes a
  // write lock and changes sqlite_stat1 even when application data did not.
  if (migrated) {
    db.pragma("analysis_limit = 1000");
    db.exec("ANALYZE");
  }
  return db;
}
