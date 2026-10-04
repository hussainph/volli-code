/**
 * Staged maintenance construction (VC-618). A host starts the returned watches
 * when it is ready; no scheduler here needs a window or a connected client.
 * Desktop keeps its original after-first-paint start and focus triggers.
 */
import type Database from "better-sqlite3";
import type { HostCorePorts } from "./index";
import type { WorktreeRuntime } from "./worktree-runtime";
import { DatabaseRecovery } from "./database-recovery";
import { getRetentionWatcher, type RetentionReclaimSeams } from "./retention-runtime";
import { getAutoReapPolicy } from "./process/auto-reap-settings";
import { createAutoReapWatch } from "./process/auto-reap-watch";
import { OrphanProcessService, type OrphanProcessDeps } from "./process/orphan-processes";
import { SpawnLedger } from "./process/spawn-ledger";
import { listWorktreeRefs, listWorktreeHoldersForSessions } from "./db/tickets-repo";
import { shutdownNativeSessions } from "./host-shutdown";

type ProcessReaders = Pick<OrphanProcessDeps, "ledger" | "liveSessionIds" | "openTerminalCwds">;

export function createHostMaintenanceServices(
  db: Database.Database | null,
  ports: Pick<HostCorePorts, "events" | "attention" | "log">,
  options: { dataDir: string; dbPath: string },
  worktrees: WorktreeRuntime,
) {
  return {
    createDatabaseRecovery: () =>
      new DatabaseRecovery({ dbPath: options.dbPath, userData: options.dataDir }),
    createSpawnLedger: () => new SpawnLedger(db),
    createOrphanProcesses: (readers: ProcessReaders) =>
      db === null
        ? null
        : new OrphanProcessService({
            ...readers,
            worktrees: () => listWorktreeRefs(db),
            liveWorktrees: () => listWorktreeHoldersForSessions(db, readers.liveSessionIds()),
            policy: () => getAutoReapPolicy(db),
            notify: (title, message) =>
              ports.attention.deliver({
                producer: "orphan-processes-reaped",
                title,
                body: message,
                target: null,
              }),
          }),
    createAutoReapWatch,
    retention: (database: Database.Database, seams?: RetentionReclaimSeams) =>
      getRetentionWatcher(database, ports, () => worktrees.deps(database), seams),
    shutdownNativeSessions: (services: Omit<Parameters<typeof shutdownNativeSessions>[0], "log">) =>
      shutdownNativeSessions({ ...services, log: ports.log }),
  };
}

export type HostMaintenanceServices = ReturnType<typeof createHostMaintenanceServices>;
