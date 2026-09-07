/**
 * The READ-ONLY orphan scan (VC-284, formerly the launch sweep).
 *
 * The finding this file answers: a button labelled "Rescan orphaned worktrees"
 * ran a destructive sweep — `git worktree prune` plus `git worktree remove` on
 * every clean orphan past the retention window — and the same act ran at
 * launch, unasked. Inspection and deletion were one function, so there was no
 * way to look. There is now: this module only ever ASKS git questions, and
 * `cleanup.ts` is the separate, confirmed act.
 *
 * Read-only is a property of the command list, so it is worth naming what runs
 * here: `worktree list --porcelain`,
 * `log -1 --format=%ct`, and the `isWorktreeDirty` probes (`status`,
 * `rev-parse --git-dir`, `log`, `submodule status`) — every one of them behind
 * {@link readOnlyGit}, because "reads only" is not the same as "asks a read-only
 * question": plain `git status` REFRESHES THE INDEX of the worktree it inspects
 * and rewrites `.git/worktrees/<name>/index` on its way out. The fixture test in
 * `scan.test.ts` fails without that switch, which is how it was found.
 *
 * The tiers below are VC-113's, unchanged in what they PROTECT — only in what
 * they do about it:
 *
 *  1. Metadata — stale `.git/worktrees` records, named from the listing's own
 *     `prunable` marker (never pruned).
 *  2. Young orphans — a registered worktree with no DB row that is clean but
 *     RECENT is kept, with the date it becomes eligible. Disposability is a
 *     question about time, not about tidiness.
 *  3. Stale clean orphans — the same thing once nothing has touched it for the
 *     retention window: named as REMOVABLE for a confirmed cleanup, which takes
 *     the directory and keeps the branch.
 *  4. Dirty orphans — never removable; reported with the reason.
 *
 * Two containment rules, and VC-113 is the second one:
 *  - OUTSIDE `~/.volli/worktrees` is someone's own `git worktree add` and is
 *    never touched or reported;
 *  - INSIDE it but outside the containers THIS database owns is ANOTHER
 *    INSTALL's checkout (see containers.ts) and is just as untouchable. Judging
 *    ownership by the shared root is what let a dev build delete the release
 *    build's worktrees on launch, silently, while their owning database went on
 *    pointing at the vanished path.
 *
 * A final disk-vs-git pass walks OUR OWN containers only, reporting dirs no
 * project's git registers at all (metadata lost): git can't vouch for them, so
 * they land in the dirty list. A dir a ticket still points at is reported too —
 * that state is unreachable through the app (VC-113: neither `git worktree
 * remove` nor `--force` will touch a path git has forgotten), so naming it in
 * Settings is the only way out that does not need a terminal.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  DirtyWorktreeOrphan,
  KeptWorktreeOrphan,
  PrunableWorktreeMetadata,
  RemovableWorktreeOrphan,
} from "../../ipc/contract";
import { listProjects } from "../db/projects-repo";
import { listWorktreePaths } from "../db/tickets-repo";
import { isOwnedWorktreeLeaf, ownedContainers } from "./containers";
import { isWorktreeDirty } from "./dirty";
import { parseWorktreeList, type WorktreeListEntry } from "./git";
import { homeDir } from "./home";
import { canonicalize } from "./paths";
import { getRetentionTtlDays, retentionTtlMs } from "./retention";
import { type RunGit, type WorktreeDeps } from "./types";

/**
 * Git that may not write. `--no-optional-locks` is git's own switch for exactly
 * this situation — it is what editors run in the background — and it is the
 * difference between a scan that leaves the repository untouched and one that
 * quietly rewrites an index it only meant to read.
 */
export function readOnlyGit(git: RunGit): RunGit {
  return (args, cwd) => git(["--no-optional-locks", ...args], cwd);
}

/** What a scan found. Every field is a statement about the world, never a change to it. */
export interface OrphanScanReport {
  /** Epoch ms the walk was judged against — one clock read for the whole scan. */
  scannedAt: number;
  /** The retention window in force, so Storage can say why a date is what it is. */
  retentionDays: number;
  prunable: PrunableWorktreeMetadata[];
  removable: RemovableWorktreeOrphan[];
  keptRecent: KeptWorktreeOrphan[];
  dirty: DirtyWorktreeOrphan[];
}

/** Why a clean orphan is kept — the two answers Storage renders as a deadline or as a shrug. */
export const KEPT_RECENT = "recently used";
export const KEPT_UNKNOWN_AGE = "last use unknown";

/**
 * How recently a clean orphan was touched, in epoch ms — the newest of its
 * directory mtime and its branch tip's commit date, so a checkout that is only
 * built in (mtime moves, no commits) and one that is only committed to (commits
 * move, mtime may not) both read as recent. `null` when neither can be read,
 * which every caller treats as "cannot vouch for it" and keeps.
 *
 * Exported because the cleanup's immediate re-check has to ask the identical
 * question: a second definition of "recent" is a second retention policy.
 */
export function lastTouchedAt(
  git: RunGit,
  entry: Pick<WorktreeListEntry, "path" | "branch">,
): number | null {
  let newest: number | null = null;
  try {
    newest = statSync(entry.path).mtimeMs;
  } catch {
    // Unreadable dir: fall through to the commit date, then to `null`.
  }
  try {
    const seconds = Number.parseInt(
      git(["log", "-1", "--format=%ct", entry.branch ?? "HEAD"], entry.path).trim(),
      10,
    );
    if (Number.isFinite(seconds)) newest = Math.max(newest ?? 0, seconds * 1000);
  } catch {
    // A branchless/unreadable worktree keeps whatever the mtime gave us.
  }
  return newest;
}

export async function scanOrphans(deps: WorktreeDeps): Promise<OrphanScanReport> {
  const git = readOnlyGit(deps.git);
  const now = deps.now?.() ?? Date.now();
  const report: OrphanScanReport = {
    scannedAt: now,
    retentionDays: getRetentionTtlDays(deps.db),
    prunable: [],
    removable: [],
    keptRecent: [],
    dirty: [],
  };

  const knownPaths = new Set(listWorktreePaths(deps.db).map((p) => canonicalize(p)));
  // The containers THIS database owns. Tiers 2-3 may name ONLY what is inside
  // them — a user's own `git worktree add ../review` is git-registered but not
  // ours, and neither is another Volli install's container under the same root.
  const containers = ownedContainers(deps.db, homeDir(deps));
  const containerById = new Map(containers.map((c) => [c.projectId, c] as const));
  /** Every path any project's git still registers — fills as the loop runs. */
  const registeredPaths = new Set<string>();
  const graceMs = retentionTtlMs(deps.db);

  for (const project of listProjects(deps.db)) {
    const projectCanonical = canonicalize(project.path);
    const container = containerById.get(project.id);

    let entries;
    try {
      entries = parseWorktreeList(git(["worktree", "list", "--porcelain"], project.path));
    } catch {
      // A project whose git can't be read is skipped, not fatal to the scan.
      continue;
    }

    // Tier 1: name the stale metadata a cleanup's `git worktree prune` would
    // drop. Read straight off the listing git already gave us, with git's own
    // reason attached, so the confirmation can be specific about records rather
    // than saying "and some metadata".
    const entriesToPrune = entries
      .filter((entry) => entry.prunable !== null)
      .map((entry) => ({ path: entry.path, reason: entry.prunable ?? "" }));
    if (entriesToPrune.length > 0) {
      report.prunable.push({
        projectId: project.id,
        projectPath: project.path,
        entries: entriesToPrune,
      });
    }

    for (const entry of entries) {
      const entryCanonical = canonicalize(entry.path);
      registeredPaths.add(entryCanonical);
      // Skip the main checkout itself, bare entries, and DB-known worktrees:
      // a ticket-linked checkout belongs to the retention flow, not to this one.
      if (entry.bare || entryCanonical === projectCanonical) continue;
      if (knownPaths.has(entryCanonical)) continue;
      // A record git itself calls stale is a METADATA question, already named
      // above; running the dirty probes against a directory git can't find
      // would only restate that as "unreadable".
      if (entry.prunable !== null) continue;

      // Containment gate (VC-113): only a leaf inside THIS project's own
      // container is ours to name — the same strict-leaf question remove.ts,
      // cleanup.ts and the orphan-delete channel ask (containers.ts), so a
      // worktree registered AT the container path itself can never be proposed.
      if (container === undefined || !isOwnedWorktreeLeaf(container, entry.path)) continue;

      // An orphan: an app-owned registered worktree with no DB row.
      const dirty = isWorktreeDirty(git, {
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

      // Tier 2: clean, but recently touched — proposing a checkout somebody was
      // working in an hour ago is the "nuke that fires asap" VC-113 is about.
      // An unreadable age keeps it too: we only offer what we can date.
      const touchedAt = lastTouchedAt(git, entry);
      if (touchedAt === null || now - touchedAt < graceMs) {
        report.keptRecent.push({
          path: entry.path,
          projectId: project.id,
          branch: entry.branch,
          lastTouchedAt: touchedAt,
          removableAt: touchedAt === null ? null : touchedAt + graceMs,
          reason: touchedAt === null ? KEPT_UNKNOWN_AGE : KEPT_RECENT,
        });
        continue;
      }

      // Tier 3: stale clean orphan — a candidate a confirmed cleanup may take.
      report.removable.push({
        path: entry.path,
        projectId: project.id,
        branch: entry.branch,
        lastTouchedAt: touchedAt,
        removableAt: touchedAt + graceMs,
      });
    }
  }

  // Disk-vs-git pass, over OUR OWN containers only: a dir git no longer
  // registers may still hold real work — git can't vouch for it, and any
  // ambiguity reads dirty. Report it for the Storage list; never propose it.
  for (const container of containers) {
    if (!existsSync(container.path)) continue;
    for (const leaf of readdirSync(container.path, { withFileTypes: true })) {
      if (!leaf.isDirectory()) continue;
      const leafPath = join(container.path, leaf.name);
      if (registeredPaths.has(canonicalize(leafPath))) continue;
      report.dirty.push({
        path: leafPath,
        projectId: container.projectId,
        // Two different things, and they want two different actions, so the
        // Storage row reads the difference aloud: a path a ticket still points
        // at is cleared from that ticket (its "Remove worktree…" now handles a
        // directory git has forgotten — VC-113), while an unclaimed leftover is
        // this list's own to delete.
        reason: knownPaths.has(canonicalize(leafPath))
          ? "A ticket still points here, but git no longer tracks it. Use Remove worktree on that ticket, then recreate it."
          : "Not registered with git, so it isn't safe to remove automatically.",
      });
    }
  }

  return report;
}
