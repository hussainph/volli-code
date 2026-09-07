/**
 * The confirmed orphan CLEANUP (VC-284) — the only destructive half of the
 * Storage pane, and the half a person has to ask for.
 *
 * It takes an explicit list of directories and projects, every one of them read
 * off a completed scan and shown in a confirmation before this runs. It then
 * distrusts that list completely: a scan is a snapshot, and the seconds between
 * the report and the click are enough for a checkout to be edited, opened in a
 * terminal, or handed to an agent. So every target is re-asked, immediately
 * before it is changed, with the same predicates the scan used and the same
 * activity guard the manual Delete uses (`activity.ts`). Anything that answers
 * differently is SKIPPED with its reason, never forced.
 *
 * What it may do, in order: prune one project's stale git metadata, and remove
 * a worktree directory with `git worktree remove` — no `--force`, ever, so
 * git's own refusals stand — which keeps the branch and every commit on it. A
 * clean worktree directory is cache; a branch is data.
 *
 * What it may never do: touch a main checkout, a bare entry, a ticket-linked
 * worktree, a personal worktree outside the app root, another install's
 * container, a container itself, a dirty/unreadable/locked checkout, one used
 * inside the retention window, one whose age can't be read, or one something is
 * running in.
 *
 * The run is written to the durable log BEFORE the first change and updated
 * after every item (`cleanup-log.ts`), because a cleanup that stops halfway has
 * to leave behind which directories are already gone.
 */
import { randomUUID } from "node:crypto";

import type { OrphanCleanupItem, OrphanCleanupRun, OrphanCleanupSource } from "../../ipc/contract";
import { listProjects } from "../db/projects-repo";
import { listWorktreePaths } from "../db/tickets-repo";
import { busyRefusal, busySiteWithin, type BusyWorktreeSites } from "./activity";
import type { AgentSiteReleaseReport } from "./agent-sites";
import { isOwnedWorktreeLeaf, ownedContainers, type OwnedContainer } from "./containers";
import { saveCleanupRun } from "./cleanup-log";
import { isWorktreeDirty } from "./dirty";
import { parseWorktreeList } from "./git";
import { homeDir } from "./home";
import { canonicalize, isInside } from "./paths";
import { lastTouchedAt, readOnlyGit } from "./scan";
import { getRetentionTtlDays, retentionTtlMs } from "./retention";
import type { WorktreeDeps } from "./types";

/** What a cleanup was asked to do. Both lists come from a scan the user just saw. */
export interface OrphanCleanupRequest {
  /** Worktree directories to remove. */
  paths: readonly string[];
  /** Projects whose stale `.git/worktrees` records to prune. */
  projectIds: readonly string[];
  source: OrphanCleanupSource;
}

/** The seams the cleanup needs beyond the worktree bundle. */
export interface OrphanCleanupDeps {
  worktree: WorktreeDeps;
  /** The activity supplier the manual Delete path uses; absent means "assume none". */
  busyWorktreeSites?: BusyWorktreeSites;
  /** Ends the structured bindings rooted in a checkout that is about to stop existing. */
  releaseAgentSites?: (directory: string) => Promise<AgentSiteReleaseReport>;
  /** Test seam for the run id. */
  newRunId?: () => string;
}

/**
 * The rules this run promises to hold to, recorded WITH the run. A preservation
 * policy that lives only in today's code cannot be checked against a removal
 * that happened three versions ago.
 */
export function preservationRules(retentionDays: number): string[] {
  return [
    "Branches, commits, and pull-request links are kept — only the folder is removed.",
    "Main checkouts, bare entries, and worktrees outside this install's folders are never touched.",
    "Ticket-linked worktrees stay under the separate Done-retention flow.",
    "A worktree with changes, untracked files, unpushed commits, a lock, an in-progress git operation, submodule drift, or unreadable git state is kept.",
    `A worktree used within the last ${retentionDays} day(s), or whose last use can't be read, is kept.`,
    "A worktree with a live terminal or agent in it is kept.",
  ];
}

/** Why one target was spared. Every string here is shown to the person who asked for the cleanup. */
const SKIP_OUTSIDE = "That path is outside the worktree folders this install owns.";
const SKIP_TICKET_LINKED =
  "This worktree is still linked to a ticket and can't be cleaned up here.";
const SKIP_UNREGISTERED = "Git no longer tracks this path, so it can't be removed here.";
const SKIP_UNKNOWN_AGE = "Volli can't tell when this was last used.";
const SKIP_UNKNOWN_PROJECT = "That project is no longer tracked.";

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** A skip verdict, or `null` when the path may be removed — carrying what git said about it. */
interface Recheck {
  skip: string | null;
  branch: string | null;
  /** The registered path as git spells it, which is what `worktree remove` must be given. */
  gitPath: string;
  projectPath: string | null;
}

/**
 * Everything asked again, in the cheapest-first order, immediately before the
 * removal. Ownership and the ticket link come from local state; dirtiness, age,
 * and busyness are re-measured from the world.
 */
async function recheck(
  deps: OrphanCleanupDeps,
  path: string,
  context: {
    containers: readonly OwnedContainer[];
    projectPaths: ReadonlyMap<string, string>;
    now: number;
    graceMs: number;
  },
): Promise<Recheck> {
  const { worktree } = deps;
  // Every question below goes through the scan's read-only runner: a check that
  // ends in a SKIP must leave the checkout exactly as it found it.
  const git = readOnlyGit(worktree.git);
  const target = canonicalize(path);
  const idle: Recheck = { skip: null, branch: null, gitPath: path, projectPath: null };

  // (a) Ours at all? The strict-leaf question — a container itself answers no.
  const container = context.containers.find((entry) => isOwnedWorktreeLeaf(entry, path));
  if (container === undefined) return { ...idle, skip: SKIP_OUTSIDE };
  const projectPath = context.projectPaths.get(container.projectId);
  if (projectPath === undefined) return { ...idle, skip: SKIP_UNKNOWN_PROJECT };

  // (b) Never a directory the DB still tracks — live OR archived, since a
  // retained checkout is still a ticket's, and clearing it is that ticket's
  // "Remove worktree…", not this list's.
  const known = listWorktreePaths(worktree.db);
  if (known.some((entry) => isInside(target, entry) || isInside(entry, target))) {
    return { ...idle, projectPath, skip: SKIP_TICKET_LINKED };
  }

  // (c) Registered right now — re-read per item, never cached across the run:
  // an earlier removal changes this listing, and so does anything the user did
  // while the confirmation was open.
  let entries;
  try {
    entries = parseWorktreeList(git(["worktree", "list", "--porcelain"], projectPath));
  } catch (caught) {
    return { ...idle, projectPath, skip: errorText(caught) };
  }
  const entry = entries.find((candidate) => canonicalize(candidate.path) === target);
  if (entry === undefined || entry.bare) {
    return { ...idle, projectPath, skip: SKIP_UNREGISTERED };
  }
  const found: Recheck = { skip: null, branch: entry.branch, gitPath: entry.path, projectPath };

  // (d) Anything that might be unsaved work — the same predicate, run again.
  const dirty = isWorktreeDirty(git, {
    worktreePath: entry.path,
    branch: entry.branch,
    baseBranch: null,
    worktreeEntries: entries,
  });
  if (dirty.dirty) return { ...found, skip: dirty.reason ?? "dirty" };

  // (e) Still stale? A checkout touched since the scan is no longer eligible.
  const touchedAt = lastTouchedAt(git, entry);
  if (touchedAt === null) return { ...found, skip: SKIP_UNKNOWN_AGE };
  if (context.now - touchedAt < context.graceMs) {
    return { ...found, skip: "Used recently, so it isn't eligible for cleanup yet." };
  }

  // (f) And is anything standing in it? The manual Delete's guard, unchanged.
  const busy = busySiteWithin(entry.path, (await deps.busyWorktreeSites?.(entry.path)) ?? []);
  if (busy !== null) return { ...found, skip: busyRefusal(busy) };

  return found;
}

/**
 * Runs one cleanup and answers with its durable record.
 *
 * Item failures are contained: a project whose prune fails, or a directory git
 * refuses to remove, is recorded as `failed` and the run carries on to the next
 * item. An unexpected throw from a seam is NOT contained — it propagates with
 * the record left exactly as far as the run got, which is the state the next
 * launch reconciles as interrupted.
 */
export async function cleanupOrphans(
  deps: OrphanCleanupDeps,
  request: OrphanCleanupRequest,
): Promise<OrphanCleanupRun> {
  const { worktree } = deps;
  const now = worktree.now?.() ?? Date.now();
  const containers = ownedContainers(worktree.db, homeDir(worktree));
  const projectPaths = new Map(listProjects(worktree.db).map((p) => [p.id, p.path] as const));
  const graceMs = retentionTtlMs(worktree.db);

  // Metadata first: pruning stale records cannot affect a live checkout, and
  // doing it up front means a run that stops early has already taken the one
  // step with nothing to lose.
  const metadataItems: OrphanCleanupItem[] = [...new Set(request.projectIds)].map((projectId) => ({
    kind: "metadata",
    path: projectPaths.get(projectId) ?? projectId,
    projectId,
    branch: null,
    status: "pending",
    detail: null,
    finishedAt: null,
  }));
  const seen = new Set<string>();
  const worktreeItems: OrphanCleanupItem[] = [];
  for (const path of request.paths) {
    const key = canonicalize(path);
    if (seen.has(key)) continue;
    seen.add(key);
    worktreeItems.push({
      kind: "worktree",
      path,
      projectId:
        containers.find((container) => isOwnedWorktreeLeaf(container, path))?.projectId ?? null,
      branch: null,
      status: "pending",
      detail: null,
      finishedAt: null,
    });
  }

  const run: OrphanCleanupRun = {
    id: (deps.newRunId ?? randomUUID)(),
    source: request.source,
    startedAt: now,
    finishedAt: null,
    interruptedAt: null,
    preservation: preservationRules(getRetentionTtlDays(worktree.db)),
    items: [...metadataItems, ...worktreeItems],
  };
  // BEFORE the first change: everything below can only ever narrow this record.
  saveCleanupRun(worktree.db, run, now);

  /** Stamps one item's outcome and persists the run — one write per item, by design. */
  const settle = (item: OrphanCleanupItem, patch: Partial<OrphanCleanupItem>): void => {
    Object.assign(item, patch, { finishedAt: worktree.now?.() ?? now });
    saveCleanupRun(worktree.db, run, item.finishedAt ?? now);
  };

  for (const item of metadataItems) {
    const projectPath = item.projectId === null ? undefined : projectPaths.get(item.projectId);
    if (projectPath === undefined) {
      settle(item, { status: "skipped", detail: SKIP_UNKNOWN_PROJECT });
      continue;
    }
    try {
      worktree.git(["worktree", "prune"], projectPath);
      settle(item, { status: "completed", detail: "Pruned stale worktree metadata." });
    } catch (caught) {
      settle(item, { status: "failed", detail: errorText(caught) });
    }
  }

  for (const item of worktreeItems) {
    const verdict = await recheck(deps, item.path, { containers, projectPaths, now, graceMs });
    item.branch = verdict.branch;
    if (verdict.skip !== null) {
      settle(item, { status: "skipped", detail: verdict.skip });
      continue;
    }
    try {
      // The bindings rooted in the checkout end first, exactly as the manual
      // delete does it: nothing may be left dispatching into a deleted path.
      await deps.releaseAgentSites?.(verdict.gitPath);
      worktree.git(["worktree", "remove", verdict.gitPath], verdict.projectPath ?? verdict.gitPath);
      settle(item, {
        status: "completed",
        detail:
          verdict.branch === null
            ? "Removed the folder. No branch was checked out here."
            : `Removed the folder. Branch ${verdict.branch} is still in git.`,
      });
    } catch (caught) {
      settle(item, { status: "failed", detail: errorText(caught) });
    }
  }

  run.finishedAt = worktree.now?.() ?? Date.now();
  saveCleanupRun(worktree.db, run, run.finishedAt);
  return run;
}
