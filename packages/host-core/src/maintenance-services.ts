/**
 * Host maintenance (VC-618; owned as one module in VC-627): the spawn ledger,
 * the orphan process sweep, the retention merge-watch and the automatic reap.
 *
 * {@link createHostMaintenance} is built only over a database that opened, so
 * nothing on it is nullable. Its readers and reclaim seams are read at CALL
 * time, never at construction, so a host can hand over closures for things it
 * builds later (desktop's terminal manager and Session runtime). Construction
 * starts nothing: the host calls `start()` when it is ready (desktop after
 * first paint, a headless host at readiness) and the host lifecycle calls
 * `stop()` before the database closes. `stop()` is final, and synchronous: it
 * disarms timers but cannot interrupt a poll or reap already running, so the
 * lifecycle awaits `settled()` while it drains, before the close.
 *
 * {@link createDatabaseRecovery} stays separate: a degraded host, whose
 * database never opened, is exactly the host that needs it.
 */
import type Database from "better-sqlite3";
import type { HostCorePorts } from "./index";
import type { WorktreeRuntime } from "./worktree-runtime";
import type { RetentionWatcher } from "./worktree";
import { DatabaseRecovery } from "./database-recovery";
import { getRetentionWatcher, type RetentionReclaimSeams } from "./retention-runtime";
import { getAutoReapPolicy } from "./process/auto-reap-settings";
import {
  createAutoReapWatch,
  type AutoReapWatch,
  type AutoReapWatchOptions,
} from "./process/auto-reap-watch";
import { OrphanProcessService, type OrphanProcessDeps } from "./process/orphan-processes";
import { SpawnLedger } from "./process/spawn-ledger";
import { listWorktreeRefs, listWorktreeHoldersForSessions } from "./db/tickets-repo";

/** Backup restore and rollback, for a live host and a degraded one alike. */
export function createDatabaseRecovery(options: {
  dataDir: string;
  dbPath: string;
}): DatabaseRecovery {
  return new DatabaseRecovery({ dbPath: options.dbPath, userData: options.dataDir });
}

/** Folds the WAL, then closes. Preserve hostd's refusal to close after a failed checkpoint. */
export function checkpointAndCloseDatabase(db: Database.Database): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

/**
 * Who is live, read on every scan. Never defaulted: a sweep that believed no
 * Session was live would propose every recorded process as an orphan.
 */
export interface MaintenanceProcessReaders {
  /** Sessions holding a live executor. */
  liveSessionIds(): readonly string[];
  /** Working directories of open terminal tabs; `[]` on a host with none. */
  openTerminalCwds(): readonly string[];
}

export interface HostMaintenanceOptions {
  readonly db: Database.Database;
  readonly ports: Pick<HostCorePorts, "events" | "attention">;
  readonly worktrees: Pick<WorktreeRuntime, "deps">;
  readonly processReaders: MaintenanceProcessReaders;
  /**
   * Whether a worktree is busy, and how to release what is bound to one.
   * Absent, retention stays read-only: prompts appear, nothing is deleted.
   */
  readonly reclaim?: RetentionReclaimSeams;
  /** Timing and log overrides for the automatic reap; tests only. */
  readonly autoReap?: AutoReapWatchOptions;
}

export interface HostMaintenance {
  /** One ledger, shared by every spawn door. */
  readonly spawnLedger: SpawnLedger;
  readonly orphanProcesses: OrphanProcessService;
  /**
   * The retention watch, built on first read. It is the process singleton the
   * retention IPC shares, so its seams are captured by whichever reads first:
   * read it where the host built it before to keep that order.
   */
  readonly retention: RetentionWatcher;
  /** Starts the retention poll and the automatic reap. Idempotent; a no-op after stop. */
  start(): void;
  /** Polls retention now (desktop's focus trigger). A no-op after stop. */
  triggerRetention(): void;
  /** Stops both loops for good. Idempotent. */
  stop(): void;
  /**
   * Resolves once neither loop has a poll or reap in flight. Never rejects and
   * adds no delay. Call after {@link stop}, so nothing new can start; a
   * retention watch nobody built has nothing to wait for and stays unbuilt.
   */
  settled(): Promise<void>;
}

export function createHostMaintenance(options: HostMaintenanceOptions): HostMaintenance {
  const { db, ports, worktrees, processReaders } = options;
  const spawnLedger = new SpawnLedger(db);
  const orphanProcesses = createOrphanProcessService(db, ports, {
    ledger: spawnLedger,
    liveSessionIds: () => processReaders.liveSessionIds(),
    openTerminalCwds: () => processReaders.openTerminalCwds(),
  });
  const autoReap: AutoReapWatch = createAutoReapWatch(orphanProcesses, options.autoReap);
  let retention: RetentionWatcher | undefined;
  const retentionWatch = (): RetentionWatcher =>
    (retention ??= getRetentionWatcher(db, ports, () => worktrees.deps(db), options.reclaim));
  let started = false;
  let stopped = false;
  return {
    spawnLedger,
    orphanProcesses,
    get retention() {
      return retentionWatch();
    },
    start() {
      if (started || stopped) return;
      started = true;
      retentionWatch().start();
      autoReap.start();
    },
    triggerRetention() {
      if (!stopped) retentionWatch().triggerNow();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      // Never built means never started: stopping must not construct the singleton.
      retention?.stop();
      autoReap.stop();
    },
    async settled() {
      await Promise.all([retention?.settled(), autoReap.settled()]);
    },
  };
}

type ProcessReaders = Pick<OrphanProcessDeps, "ledger" | "liveSessionIds" | "openTerminalCwds">;

function createOrphanProcessService(
  db: Database.Database,
  ports: Pick<HostCorePorts, "attention">,
  readers: ProcessReaders,
): OrphanProcessService {
  return new OrphanProcessService({
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
  });
}
