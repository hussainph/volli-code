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
 * terminal, handed to an agent, claimed by a ticket, moved to another branch,
 * or measured against a retention window somebody just changed. So the last
 * thing before each mutation is a COMPLETE re-ask, and it is deliberately
 * shaped so nothing can happen inside it (VC-284 re-review C1/C2/C4):
 *
 *  - everything asynchronous happens BEFORE the gate — the agent bindings are
 *    released, the activity supplier is asked, the durable `started` fact is
 *    written;
 *  - the gate itself ({@link finalGate}, {@link metadataEligibility}) is
 *    SYNCHRONOUS, reading the database and git in one turn;
 *  - the mutation runs in that same turn, with no `await` between the last
 *    answer and the irreversible call.
 *
 * Around the awaits that cannot be avoided sits a two-sided deletion lease
 * (`deletion-lease.ts`): while cleanup holds a path, nothing may start a
 * terminal or an agent inside it, and while something is starting there,
 * cleanup will not take it.
 *
 * What it may do, in order: prune one project's stale git metadata, and remove
 * a worktree directory with `git worktree remove` — no `--force`, ever, so
 * git's own refusals stand — which keeps the branch and every commit on it. A
 * clean worktree directory is cache; a branch is data.
 *
 * `git worktree prune` cannot be aimed at one record, so metadata is handled as
 * a set (review C2): immediately before pruning, the project's current prunable
 * records are listed again, and the prune runs only if that set is EXACTLY the
 * set of confirmed records — in a repository whose path still matches the one
 * confirmed, with every confirmed record still owned by this database and
 * claimed by no ticket.
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
import {
  busyRefusal,
  busySiteWithin,
  type BusyWorktreeSite,
  type BusyWorktreeSites,
} from "./activity";
import type { AgentSiteReleaseReport } from "./agent-sites";
import type { OrphanCleanupEngine } from "./cleanup-engine";
import { isOwnedWorktreeLeaf, ownedContainers, type OwnedContainer } from "./containers";
import { acquireDeletionLease } from "./deletion-lease";
import { isWorktreeDirty } from "./dirty";
import { parseWorktreeList, type WorktreeListEntry } from "./git";
import { homeDir } from "./home";
import { canonicalize, isInside } from "./paths";
import { lastTouchedAt, metadataKeptReason, readOnlyGit } from "./scan";
import { getRetentionTtlDays, retentionTtlMs } from "./retention";
import type { WorktreeDeps } from "./types";

/** What a cleanup was asked to do: a command id, a scan revision, and its items. */
export interface OrphanCleanupRequest {
  /** The caller's UUID. The same one twice replays instead of removing twice. */
  commandId: string;
  /** The revision of the scan whose proposal was confirmed. */
  scanRevision: string;
  /** The item ids as the caller sent them, recorded so a retry is decidable durably. */
  requestedItemIds: readonly string[];
  /** The retention window the confirmed proposal was measured against. */
  retentionDays: number;
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
  /** Test seam: how long the release may take before the item is skipped. */
  releaseTimeoutMs?: number;
}

/**
 * How long an agent-binding release may run before cleanup gives up on the
 * item.
 *
 * A release that never settles used to hold the deletion lease for the life of
 * the process (VC-284 re-review C4): the item never completed, and every later
 * cleanup and every terminal start under that path was refused by a lease
 * nobody would ever release. Timing out is the honest end — the directory is
 * left alone, the reason says so, and the lease goes back.
 */
export const AGENT_RELEASE_TIMEOUT_MS = 30_000;

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
const SKIP_RELEASE_TIMEOUT =
  "Volli couldn't confirm the agent sessions here had stopped, so this folder was left alone.";
const SKIP_METADATA_DRIFT =
  "The stale git records in this project changed since the scan, so pruning would do more than was confirmed. Scan again.";
const SKIP_METADATA_GONE = "This record is no longer stale, so there is nothing to prune.";

/** The project this item was confirmed against has moved, so nothing here is that repository. */
function projectMovedText(confirmed: string, current: string): string {
  return `This project's folder moved from ${confirmed} to ${current} since the scan, so nothing was changed. Scan again.`;
}

/** The branch on the confirmed path is not the branch that was shown. */
function branchChangedText(confirmed: string | null, current: string | null): string {
  const was = confirmed ?? "no branch";
  const now = current ?? "no branch";
  return `This folder was ${was} when it was scanned and is ${now} now, so it wasn't removed. Scan again.`;
}

/** The retention window moved after the confirmation, so the verdict it was measured by is void. */
function retentionChangedText(confirmed: number, current: number): string {
  return `The retention window changed from ${confirmed} to ${current} day(s) since the scan, so this wasn't removed. Scan again.`;
}

/** A stale record this flow may not prune at all — with the reason the scan uses. */
function metadataIneligibleText(reason: "not-owned" | "ticket-linked"): string {
  return reason === "ticket-linked"
    ? "A ticket now claims this stale record, so the project's records were left alone. Scan again."
    : "This stale record isn't inside a folder this install owns, so the project's records were left alone. Scan again.";
}

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
 * Everything asked again, in the cheapest-first order — SYNCHRONOUSLY, so the
 * mutation that follows a clean verdict runs in the same turn as the verdict
 * (VC-284 re-review C1/C4). The one asynchronous input, what is live inside the
 * directory, is fetched by the caller and handed in.
 *
 * Ownership, the confirmed project, the ticket link, the branch, the retention
 * window and the clock all come from a FRESH read each time it runs: a value
 * snapshotted once for the whole run is a value another mutation can invalidate
 * while this one is still going.
 */
function finalGate(
  deps: OrphanCleanupDeps,
  item: OrphanCleanupPlanItem,
  request: Pick<OrphanCleanupRequest, "retentionDays">,
  sites: readonly BusyWorktreeSite[],
): Recheck {
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
  // (a2) And is it the SAME project folder the plan named? A project whose path
  // was re-pointed after the confirmation is a different repository; running
  // `worktree remove` in it would be running it somewhere nobody confirmed.
  if (canonicalize(projectPath) !== canonicalize(item.projectPath)) {
    return { ...idle, projectPath, skip: projectMovedText(item.projectPath, projectPath) };
  }

  // (b) Never a directory the DB still tracks — live OR archived, since a
  // retained checkout is still a ticket's, and clearing it is that ticket's
  // "Remove worktree…", not this list's.
  const known = listWorktreePaths(worktree.db);
  if (known.some((entry) => isInside(target, entry) || isInside(entry, target))) {
    return { ...idle, projectPath, skip: SKIP_TICKET_LINKED };
  }

  // (b2) The window this proposal was MEASURED against. A person who shortens
  // or lengthens retention between the scan and the click has changed the
  // policy the eligibility dates were computed under; re-deciding under the new
  // one silently would remove a folder against a verdict nobody reviewed.
  const currentRetentionDays = getRetentionTtlDays(worktree.db);
  if (currentRetentionDays !== request.retentionDays) {
    return {
      ...idle,
      projectPath,
      skip: retentionChangedText(request.retentionDays, currentRetentionDays),
    };
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

  // (c2) The same checkout, or the same address? A path can be removed and
  // re-added on another branch between the scan and the click, and the
  // confirmation named a branch. Removing a directory holding a DIFFERENT
  // branch's checkout is removing something nobody was shown.
  if (entry.branch !== item.branch) {
    return { ...found, skip: branchChangedText(item.branch, entry.branch) };
  }

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

  // (f) And is anything standing in it? The manual Delete's guard, unchanged —
  // asked of the sites the caller fetched a moment ago, in this same turn.
  const busy = busySiteWithin(entry.path, sites);
  if (busy !== null) return { ...found, skip: busyRefusal(busy) };

  return found;
}

/** What is live in one directory, or nothing when there is no supplier. */
async function busySitesFor(
  deps: OrphanCleanupDeps,
  path: string,
): Promise<readonly BusyWorktreeSite[]> {
  return (await deps.busyWorktreeSites?.(path)) ?? [];
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
    requestedItemIds: request.requestedItemIds,
    // The window the PROPOSAL was measured against — not whatever the setting
    // reads at this instant. The two being different is itself a refusal
    // condition below, and the record has to say which one was confirmed.
    retentionDays: request.retentionDays,
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
    // A pre-flight, before any intent is announced: an item that is already
    // hopeless (dirty, claimed, occupied) never becomes an `executing` fact a
    // later launch has to reconcile.
    const verdict = finalGate(deps, item, request, await busySitesFor(deps, item.path));
    if (verdict.skip !== null) {
      await settle(item.id, "skipped", verdict.skip, verdict.branch);
      continue;
    }
    // The lease closes the window the review named: from here until this item
    // settles, nothing may start a terminal or a harness inside this path — and
    // nothing that is already starting there could have let cleanup take it.
    const lease = acquireDeletionLease(verdict.gitPath);
    if (lease === null) {
      await settle(item.id, "skipped", SKIP_LEASED, verdict.branch);
      continue;
    }
    try {
      // The bindings rooted in the checkout end first, exactly as the manual
      // delete does it: nothing may be left dispatching into a deleted path.
      // Bounded, because a release that never settles must not hold this
      // directory's lease for the life of the process.
      const release = await releaseWithin(deps, verdict.gitPath);
      if (release.timedOut) {
        await settle(item.id, "skipped", SKIP_RELEASE_TIMEOUT, verdict.branch);
        continue;
      }
      if (release.report !== null && release.report.stillOpen.length > 0) {
        // A binding that would not close is a refusal, not a detail to log: the
        // directory is still someone's working tree.
        await settle(item.id, "skipped", SKIP_STILL_BOUND, verdict.branch);
        continue;
      }
      // Announced BEFORE the last look (review C3, re-review C1): if the app
      // dies from here on, the run says this item was being executed and the
      // launch reconcile asks git and disk what actually happened. It is
      // written here rather than after the gate so that nothing awaits between
      // the gate's answer and the removal.
      await engine.beginItem({ commandId: request.commandId, itemId: item.id });
      // The last asynchronous act of this item: what is live inside it.
      const sites = await busySitesFor(deps, item.path);
      // ---- no `await` from here to the mutation -----------------------------
      const confirmed = finalGate(deps, item, request, sites);
      if (confirmed.skip !== null) {
        await settle(item.id, "skipped", confirmed.skip, confirmed.branch);
        continue;
      }
      let removal: { ok: true } | { ok: false; error: string };
      try {
        worktree.git(
          ["worktree", "remove", confirmed.gitPath],
          confirmed.projectPath ?? confirmed.gitPath,
        );
        removal = { ok: true };
      } catch (caught) {
        removal = { ok: false, error: errorText(caught) };
      }
      // ---- the mutation is over; recording it may await again ---------------
      if (removal.ok) {
        await settle(
          item.id,
          "completed",
          confirmed.branch === null
            ? "Removed the folder. No branch was checked out here."
            : `Removed the folder. Branch ${confirmed.branch} is still in git.`,
          confirmed.branch,
        );
      } else {
        await settle(item.id, "failed", removal.error, confirmed.branch);
      }
    } finally {
      lease.release();
    }
  }

  return engine.finish({ commandId: request.commandId });
}

/** The agent-binding release, with a deadline. A timeout is a skip, never a removal. */
async function releaseWithin(
  deps: OrphanCleanupDeps,
  directory: string,
): Promise<{ timedOut: boolean; report: AgentSiteReleaseReport | null }> {
  const release = deps.releaseAgentSites;
  if (release === undefined) return { timedOut: false, report: null };
  const timeoutMs = deps.releaseTimeoutMs ?? AGENT_RELEASE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    // Never keep the app alive for a lease deadline.
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([release(directory), deadline]);
    return outcome === "timeout"
      ? { timedOut: true, report: null }
      : { timedOut: false, report: outcome };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A metadata verdict for one project's confirmed records, and where to run git. */
interface MetadataGate {
  skip: string | null;
  projectPath: string;
}

/**
 * Whether this project's confirmed records are still this flow's to prune —
 * synchronously, from a fresh database read (VC-284 re-review C2).
 *
 * Set equality alone is not enough. A ticket that starts claiming a confirmed
 * record after the scan leaves the stale SET untouched while making the record
 * one the preservation policy protects, and a project whose path was re-pointed
 * leaves the set untouched while making the repository a different repository.
 * Both are asked here, with the scan's own eligibility rule.
 */
function metadataEligibility(
  deps: OrphanCleanupDeps,
  items: readonly OrphanCleanupPlanItem[],
  first: OrphanCleanupPlanItem,
): MetadataGate {
  const { worktree } = deps;
  const project = listProjects(worktree.db).find((entry) => entry.id === first.projectId);
  if (project === undefined) return { skip: SKIP_UNKNOWN_PROJECT, projectPath: first.projectPath };
  if (canonicalize(project.path) !== canonicalize(first.projectPath)) {
    return {
      skip: projectMovedText(first.projectPath, project.path),
      projectPath: project.path,
    };
  }
  const containers = ownedContainers(worktree.db, homeDir(worktree));
  const container: OwnedContainer | undefined = containers.find(
    (entry) => entry.projectId === project.id,
  );
  const known = new Set(listWorktreePaths(worktree.db).map((path) => canonicalize(path)));
  for (const item of items) {
    const kept = metadataKeptReason(container, known, item.path);
    if (kept !== null) return { skip: metadataIneligibleText(kept), projectPath: project.path };
  }
  return { skip: null, projectPath: project.path };
}

/**
 * Prunes one project's stale records, or skips every confirmed record of that
 * project with the reason it was not safe to (review C2).
 *
 * `git worktree prune` takes no path argument: it drops every record the repo
 * currently calls prunable. So the only way to make it do exactly what was
 * confirmed is to prove, immediately before running it, that "every record the
 * repo currently calls prunable" and "the records this person confirmed" are
 * the same set — and that every one of those records is still eligible at all.
 * Anything else means the command would exceed its confirmation, and it does
 * not run.
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
  const skipAll = async (detail: string): Promise<void> => {
    for (const item of items) await settle(item.id, "skipped", detail);
  };
  // Pre-flight, for the same reason the directory path has one: an obviously
  // ineligible project never announces intent it will not act on.
  const preflight = metadataEligibility(deps, items, first);
  if (preflight.skip !== null) return skipAll(preflight.skip);

  for (const item of items) {
    await deps.engine.beginItem({ commandId: request.commandId, itemId: item.id });
  }
  // ---- no `await` from here to the prune ----------------------------------
  const gate = metadataEligibility(deps, items, first);
  if (gate.skip !== null) return skipAll(gate.skip);
  const git = readOnlyGit(worktree.git);
  let current: Set<string>;
  try {
    current = new Set(
      parseWorktreeList(git(["worktree", "list", "--porcelain"], gate.projectPath))
        .filter((entry) => entry.prunable !== null)
        .map((entry) => canonicalize(entry.path)),
    );
  } catch (caught) {
    const detail = errorText(caught);
    for (const item of items) await settle(item.id, "failed", detail);
    return;
  }
  const confirmed = confirmedRecordPaths(request.items, first.projectId);
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
  let pruned: { ok: true } | { ok: false; error: string };
  try {
    worktree.git(["worktree", "prune"], gate.projectPath);
    pruned = { ok: true };
  } catch (caught) {
    pruned = { ok: false, error: errorText(caught) };
  }
  // ---- the mutation is over; recording it may await again ------------------
  for (const item of items) {
    if (pruned.ok) {
      await settle(item.id, "completed", "Pruned this stale git record; nothing on disk changed.");
    } else {
      await settle(item.id, "failed", pruned.error);
    }
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
