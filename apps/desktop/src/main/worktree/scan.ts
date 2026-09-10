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
 *
 * Three things the first version of this file left to the cleanup to discover,
 * which the review sent back (C1, C2, C5):
 *
 *  - Every scan mints an opaque REVISION and, with it, the exact plan a cleanup
 *    command may select from. A proposal a person reviewed is a thing with an
 *    identity; without one, the destructive channel had to accept whatever
 *    paths it was handed and hope they came from a report.
 *  - Stale metadata goes through the SAME ownership and ticket gates the
 *    directories do. A record pointing outside our containers, or at a path a
 *    ticket still claims, is reported as kept, never proposed.
 *  - Activity is asked HERE, read-only, so an occupied checkout is reported as
 *    kept rather than proposed and then refused after the confirmation; and a
 *    project whose listing cannot be read is named as unreadable rather than
 *    silently dropped, which used to make its checkouts read as "not
 *    registered with git".
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type {
  OrphanAgeBasis,
  OrphanCleanupPlanItem,
  OrphanMetadataKeptReason,
} from "@volli/shared";

import type {
  DirtyWorktreeOrphan,
  KeptWorktreeMetadata,
  KeptWorktreeOrphan,
  PrunableWorktreeMetadata,
  RemovableWorktreeOrphan,
  UnreadableWorktreeProject,
} from "../../ipc/contract";
import { listProjects } from "../db/projects-repo";
import { listWorktreePaths } from "../db/tickets-repo";
import { busyRefusal, busySiteWithin, type BusyWorktreeSites } from "./activity";
import { isOwnedWorktreeLeaf, ownedContainers, type OwnedContainer } from "./containers";
import { isWorktreeDirty } from "./dirty";
import { parseWorktreeList, type WorktreeListEntry } from "./git";
import { homeDir } from "./home";
import { canonicalize, isInside } from "./paths";
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

/**
 * What a scan found. Every field is a statement about the world, never a change
 * to it — and `revision` is what makes the statement quotable: a cleanup command
 * names it, and main will only act on the plan THIS scan minted (review C1).
 */
export interface OrphanScanReport {
  /** Opaque, minted per scan. A cleanup that names another one is refused. */
  revision: string;
  /** Epoch ms the walk was judged against — one clock read for the whole scan. */
  scannedAt: number;
  /** The retention window in force, so Storage can say why a date is what it is. */
  retentionDays: number;
  prunable: PrunableWorktreeMetadata[];
  keptMetadata: KeptWorktreeMetadata[];
  removable: RemovableWorktreeOrphan[];
  keptRecent: KeptWorktreeOrphan[];
  unreadableProjects: UnreadableWorktreeProject[];
  dirty: DirtyWorktreeOrphan[];
  /**
   * The proposal a cleanup command may select from, by item id. It carries the
   * project path each git command would run in and the git reason each record
   * was named for, so the confirmed intent is complete on its own — the command
   * that runs it does not have to trust a client for a single path.
   */
  plan: OrphanCleanupPlanItem[];
}

/** The read-only seams a scan may use beyond the worktree bundle. */
export interface OrphanScanOptions {
  /**
   * Live terminals and agent turns, the same supplier the manual Delete and the
   * cleanup use. Read-only: the scan only asks, so it can report an ACTIVE
   * checkout as kept instead of proposing a folder somebody is working in and
   * leaving the refusal to be discovered after the confirmation (review C5).
   */
  busyWorktreeSites?: BusyWorktreeSites;
  /** Test seam for the revision id. */
  newRevision?: () => string;
}

/** How the retention clock read a worktree's last use, and when. */
export interface WorktreeAge {
  at: number;
  basis: OrphanAgeBasis;
}

/**
 * How recently a clean orphan was touched — the newest of its directory mtime
 * and its branch tip's commit date, so a checkout that is only built in (mtime
 * moves, no commits) and one that is only committed to (commits move, mtime may
 * not) both read as recent. `null` when EITHER source cannot be read: without
 * both values the newer one is unknowable, and the preservation rule says any
 * unreadable state stays in place.
 *
 * It answers with the BASIS as well as the timestamp, because a deadline nobody
 * can explain is a deadline nobody can argue with (review C6) — Storage says
 * which of the two clocks decided.
 *
 * Exported because the cleanup's immediate re-check has to ask the identical
 * question: a second definition of "recent" is a second retention policy.
 */
export function lastTouchedAt(
  git: RunGit,
  entry: Pick<WorktreeListEntry, "path" | "branch">,
): WorktreeAge | null {
  let directoryMtime: number;
  try {
    directoryMtime = statSync(entry.path).mtimeMs;
  } catch {
    return null;
  }
  try {
    const seconds = Number.parseInt(
      git(["log", "-1", "--format=%ct", entry.branch ?? "HEAD"], entry.path).trim(),
      10,
    );
    if (!Number.isFinite(seconds)) return null;
    const commitMs = seconds * 1000;
    return commitMs > directoryMtime
      ? { at: commitMs, basis: "commit" }
      : { at: directoryMtime, basis: "directory" };
  } catch {
    return null;
  }
}

/** What one project's listing produced, or why it could not be read. */
interface ProjectListing {
  entries: readonly WorktreeListEntry[];
  error: string | null;
}

function listWorktrees(git: RunGit, projectPath: string): ProjectListing {
  try {
    return {
      entries: parseWorktreeList(git(["worktree", "list", "--porcelain"], projectPath)),
      error: null,
    };
  } catch (caught) {
    return { entries: [], error: caught instanceof Error ? caught.message : String(caught) };
  }
}

/**
 * Whether a stale git record is this flow's to prune (review C2).
 *
 * The eligibility rule for metadata is the eligibility rule for directories,
 * stated once: a record pointing INSIDE a container this database owns, that no
 * ticket still claims. Anything else — a user's own `git worktree add ../review`
 * they later deleted, another install's container, a ticket's checkout that
 * vanished — is reported and left alone. Pruning is repo-wide, so a record we
 * may not touch is not merely skipped: it stops the prune for that project
 * entirely (`cleanup.ts`), because `git worktree prune` cannot be aimed.
 *
 * Exported because the cleanup has to ask it AGAIN immediately before pruning
 * (VC-284 re-review C2): a ticket that started claiming a confirmed record
 * after the scan changes nothing about the stale SET, so set equality alone
 * would let a repo-wide prune drop ticket-linked metadata the policy protects.
 * One definition, asked twice, is the only way the second answer can be trusted.
 */
export function metadataKeptReason(
  container: OwnedContainer | undefined,
  knownPaths: ReadonlySet<string>,
  recordPath: string,
): OrphanMetadataKeptReason | null {
  const canonical = canonicalize(recordPath);
  if (knownPaths.has(canonical)) return "ticket-linked";
  if (container === undefined || !isOwnedWorktreeLeaf(container, recordPath)) return "not-owned";
  return null;
}

export async function scanOrphans(
  deps: WorktreeDeps,
  options: OrphanScanOptions = {},
): Promise<OrphanScanReport> {
  const git = readOnlyGit(deps.git);
  const now = deps.now?.() ?? Date.now();
  const revision = (options.newRevision ?? randomUUID)();
  const report: OrphanScanReport = {
    revision,
    scannedAt: now,
    retentionDays: getRetentionTtlDays(deps.db),
    prunable: [],
    keptMetadata: [],
    removable: [],
    keptRecent: [],
    unreadableProjects: [],
    dirty: [],
    plan: [],
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
  const projectNames = new Map<string, string>();
  /** Candidates held back until their activity has been asked about. */
  const candidates: {
    entry: WorktreeListEntry;
    projectId: string;
    projectPath: string;
    projectName: string;
    age: WorktreeAge;
  }[] = [];

  for (const project of listProjects(deps.db)) {
    const projectCanonical = canonicalize(project.path);
    const container = containerById.get(project.id);
    projectNames.set(project.id, project.name);

    const listing = listWorktrees(git, project.path);
    if (listing.error !== null) {
      // A project whose git can't be read is REPORTED, not skipped in silence
      // (review C5). Without the listing every checkout in its container is
      // unaccounted for, and the disk pass below would otherwise describe them
      // as "not registered with git" — a different, wrong statement.
      report.unreadableProjects.push({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        error: listing.error,
      });
      if (container !== undefined) {
        for (const leaf of containerLeaves(container)) registeredPaths.add(canonicalize(leaf));
      }
      continue;
    }
    const entries = listing.entries;

    // Tier 1: name the stale metadata a cleanup's `git worktree prune` would
    // drop. Read straight off the listing git already gave us, with git's own
    // reason attached, so the confirmation can be specific about records rather
    // than saying "and some metadata" — and split by the SAME ownership and
    // ticket gates the directories go through (review C2).
    for (const entry of entries) {
      if (entry.prunable === null) continue;
      const kept = metadataKeptReason(container, knownPaths, entry.path);
      if (kept !== null) {
        report.keptMetadata.push({
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          path: entry.path,
          gitReason: entry.prunable,
          reason: kept,
        });
        continue;
      }
      const id = `${revision}:metadata:${report.prunable.length}`;
      report.prunable.push({
        id,
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        path: entry.path,
        reason: entry.prunable,
      });
      report.plan.push({
        id,
        kind: "metadata",
        path: entry.path,
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        branch: null,
        gitReason: entry.prunable,
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
          projectName: project.name,
          reason: dirty.reason ?? "dirty",
        });
        continue;
      }

      // Tier 2: clean, but recently touched — proposing a checkout somebody was
      // working in an hour ago is the "nuke that fires asap" VC-113 is about.
      // An unreadable age keeps it too: we only offer what we can date.
      const age = lastTouchedAt(git, entry);
      if (age === null || now - age.at < graceMs) {
        report.keptRecent.push({
          path: entry.path,
          projectId: project.id,
          projectName: project.name,
          branch: entry.branch,
          lastTouchedAt: age?.at ?? null,
          ageBasis: age?.basis ?? null,
          removableAt: age === null ? null : age.at + graceMs,
          reason: age === null ? "age-unknown" : "recently-used",
          detail: null,
        });
        continue;
      }

      candidates.push({
        entry,
        projectId: project.id,
        projectPath: project.path,
        projectName: project.name,
        age,
      });
    }
  }

  // Tier 3: stale clean orphans — but only the ones nothing is working in.
  // Asking here rather than only in the cleanup is the difference between a
  // report a person can trust and one whose refusals arrive after they have
  // already confirmed (review C5). It is a read, like everything else here.
  for (const candidate of candidates) {
    const busy = await busySite(options.busyWorktreeSites, candidate.entry.path);
    if (busy !== null) {
      report.keptRecent.push({
        path: candidate.entry.path,
        projectId: candidate.projectId,
        projectName: candidate.projectName,
        branch: candidate.entry.branch,
        lastTouchedAt: candidate.age.at,
        ageBasis: candidate.age.basis,
        removableAt: candidate.age.at + graceMs,
        reason: "active",
        detail: busy,
      });
      continue;
    }
    const id = `${revision}:worktree:${report.removable.length}`;
    report.removable.push({
      id,
      path: candidate.entry.path,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      branch: candidate.entry.branch,
      lastTouchedAt: candidate.age.at,
      ageBasis: candidate.age.basis,
      removableAt: candidate.age.at + graceMs,
    });
    report.plan.push({
      id,
      kind: "worktree",
      path: candidate.entry.path,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      projectPath: candidate.projectPath,
      branch: candidate.entry.branch,
      gitReason: null,
    });
  }

  // Disk-vs-git pass, over OUR OWN containers only: a dir git no longer
  // registers may still hold real work — git can't vouch for it, and any
  // ambiguity reads dirty. Report it for the Storage list; never propose it.
  for (const container of containers) {
    for (const leafPath of containerLeaves(container)) {
      if (registeredPaths.has(canonicalize(leafPath))) continue;
      report.dirty.push({
        path: leafPath,
        projectId: container.projectId,
        projectName: projectNames.get(container.projectId) ?? "",
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

/** Every directory sitting directly inside one owned container. */
function containerLeaves(container: OwnedContainer): string[] {
  if (!existsSync(container.path)) return [];
  return readdirSync(container.path, { withFileTypes: true })
    .filter((leaf) => leaf.isDirectory())
    .map((leaf) => join(container.path, leaf.name));
}

/**
 * What is live in a directory, as a sentence, or `null` for nothing.
 *
 * A supplier that THROWS reads as active. The scan is a proposal, and proposing
 * a checkout whose occupancy could not be established is the same class of
 * mistake as proposing one whose age could not be read — the fail-safe answer
 * keeps it, and the cleanup's own re-check gets to ask again.
 */
async function busySite(
  sites: BusyWorktreeSites | undefined,
  path: string,
): Promise<string | null> {
  if (sites === undefined) return null;
  try {
    const site = busySiteWithin(path, await sites(path));
    return site === null ? null : busyRefusal(site);
  } catch {
    return "Volli couldn't check whether anything is running in this folder.";
  }
}

/** Whether `target` is inside any of the DB-known worktree paths, or holds one. */
export function touchesKnownWorktree(knownPaths: readonly string[], target: string): boolean {
  return knownPaths.some((known) => isInside(target, known) || isInside(known, target));
}
