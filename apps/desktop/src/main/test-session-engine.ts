import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers";
import type Database from "better-sqlite3";
import { createSessionEngine, type SessionEngine } from "@volli/session-engine";
import {
  createCheckpointFailureReporter,
  createSqliteSessionLedger,
} from "@volli/host-core/session-control";

/** Test-only composition: fixtures explicitly own their SQLite-backed engine. */
export function createTestSessionEngine(
  db: Database.Database,
  options: {
    now?: () => number;
    nextId?: () => string;
    onProjectionCheckpointFailure?: (error: unknown) => void;
  } = {},
): SessionEngine {
  return createSessionEngine({
    ledger: createSqliteSessionLedger(db),
    clock: { now: options.now ?? Date.now },
    ids: { next: () => (options.nextId ?? randomUUID)() },
    onProjectionCheckpointFailure:
      options.onProjectionCheckpointFailure ?? createCheckpointFailureReporter(),
    yieldToHost: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
}
