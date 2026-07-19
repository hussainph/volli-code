/**
 * Startup orphan sweep (worktree-support §7). Disk (what git has registered)
 * vs DB, on canonicalized paths (including macOS `/private` aliasing). Three
 * tiers, in ascending destructiveness:
 *
 *  1. Metadata — `git worktree prune` per project. Always safe.
 *  2. Clean orphans — a registered worktree with no DB row that passes dirty
 *     detection: the directory is removed but the BRANCH IS RETAINED (a clean
 *     worktree dir is cache, not data — #16's no-destruction law holds).
 *  3. Dirty orphans — never auto-removed; reported for the user to resolve.
 *
 * A final disk-vs-git pass reports dirs under `~/.volli/worktrees` that no
 * project's git registers at all (metadata lost): git can't vouch for them, so
 * they land in the dirty list untouched.
 *
 * Removal re-verifies cleanliness immediately before deleting (via the same
 * `isWorktreeDirty` predicate). Startup-only caller wires in later; the periodic
 * TTL sweep (issue #76) reuses these tiers.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { listProjects } from "../db/projects-repo";
import { listWorktreePaths } from "../db/tickets-repo";
import { isWorktreeDirty } from "./dirty";
import { parseWorktreeList } from "./git";
import { homeDir } from "./home";
import { canonicalize } from "./paths";
import { type SweepReport, type WorktreeDeps } from "./types";

export async function sweepOrphans(deps: WorktreeDeps): Promise<SweepReport> {
  const report: SweepReport = { pruned: [], removedClean: [], dirty: [] };

  const knownPaths = new Set(listWorktreePaths(deps.db).map((p) => canonicalize(p)));
  /** Every path any project's git still registers — fills as the loop runs. */
  const registeredPaths = new Set<string>();

  for (const project of listProjects(deps.db)) {
    const projectCanonical = canonicalize(project.path);

    // Tier 1: prune stale metadata — always safe.
    try {
      deps.git(["worktree", "prune"], project.path);
      report.pruned.push(project.id);
    } catch {
      // A project whose git can't be read is skipped, not fatal to the sweep.
      continue;
    }

    let entries;
    try {
      entries = parseWorktreeList(deps.git(["worktree", "list", "--porcelain"], project.path));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryCanonical = canonicalize(entry.path);
      registeredPaths.add(entryCanonical);
      // Skip the main checkout itself, bare entries, and DB-known worktrees.
      if (entry.bare || entryCanonical === projectCanonical) continue;
      if (knownPaths.has(entryCanonical)) continue;

      // An orphan: a registered worktree with no DB row.
      const dirty = isWorktreeDirty(deps.git, {
        worktreePath: entry.path,
        branch: entry.branch,
        baseBranch: null,
      });
      if (dirty.dirty) {
        report.dirty.push({
          path: entry.path,
          projectId: project.id,
          reason: dirty.reason ?? "dirty",
        });
        continue;
      }

      // Tier 2: clean orphan — remove the dir, keep the branch.
      try {
        deps.git(["worktree", "remove", entry.path], project.path);
        report.removedClean.push(entry.path);
      } catch (caught) {
        report.dirty.push({
          path: entry.path,
          projectId: project.id,
          reason: caught instanceof Error ? caught.message : "removal failed",
        });
      }
    }
  }

  // Disk-vs-git pass: a dir under the app's worktree home that NO project's
  // git registers anymore is invisible to the loop above (prune already forgot
  // it), yet it may hold real work — git can't vouch for it, and any ambiguity
  // reads dirty (§7). Report it for the Settings list; never touch it.
  const worktreesHome = join(homeDir(deps), ".volli", "worktrees");
  if (existsSync(worktreesHome)) {
    for (const container of readdirSync(worktreesHome, { withFileTypes: true })) {
      if (!container.isDirectory()) continue;
      const containerPath = join(worktreesHome, container.name);
      for (const leaf of readdirSync(containerPath, { withFileTypes: true })) {
        if (!leaf.isDirectory()) continue;
        const leafPath = join(containerPath, leaf.name);
        const leafCanonical = canonicalize(leafPath);
        if (registeredPaths.has(leafCanonical) || knownPaths.has(leafCanonical)) continue;
        report.dirty.push({
          path: leafPath,
          reason: "not registered with git — cannot verify it is safe to remove",
        });
      }
    }
  }

  return report;
}
