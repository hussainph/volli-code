import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers";
import type Database from "better-sqlite3";
import { createSessionEngine } from "@volli/session-engine";
import type { SessionEngine } from "@volli/session-engine";
import { createCheckpointFailureReporter } from "./checkpoint-diagnostics";
import { createSqliteSessionLedger } from "./sqlite-ledger";

/** Main-process composition root: SQLite is the only Session writer today. */
export function createDesktopSessionEngine(
  db: Database.Database,
  ports: {
    now?: () => number;
    nextId?: () => string;
    /**
     * The host's reporter for recovered checkpoint failures. Passed in when the
     * runtime is composed too, so one launch reports through a single throttle
     * instead of one per composition (VC-355).
     */
    onProjectionCheckpointFailure?: (error: unknown) => void;
  } = {},
): SessionEngine {
  const now = ports.now ?? Date.now;
  const nextId = ports.nextId ?? randomUUID;
  return createSessionEngine({
    ledger: createSqliteSessionLedger(db),
    clock: { now },
    ids: { next: () => nextId() },
    onProjectionCheckpointFailure:
      ports.onProjectionCheckpointFailure ?? createCheckpointFailureReporter(),
    yieldToHost: yieldToMainProcess,
  });
}

/**
 * The main process's turn of its event loop, for a roster fold that spans
 * many Sessions (VC-388).
 *
 * `setImmediate` lands in the check phase with no floor; the engine's own
 * default is `setTimeout(0)`, which Node clamps to a millisecond, and that
 * clamp is paid once per chunk. The engine owns no Node API, so the faster
 * spelling is this host's to supply.
 */
function yieldToMainProcess(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export { createCheckpointFailureReporter } from "./checkpoint-diagnostics";
export type { CheckpointFailureReporterPorts } from "./checkpoint-diagnostics";
export { createSqliteSessionLedger, SqliteSessionLedger } from "./sqlite-ledger";
export {
  latestTerminalAttachment,
  readTerminalAttachmentDetail,
  terminalNativeReference,
  terminalSessionRecord,
} from "./terminal-attachment";
export type { TerminalAttachmentDetail } from "./terminal-attachment";
export { chatSessionRecord, latestStructuredAttachment } from "./chat-attachment";
export { sessionListingRow, sessionListingRows } from "./listing-row";
export { sessionListingRowsForRoster } from "./listing-roster";
export { watchSessionActivity } from "./activity-watch";
export type { SessionActivityWatch, SessionActivityWatchPorts } from "./activity-watch";
export { createSessionWatchdog } from "./session-watchdog";
export type { SessionWatchdog, SessionWatchdogPorts } from "./session-watchdog";
