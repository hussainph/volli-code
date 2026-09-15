/**
 * The rail's last-known worktree snapshot (VC-372), beside the VC-369
 * coalescers.
 *
 * Coalescing shares a read that is STILL RUNNING; it keeps no last result, so
 * any second read more than the share window away spawns the whole git set
 * again. The rail's page switch is exactly that second read: Now↔Diffs unmounts
 * `TicketRepositorySummary` and mounts `TicketChangesPanel` (and back), and each
 * mount asks for the same `status` + `changeSet` pair — five children plus five
 * commands, per flip — and opening a diff tab asks for the Change Set a third
 * time. Twice the work for one unchanged answer.
 *
 * So this module keeps the last GOOD answer per ticket (`{ status, changeSet,
 * revision }`) and serves it to any read that arrives while nothing has
 * invalidated it since it was taken. Three things invalidate:
 *
 * - the shared change watcher reports a relevant filesystem change (see
 *   `change-set-watch.ts`'s `onRelevantChange`);
 * - a worktree-mutating verb runs in this process (commit, push-pr, sync,
 *   remove/recreate, retention archive-clean, trim, orphan cleanup, an
 *   ensure that materializes a checkout);
 * - the watch's coverage of that worktree ends (see below).
 *
 * ## Coverage is the trust condition
 *
 * A cached answer is only trustworthy while an armed watcher covers the
 * worktree: that is what observes the changes that would invalidate it. With no
 * watcher, a ticket nobody is watching would be served an answer that may have
 * gone stale invisibly, so serving requires {@link WorktreeSnapshotCache.noteCovered}.
 * The cache still STORES answers taken while uncovered (a panel's mount read
 * precedes its own watch by an instant, and the flipped-to panel must find it),
 * but such an answer is never served until a watcher has covered the worktree
 * and nothing has invalidated it since.
 *
 * The shared-root manager keeps a released root armed for a short grace
 * (`WATCH_REWATCH_GRACE_MS`), so the panel swap's unwatch→watch handoff does not
 * tear coverage down between the two mounts; a real teardown — a closed rail, a
 * removed checkout, a window gone — ends coverage and drops the answer.
 *
 * ## The TTL: the acts nothing here can see
 *
 * An armed watcher sees file writes, and every worktree verb invalidates, but a
 * `git commit` or `git fetch` typed in a terminal reaches NEITHER: a linked
 * worktree's `.git` is a file, so the commit's bookkeeping lands in the main
 * repo and the watched tree never changes. Serving a snapshot forever would
 * leave a rail showing work that a terminal already committed, so an answer is
 * served for at most {@link RAIL_SNAPSHOT_TTL_MS}; past it the next read pays
 * for a fresh one. It is a ceiling on staleness, not a refresh cadence — the
 * events and verbs above are what keep a live rail current.
 *
 * ## The revision
 *
 * Invalidation bumps a per-ticket counter rather than only deleting the entry:
 * a read already in flight when the invalidation lands captured the OLD
 * revision, so its result must never be stored as current. Delete-plus-revision
 * is what makes that race safe. `invalidateAll` moves a global counter for the
 * untargeted acts (a trim sweep, an orphan cleanup) whose affected tickets
 * cannot be named.
 */
import type { WorktreeChangeSetRead, WorktreeStatusRead } from "./read";

/** One stored answer, stamped with the revision it was computed under. */
interface SnapshotEntry<T> {
  readonly revision: number;
  readonly value: T;
  readonly takenAt: number;
}

/**
 * How long an answer may be served at all (see the module doc). Ten seconds
 * covers a visit's page flips and tab opens — the reads this exists to share —
 * while keeping a terminal commit's invisible staleness bounded to one stale
 * remount rather than an afternoon.
 */
export const RAIL_SNAPSHOT_TTL_MS = 10_000;

/** Injectable clock and TTL, so the suite drives freshness rather than sleeping. */
export interface WorktreeSnapshotCacheOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/** The last-known status/Change Set pair, served while a watch covers the worktree. */
export interface WorktreeSnapshotCache {
  /** An armed watcher now covers this ticket's worktree. */
  noteCovered(ticketId: string): void;
  /** No armed watcher covers this ticket's worktree any more: its answer is gone. */
  noteUncovered(ticketId: string): void;
  /** This ticket's answer is no longer trusted (a watcher change, or a mutating verb). */
  invalidate(ticketId: string): void;
  /** Every answer is no longer trusted — an untargeted worktree act ran. */
  invalidateAll(): void;
  /** The ticket's last good status read, or a fresh one from `load`. */
  readStatus(
    ticketId: string,
    load: () => Promise<WorktreeStatusRead>,
  ): Promise<WorktreeStatusRead>;
  /** The ticket's last good Change Set read, or a fresh one from `load`. */
  readChangeSet(
    ticketId: string,
    load: () => Promise<WorktreeChangeSetRead>,
  ): Promise<WorktreeChangeSetRead>;
}

export function createWorktreeSnapshotCache(
  options: WorktreeSnapshotCacheOptions = {},
): WorktreeSnapshotCache {
  const ttlMs = options.ttlMs ?? RAIL_SNAPSHOT_TTL_MS;
  const now = options.now ?? Date.now;
  /** Tickets whose worktree an armed watcher covers right now. */
  const covered = new Set<string>();
  /** Per-ticket invalidation counter: never reset, so an old stamp can never match again. */
  const revisions = new Map<string, number>();
  /** Untargeted invalidations (`invalidateAll`), added into every ticket's revision. */
  let globalRevision = 0;
  const status = new Map<string, SnapshotEntry<WorktreeStatusRead>>();
  const changeSet = new Map<string, SnapshotEntry<WorktreeChangeSetRead>>();

  const revisionOf = (ticketId: string): number => globalRevision + (revisions.get(ticketId) ?? 0);

  const invalidate = (ticketId: string): void => {
    revisions.set(ticketId, (revisions.get(ticketId) ?? 0) + 1);
    status.delete(ticketId);
    changeSet.delete(ticketId);
  };

  return {
    noteCovered(ticketId: string): void {
      covered.add(ticketId);
    },

    noteUncovered(ticketId: string): void {
      covered.delete(ticketId);
      // No watcher, no observation: the stored answer must not survive into a
      // later coverage, which could not have seen what happened in the gap.
      invalidate(ticketId);
    },

    invalidate,

    invalidateAll(): void {
      globalRevision += 1;
      status.clear();
      changeSet.clear();
    },

    async readStatus(
      ticketId: string,
      load: () => Promise<WorktreeStatusRead>,
    ): Promise<WorktreeStatusRead> {
      // The revision is captured BEFORE the load: an invalidation that lands
      // while this read is in flight must leave it unusable on arrival.
      const revision = revisionOf(ticketId);
      const at = now();
      const entry = status.get(ticketId);
      if (
        entry !== undefined &&
        entry.revision === revision &&
        at - entry.takenAt < ttlMs &&
        covered.has(ticketId)
      ) {
        return entry.value;
      }
      const value = await load();
      // Only a real answer is worth keeping; a failure arm may be transient
      // (a checkout being recreated) and would pin the rail to an error.
      if (value.kind === "ok") status.set(ticketId, { revision, value, takenAt: at });
      return value;
    },

    async readChangeSet(
      ticketId: string,
      load: () => Promise<WorktreeChangeSetRead>,
    ): Promise<WorktreeChangeSetRead> {
      const revision = revisionOf(ticketId);
      const at = now();
      const entry = changeSet.get(ticketId);
      if (
        entry !== undefined &&
        entry.revision === revision &&
        at - entry.takenAt < ttlMs &&
        covered.has(ticketId)
      ) {
        return entry.value;
      }
      const value = await load();
      if (value.kind === "ok") changeSet.set(ticketId, { revision, value, takenAt: at });
      return value;
    },
  };
}

let snapshots = createWorktreeSnapshotCache();

/**
 * The main process's one snapshot store. Main serves every window and the CLI's
 * `worktree status` from the same last-known answer, so a read by one is a
 * saving for the others; a per-registration instance would silently stop that
 * sharing (and the CLI's `worktree sync` invalidation has no other way to reach
 * the IPC handlers' store).
 */
export function getWorktreeSnapshots(): WorktreeSnapshotCache {
  return snapshots;
}

/** Test seam: start from a clean process, as a fresh launch does. */
export function resetWorktreeSnapshotsForTest(): void {
  snapshots = createWorktreeSnapshotCache();
}
