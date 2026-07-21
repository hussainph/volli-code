/**
 * The `ensure` pipeline (worktree-support §3): the ONE seam that materializes a
 * ticket's execution state, triggered by session boot before the PTY spawns. It
 * is idempotent and SINGLE-FLIGHT per ticket — concurrent callers (kickoff and
 * `+` racing) join one in-flight run rather than duplicating `git worktree add`.
 *
 * Order (git first, DB write last — DB writes never straddle long-running git):
 *   resolve identity → reconcile → resolve base → git worktree add → copy step
 *   → materialize attachments (CONCEPT decision #19, issue #77 PR 2) →
 *   persist identity (emits `worktree_changed`) → phase `ready`.
 *
 * On failure at any stage: phase → `failed`, a `worktree_failed` ticket event
 * with the stage + trimmed stderr, and a typed error Result the caller toasts —
 * the session NEVER silently falls back to the main checkout (#38). Setup-command
 * execution is deliberately NOT here: it runs in the PTY after spawn (`setup.ts`
 * builds/parses its sentinel), so `ensure` ends at `ready` with the identity.
 */
import {
  displayTicketId,
  trimWorktreeFailureStderr,
  type TicketEventActor,
  type WorktreeIdentity,
} from "@volli/shared";

import { materializeAttachments } from "../attachment-materialize";
import { recordTicketEvent } from "../db/events-repo";
import { getProjectById } from "../db/projects-repo";
import { getTicketRow } from "../db/tickets-repo";
import { updateTicketFieldsCommand } from "../ticket-commands";
import { refExists, resolveBaseBranch } from "./base";
import { GitError, stderrOf } from "./git";
import { homeDir } from "./home";
import { resolveWorktreeIdentity } from "./identity";
import { copyIncludedFiles } from "./include";
import { setPhase } from "./phase";
import { reconcile } from "./reconcile";
import { err, ok, type RunGit, type WorktreeDeps, type WorktreeResult } from "./types";

/**
 * The success value of `ensure`: the resolved identity plus whether THIS run
 * actually created the worktree on disk (`git worktree add` ran) versus found
 * it already present. `created` is the setup-command gate — the setup command
 * must run exactly once, for a freshly-materialized worktree only, so a session
 * booting into an existing worktree never re-runs it (worktree-support §6).
 */
export interface EnsureOutcome {
  identity: WorktreeIdentity;
  created: boolean;
}

/** Concurrent `ensure(ticketId)` calls join the same promise; the entry clears on settle. */
const inflight = new Map<string, Promise<WorktreeResult<EnsureOutcome>>>();

// System-driven, no session: these mutations are attributed to automation.
const SYSTEM_ACTOR: TicketEventActor = { kind: "automation" };

type Stage = "create" | "copy" | "attachments";

/** Records the failure event + phase, returns the typed error Result. */
function fail(
  deps: WorktreeDeps,
  ticketId: string,
  stage: Stage,
  message: string,
  stderr: string,
): WorktreeResult<EnsureOutcome> {
  setPhase(ticketId, "failed", deps.onPhase);
  recordTicketEvent(
    deps.db,
    ticketId,
    { kind: "worktree_failed", stage, stderr: trimWorktreeFailureStderr(stderr) },
    Date.now(),
    SYSTEM_ACTOR,
  );
  return err(message);
}

/** Runs `git worktree add`, pruning first if reconcile asked, and retrying ONCE after a prune on failure. */
function addWorktree(
  git: RunGit,
  projectPath: string,
  addArgs: readonly string[],
  prune: boolean,
): void {
  const runAdd = (): void => {
    git(["worktree", "add", ...addArgs], projectPath);
  };
  if (prune) git(["worktree", "prune"], projectPath);
  try {
    runAdd();
  } catch (first) {
    // Vibe Kanban: a stale registration can defeat the first add; prune + one retry.
    try {
      git(["worktree", "prune"], projectPath);
      runAdd();
    } catch {
      throw first;
    }
  }
}

async function runEnsure(
  deps: WorktreeDeps,
  ticketId: string,
): Promise<WorktreeResult<EnsureOutcome>> {
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket) return err("Unknown ticket");
  const project = getProjectById(deps.db, ticket.project_id);
  if (!project) return err("Unknown project");

  setPhase(ticketId, "creating", deps.onPhase);

  const displayId = displayTicketId(project.ticketPrefix, ticket.ticket_number);
  const identity = resolveWorktreeIdentity({
    home: homeDir(deps),
    projectPath: project.path,
    projectId: project.id,
    displayId,
    title: ticket.title,
    persistedPath: ticket.worktree_path,
    persistedBranch: ticket.branch,
  });

  // Reconcile the collision matrix on canonicalized paths.
  const reconciled = reconcile(deps.git, {
    projectPath: project.path,
    worktreePath: identity.path,
    branch: identity.branch,
  });
  if (!reconciled.ok) return fail(deps, ticketId, "create", reconciled.error, reconciled.error);

  // Resolve base for stamping + (for a new branch) branching. Reusing an
  // existing ticket branch never resets it, so base is only structurally
  // required when we create the branch.
  const reuseBranch = refExists(deps.git, project.path, `refs/heads/${identity.branch}`);
  const base = resolveBaseBranch(deps.git, {
    projectPath: project.path,
    ticketBaseBranch: ticket.base_branch,
    projectBaseBranch: project.baseBranch ?? null,
  });
  if (!reuseBranch && !base) {
    const message = "Could not resolve a base branch to create the worktree from.";
    return fail(deps, ticketId, "create", message, message);
  }

  // Whether THIS run runs `git worktree add`; drives the setup-command gate.
  const created = reconciled.value.kind === "create";
  if (reconciled.value.kind === "create") {
    const addArgs = reuseBranch
      ? [identity.path, identity.branch]
      : ["-b", identity.branch, identity.path, base!.startPoint];
    try {
      addWorktree(deps.git, project.path, addArgs, reconciled.value.prune);
    } catch (caught) {
      const message =
        caught instanceof GitError && caught.stderr.trim()
          ? caught.stderr.trim()
          : "git worktree add failed";
      return fail(deps, ticketId, "create", message, stderrOf(caught));
    }
  }

  // Copy step — transport git-uncarried local files.
  setPhase(ticketId, "copying", deps.onPhase);
  try {
    copyIncludedFiles(project.path, identity.path);
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
    materializeAttachments(deps.db, deps.attachmentsRoot, ticketId, identity.path);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return fail(deps, ticketId, "attachments", message, message);
  }

  // Persist identity (synchronous, after all git work) — emits `worktree_changed`.
  const baseBranch = base?.name ?? ticket.base_branch ?? null;
  try {
    updateTicketFieldsCommand(
      deps.db,
      {
        ticketId,
        worktreePath: identity.path,
        branch: identity.branch,
        baseBranch,
      },
      { now: Date.now(), actor: SYSTEM_ACTOR },
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return fail(deps, ticketId, "create", message, message);
  }

  setPhase(ticketId, "ready", deps.onPhase);
  const result: WorktreeIdentity = {
    worktreePath: identity.path,
    branch: identity.branch,
    baseBranch,
  };
  return ok({ identity: result, created });
}

/**
 * Ensures the ticket's worktree exists and is prepared, returning its identity
 * plus whether THIS call created it (the setup-command gate — see {@link
 * EnsureOutcome}). Idempotent and single-flight: a concurrent call for the same
 * ticket joins the in-flight promise instead of running the pipeline twice.
 */
export function ensure(
  deps: WorktreeDeps,
  ticketId: string,
): Promise<WorktreeResult<EnsureOutcome>> {
  const existing = inflight.get(ticketId);
  // A joiner shares the leader's work but must NOT re-fire created-only side
  // effects (the setup command runs exactly once, for the run that actually
  // materialized the worktree). Only the leader reports `created` as it
  // happened; every joiner sees `created: false`.
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
