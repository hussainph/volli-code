/**
 * The `ensure` pipeline (worktree-support §3): the ONE seam that materializes a
 * ticket's execution state, triggered by session boot before the PTY spawns. It
 * is idempotent and SINGLE-FLIGHT per ticket — concurrent callers (kickoff and
 * `+` racing) join one in-flight run rather than duplicating `git worktree add`.
 *
 * Order (git first, DB write last — DB writes never straddle long-running git):
 *   resolve identity → reconcile (which may adopt a same-ticket branch already
 *   checked out at the ticket's path) → resolve base → record the first-run
 *   steps pending → git worktree add → copy step (while it is still pending:
 *   the Main-checkout walk is a creation cost, never a per-boot one) →
 *   materialize attachments (CONCEPT decision #19, issue #77 PR 2) → persist
 *   identity (emits `worktree_changed`) → phase `ready`.
 *
 * Every step is ASYNC — git through the non-blocking runner, the copy walk
 * through fs/promises — because this pipeline runs on Electron main and its
 * synchronous ancestor froze every window for the duration (VC-16).
 *
 * On failure at any stage: phase → `failed`, a `worktree_failed` ticket event
 * with the stage + trimmed stderr, and a typed error Result the caller toasts —
 * the session NEVER silently falls back to the main checkout (#38). Setup-command
 * execution is deliberately NOT here: `ensure` only reports whether it is still
 * pending, and the door that starts work claims and runs it — the terminal in
 * its shell after spawn (`setup.ts` builds/parses its sentinel), a structured
 * Session before its first turn (`setup-exec.ts`). See `first-run.ts` for why
 * both creation-only steps are a durable fact rather than this call's `created`.
 */
import {
  displayTicketId,
  trimWorktreeFailureStderr,
  type TicketEventActor,
  type WorktreeIdentity,
} from "@volli/shared";

import { materializeBlobs } from "../blob-materialize";
import { recordTicketEvent } from "../db/events-repo";
import { getProjectById } from "../db/projects-repo";
import { getTicketRow } from "../db/tickets-repo";
import { updateTicketFieldsCommand } from "../ticket-commands";
import { refExists, resolveBaseBranch } from "./base";
import { GitError, parseWorktreeList, stderrOf } from "./git";
import { existsSync } from "node:fs";
import { acquireDeletionLease, UNDER_DELETION_REFUSAL } from "./deletion-lease";
import { busyRefusal, busySiteWithin, type BusyWorktreeSites } from "./activity";
import { isWorktreeDirtyAsync } from "./dirty";
import { canonicalize } from "./paths";
import type { AgentSiteReleaseReport } from "./agent-sites";
import { homeDir } from "./home";
import { resolveWorktreeIdentity } from "./identity";
import { completeFirstRunCopy, isFirstRunPending, markFirstRunPending } from "./first-run";
import type { FirstRunStep } from "./first-run";
import { copyIncludedFiles } from "./include";
import { setPhase } from "./phase";
import { reconcile } from "./reconcile";
import { withRepositoryWorktreeTurn } from "./repository-turn";
import { err, ok, type RunGitAsync, type WorktreePorts, type WorktreeResult } from "./types";

/**
 * The success value of `ensure`: the resolved identity plus whether THIS run
 * actually created the worktree on disk (`git worktree add` ran) versus found
 * it already present.
 *
 * `setupPending` is the setup-command gate: the worktree was created with a
 * setup command configured and no door has claimed that run yet
 * (`first-run.ts`). It is a durable fact of the worktree, not of this call, so
 * a Retry after a start that failed past the add still owes it, and a Session
 * booting into a worktree whose setup already ran never re-runs it
 * (worktree-support §6). A door that acts on it must claim it first
 * (`claimFirstRunSetup`) — two doors can both read `true`.
 *
 * `restamped` says whether THIS run changed the identity the ticket records —
 * true on a first creation, and on a reuse that adopted a same-ticket branch
 * already checked out at the ticket's path. It is the broadcast gate, kept
 * apart from `created` because adoption changes the rail's Branch without
 * making a worktree, and must never fire the setup command.
 */
export interface EnsureOutcome {
  identity: WorktreeIdentity;
  created: boolean;
  restamped: boolean;
  setupPending: boolean;
}

/** Concurrent `ensure(ticketId)` calls join the same promise; the entry clears on settle. */
const inflight = new Map<string, Promise<WorktreeResult<EnsureOutcome>>>();

// System-driven, no session: these mutations are attributed to automation.
const SYSTEM_ACTOR: TicketEventActor = { kind: "automation" };

export type EnsureStage = "create" | "copy" | "attachments";

/** Board facts supplied by a store. The git pipeline never reads a board. */
export interface EnsureFacts {
  ticketId: string;
  projectId: string;
  checkoutPath: string;
  displayId: string;
  title: string;
  usesWorktree: boolean;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  projectBaseBranch: string | null;
  setupCommand: string | null;
}

/** Machine operations plus store-specific publication; no SQLite dependency. */
export interface EnsureExplicitPorts {
  gitAsync: RunGitAsync;
  home?: string;
  environmentRecipes?: () => boolean;
  onPhase?: WorktreePorts["onPhase"];
  onFailure?: (ticketId: string, stage: EnsureStage, stderr: string) => void;
  materializeAttachments?: (ticketId: string, worktreePath: string) => Promise<void>;
  persistIdentity?: (identity: WorktreeIdentity) => void;
}

/** Records store-specific failure evidence without giving the core a board writer. */
function fail(
  deps: EnsureExplicitPorts,
  ticketId: string,
  stage: EnsureStage,
  message: string,
  stderr: string,
): WorktreeResult<EnsureOutcome> {
  deps.onPhase?.(ticketId, "failed");
  deps.onFailure?.(ticketId, stage, trimWorktreeFailureStderr(stderr));
  return err(message);
}

/** Runs `git worktree add`, pruning first if reconcile asked, and retrying ONCE after a prune on failure. */
async function addWorktree(
  git: RunGitAsync,
  projectPath: string,
  addArgs: readonly string[],
  prune: boolean,
): Promise<void> {
  const runAdd = async (): Promise<void> => {
    await git(["worktree", "add", ...addArgs], projectPath);
  };
  if (prune) await git(["worktree", "prune"], projectPath);
  try {
    await runAdd();
  } catch (first) {
    // A deadline is not a stale registration: retrying would run the whole
    // checkout again inside the repository's turn, and git has already
    // cleaned up after the stopped one.
    if (first instanceof GitError && first.timedOut) throw first;
    // A stale registration can defeat the first add; prune and retry once.
    try {
      await git(["worktree", "prune"], projectPath);
      await runAdd();
    } catch {
      throw first;
    }
  }
}

async function runEnsure(
  deps: WorktreePorts,
  ticketId: string,
): Promise<WorktreeResult<EnsureOutcome>> {
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket) return err("Unknown ticket");
  const project = getProjectById(deps.db, ticket.project_id);
  if (!project) return err("Unknown project");
  return runEnsureExplicit(
    {
      ...deps,
      onPhase: (id, phase) => setPhase(id, phase, deps.onPhase),
      onFailure: (id, stage, stderr) => {
        recordTicketEvent(
          deps.db,
          id,
          { kind: "worktree_failed", stage, stderr },
          Date.now(),
          SYSTEM_ACTOR,
        );
      },
      materializeAttachments: async (id, path) => {
        await materializeBlobs(deps.db, deps.blobsRoot, null, id, path);
      },
      persistIdentity: (identity) => {
        updateTicketFieldsCommand(
          deps.db,
          {
            ticketId,
            worktreePath: identity.worktreePath,
            branch: identity.branch,
            baseBranch: identity.baseBranch,
          },
          { now: Date.now(), actor: SYSTEM_ACTOR },
        );
      },
    },
    {
      ticketId,
      projectId: project.id,
      checkoutPath: project.path,
      displayId: displayTicketId(project.ticketPrefix, ticket.ticket_number),
      title: ticket.title,
      usesWorktree: true,
      worktreePath: ticket.worktree_path,
      branch: ticket.branch,
      baseBranch: ticket.base_branch,
      projectBaseBranch: project.baseBranch ?? null,
      setupCommand: project.setupCommand ?? null,
    },
  );
}

async function runEnsureExplicit(
  deps: EnsureExplicitPorts,
  facts: EnsureFacts,
): Promise<WorktreeResult<EnsureOutcome>> {
  const { ticketId, displayId } = facts;
  if (!facts.usesWorktree) {
    return ok({
      identity: { worktreePath: null, branch: facts.branch, baseBranch: facts.baseBranch },
      created: false,
      restamped: false,
      setupPending: false,
    });
  }
  // Every git step below runs through the REQUIRED async runner — this pipeline
  // runs on Electron main, and one `execFileSync` here freezes every window for
  // the duration of a `git worktree add` (VC-16's rainbow wheel). Requiring the
  // seam makes a missing bundle fail at its construction site instead of quietly
  // escaping to real git or back onto the main thread.
  const git = deps.gitAsync;

  deps.onPhase?.(ticketId, "creating");

  const identity = resolveWorktreeIdentity({
    home: homeDir(deps),
    projectPath: facts.checkoutPath,
    projectId: facts.projectId,
    displayId,
    title: facts.title,
    persistedPath: facts.worktreePath,
    persistedBranch: facts.branch,
  });

  // Reconcile the collision matrix on canonicalized paths.
  const reconciled = await reconcile(git, {
    projectPath: facts.checkoutPath,
    worktreePath: identity.path,
    branch: identity.branch,
    displayId,
  });
  if (!reconciled.ok) return fail(deps, ticketId, "create", reconciled.error, reconciled.error);
  // The branch the worktree stands on. Usually `identity.branch`; when the
  // ticket's own path is already on another branch of this same ticket (an
  // agent cut a narrower one, or a retitle drifted the name), reconcile adopts
  // that checkout, and the identity write below records it as the ticket's
  // branch through the ordinary `worktree_changed` event.
  const branch = reconciled.value.branch;

  // Resolve base for stamping + (for a new branch) branching. Reusing an
  // existing ticket branch never resets it, so base is only structurally
  // required when we create the branch.
  const reuseBranch = await refExists(git, facts.checkoutPath, `refs/heads/${branch}`);
  const base = await resolveBaseBranch(git, {
    projectPath: facts.checkoutPath,
    ticketBaseBranch: facts.baseBranch,
    projectBaseBranch: facts.projectBaseBranch,
  });
  if (!reuseBranch && !base) {
    const message = "Couldn't resolve a base branch to create the worktree from.";
    return fail(deps, ticketId, "create", message, message);
  }

  // Whether THIS run runs `git worktree add`.
  const created = reconciled.value.kind === "create";
  if (reconciled.value.kind === "create") {
    // The creation-only steps are owed from before the add, so a start that
    // dies anywhere past this point — the add outliving its deadline included —
    // still owes them to the next start (`first-run.ts`). Setup is owed only
    // when the project has a command now: one configured later belongs to the
    // next worktree, not to this one's next boot. With environment recipes on
    // it is always owed: whether the checkout carries `.agents/setup` is known
    // only once it exists, and the door that claims the run resolves it.
    const steps: FirstRunStep[] =
      deps.environmentRecipes?.() === true || (facts.setupCommand?.trim() ?? "").length > 0
        ? ["copy", "setup"]
        : ["copy"];
    try {
      markFirstRunPending(deps, identity.path, ticketId, steps);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return fail(deps, ticketId, "create", message, message);
    }
    const addArgs = reuseBranch
      ? [identity.path, branch]
      : ["-b", branch, identity.path, base!.startPoint];
    try {
      // The repository's turn wraps the MUTATION, not the decision (VC-389).
      // `reconcile` read the listing outside it, so `prune` can be one tick
      // stale by the time the turn comes — deliberately: holding the turn
      // across the reads would serialize every Session start in a project on
      // work that changes nothing. Staleness is safe in both directions here,
      // because `addWorktree` prunes and retries once when the add fails on a
      // record it did not expect, and a prune nobody needed is a no-op.
      const prune = reconciled.value.prune;
      await withRepositoryWorktreeTurn(facts.checkoutPath, () =>
        addWorktree(git, facts.checkoutPath, addArgs, prune),
      );
    } catch (caught) {
      // A timeout is reported as one: the stderr of a stopped add is git's own
      // "Preparing worktree" line and progress, which names no cause.
      const message =
        caught instanceof GitError && caught.timedOut
          ? caught.message
          : caught instanceof GitError && caught.stderr.trim()
            ? caught.stderr.trim()
            : "git worktree add failed";
      return fail(deps, ticketId, "create", message, stderrOf(caught));
    }
  }

  // Copy step — transport git-uncarried local files. CREATION ONLY: the walk
  // visits the whole Main checkout (include.ts's performance note), and running
  // it on every reuse boot was the multisecond stall VC-16's follow-up comment
  // reports — a ready worktree already carries its local files, and a new `.env`
  // in the Main checkout transports on the next worktree CREATION, not on every
  // Session boot into an old one. "Creation" is the durable pending record, not
  // this call: a creation whose copy failed owes it to the Retry, which
  // reconciles to `already-present`.
  deps.onPhase?.(ticketId, "copying");
  try {
    if (isFirstRunPending(deps, identity.path, "copy")) {
      await copyIncludedFiles(facts.checkoutPath, identity.path);
      completeFirstRunCopy(deps, identity.path);
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return fail(deps, ticketId, "copy", message, message);
  }

  // Materialize the ticket's file attachments into the fresh worktree
  // (CONCEPT decision #19, issue #77 PR 2) — still within the "copying"
  // phase; there's no dedicated phase for this quick post-copy step. A
  // missing source file (row exists, bytes don't) throws with the
  // attachment's label, which becomes this stage's failure message.
  try {
    await deps.materializeAttachments?.(ticketId, identity.path);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return fail(deps, ticketId, "attachments", message, message);
  }

  // Persist identity (synchronous, after all git work) — emits `worktree_changed`.
  const baseBranch = base?.name ?? facts.baseBranch ?? null;
  const restamped =
    facts.worktreePath !== identity.path ||
    facts.branch !== branch ||
    facts.baseBranch !== baseBranch;
  try {
    deps.persistIdentity?.({ worktreePath: identity.path, branch, baseBranch });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return fail(deps, ticketId, "create", message, message);
  }

  // Read after every other step: the copy and attachments stages can fail,
  // and the setup a failed start owes is the Retry's to report. A record that
  // cannot be read fails the start rather than quietly owing nothing.
  let setupPending: boolean;
  try {
    setupPending = isFirstRunPending(deps, identity.path, "setup");
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return fail(deps, ticketId, "create", message, message);
  }
  deps.onPhase?.(ticketId, "ready");
  const result: WorktreeIdentity = {
    worktreePath: identity.path,
    branch,
    baseBranch,
  };
  return ok({ identity: result, created, restamped, setupPending });
}

/**
 * Ensures the ticket's worktree exists and is prepared, returning its identity,
 * whether THIS call created it, and whether its setup run is still owed (see
 * {@link EnsureOutcome}). Idempotent and single-flight: a concurrent call for
 * the same ticket joins the in-flight promise instead of running the pipeline
 * twice.
 */
export function ensure(
  deps: WorktreePorts,
  ticketId: string,
): Promise<WorktreeResult<EnsureOutcome>> {
  const existing = inflight.get(ticketId);
  // A joiner shares the leader's work. Only the leader reports `created` as it
  // happened; every joiner sees `created: false`. Both may see `setupPending`
  // — the claim, not this flag, is what makes the setup run exactly once.
  if (existing) return existing.then(asJoiner);
  const run = runEnsure(deps, ticketId).finally(() => inflight.delete(ticketId));
  inflight.set(ticketId, run);
  return run;
}

/** Masks `created` to false on a joined outcome; leaves the leader's identity intact. */
function asJoiner(result: WorktreeResult<EnsureOutcome>): WorktreeResult<EnsureOutcome> {
  if (!result.ok || !result.value.created) return result;
  return ok({ ...result.value, created: false });
}

/**
 * The same reconcile/add/copy/attachments pipeline with explicit facts and no
 * board reads or writes. Cloud callers reserve the path before entering it.
 * Flights are path-scoped across port objects: the Session and inbox services
 * share one physical checkout even when they use different query ports.
 */
const explicitFlights = new Map<string, Promise<WorktreeResult<EnsureOutcome>>>();
export function ensureExplicit(
  deps: EnsureExplicitPorts,
  facts: EnsureFacts,
): Promise<WorktreeResult<EnsureOutcome>> {
  const target =
    facts.worktreePath ??
    resolveWorktreeIdentity({
      home: homeDir(deps),
      projectPath: facts.checkoutPath,
      projectId: facts.projectId,
      displayId: facts.displayId,
      title: facts.title,
      persistedPath: null,
      persistedBranch: facts.branch,
    }).path;
  const key = `${canonicalize(facts.checkoutPath)}\0${facts.ticketId}\0${canonicalize(target)}`;
  const existing = explicitFlights.get(key);
  if (existing) return existing.then(asJoiner);
  const run = runEnsureExplicit(deps, facts).finally(() => explicitFlights.delete(key));
  explicitFlights.set(key, run);
  return run;
}

/**
 * Board-free cache eviction for runner-owned paths. No force and no raw folder
 * delete fallback: forgotten/unverifiable directories always stay untouched.
 * The registry keeps the path so another materialization can recreate it.
 */
export async function reclaimExplicit(
  ports: {
    gitAsync: RunGitAsync;
    busySites?: BusyWorktreeSites;
    releaseAgentSites?: (directory: string) => Promise<AgentSiteReleaseReport>;
  },
  input: { checkoutPath: string; worktreePath: string; baseBranch: string | null; keep: boolean },
): Promise<WorktreeResult<void>> {
  if (input.keep) return err("This working copy is kept.");
  if (canonicalize(input.checkoutPath) === canonicalize(input.worktreePath))
    return err("The main checkout cannot be reclaimed.");
  if (!ports.busySites) return err("Worktree activity is unavailable; refusing to reclaim.");
  const lease = acquireDeletionLease(input.worktreePath);
  if (!lease) return err(UNDER_DELETION_REFUSAL);
  try {
    if (!existsSync(input.worktreePath)) return ok(undefined);
    const busy = busySiteWithin(input.worktreePath, await ports.busySites(input.worktreePath));
    if (busy) return err(busyRefusal(busy));
    return await withRepositoryWorktreeTurn(input.checkoutPath, async () => {
      const listing = parseWorktreeList(
        await ports.gitAsync(["worktree", "list", "--porcelain"], input.checkoutPath),
      );
      if (!listing.some((entry) => canonicalize(entry.path) === canonicalize(input.worktreePath)))
        return err("Git no longer tracks this working copy; refusing to delete the folder.");
      const dirty = await isWorktreeDirtyAsync(ports.gitAsync, {
        worktreePath: input.worktreePath,
        branch: null,
        baseBranch: input.baseBranch,
        worktreeEntries: listing,
      });
      if (dirty.dirty)
        return err(`This working copy cannot be reclaimed: ${dirty.reason ?? "dirty"}.`);
      await ports.releaseAgentSites?.(input.worktreePath);
      await ports.gitAsync(["worktree", "remove", input.worktreePath], input.checkoutPath);
      return ok(undefined);
    });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  } finally {
    lease.release();
  }
}
