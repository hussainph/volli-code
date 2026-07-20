/**
 * The Done-flow push + draft-PR composition (done-flow §"Persistence, IPC,
 * events"). Where `net.ts` owns the individual async verbs (fetch/push/gh) and
 * their taxonomy, THIS is the orchestration the rail's "Push & create draft PR"
 * button drives — the one place that sequences them, maps a `gh` failure kind
 * to a friendly sentence, and persists the durable `pr_url` truth (#5) with a
 * `pr_opened` History event.
 *
 * The ensure.ts §5 discipline holds: all long-running work (fetch, push, `gh`)
 * runs FIRST; the synchronous DB write (`pr_url` + the event) lands last, in one
 * transaction, never straddling a network round-trip. Re-entry is honest — an
 * already-open PR is re-discovered and returned, and `pr_opened` is recorded
 * only when the ticket's stored `pr_url` was previously empty, so re-clicking
 * never spams a duplicate History line.
 *
 * `commitTicketRemaining` is the sibling wrapper for the one-click commit safety
 * net: it loads identity, calls `commitRemaining` (`commit.ts`), and records the
 * `worktree_committed` / `worktree_failed` event around it.
 */
import {
  displayTicketId,
  trimWorktreeFailureStderr,
  type TicketEventActor,
  type TicketEventPayload,
} from "@volli/shared";

import { recordTicketEvent } from "../db/events-repo";
import { getProjectById } from "../db/projects-repo";
import { getTicketRow, updateTicketFields } from "../db/tickets-repo";
import { resolveBaseBranch } from "./base";
import { commitRemaining } from "./commit";
import {
  fetchBase,
  ghCreateDraftPr,
  ghFindPr,
  pushBranch,
  type GhFailure,
  type RunNet,
} from "./net";
import { err, ok, type WorktreeDeps, type WorktreeResult } from "./types";

/**
 * The publish flow's deps: the standard worktree bundle plus the async network
 * runner (`net.ts`'s injectable seam). Parallel to {@link WorktreeDeps} rather
 * than folded into it because only the network verbs need it — the rest of the
 * module stays `RunNet`-free.
 */
export interface PublishDeps extends WorktreeDeps {
  net: RunNet;
}

/** The success value of {@link publishTicketBranch}: the PR url, and whether it pre-existed. */
export interface PublishOutcome {
  url: string;
  /** `true` when the PR was re-discovered (already open), `false` when this call created it. */
  existing: boolean;
}

// These are user-clicked rail actions (done-flow §"Persistence, IPC, events"),
// so their events are attributed to the user — matching how ticket-commands.ts
// records IPC-driven mutations.
const USER_ACTOR: TicketEventActor = { kind: "user" };

/** The resolved identity a publish/commit needs — pulled once, up front. */
interface TicketIdentity {
  worktreePath: string;
  branch: string;
  baseBranch: string | null;
  displayId: string;
  title: string;
  body: string;
  /** The ticket's currently-stored PR url (drives the no-duplicate-event guard). */
  storedPrUrl: string | null;
}

/**
 * Loads and validates the ticket's worktree identity. Errs early (before any
 * network work) when the ticket, its project, or a materialized worktree is
 * missing — the rail buttons should never have offered the action, but main
 * re-checks rather than trusting a stale client.
 */
function loadIdentity(deps: PublishDeps, ticketId: string): WorktreeResult<TicketIdentity> {
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket) return err("Unknown ticket");
  const project = getProjectById(deps.db, ticket.project_id);
  if (!project) return err("Unknown project");
  if (!ticket.worktree_path || !ticket.branch) {
    return err("This ticket has no worktree yet, so there is nothing to push.");
  }
  // Same offline precedence chain ensure/base.ts resolves from, so the PR base
  // matches the branch's actual fork point when `ticket.base_branch` is null.
  const baseBranch =
    ticket.base_branch ??
    resolveBaseBranch(deps.git, {
      projectPath: project.path,
      ticketBaseBranch: ticket.base_branch,
      projectBaseBranch: project.baseBranch ?? null,
    })?.name ??
    null;
  return ok({
    worktreePath: ticket.worktree_path,
    branch: ticket.branch,
    baseBranch,
    displayId: displayTicketId(project.ticketPrefix, ticket.ticket_number),
    title: ticket.title,
    body: ticket.body,
    storedPrUrl: ticket.pr_url,
  });
}

/** Records a `worktree_failed` event for the given Done-flow stage, trimmed like ensure.ts. */
function recordFailure(
  deps: PublishDeps,
  ticketId: string,
  stage: "commit" | "push" | "pr",
  stderr: string,
): void {
  recordTicketEvent(
    deps.db,
    ticketId,
    { kind: "worktree_failed", stage, stderr: trimWorktreeFailureStderr(stderr) },
    Date.now(),
    USER_ACTOR,
  );
}

/** Maps a `gh` failure taxonomy kind to the sentence the rail surfaces (done-flow §8). */
function friendlyGhMessage(failure: GhFailure): string {
  switch (failure.kind) {
    case "not-installed":
      return "GitHub CLI (gh) is not installed or not on your PATH. Install it from https://cli.github.com, then try again.";
    case "not-authenticated":
      return "You are not signed in to the GitHub CLI. Run `gh auth login`, then try again.";
    case "no-remote":
      return "No GitHub repository is configured for this worktree. Add a GitHub remote, then try again.";
    case "network":
      return "Could not reach GitHub. Check your connection, then try again.";
    case "pr-exists":
      return "A pull request already exists for this branch, but its URL could not be read.";
    case "unknown":
      // No taxonomy match — the real gh stderr is the most useful thing to show.
      return failure.message;
  }
}

/**
 * Persists `pr_url` and (conditionally) records `pr_opened`, in one synchronous
 * transaction — the ensure.ts §5 "DB write last, never straddling the network"
 * discipline. `recordOpened` is false on a re-entry that only re-discovered an
 * already-stored PR, so History gains no duplicate line.
 */
function persistPr(deps: PublishDeps, ticketId: string, url: string, recordOpened: boolean): void {
  const now = Date.now();
  const write = deps.db.transaction(() => {
    updateTicketFields(deps.db, ticketId, { prUrl: url }, now);
    if (recordOpened) {
      const payload: TicketEventPayload = { kind: "pr_opened", url };
      recordTicketEvent(deps.db, ticketId, payload, now, USER_ACTOR);
    }
  });
  write();
}

/**
 * Records the outcome of re-discovering an EXISTING PR: persists its url (in
 * case it drifted) and records `pr_opened` only when the stored url was empty.
 */
function returnExisting(
  deps: PublishDeps,
  ticketId: string,
  storedPrUrl: string | null,
  url: string,
): WorktreeResult<PublishOutcome> {
  persistPr(deps, ticketId, url, storedPrUrl === null || storedPrUrl.length === 0);
  return ok({ url, existing: true });
}

/**
 * Pushes the ticket's branch and opens (or re-discovers) its draft PR, then
 * persists `pr_url` + a `pr_opened` event. The flow, per done-flow §8:
 *   fetch base (best-effort) → push (fatal on reject) → find existing PR →
 *   else create draft PR (pr-exists falls back to one more find) → persist.
 */
export async function publishTicketBranch(
  deps: PublishDeps,
  ticketId: string,
): Promise<WorktreeResult<PublishOutcome>> {
  const loaded = loadIdentity(deps, ticketId);
  if (!loaded.ok) return loaded;
  const identity = loaded.value;

  // (b) fetch — BEST-EFFORT. A failure degrades to stale-local info (§3); it is
  // recorded nowhere and never blocks the push.
  await fetchBase(deps.net, {
    worktreePath: identity.worktreePath,
    baseBranch: identity.baseBranch,
  });

  // (c) push — FATAL. A rejection (remote moved) or missing remote is the user's
  // to resolve; record it and stop before touching `gh`.
  const pushed = await pushBranch(deps.net, {
    worktreePath: identity.worktreePath,
    branch: identity.branch,
  });
  if (!pushed.ok) {
    recordFailure(deps, ticketId, "push", pushed.error);
    return err(pushed.error);
  }

  // (d) find existing — a re-entry (the branch already has a PR) short-circuits
  // to it rather than erroring. A find failure falls through to create, which
  // produces the definitive, taxonomized result.
  const found = await ghFindPr(deps.net, {
    worktreePath: identity.worktreePath,
    branch: identity.branch,
  });
  if (found.ok && found.value.url !== null) {
    return returnExisting(deps, ticketId, identity.storedPrUrl, found.value.url);
  }

  // (e) create — needs a base. If none resolved, we can go no further.
  if (!identity.baseBranch) {
    const message = "Could not resolve a base branch to open the pull request against.";
    recordFailure(deps, ticketId, "pr", message);
    return err(message);
  }
  const body = `${identity.body}\n\n---\nOpened from Volli ticket ${identity.displayId}.`;
  const created = await ghCreateDraftPr(deps.net, {
    worktreePath: identity.worktreePath,
    base: identity.baseBranch,
    branch: identity.branch,
    title: `${identity.displayId}: ${identity.title}`,
    body,
  });
  if (created.ok) {
    persistPr(deps, ticketId, created.value.url, true);
    return ok({ url: created.value.url, existing: false });
  }

  // A `pr-exists` here means a PR was created between our find and our create
  // (or the find failed above) — answer it with one more find, never an error
  // dialog. Any other find result falls through to the friendly failure below.
  if (created.failure.kind === "pr-exists") {
    const refind = await ghFindPr(deps.net, {
      worktreePath: identity.worktreePath,
      branch: identity.branch,
    });
    if (refind.ok && refind.value.url !== null) {
      return returnExisting(deps, ticketId, identity.storedPrUrl, refind.value.url);
    }
  }

  recordFailure(deps, ticketId, "pr", created.failure.message);
  return err(friendlyGhMessage(created.failure));
}

/**
 * The one-click "commit remaining work" wrapper (done-flow §6): loads identity,
 * runs `commitRemaining`, and records `worktree_committed` on success or
 * `worktree_failed { stage: "commit" }` on refusal/error. No network, so it
 * takes the plain {@link WorktreeDeps} — the git seam is enough.
 */
export function commitTicketRemaining(
  deps: WorktreeDeps,
  ticketId: string,
): WorktreeResult<{ message: string }> {
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket) return err("Unknown ticket");
  const project = getProjectById(deps.db, ticket.project_id);
  if (!project) return err("Unknown project");
  if (!ticket.worktree_path) {
    return err("This ticket has no worktree yet, so there is nothing to commit.");
  }
  const displayId = displayTicketId(project.ticketPrefix, ticket.ticket_number);
  const result = commitRemaining(deps.git, {
    worktreePath: ticket.worktree_path,
    displayId,
  });
  const now = Date.now();
  if (!result.ok) {
    recordTicketEvent(
      deps.db,
      ticketId,
      { kind: "worktree_failed", stage: "commit", stderr: trimWorktreeFailureStderr(result.error) },
      now,
      USER_ACTOR,
    );
    return result;
  }
  recordTicketEvent(
    deps.db,
    ticketId,
    { kind: "worktree_committed", message: result.value.message },
    now,
    USER_ACTOR,
  );
  return result;
}
