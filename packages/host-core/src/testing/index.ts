/**
 * `@volli/host-core/testing`: test support for host-core's clients: database and Session fixtures, scripted git, the backup fixture profile, a standalone Session engine and ledger, child-process helpers. Production code never imports it (`package-interface.test.ts`, and desktop's and hostd's own guards).
 *
 * An explicit list: a name is public because a client, or a client's test,
 * imports it as this cluster's API. Add one here when a client needs it;
 * host-core's own files import the module itself, never this entry. See
 * the cluster map in the package README.
 */
export {
  createFixtureProfile,
  FIXTURE_NATIVE_RECEIPT_EVENT_ID,
  FIXTURE_NATIVE_USAGE_EVENT_ID,
  type FixtureProfile,
} from "../backup/test-fixture";
export { beginDatabaseRecovery, recoveryPendingPath } from "../db/recovery-pending";
export {
  openRawDb,
  openTestDb,
  type TestDb,
  testProject,
  testSession,
  testTicket,
} from "../db/test-helpers";
export {
  sealTestHandlers,
  testHostHandlers,
  type TestHandlerEntries,
  type TestHandlerPorts,
} from "./host-handlers";
export { captureHostLog, type CapturedHostLog } from "./log";
export { resetOrphanScanForTest } from "../orphan-scan";
export { resetRetentionWatcherForTest } from "../retention-runtime";
export { SecretStore as N1SecretStore } from "../secrets/test-support/n1/secrets/store";
export { startChild } from "../secrets/test-support/processes";
export { createCheckpointFailureReporter } from "../session-control";
export { createSqliteSessionLedger, SqliteSessionLedger } from "../session-control/sqlite-ledger";
export {
  getSession,
  insertSession,
  listSessions,
  listTicketSessions,
} from "../session-control/test-support";
export { createTestSessionEngine } from "./session-engine";
export { resetDeletionLeasesForTest } from "../worktree/deletion-lease";
export { resetWorktreeSnapshotsForTest } from "../worktree/snapshot";
