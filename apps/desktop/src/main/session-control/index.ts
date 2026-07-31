import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { createControlPlane } from "@volli/control-plane";
import type { ControlPlane } from "@volli/control-plane";
import { createSqliteSessionLedger } from "./sqlite-ledger";

/** Main-process composition root: SQLite is the only Session writer today. */
export function createDesktopControlPlane(
  db: Database.Database,
  ports: { now?: () => number; nextId?: () => string } = {},
): ControlPlane {
  const now = ports.now ?? Date.now;
  const nextId = ports.nextId ?? randomUUID;
  return createControlPlane({
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
