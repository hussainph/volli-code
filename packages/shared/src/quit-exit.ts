/**
 * What a quit may do about the worker threads still running when the app
 * exits (VC-1208, VC-1207).
 *
 * After `app.exit()`, Electron tears down Node, and Node joins every worker
 * thread first. A worker inside one long SQLite call cannot be stopped:
 * better-sqlite3 has no interrupt, and a terminated worker only stops once
 * the native call returns. Until then the process stays alive with no window
 * and holds the single-instance lock, and Squirrel's installer waits for it.
 * On a 2 GB profile that wait lasted hours.
 *
 * The process may end at once, without that join, only when every worker
 * still running is positively known not to write the live database at that
 * moment. A schema upgrade is never cut short: the quit waits for it with
 * its window up. Any worker no creation site declared is unknown, and an
 * unknown worker is waited for, as before.
 *
 * Pure: the host reads its live workers and their phases, and this decides.
 */

/** What one creation site declares its worker to be. */
export type DeclaredWorkerKind =
  /**
   * A launch's routine database check: read-only until it reports that it is
   * about to write (its phase), refusing to write once a quit has claimed it.
   */
  | "database-check"
  /** A launch's schema upgrade: never cut short. */
  | "database-upgrade"
  /**
   * The automatic (daily) backup: it reads the live database through a
   * read-only connection and writes only its own work directory and archive.
   */
  | "automatic-backup"
  /** A long-lived reader holding only a read-only connection (usage reports). */
  | "database-reader"
  /** Writes nothing anywhere (HTML extraction, icon decoding). */
  | "stateless";

/** What a live worker is to a quit, right now. */
export type WorkerExitClass = "read-only" | "writing" | "upgrade" | "unknown";

/** What the quit does. */
export type QuitExitDecision =
  /** Exit as before: Node joins every worker. Nothing live, or something not known to be read-only. */
  | "exit"
  /** Every live worker is read-only: end the process without waiting for them. */
  | "exit-now"
  /** An upgrade is running: keep the process and its window until it returns. */
  | "finish-upgrade-first";

/**
 * The tag a creation site puts on its worker. A registered symbol, so a
 * package that cannot import the host's watcher can still declare its worker.
 */
const WORKER_EXIT_KIND: unique symbol = Symbol.for("volli.worker-exit-kind");

/** Declares what `worker` is; call right after constructing it. */
export function declareWorkerExitKind(worker: object, kind: DeclaredWorkerKind): void {
  Object.defineProperty(worker, WORKER_EXIT_KIND, { value: kind, configurable: true });
}

/** The kind a creation site declared, or `undefined`. */
export function declaredWorkerExitKind(worker: object): DeclaredWorkerKind | undefined {
  const value: unknown = (worker as { [WORKER_EXIT_KIND]?: unknown })[WORKER_EXIT_KIND];
  return value === "database-check" ||
    value === "database-upgrade" ||
    value === "automatic-backup" ||
    value === "database-reader" ||
    value === "stateless"
    ? value
    : undefined;
}

/**
 * One worker's class. A check is read-only only while the quit holds its
 * claim (`claimed`): unclaimed, it may already be writing.
 */
export function classifyWorker(
  kind: DeclaredWorkerKind | undefined,
  claimed = false,
): WorkerExitClass {
  switch (kind) {
    case "database-check":
      return claimed ? "read-only" : "writing";
    case "database-upgrade":
      return "upgrade";
    case "automatic-backup":
    case "database-reader":
    case "stateless":
      return "read-only";
    default:
      return "unknown";
  }
}

/** The rule: an upgrade waits with its window; all read-only exits now; anything else exits as before. */
export function decideQuitExit(live: readonly WorkerExitClass[]): QuitExitDecision {
  if (live.includes("upgrade")) return "finish-upgrade-first";
  if (live.length > 0 && live.every((entry) => entry === "read-only")) return "exit-now";
  return "exit";
}

/** Why the app is quitting, as the log records it. */
export type QuitReasonCode =
  /** Restart to update: the installer runs once the process exits. */
  | "update-install"
  /** The last window closed where that quits (not macOS). */
  | "last-window-closed"
  /** A restart the app asked for (restore, another product store). */
  | "relaunch"
  /** The system is logging out, restarting or shutting down (menu-bar mode). */
  | "system-shutdown"
  /**
   * Any other quit: ⌘Q, the menu, the Dock, the Tray, or SIGTERM/SIGINT.
   * Electron 44 quits on a signal through the same path and never runs a
   * Node signal listener, so a signal cannot be told apart from these.
   */
  | "quit";

/** The reason, from what main knows when a quit is accepted, most specific first. */
export function quitReason(state: {
  readonly updateInstall: boolean;
  readonly relaunch: boolean;
  readonly systemShutdown: boolean;
  readonly lastWindowClosed: boolean;
}): QuitReasonCode {
  if (state.updateInstall) return "update-install";
  if (state.relaunch) return "relaunch";
  if (state.systemShutdown) return "system-shutdown";
  if (state.lastWindowClosed) return "last-window-closed";
  return "quit";
}
