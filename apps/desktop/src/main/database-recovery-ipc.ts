import type { DatabaseOpenFault } from "../ipc/contract";
import { DatabaseRecovery, NO_CLEAN_BACKUP, RecoveryFailure } from "@volli/host-core/maintenance";
import { DATABASE_RECOVERY_IPC } from "./ipc-descriptors";
import { registerGuardedIpcHandlers } from "./ipc-registry";
import { hostLogger } from "@volli/host-core/log";

const log = hostLogger("database-recovery");

export function registerDatabaseRecoveryIpcHandlers(options: {
  recovery: DatabaseRecovery;
  degraded: boolean;
  /**
   * Which recovery screen the renderer shows (VC-602): `newer-version` when
   * the database is from a newer Volli this build refused to open.
   */
  fault: DatabaseOpenFault;
  restart: () => void;
  /** Quits the app from the recovery screen. */
  quit: () => void;
}): void {
  const recovery = options.recovery;
  let restored = false;
  const degraded = (): void => {
    if (!options.degraded)
      throw new Error("Backup recovery is only available when the database failed to open.");
  };
  const available = (): void => {
    degraded();
    if (restored) throw new Error("The database has been restored. Volli is restarting.");
  };
  registerGuardedIpcHandlers(DATABASE_RECOVERY_IPC, {
    "volli:database-recovery-fault": () => {
      degraded();
      return { ok: true, fault: options.fault };
    },
    "volli:database-recovery-quit": () => {
      degraded();
      options.quit();
      return { ok: true };
    },
    "volli:database-recovery-list": () => {
      available();
      try {
        return { ok: true, backups: recovery.list() };
      } catch (error) {
        log.error("could not list safety copies", { error });
        return {
          ok: false,
          error:
            "Local safety copies could not be checked. Nothing was changed. Your files are preserved for manual recovery.",
        };
      }
    },
    "volli:database-recovery-restore": () => {
      available();
      let restoredBackup: string;
      try {
        restoredBackup = recovery.restore();
      } catch (error) {
        log.error("restore unavailable", { error });
        return {
          ok: false,
          error:
            error instanceof RecoveryFailure ||
            (error instanceof Error && error.message === NO_CLEAN_BACKUP)
              ? error.message
              : "Restore could not start. Nothing was restored. Your files are preserved for manual recovery.",
        };
      }
      restored = true;
      options.restart();
      return { ok: true, restoredBackup };
    },
  });
}
