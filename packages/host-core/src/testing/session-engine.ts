/** Standalone engine fixture; production consumers receive createHostCore's engine. */
import type Database from "better-sqlite3";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createHostSessionEngine } from "../sessions/engine";

export function createTestSessionEngine(
  db: Database.Database,
  ports: Parameters<typeof createHostSessionEngine>[1] = {},
) {
  return createHostSessionEngine(createSqliteSessionLedger(db), ports);
}
