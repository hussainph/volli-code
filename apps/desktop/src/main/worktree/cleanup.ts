/**
 * The confirmed orphan CLEANUP (VC-284) — the only destructive half of the
 * Storage pane, and the half a person has to ask for.
 *
 * It is the EXECUTOR, not the record: `cleanup-engine.ts` owns the command, its
 * acceptance receipt and the immutable facts, and this file is what actually
 * runs git between them. The split is the review's S1 — a destructive product
 * act takes the command → event → projection shape, with the transport (and
 * this executor) as adapters around a core that knows nothing about either.
 *
 * What it acts on is never a list of paths from a client. A caller names a scan
 * revision and the ids of items in THAT scan's plan; main resolves them to the
 * proposal it minted itself (`orphan-scan.ts`), and anything else is refused
 * (review C1). So the confirmation, the accepted intent, and the work are the
 * same three lists by construction.
 *
 * Then it distrusts even that. A scan is a snapshot, and the seconds between
 * the report and the click are enough for a checkout to be edited, opened in a
 * terminal, or handed to an agent. Every target is re-asked immediately before
 * it is changed, with the same predicates the scan used, the same activity
 * guard the manual Delete uses (`activity.ts`), and — for the awaits that
 * cannot be avoided — a deletion lease that stops new work from starting in a
 * directory that is about to go (`deletion-lease.ts`, review C4). Ownership,
 * the ticket link, the retention window and the clock are all re-read PER ITEM,
 * never snapshotted for the run: another IPC call can change any of them while
 * this one is running.
 *
 * What it may do, in order: prune one project's stale git metadata, and remove
 * a worktree directory with `git worktree remove` — no `--force`, ever, so
 * git's own refusals stand — which keeps the branch and every commit on it. A
 * clean worktree directory is cache; a branch is data.
 *
 * `git worktree prune` cannot be aimed at one record, so metadata is handled as
 * a set (review C2): immediately before pruning, the project's current prunable
 * records are listed again, and the prune runs only if that set is EXACTLY the
 * set of confirmed records. A record that appeared since, or one that is not
 * ours to touch, means the prune would do more than was confirmed — so it is
 * skipped, per record, with that reason.
 */
import type {
  OrphanCleanupItemOutcome,
  OrphanCleanupPlanItem,
  OrphanCleanupReceipt,
  OrphanCleanupRejectionCode,
  OrphanCleanupRun,
  OrphanCleanupSource,
} from "@volli/shared";
import { CLEANUP_PRESERVATION_RULES } from "@volli/shared";

import { listProjects } from "../db/projects-repo";
import { listWorktreePaths } from "../db/tickets-repo";
import { busyRefusal, busySiteWithin, type BusyWorktreeSites } from "./activity";
import type { AgentSiteReleaseReport } from "./agent-sites";
import type { OrphanCleanupEngine } from "./cleanup-engine";
import { isOwnedWorktreeLeaf, ownedContainers } from "./containers";
import { acquireDeletionLease } from "./deletion-lease";
import { isWorktreeDirty } from "./dirty";
import { parseWorktreeList, type WorktreeListEntry } from "./git";
import { homeDir } from "./home";
import { canonicalize, isInside } from "./paths";
import { lastTouchedAt, readOnlyGit } from "./scan";
import { getRetentionTtlDays, retentionTtlMs } from "./retention";
import type { WorktreeDeps } from "./types";

/** What a cleanup was asked to do: a command id, a scan revision, and its items. */
export interface OrphanCleanupRequest {
  /** The caller's UUID. The same one twice replays instead of removing twice. */
  commandId: string;
  /** The revision of the scan whose proposal was confirmed. */
  scanRevision: string;
  /** The plan items selected out of that revision, already resolved by main. */
  items: readonly OrphanCleanupPlanItem[];
  source: OrphanCleanupSource;
}

/** The seams the cleanup needs beyond the worktree bundle. */
export interface OrphanCleanupDeps {
  worktree: WorktreeDeps;
  /** The durable command core; the executor never writes storage itself. */
  engine: OrphanCleanupEngine;
  /** The activity supplier the manual Delete path uses; absent means "assume none". */
  busyWorktreeSites?: BusyWorktreeSites;
  /** Ends the structured bindings rooted in a checkout that is about to stop existing. */
  releaseAgentSites?: (directory: string) => Promise<AgentSiteReleaseReport>;
}

/** The rules this run promises to hold to, recorded WITH the run, as ids. */
export function preservationRuleIds(): readonly string[] {
  return CLEANUP_PRESERVATION_RULES;
}

/** Why one target was spared. Every string here is shown to the person who asked for the cleanup. */
const SKIP_OUTSIDE = "That path is outside the worktree folders this install owns.";
const SKIP_TICKET_LINKED =
  "This worktree is still linked to a ticket and can't be cleaned up here.";
const SKIP_UNREGISTERED = "Git no longer tracks this path, so it can't be removed here.";
const SKIP_UNKNOWN_AGE = "Volli can't tell when this was last used.";
const SKIP_UNKNOWN_PROJECT = "That project is no longer tracked.";
const SKIP_RECENT = "Used recently, so it isn't eligible for cleanup yet.";
const SKIP_LEASED = "Something else is already changing this folder.";
const SKIP_STILL_BOUND =
  "An agent session is still bound to this worktree and could not be released.";
const SKIP_METADATA_DRIFT =
  "The stale git records in this project changed since the scan, so pruning would do more than was confirmed. Scan again.";
const SKIP_METADATA_GONE = "This record is no longer stale, so there is nothing to prune.";

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
 * change. Ownership, the ticket link, the retention window and the clock all
 * come from a FRESH read of the database each time it runs — the review's C4:
 * a value snapshotted once for the whole run is a value another mutation can
 * invalidate while this one is still going.
 */
async function recheck(deps: OrphanCleanupDeps, item: OrphanCleanupPlanItem): Promise<Recheck> {
  const { worktree } = deps;
  // Every question below goes through the scan's read-only runner: a check that
  // ends in a SKIP must leave the checkout exactly as it found it.
  const git = readOnlyGit(worktree.git);
  const target = canonicalize(item.path);
  const idle: Recheck = { skip: null, branch: null, gitPath: item.path, projectPath: null };

  // (a) Ours at all, RIGHT NOW? The strict-leaf question — a container itself
  // answers no — against containers re-derived from the database this instant.
  const containers = ownedContainers(worktree.db, homeDir(worktree));
  const container = containers.find((entry) => isOwnedWorktreeLeaf(entry, item.path));
  if (container === undefined) return { ...idle, skip: SKIP_OUTSIDE };
  const projectPath = listProjects(worktree.db).find(
    (project) => project.id === container.projectId,
  )?.path;
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
  let entries: readonly WorktreeListEntry[];
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

  // (e) Still stale? A checkout touched since the scan is no longer eligible,
  // measured against the retention window and the clock as they read NOW.
  const age = lastTouchedAt(git, entry);
  if (age === null) return { ...found, skip: SKIP_UNKNOWN_AGE };
  const now = worktree.now?.() ?? Date.now();
  if (now - age.at < retentionTtlMs(worktree.db)) return { ...found, skip: SKIP_RECENT };

  // (f) And is anything standing in it? The manual Delete's guard, unchanged.
  const busy = busySiteWithin(entry.path, (await deps.busyWorktreeSites?.(entry.path)) ?? []);
  if (busy !== null) return { ...found, skip: busyRefusal(busy) };

  return found;
}

/** The confirmed record paths for one project, canonicalized. */
function confirmedRecordPaths(
  items: readonly OrphanCleanupPlanItem[],
  projectId: string,
): Set<string> {
  return new Set(
    items
      .filter((item) => item.kind === "metadata" && item.projectId === projectId)
      .map((item) => canonicalize(item.path)),
  );
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/**
 * Runs one cleanup and answers with the receipt and the durable run.
 *
 * Item failures are contained: a project whose prune fails, or a directory git
 * refuses to remove, is recorded as `failed` and the run carries on to the next
 * item. An unexpected throw from a seam is NOT contained — it propagates with
 * the record left exactly as far as the run got, which is the state the next
 * launch reconciles.
 */
export async function cleanupOrphans(
  deps: OrphanCleanupDeps,
  request: OrphanCleanupRequest,
): Promise<{ run: OrphanCleanupRun; receipt: OrphanCleanupReceipt }> {
  const { worktree, engine } = deps;
  const accepted = await engine.accept({
    commandId: request.commandId,
    source: request.source,
    scanRevision: request.scanRevision,
    retentionDays: getRetentionTtlDays(worktree.db),
    preservation: preservationRuleIds(),
    items: request.items,
  });
  if (!accepted.ok) throw new OrphanCleanupRefused(accepted.code, accepted.error);
  // A replay is the whole answer: the first run already did this work, and
  // doing it again is the duplicate deletion the command id exists to prevent.
  if (accepted.replayed) return { run: accepted.run, receipt: accepted.receipt };

  const settle = async (
    itemId: string,
    state: OrphanCleanupItemOutcome,
    detail: string,
    branch?: string | null,
  ): Promise<void> => {
    await engine.settleItem({ commandId: request.commandId, itemId, state, detail, branch });
  };

  // Metadata first: pruning stale records cannot affect a live checkout, and
  // doing it up front means a run that stops early has already taken the one
  // step with nothing to lose.
  const metadataItems = request.items.filter((item) => item.kind === "metadata");
  const prunedProjects = new Set<string>();
  for (const item of metadataItems) {
    if (prunedProjects.has(item.projectId)) continue;
    const siblings = metadataItems.filter((entry) => entry.projectId === item.projectId);
    prunedProjects.add(item.projectId);
    await pruneProject(deps, request, siblings, settle);
  }

  for (const item of request.items) {
    if (item.kind !== "worktree") continue;
    const verdict = await recheck(deps, item);
    if (verdict.skip !== null) {
      await settle(item.id, "skipped", verdict.skip, verdict.branch);
      continue;
    }
    // The lease closes the window the review named: from here until this item
    // settles, nothing may start a terminal or a harness inside this path, so
    // the awaits below cannot be overtaken by work arriving in the directory.
    const lease = acquireDeletionLease(verdict.gitPath);
    if (lease === null) {
      await settle(item.id, "skipped", SKIP_LEASED, verdict.branch);
      continue;
    }
    try {
      // The bindings rooted in the checkout end first, exactly as the manual
      // delete does it: nothing may be left dispatching into a deleted path.
      const release = await deps.releaseAgentSites?.(verdict.gitPath);
      if (release !== undefined && release.stillOpen.length > 0) {
        // A binding that would not close is a refusal, not a detail to log: the
        // directory is still someone's working tree.
        await settle(item.id, "skipped", SKIP_STILL_BOUND, verdict.branch);
        continue;
      }
      // Everything above took time. Ask the WHOLE question again — ownership,
      // ticket link, registration, dirtiness, age, activity — now that there is
      // nothing left to await before the irreversible call.
      const confirmed = await recheck(deps, item);
      if (confirmed.skip !== null) {
        await settle(item.id, "skipped", confirmed.skip, confirmed.branch);
        continue;
      }
      // Announced BEFORE the mutation (review C3): if the app dies inside the
      // next line, the run says this item was being executed, and the launch
      // reconcile asks git and disk what actually happened — rather than the
      // record claiming nobody ever tried.
      await engine.beginItem({ commandId: request.commandId, itemId: item.id });
      try {
        worktree.git(
          ["worktree", "remove", confirmed.gitPath],
          confirmed.projectPath ?? confirmed.gitPath,
        );
        await settle(
          item.id,
          "completed",
          confirmed.branch === null
            ? "Removed the folder. No branch was checked out here."
            : `Removed the folder. Branch ${confirmed.branch} is still in git.`,
          confirmed.branch,
        );
      } catch (caught) {
        await settle(item.id, "failed", errorText(caught), confirmed.branch);
      }
    } finally {
      lease.release();
    }
  }

  return engine.finish({ commandId: request.commandId });
}

/**
 * Prunes one project's stale records, or skips every confirmed record of that
 * project with the reason it was not safe to (review C2).
 *
 * `git worktree prune` takes no path argument: it drops every record the repo
 * currently calls prunable. So the only way to make it do exactly what was
 * confirmed is to prove, immediately before running it, that "every record the
 * repo currently calls prunable" and "the records this person confirmed" are
 * the same set. Anything else — a record that went stale since the scan, one
 * that belongs to a ticket or to another install, one that has already been
 * pruned — means the command would exceed its confirmation, and it does not run.
 */
async function pruneProject(
  deps: OrphanCleanupDeps,
  request: OrphanCleanupRequest,
  items: readonly OrphanCleanupPlanItem[],
  settle: (
    itemId: string,
    state: OrphanCleanupItemOutcome,
    detail: string,
    branch?: string | null,
  ) => Promise<void>,
): Promise<void> {
  const { worktree } = deps;
  const first = items[0];
  if (first === undefined) return;
  const project = listProjects(worktree.db).find((entry) => entry.id === first.projectId);
  if (project === undefined) {
    for (const item of items) await settle(item.id, "skipped", SKIP_UNKNOWN_PROJECT);
    return;
  }
  const git = readOnlyGit(worktree.git);
  let current: Set<string>;
  try {
    current = new Set(
      parseWorktreeList(git(["worktree", "list", "--porcelain"], project.path))
        .filter((entry) => entry.prunable !== null)
        .map((entry) => canonicalize(entry.path)),
    );
  } catch (caught) {
    for (const item of items) await settle(item.id, "failed", errorText(caught));
    return;
  }
  const confirmed = confirmedRecordPaths(request.items, project.id);
  if (!sameSet(current, confirmed)) {
    // Two different truths, so two different sentences: a record that is simply
    // gone was already pruned by something else, while a set that grew or moved
    // means this prune would take records nobody confirmed.
    for (const item of items) {
      await settle(
        item.id,
        "skipped",
        current.has(canonicalize(item.path)) ? SKIP_METADATA_DRIFT : SKIP_METADATA_GONE,
      );
    }
    return;
  }
  for (const item of items) {
    await deps.engine.beginItem({ commandId: request.commandId, itemId: item.id });
  }
  try {
    worktree.git(["worktree", "prune"], project.path);
    for (const item of items) {
      await settle(item.id, "completed", "Pruned this stale git record; nothing on disk changed.");
    }
  } catch (caught) {
    const detail = errorText(caught);
    for (const item of items) await settle(item.id, "failed", detail);
  }
}

/** A command main refused before doing anything: the caller gets the code. */
export class OrphanCleanupRefused extends Error {
  constructor(
    readonly code: OrphanCleanupRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "OrphanCleanupRefused";
  }
}
