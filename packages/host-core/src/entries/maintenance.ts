/**
 * `@volli/host-core/maintenance`: keeping a host healthy: backup, recovery, process reaping, retention, quiet windows, login PATH and shutdown.
 *
 * An explicit list: a name is public because a client imports it. Add one
 * here when a client needs it; host-core's own files import the module
 * itself, never this entry. See the cluster map in the package README.
 */
export { buildBackupDataDocument, validateBackupDataDocument } from "../backup/data-document";
export { DatabaseRecovery, NO_CLEAN_BACKUP, RecoveryFailure } from "../database-recovery";
export { createLoginPathBootstrap } from "../login-path-adoption";
export {
  ADOPTION_PROBE,
  loginShellPath,
  probeLoginShellPath,
  resetLoginShellPathCache,
} from "../login-shell-path";
export {
  createDatabaseRecovery,
  createHostMaintenance,
  type HostMaintenance,
} from "../maintenance-services";
export {
  invalidateOrphanScan,
  orphanScanReport,
  resetOrphanScanForTest,
  resolveCleanupPlan,
  startOrphanScan,
} from "../orphan-scan";
export { getAutoReapPolicy, setAutoReapPolicy } from "../process/auto-reap-settings";
export { OrphanProcessService } from "../process/orphan-processes";
export { SpawnLedger } from "../process/spawn-ledger";
export {
  applyQuietAppPolicy,
  quietWindowPolicy,
  revealWindow,
  sealQuietAppActivation,
} from "../quiet-windows";
export {
  getRetentionWatcher,
  resetRetentionWatcherForTest,
  type RetentionReclaimSeams,
} from "../retention-runtime";
export { settleShutdownBeforeDeadline } from "../shutdown-deadline";
