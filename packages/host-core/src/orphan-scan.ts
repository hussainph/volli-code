/**
 * The orphan SCAN cache, and the only place a cleanup's plan may come from
 * (VC-284, review C1).
 *
 * This file used to cache a DESTRUCTIVE sweep, and the caching was the safety
 * mechanism: the sweep pruned git metadata and deleted clean orphan
 * directories, so it had to run exactly once per launch and never again on a
 * renderer reload. That is no longer what is being protected. `scanOrphans`
 * only asks git questions (see `worktree/scan.ts`), so a second scan is merely
 * wasted work — and the Storage pane's Scan may be pressed as often as a person
 * likes.
 *
 * What the cache protects now is INTENT. Every scan mints an opaque revision
 * and, with it, the exact proposal a person is shown. A cleanup command names
 * that revision and the ids inside it, and {@link resolveCleanupPlan} is the
 * one door from those ids to real paths — so no caller, present or future, can
 * ask this app to delete a directory that no completed scan proposed. A newer
 * scan supersedes the older revision, because a proposal a person reviewed
 * minutes ago describes a world that has since moved.
 */
import { scanOrphans } from "./worktree";
import type { OrphanScanOptions, OrphanScanReport, WorktreeDeps } from "./worktree";
import type { OrphanCleanupPlanItem, OrphanCleanupRejectionCode } from "@volli/shared";

/** The single in-flight/settled scan promise for this launch; `null` until first triggered. */
let cached: Promise<OrphanScanReport> | null = null;

/**
 * Kicks off the read-only scan once, caching its promise. Idempotent: a second
 * call (e.g. the renderer's boot orphans() beating the deferred kickoff, or
 * vice versa) joins the existing promise rather than scanning again.
 */
export function startOrphanScan(
  deps: WorktreeDeps,
  options: OrphanScanOptions = {},
): Promise<OrphanScanReport> {
  cached ??= scanOrphans(deps, options);
  return cached;
}

/**
 * The cached scan. With `refresh`, runs a fresh one — still read-only, which is
 * the whole point of VC-284 — and mints a new revision, superseding the old one.
 */
export function orphanScanReport(
  deps: WorktreeDeps,
  opts: { refresh?: boolean } & OrphanScanOptions = {},
): Promise<OrphanScanReport> {
  if (opts.refresh) cached = scanOrphans(deps, opts);
  return startOrphanScan(deps, opts);
}

/** A resolved plan, or the reason this request may not become one. */
export type CleanupPlanResolution =
  | {
      ok: true;
      items: OrphanCleanupPlanItem[];
      /** The retention window this proposal was measured against, and shown under. */
      retentionDays: number;
    }
  | { ok: false; code: OrphanCleanupRejectionCode; error: string };

/**
 * Turns "revision R, items X and Y" into the exact plan items main itself
 * minted, or refuses.
 *
 * Three refusals, and each is a different recovery: a revision this launch does
 * not hold (or no longer holds) is `scan-superseded` and is fixed by scanning
 * again; ids that revision never proposed are `unknown-items`; an empty
 * selection is refused as well, because a confirmed cleanup that changes
 * nothing should never open a durable run.
 */
export async function resolveCleanupPlan(request: {
  scanRevision: string;
  itemIds: readonly string[];
}): Promise<CleanupPlanResolution> {
  const report = cached === null ? null : await cached;
  if (report === null || report.revision !== request.scanRevision) {
    return {
      ok: false,
      code: "scan-superseded",
      error: "That scan has been superseded. Scan again, review what it finds, and confirm.",
    };
  }
  const byId = new Map(report.plan.map((item) => [item.id, item] as const));
  const items: OrphanCleanupPlanItem[] = [];
  const unknown: string[] = [];
  for (const id of new Set(request.itemIds)) {
    const item = byId.get(id);
    if (item === undefined) unknown.push(id);
    else items.push(item);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      code: "unknown-items",
      error: "That scan didn't propose everything this cleanup asked for. Scan again.",
    };
  }
  if (items.length === 0) {
    return { ok: false, code: "unknown-items", error: "That cleanup selected nothing to do." };
  }
  // Plan order, not request order: what runs is what was proposed and shown.
  return {
    ok: true,
    items: report.plan.filter((item) => items.includes(item)),
    retentionDays: report.retentionDays,
  };
}

/** Drops the cached scan, so the next read reflects a cleanup that just happened. */
export function invalidateOrphanScan(): void {
  cached = null;
}

/** Test seam: drops the cached scan so each test starts from a clean launch. */
export function resetOrphanScanForTest(): void {
  cached = null;
}
