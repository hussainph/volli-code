/**
 * The one-per-launch orphan sweep cache (worktree-support §7). The startup
 * sweep is DESTRUCTIVE (it prunes stale git metadata and removes clean orphaned
 * worktree dirs), so it must run exactly ONCE per launch — never twice, and
 * never again on every renderer reload. index.ts kicks it off after the first
 * window loads; the `volli:worktree-orphans` handler reads the SAME cached
 * report instead of re-sweeping. A user-initiated rescan (Settings → Worktrees)
 * passes `rescan: true` to force a fresh sweep.
 */
import { sweepOrphans } from "./worktree";
import type { SweepReport, WorktreeDeps } from "./worktree";

/** The single in-flight/settled sweep promise for this launch; `null` until first triggered. */
let cached: Promise<SweepReport> | null = null;

/**
 * Kicks off the destructive sweep once, caching its promise. Idempotent: a
 * second call (e.g. the renderer's boot orphans() beating the deferred kickoff,
 * or vice versa) joins the existing promise rather than sweeping again.
 */
export function startOrphanSweep(deps: WorktreeDeps): Promise<SweepReport> {
  cached ??= sweepOrphans(deps);
  return cached;
}

/**
 * The cached sweep report. With `rescan`, forces a fresh destructive sweep
 * (the explicit Settings → Worktrees rescan). Otherwise returns the cached
 * report, kicking the sweep off on first demand if the deferred launch trigger
 * hasn't fired yet — so the renderer's boot call and index.ts's deferred
 * kickoff still yield exactly one sweep between them.
 */
export function orphanReport(
  deps: WorktreeDeps,
  opts: { rescan?: boolean } = {},
): Promise<SweepReport> {
  if (opts.rescan) cached = sweepOrphans(deps);
  return startOrphanSweep(deps);
}

/** Test seam: drops the cached sweep so each test starts from a clean launch. */
export function resetOrphanSweepForTest(): void {
  cached = null;
}
