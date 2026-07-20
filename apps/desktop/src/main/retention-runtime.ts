/**
 * The app-side construction of the retention merge-watch (CONCEPT #16, issue
 * #76). Like `worktree-runtime.ts`, this is where the pure, injected watch
 * ({@link RetentionWatcher}) is wired to its real Electron/main seams — the open
 * database, the stderr-capturing git runner, the async `gh`/git network runner,
 * the wall clock, a native `Notification` for the single "PR merged" alert, and
 * `broadcastDataChanged` so every window re-hydrates when the watch's observed
 * state moves. Held as ONE singleton so `data-ipc.ts` (the retention IPC
 * handlers) and `index.ts` (start/stop + on-focus trigger) drive the same
 * watch — the transient observation/notify-dedup/dismissal state is meaningless
 * if each entrypoint built its own.
 */
import { Notification } from "electron";
import type Database from "better-sqlite3";

import { broadcastDataChanged } from "./broadcast";
import { RetentionWatcher, retentionConfigFromEnv, runGitCapturing, runNet } from "./worktree";

let watcher: RetentionWatcher | null = null;

/**
 * The retention watch singleton, built lazily against `db`. The first caller
 * (index.ts on boot, or the first retention IPC) constructs it; everyone after
 * shares it. Timing is env-overridable through {@link retentionConfigFromEnv}.
 */
export function getRetentionWatcher(db: Database.Database): RetentionWatcher {
  watcher ??= new RetentionWatcher(
    {
      db,
      git: runGitCapturing,
      net: runNet,
      now: () => Date.now(),
      notify: (title, body) => new Notification({ title, body }).show(),
      onChange: broadcastDataChanged,
    },
    retentionConfigFromEnv(process.env),
  );
  return watcher;
}

/** Test seam: drops the singleton so each test starts from a clean watch. */
export function resetRetentionWatcherForTest(): void {
  watcher?.stop();
  watcher = null;
}
