/**
 * The app-side construction of the retention merge-watch (CONCEPT #16, issue
 * #76). Like `worktree-runtime.ts`, this is where the pure, injected watch
 * ({@link RetentionWatcher}) is wired to its real Electron/main seams — the open
 * database, the async `gh`/git network runner, the wall clock, the one
 * notification delivery path for its three alerts (VC-295), and
 * `broadcastDataChanged` so every window re-hydrates when the
 * watch's observed state moves. Held as ONE singleton so `data-ipc.ts` (the
 * retention IPC handlers) and `index.ts` (start/stop + on-focus trigger) drive the same
 * watch — the transient observation/notify-dedup/dismissal state is meaningless
 * if each entrypoint built its own.
 */
import type Database from "better-sqlite3";

import { broadcastDataChanged } from "./broadcast";
import { deliverNotification } from "./notifications/runtime";
import { RetentionWatcher, retentionConfigFromEnv, runNet, type ReclaimDeps } from "./worktree";
import { worktreeDeps } from "./worktree-runtime";

let watcher: RetentionWatcher | null = null;

/**
 * The seams the duration-gated reclaim (VC-113) needs beyond the worktree
 * bundle, handed in by `index.ts` because only it can answer them: whether work
 * is in flight in a directory, and how to end what is bound to one. They are
 * captured on FIRST construction — whichever entrypoint builds the singleton
 * first — so `index.ts` passes them, and `data-ipc.ts`'s later reads share the
 * same watch. Absent means the watch keeps its old read-only behaviour: prompts
 * still appear, nothing is ever deleted.
 */
export type RetentionReclaimSeams = Pick<ReclaimDeps, "releaseAgentSites" | "busyWorktreeSites">;

/**
 * The retention watch singleton, built lazily against `db`. The first caller
 * (index.ts on boot, or the first retention IPC) constructs it; everyone after
 * shares it. Timing is env-overridable through {@link retentionConfigFromEnv}.
 */
export function getRetentionWatcher(
  db: Database.Database,
  reclaimSeams?: RetentionReclaimSeams,
): RetentionWatcher {
  watcher ??= new RetentionWatcher(
    {
      db,
      net: runNet,
      now: () => Date.now(),
      // The one delivery door (VC-295), reached through the process runtime
      // because this watch is a lazy singleton with no constructor argument to
      // receive it in. The watch names a producer per alert — `finished` for a
      // merged PR, `swept` for a reclaim, operational for a failed write — and
      // the preference is read there, not here.
      notify: deliverNotification,
      onChange: broadcastDataChanged,
      // No seams, no reclaim: an app that cannot ask whether a directory is
      // busy has no business deleting one.
      reclaim:
        reclaimSeams === undefined
          ? undefined
          : { worktree: worktreeDeps(db), now: () => Date.now(), ...reclaimSeams },
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
