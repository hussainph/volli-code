/**
 * The host-side construction of the retention merge-watch (CONCEPT #16, issue
 * #76). Like `worktree-runtime.ts`, this is where the pure, injected watch
 * ({@link RetentionWatcher}) is wired to its host ports — the open
 * database, the async `gh`/git network runner, the wall clock, the one
 * notification delivery path for its three alerts (VC-295), and
 * the event bus so every client re-hydrates when the
 * watch's observed state moves. Held as ONE singleton so `data-ipc.ts` (the
 * retention IPC handlers) and `index.ts` (start/stop + on-focus trigger) drive the same
 * watch — the transient observation/notify-dedup/dismissal state is meaningless
 * if each entrypoint built its own.
 */
import type Database from "better-sqlite3";

import type { AttentionDeliveryPort, HostEventBus } from "./ports";
import {
  RetentionWatcher,
  retentionConfigFromEnv,
  runNet,
  type ReclaimDeps,
  type TrimFinishDeps,
  type WorktreeDeps,
} from "./worktree";

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
 * The trim-on-finish pass (VC-340) shares the reclaim's busy question and needs
 * nothing else: it removes only what git ignores, so there is no binding to
 * release and no identity to clear. Reusing the ONE busy seam is the point — an
 * automatic trim must refuse everything an automatic removal would.
 */
function trimSeams(
  worktree: () => WorktreeDeps,
  reclaimSeams: RetentionReclaimSeams,
): TrimFinishDeps | undefined {
  const busy = reclaimSeams.busyWorktreeSites;
  if (busy === undefined) return undefined;
  return { worktree: worktree(), now: () => Date.now(), busySites: busy };
}

/**
 * The retention watch singleton, built lazily against `db`. The first caller
 * (index.ts on boot, or the first retention IPC) constructs it; everyone after
 * shares it. Timing is env-overridable through {@link retentionConfigFromEnv}.
 */
export function getRetentionWatcher(
  db: Database.Database,
  ports: { events: HostEventBus; attention: Pick<AttentionDeliveryPort, "deliver"> },
  worktree: () => WorktreeDeps,
  reclaimSeams?: RetentionReclaimSeams,
): RetentionWatcher {
  watcher ??= new RetentionWatcher(
    {
      db,
      net: runNet,
      now: () => Date.now(),
      // The one delivery door (VC-295), through the host's attention port.
      // The watch names a producer per alert — `finished` for a merged PR,
      // `swept` for a reclaim, operational for a failed write — and the
      // preference is read there, not here.
      notify: (request) => ports.attention.deliver(request),
      onChange: () => ports.events.publish("data-changed", {}),
      // No seams, no reclaim: an app that cannot ask whether a directory is
      // busy has no business deleting one.
      reclaim:
        reclaimSeams === undefined
          ? undefined
          : { worktree: worktree(), now: () => Date.now(), ...reclaimSeams },
      // Same rule as the reclaim, one step smaller: an app that cannot ask
      // whether a directory is busy has no business deleting anything in one.
      trim: reclaimSeams === undefined ? undefined : trimSeams(worktree, reclaimSeams),
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
