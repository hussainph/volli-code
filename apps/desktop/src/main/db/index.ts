import Database from "better-sqlite3";
import { migrate } from "./migrations";

/**
 * Opens (creating if absent) the Volli SQLite database at `dbPath`, applies
 * the pragmas migration 001 assumes — WAL journaling, foreign keys ON, a
 * busy timeout so a brief writer/reader overlap blocks instead of erroring,
 * NORMAL synchronous (safe under WAL) — and runs any pending migrations.
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
  migrate(db, dbPath);
  return db;
}
