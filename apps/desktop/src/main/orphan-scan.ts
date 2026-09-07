/**
 * The one-per-launch orphan SCAN cache (VC-284).
 *
 * This file used to cache a DESTRUCTIVE sweep, and the caching was the safety
 * mechanism: the sweep pruned git metadata and deleted clean orphan directories,
 * so it had to run exactly once per launch and never again on a renderer
 * reload. That is no longer what is being protected. `scanOrphans` only asks
 * git questions (see `worktree/scan.ts`), so a second scan is merely wasted
 * work, not a second deletion — and `{ refresh: true }` may re-run it freely
 * because the Storage pane's Scan changes nothing.
 *
 * The cache remains for the reason a cache normally exists: the walk spawns
 * several git children per project, and the renderer asks for the report on
 * every mount of the Storage pane. Cleanup invalidates it, because a report
 * that still lists a directory the user just removed is a lie.
 */
import { scanOrphans } from "./worktree";
import type { OrphanScanReport, WorktreeDeps } from "./worktree";

/** The single in-flight/settled scan promise for this launch; `null` until first triggered. */
let cached: Promise<OrphanScanReport> | null = null;

/**
 * Kicks off the read-only scan once, caching its promise. Idempotent: a second
 * call (e.g. the renderer's boot orphans() beating the deferred kickoff, or
 * vice versa) joins the existing promise rather than scanning again.
 */
export function startOrphanScan(deps: WorktreeDeps): Promise<OrphanScanReport> {
  cached ??= scanOrphans(deps);
  return cached;
}

/**
 * The cached scan. With `refresh`, runs a fresh one — still read-only, which is
 * the whole point of VC-284: the button that says Scan may be pressed as often
 * as a person likes without anything being removed.
 */
export function orphanScanReport(
  deps: WorktreeDeps,
  opts: { refresh?: boolean } = {},
): Promise<OrphanScanReport> {
  if (opts.refresh) cached = scanOrphans(deps);
  return startOrphanScan(deps);
}

/** Drops the cached scan, so the next read reflects a cleanup that just happened. */
export function invalidateOrphanScan(): void {
  cached = null;
}

/** Test seam: drops the cached scan so each test starts from a clean launch. */
export function resetOrphanScanForTest(): void {
  cached = null;
}
