/**
 * The host's one worktree read service (VC-788): the change watch, the
 * last-known snapshot and the coalescers, composed once per host so every door
 * — the desktop window's IPC, the agent socket's `worktree status` /
 * `worktree diff`, and hostd's socket — asks the same question at the same
 * cost:
 *
 * - **Coalescing** (`worktree/coalesce.ts`, VC-369): one read in flight per
 *   ticket, with a share window for the status and diff reads so two callers
 *   reacting to one event share one git set.
 * - **The last-known snapshot** (`worktree/snapshot.ts`, VC-372): the last good
 *   status and Change Set per ticket, served while an armed watch covers the
 *   worktree. An instance per service, so the cache belongs to the host that
 *   built it rather than to the process.
 * - **The change watch** (`worktree/change-set-watch.ts`): the shared recursive
 *   watcher whose coverage makes a snapshot trustworthy and whose relevant
 *   changes retire it. A host with no watching client (hostd today) never
 *   covers a worktree, so its snapshot stores answers and never serves them —
 *   the honest outcome for a host that cannot see the tree change.
 *
 * The read functions and their result kinds are the git verbs' own; each door
 * still maps them to its own error sentences, and the socket keeps its context
 * ladder. Every worktree-mutating act calls {@link WorktreeReadService.invalidate}
 * (or `invalidateAll` when it cannot name the ticket) so no door is served an
 * answer the act made stale.
 */
import type { WorktreeDiffMode } from "@volli/shared";

import type { HostClientEventSink } from "./ports";
import {
  readWorktreeBaseFile,
  readWorktreeChangeSet,
  readWorktreeDiff,
  readWorktreeStatus,
  resolveWorktreeTarget,
  WorktreeChangeWatchManager,
} from "./worktree";
import type {
  WorktreeBaseFileRead,
  WorktreeChangeSetRead,
  WorktreeDiffRead,
  WorktreeReadFailure,
  WorktreeReadPorts,
  WorktreeStatusRead,
} from "./worktree/read";
import type { WorktreeChangeWatchOptions } from "./worktree/change-set-watch";
import { createCoalescer, RAIL_READ_SHARE_WINDOW_MS } from "./worktree/coalesce";
import { createWorktreeSnapshotCache, type WorktreeSnapshotCache } from "./worktree/snapshot";

type Result = { ok: true } | { ok: false; error: string };

/** A watch request's answer: the ticket's resolution failure, or the watch's own result. */
type WorktreeWatchRead = WorktreeReadFailure | { kind: "ok"; result: Result };

/** What a worktree-mutating act needs from the service: the means to retire its answers. */
export interface WorktreeReadInvalidation {
  /** This ticket's last-known answers are stale: a mutating act ran on its checkout. */
  invalidate(ticketId: string): void;
  /** Every last-known answer is stale: an act ran on worktrees it cannot name. */
  invalidateAll(): void;
}

export interface WorktreeReadService extends WorktreeReadInvalidation {
  /** The ticket's branch, base and sync state — snapshot, then coalesced (share window). */
  readStatus(ticketId: string): Promise<WorktreeStatusRead>;
  /** The ticket's diff in one mode — coalesced per ticket and mode (share window). */
  readDiff(ticketId: string, mode: WorktreeDiffMode): Promise<WorktreeDiffRead>;
  /** The ticket's Change Set — snapshot, then coalesced (strict: no share window). */
  readChangeSet(ticketId: string): Promise<WorktreeChangeSetRead>;
  /** One file's base-side content for a diff tab. Uncached: each read names its own path. */
  readBaseFile(
    ticketId: string,
    path: string,
    baseRevision?: string,
  ): Promise<WorktreeBaseFileRead>;
  /** Subscribes one client to the ticket's worktree changes; its coverage arms the snapshot. */
  watch(client: HostClientEventSink, ticketId: string): Promise<WorktreeWatchRead>;
  /** Pauses one client's subscription (a backgrounded surface). */
  pause(client: HostClientEventSink, ticketId: string): Result;
  /** Resumes one client's subscription, with a catch-up refresh. */
  resume(client: HostClientEventSink, ticketId: string): Promise<Result>;
  /** Releases one client's subscription; the root lingers for the rewatch grace. */
  unwatch(client: HostClientEventSink, ticketId: string): void;
  /**
   * The ticket's checkout is going away (remove, archive-clean): every client's
   * watch on it ends now, and no answer about it survives.
   */
  releaseTicket(ticketId: string): void;
}

interface WorktreeReadServiceOptions {
  /**
   * The read deps, asked per read: the database, the non-blocking git runner
   * and the disk-existence seam. Production passes the host's worktree deps.
   */
  readonly deps: () => WorktreeReadPorts;
  /** An injected snapshot cache, so a suite can drive coverage directly. */
  readonly snapshots?: WorktreeSnapshotCache;
  /** The change watch's seams, minus the two observers this service owns. */
  readonly watch?: Omit<WorktreeChangeWatchOptions, "onCoverageChange" | "onRelevantChange">;
  /** The coalescers' clock, so a suite drives the share window rather than sleeping. */
  readonly now?: () => number;
}

export function createWorktreeReadService(
  options: WorktreeReadServiceOptions,
): WorktreeReadService {
  const { deps } = options;
  const snapshots = options.snapshots ?? createWorktreeSnapshotCache();
  const changes = new WorktreeChangeWatchManager({
    ...options.watch,
    // Coverage says whether a stored answer can be trusted at all, and a
    // relevant change (reported before the debounced broadcast, the earliest
    // this host knows) says it is already stale (VC-372).
    onCoverageChange: (ticketId, covered) => {
      if (covered) snapshots.noteCovered(ticketId);
      else snapshots.noteUncovered(ticketId);
    },
    onRelevantChange: (ticketIds) => {
      for (const ticketId of ticketIds) snapshots.invalidate(ticketId);
    },
  });
  const clock = options.now === undefined ? {} : { now: options.now };
  // The Change Set keeps the strict always-fresh rule: a caller arriving
  // mid-flight is reacting to a change the running read may predate.
  const coalesceChangeSet = createCoalescer(clock);
  // Status and diff share a burst: two surfaces (or two CLI calls) asking in the
  // same instant get one git set. The window sits far below the watch debounce,
  // so a read reacting to a real filesystem change still gets its own run (VC-369).
  const coalesceStatus = createCoalescer({ ...clock, shareWindowMs: RAIL_READ_SHARE_WINDOW_MS });
  const coalesceDiff = createCoalescer({ ...clock, shareWindowMs: RAIL_READ_SHARE_WINDOW_MS });

  return {
    readStatus: (ticketId) =>
      snapshots.readStatus(ticketId, () =>
        coalesceStatus(ticketId, () => readWorktreeStatus(deps(), ticketId)),
      ),

    // Keyed by mode as well as ticket: "what would the PR contain" and "what is
    // uncommitted now" are different questions, so one answer must never serve both.
    readDiff: (ticketId, mode) =>
      coalesceDiff(`${ticketId}:${mode}`, () => readWorktreeDiff(deps(), ticketId, mode)),

    readChangeSet: (ticketId) =>
      snapshots.readChangeSet(ticketId, () =>
        coalesceChangeSet(ticketId, () => readWorktreeChangeSet(deps(), ticketId)),
      ),

    readBaseFile: (ticketId, path, baseRevision) =>
      readWorktreeBaseFile(deps(), ticketId, path, baseRevision),

    async watch(client, ticketId) {
      // Only the path is wanted, so this resolves the target rather than
      // reading the status: the full read is five git children whose answers a
      // watch would discard (VC-369).
      const resolved = resolveWorktreeTarget(deps(), ticketId);
      if (resolved.kind !== "ok") return resolved;
      return {
        kind: "ok",
        result: await changes.watch(client, ticketId, resolved.target.worktreePath),
      };
    },

    pause: (client, ticketId) => changes.pause(client, ticketId),
    resume: (client, ticketId) => changes.resume(client, ticketId),
    unwatch: (client, ticketId) => changes.unwatch(client, ticketId),

    releaseTicket(ticketId) {
      changes.unwatchTicket(ticketId);
      // Ending coverage already drops the answer; this also drops one stored
      // while nothing covered the worktree.
      snapshots.invalidate(ticketId);
    },

    invalidate: (ticketId) => snapshots.invalidate(ticketId),
    invalidateAll: () => snapshots.invalidateAll(),
  };
}
