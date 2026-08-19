/**
 * Startup orphan sweep (worktree-support §7). Disk (what git has registered)
 * vs DB, on canonicalized paths (including macOS `/private` aliasing). Four
 * tiers, in ascending destructiveness:
 *
 *  1. Metadata — `git worktree prune` per project. Always safe.
 *  2. Young orphans — a registered worktree with no DB row that is clean but
 *     RECENT is left alone and reported as `keptRecent`: disposability is a
 *     question about time, not about tidiness (VC-113).
 *  3. Stale clean orphans — the same thing, once nothing has touched it for the
 *     retention window: the directory is removed but the BRANCH IS RETAINED (a
 *     clean worktree dir is cache, not data — #16's no-destruction law holds).
 *  4. Dirty orphans — never auto-removed; reported for the user to resolve.
 *
 * Two containment rules, and VC-113 is the second one:
 *  - OUTSIDE `~/.volli/worktrees` is someone's own `git worktree add` and is
 *    never touched;
 *  - INSIDE it but outside the containers THIS database owns is ANOTHER
 *    INSTALL's checkout (see containers.ts) and is just as untouchable. Judging
 *    ownership by the shared root is what let a dev build delete the release
 *    build's worktrees on launch, silently, while their owning database went on
 *    pointing at the vanished path.
 *
 * A final disk-vs-git pass walks OUR OWN containers only, reporting dirs no
 * project's git registers at all (metadata lost): git can't vouch for them, so
 * they land in the dirty list untouched. A dir a ticket still points at is
 * reported too — that state is unreachable through the app (VC-113: neither
 * `git worktree remove` nor `--force` will touch a path git has forgotten), so
 * naming it in Settings is the only way out that does not need a terminal.
 *
 * Removal re-verifies cleanliness immediately before deleting (via the same
 * `isWorktreeDirty` predicate). Startup-only caller wires in later; the periodic
 * TTL sweep (issue #76) reuses these tiers.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { listProjects } from "../db/projects-repo";
import { listWorktreePaths } from "../db/tickets-repo";
import { ownedContainers } from "./containers";
import { isWorktreeDirty } from "./dirty";
import { parseWorktreeList, type WorktreeListEntry } from "./git";
import { homeDir } from "./home";
import { canonicalize, isInside } from "./paths";
import { retentionTtlMs } from "./retention";
import { type SweepReport, type WorktreeDeps } from "./types";

/**
 * How recently a clean orphan was touched, in epoch ms — the newest of its
 * directory mtime and its branch tip's commit date, so a checkout that is only
 * built in (mtime moves, no commits) and one that is only committed to (commits
 * move, mtime may not) both read as recent. `null` when neither can be read,
 * which the caller treats as "cannot vouch for it" and keeps.
 */
function lastTouchedAt(deps: WorktreeDeps, entry: WorktreeListEntry): number | null {
  let newest: number | null = null;
  try {
    newest = statSync(entry.path).mtimeMs;
  } catch {
    // Unreadable dir: fall through to the commit date, then to `null`.
  }
  try {
    const seconds = Number.parseInt(
      deps.git(["log", "-1", "--format=%ct", entry.branch ?? "HEAD"], entry.path).trim(),
      10,
    );
    if (Number.isFinite(seconds)) newest = Math.max(newest ?? 0, seconds * 1000);
  } catch {
    // A branchless/unreadable worktree keeps whatever the mtime gave us.
  }
  return newest;
}

export async function sweepOrphans(deps: WorktreeDeps): Promise<SweepReport> {
  const report: SweepReport = { pruned: [], removedClean: [], keptRecent: [], dirty: [] };

  const knownPaths = new Set(listWorktreePaths(deps.db).map((p) => canonicalize(p)));
  // The containers THIS database owns. Tiers 2-3 may act ONLY inside them — a
  // user's own `git worktree add ../review` is git-registered but not ours, and
  // neither is another Volli install's container under the same shared root.
  const containers = ownedContainers(deps.db, homeDir(deps));
  const containerById = new Map(containers.map((c) => [c.projectId, c] as const));
  /** Every path any project's git still registers — fills as the loop runs. */
  const registeredPaths = new Set<string>();
  // One clock read for the whole sweep, so every orphan is judged against the
  // same "now" no matter how long the walk takes.
  const now = deps.now?.() ?? Date.now();
  const graceMs = retentionTtlMs(deps.db);

  for (const project of listProjects(deps.db)) {
    const projectCanonical = canonicalize(project.path);
    const container = containerById.get(project.id);

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

      // Containment gate (§7 + VC-113): only a leaf inside THIS project's own
      // container is ours to clean. Everything else — a personal worktree
      // elsewhere on disk, another project's container, another INSTALL's
      // container under the same root — is never removed and never reported.
      if (container === undefined || !isInside(container.path, entry.path)) continue;

      // An orphan: an app-owned registered worktree with no DB row.
      const dirty = isWorktreeDirty(deps.git, {
        worktreePath: entry.path,
        branch: entry.branch,
        baseBranch: null,
        worktreeEntries: entries,
      });
      if (dirty.dirty) {
        report.dirty.push({
          path: entry.path,
          projectId: project.id,
          reason: dirty.reason ?? "dirty",
        });
        continue;
      }

      // Tier 2: clean, but recently touched — deleting a checkout somebody was
      // working in an hour ago is the "nuke that fires asap" VC-113 is about.
      // An unreadable age keeps it too: we only delete what we can date.
      const touchedAt = lastTouchedAt(deps, entry);
      if (touchedAt === null || now - touchedAt < graceMs) {
        report.keptRecent.push({
          path: entry.path,
          projectId: project.id,
          branch: entry.branch,
          lastTouchedAt: touchedAt,
          removableAt: touchedAt === null ? null : touchedAt + graceMs,
        });
        continue;
      }

      // Tier 3: stale clean orphan — remove the dir, keep the branch.
      try {
        deps.git(["worktree", "remove", entry.path], project.path);
        report.removedClean.push({
          path: entry.path,
          projectId: project.id,
          branch: entry.branch,
          lastTouchedAt: touchedAt,
        });
      } catch (caught) {
        report.dirty.push({
          path: entry.path,
          projectId: project.id,
          reason: caught instanceof Error ? caught.message : "removal failed",
        });
      }
    }
  }

  // Disk-vs-git pass, over OUR OWN containers only: a dir git no longer
  // registers is invisible to the loop above (prune already forgot it), yet it
  // may hold real work — git can't vouch for it, and any ambiguity reads dirty
  // (§7). Report it for the Settings list; never touch it.
  for (const container of containers) {
    if (!existsSync(container.path)) continue;
    for (const leaf of readdirSync(container.path, { withFileTypes: true })) {
      if (!leaf.isDirectory()) continue;
      const leafPath = join(container.path, leaf.name);
      if (registeredPaths.has(canonicalize(leafPath))) continue;
      report.dirty.push({
        path: leafPath,
        projectId: container.projectId,
        // A path a ticket still points at is the VC-113 dead end: git has
        // forgotten it, so `git worktree remove` refuses in both modes and no
        // in-app route can clear it. Say which one this is, because the two
        // want different actions (recreate the ticket's worktree vs delete a
        // leftover), and the Settings row reads the reason aloud.
        reason: knownPaths.has(canonicalize(leafPath))
          ? "A ticket still points here, but git no longer tracks it. Delete the folder to let the ticket recreate its worktree."
          : "Not registered with git, so it isn't safe to remove automatically.",
      });
    }
  }

  return report;
}
