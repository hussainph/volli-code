import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { createSessionEngine } from "@volli/session-engine";
import type { SessionEngine } from "@volli/session-engine";
import { createSqliteSessionLedger } from "./sqlite-ledger";

/** Main-process composition root: SQLite is the only Session writer today. */
export function createDesktopSessionEngine(
  db: Database.Database,
  ports: { now?: () => number; nextId?: () => string } = {},
): SessionEngine {
  const now = ports.now ?? Date.now;
  const nextId = ports.nextId ?? randomUUID;
  return createSessionEngine({
    ledger: createSqliteSessionLedger(db),
    clock: { now },
    ids: { next: () => nextId() },
  });
}

export { createSqliteSessionLedger, SqliteSessionLedger } from "./sqlite-ledger";
export {
  latestTerminalAttachment,
  readTerminalAttachmentDetail,
  terminalNativeReference,
  terminalSessionRecord,
} from "./terminal-attachment";
export type { TerminalAttachmentDetail } from "./terminal-attachment";
