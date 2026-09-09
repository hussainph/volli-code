/**
 * The manual trim across every worktree this database owns (VC-340), and the
 * read that shows what it would take.
 *
 * The retention hook trims one ticket at the moment it finishes, which fixes the
 * future. This is the surface for the present: 143 checkouts already on disk,
 * 131 of them carrying a full `node_modules`, and no route in the app that could
 * do anything about them. So Settings gets one action over the whole set, and a
 * read beside it — {@link scanTrimTargets} — that answers "which of these are
 * carrying artifacts, and which are off limits" without removing anything.
 *
 * `git worktree prune` rides along with the action rather than living apart from
 * it, because the two are the same complaint measured twice: `.git/worktrees`
 * held 171 admin entries for 143 directories. Pruning is the cheapest, safest
 * tier of the launch sweep (see `sweep.ts`), and doing it here means the count on
 * disk and the count in git metadata agree once the action finishes.
 *
 * Ownership is answered exactly as every other destructive worktree path answers
 * it (`containers.ts`): only a strict leaf inside a container THIS database
 * computes is ours to touch. A worktree somebody added by hand, or another
 * install's container under the same shared root, is not enumerated at all.
 *
 * "Non-active" is the trim primitive's own question, deliberately: a live agent,
 * an open terminal, or a changed tracked file refuses there, and this pass
 * reports the refusal per worktree instead of inventing a second, looser rule.
 */
import type { WorktreeTrimScanEntry, WorktreeTrimSweepReport } from "../../ipc/contract";

import { listProjects } from "../db/projects-repo";
import { listWorktreePathOwners } from "../db/tickets-repo";
import { isOwnedWorktreeLeaf, ownedContainers } from "./containers";
import { parseWorktreeList, runGitCapturingAsync } from "./git";
import { homeDir } from "./home";
import { canonicalize, isInside } from "./paths";
import {
  busyRefusal,
  countIgnoredArtifacts,
  trimIgnoredArtifacts,
  type BusyWorktreeSites,
} from "./trim";
import { getTrimSettings } from "./trim-settings";
import { type WorktreeDeps } from "./types";

/** What the sweep needs beyond the worktree bundle: the one busy question. */
export interface TrimSweepDeps {
  worktree: WorktreeDeps;
  /** Absent means nothing structured can be asked, so nothing structured blocks. */
  busySites?: BusyWorktreeSites;
}

/** One app-owned worktree the sweep can see, with the ticket that claims it. */
interface OwnedWorktree {
  path: string;
  projectId: string;
  projectPath: string;
  branch: string | null;
  locked: boolean;
  ticketId: string | null;
}

/**
 * Every worktree git registers inside a container this database owns. The main
 * checkout, bare entries, and anything outside our containers are skipped — the
 * same containment gate the launch sweep applies before it deletes anything.
 */
function ownedWorktrees(deps: TrimSweepDeps): OwnedWorktree[] {
  const db = deps.worktree.db;
  const containers = new Map(
    ownedContainers(db, homeDir(deps.worktree)).map((container) => [
      container.projectId,
      container,
    ]),
  );
  const ticketByPath = new Map(
    listWorktreePathOwners(db).map((owner) => [canonicalize(owner.worktreePath), owner.ticketId]),
  );

  const found: OwnedWorktree[] = [];
  for (const project of listProjects(db)) {
    const container = containers.get(project.id);
    if (container === undefined) continue;
    let listing: string;
    try {
      listing = deps.worktree.git(["worktree", "list", "--porcelain"], project.path);
    } catch {
      // A project whose git cannot be read contributes nothing; the rest still run.
      continue;
    }
    for (const entry of parseWorktreeList(listing)) {
      if (entry.bare) continue;
      if (!isOwnedWorktreeLeaf(container, entry.path)) continue;
      found.push({
        path: entry.path,
        projectId: project.id,
        projectPath: project.path,
        branch: entry.branch,
        locked: entry.locked,
        ticketId: ticketByPath.get(canonicalize(entry.path)) ?? null,
      });
    }
  }
  return found;
}

/** Why this worktree is off limits right now, or `null` when it may be trimmed. */
async function activeReason(deps: TrimSweepDeps, worktree: OwnedWorktree): Promise<string | null> {
  // `git worktree lock` is respected absolutely, exactly as dirty detection
  // respects it: a lock is a person saying "leave this alone".
  if (worktree.locked) return "This worktree is locked.";
  const sites = (await deps.busySites?.(worktree.path)) ?? [];
  const busy = sites.find((site) => isInside(worktree.path, site.directory));
  return busy === undefined ? null : busyRefusal(busy);
}

/**
 * The read behind the Settings table: every owned worktree, whether it is off
 * limits, and how many ignored paths a trim would take from it. Sizes are NOT
 * measured here — that needs a full walk per worktree, and `du -sh` across this
 * set is what stalled for thirty seconds in the audit that opened VC-340. The
 * count answers the only question the table asks ("is anything in here?"); the
 * action measures.
 */
export async function scanTrimTargets(
  deps: TrimSweepDeps,
): Promise<{ worktrees: WorktreeTrimScanEntry[] }> {
  const keepPatterns = getTrimSettings(deps.worktree.db).keepPatterns;
  const gitAsync = deps.worktree.gitAsync ?? runGitCapturingAsync;
  const worktrees: WorktreeTrimScanEntry[] = [];
  for (const worktree of ownedWorktrees(deps)) {
    const counted = await countIgnoredArtifacts(gitAsync, worktree.path, keepPatterns);
    worktrees.push({
      path: worktree.path,
      projectId: worktree.projectId,
      ticketId: worktree.ticketId,
      branch: worktree.branch,
      // An unreadable worktree reports nothing to trim rather than a guess; the
      // trim itself would refuse it anyway, and say why.
      artifactCount: counted.ok ? counted.value : 0,
      activeReason: await activeReason(deps, worktree),
    });
  }
  worktrees.sort((a, b) => b.artifactCount - a.artifactCount || a.path.localeCompare(b.path));
  return { worktrees };
}

/**
 * Trims every non-active owned worktree and prunes each project's stale worktree
 * metadata in the same pass.
 *
 * Prune runs FIRST and for every project: it is the tier that cannot lose data
 * (git only forgets admin entries whose directory is already gone), and running
 * it up front means the listing the trim then walks is the one git still stands
 * behind. A prune failure is recorded by omission from `pruned` and never stops
 * the trim.
 */
export async function trimAllWorktrees(
  deps: TrimSweepDeps,
  opts: { dryRun?: boolean } = {},
): Promise<WorktreeTrimSweepReport> {
  const dryRun = opts.dryRun === true;
  const keepPatterns = getTrimSettings(deps.worktree.db).keepPatterns;
  const gitAsync = deps.worktree.gitAsync ?? runGitCapturingAsync;
  const report: WorktreeTrimSweepReport = {
    worktrees: [],
    skipped: [],
    pruned: [],
    totalBytes: 0,
    removedCount: 0,
    dryRun,
  };

  for (const project of listProjects(deps.worktree.db)) {
    if (dryRun) continue; // a preview measures; it does not touch git metadata
    try {
      deps.worktree.git(["worktree", "prune"], project.path);
      report.pruned.push(project.id);
    } catch {
      // Unreadable git: the trim below simply finds nothing for this project.
    }
  }

  for (const worktree of ownedWorktrees(deps)) {
    const reason = await activeReason(deps, worktree);
    if (reason !== null) {
      report.skipped.push({ path: worktree.path, reason });
      continue;
    }
    const trimmed = await trimIgnoredArtifacts(gitAsync, {
      worktreePath: worktree.path,
      keepPatterns,
      dryRun,
      ...(deps.busySites === undefined ? {} : { busySites: deps.busySites }),
    });
    if (!trimmed.ok) {
      report.skipped.push({ path: worktree.path, reason: trimmed.error });
      continue;
    }
    if (trimmed.value.removed.length === 0 && trimmed.value.kept.length === 0) continue;
    report.worktrees.push(trimmed.value);
    report.totalBytes += trimmed.value.totalBytes;
    report.removedCount += trimmed.value.removed.length;
  }

  report.worktrees.sort((a, b) => b.totalBytes - a.totalBytes);
  return report;
}
