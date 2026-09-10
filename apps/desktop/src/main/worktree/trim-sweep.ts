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
 * What this action deliberately does NOT do is prune git metadata, and the reason
 * is worth stating because the ticket asked for it. VC-340 was written when the
 * launch sweep still pruned on its own; VC-284 then made pruning a CONFIRMED act
 * over a reviewed set, because `git worktree prune` takes no path argument — it
 * drops every stale record in the repository, including ones that went stale
 * after the report a person read, and ones a ticket still claims. `cleanup.ts`
 * earns the right to run it with a synchronous final gate that re-lists the
 * prunable set and refuses unless it is EXACTLY the confirmed set. A blind prune
 * inside a different action would give that back, so the 171-vs-143 metadata
 * complaint stays where it now belongs: Settings → Storage → Orphaned worktrees,
 * which reports prunable records and prunes them on confirmation.
 *
 * The worktree set here is also not the orphan scan's. That one reports
 * checkouts with no ticket; this one covers every worktree this database owns,
 * claimed or not — a Done ticket's own checkout is the most common carrier of a
 * dead dependency tree, and it is never an orphan.
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
import { listWorktreeRefs } from "../db/tickets-repo";
import { isOwnedWorktreeLeaf, ownedContainers } from "./containers";
import { parseWorktreeList, runGitCapturingAsync } from "./git";
import { homeDir } from "./home";
import { canonicalize } from "./paths";
import { busyRefusal, busySiteWithin, type BusyWorktreeSites } from "./activity";
import { countIgnoredArtifacts, trimIgnoredArtifacts } from "./trim";
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
  // VC-341's own path→Ticket read, rather than a second query saying the same
  // thing: it lands after this branch was written and answers exactly the
  // question here (git reports directories; the table names tickets).
  const ticketByPath = new Map(
    listWorktreeRefs(db).map((ref) => [canonicalize(ref.path), ref.ticketId]),
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
  const busy = busySiteWithin(worktree.path, (await deps.busySites?.(worktree.path)) ?? []);
  return busy === null ? null : busyRefusal(busy);
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
 * Trims every non-active owned worktree, reporting each one it took, each one it
 * refused, and why. A worktree that had nothing to trim is not reported at all:
 * a list of a hundred "nothing here" rows is how the two that mattered get lost.
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
    totalBytes: 0,
    removedCount: 0,
    dryRun,
  };

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
