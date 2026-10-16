/**
 * The §4 reconciliation matrix — the proactive collision check run before any
 * `git worktree add`, on realpath-canonicalized paths throughout. It answers a
 * single question: is it safe to materialize the target worktree, does the add
 * need a `git worktree prune` first, and which branch does the worktree stand on?
 *
 * | DB says          | Disk says                                | Action                              |
 * |------------------|------------------------------------------|-------------------------------------|
 * | worktree at path | registered + dir present                 | already-present (idempotent no-op)  |
 * | worktree at path | registered, dir missing                  | prune, then recreate at same path   |
 * | no worktree      | empty dir exists, unregistered           | create (git accepts an empty dir)   |
 * | no worktree      | dir exists, looks like a worktree        | friendly orphan error, never rm -rf |
 * | no worktree      | dir exists, NOT a worktree               | friendly error, never blind rm -rf  |
 * | —                | branch checked out elsewhere             | hard fail, no --force               |
 * | —                | path on ANOTHER branch of the SAME ticket | adopt that branch (rows 1–2 apply) |
 * | —                | path on another ticket's/non-volli branch | hard fail, one recovery action     |
 * | —                | path in detached HEAD                    | hard fail, one recovery action      |
 *
 * "Branch checked out elsewhere" is detected up front (T3's proactive check)
 * from `git worktree list --porcelain`, which includes the main checkout, so
 * the main repo having the branch active is caught too. `git` failures here are
 * surfaced as errors, not swallowed — a reconcile that can't see the truth must
 * not green-light a destructive add.
 *
 * The decision names the branch the worktree stands on, which is the caller's
 * `branch` except when the ticket's own path is registered on ANOTHER branch of
 * the same ticket (`classifyTicketWorktreeCheckout`). That is the ticket's work,
 * moved — an agent in the worktree cut `volli/VC-297-scoped-history-reads`, or a
 * retitle drifted the slug the ticket would name — and refusing it left the
 * ticket unable to open any Session while the work sat in plain view. So the
 * checkout wins and `ensure` records it as the ticket's branch. Nothing is
 * checked out, reset or deleted to get there: adoption only changes which name
 * the ticket writes down.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { classifyTicketWorktreeCheckout } from "@volli/shared";

import { GitError, parseWorktreeList } from "./git";
import { canonicalize, samePath } from "./paths";
import { err, ok, type RunGitAsync, type WorktreeResult } from "./types";

/**
 * Whether the add may proceed, whether git metadata must be pruned first, and
 * the branch the worktree stands on (or will): the requested one, or the
 * same-ticket branch already checked out at the ticket's path (adopted).
 */
export type ReconcileDecision =
  | { kind: "already-present"; branch: string }
  | { kind: "create"; prune: boolean; branch: string };

/**
 * A directory that exists on disk but isn't registered is treated as an
 * orphaned worktree ONLY when it carries a `.git` file (linked worktrees have a
 * `.git` FILE, not a dir) — that's git's own fingerprint, so pruning + recreate
 * is safe. Anything else is someone's real directory and we refuse to touch it.
 */
function looksLikeWorktree(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

export async function reconcile(
  git: RunGitAsync,
  input: {
    projectPath: string;
    worktreePath: string;
    /** The branch the ticket records (or would name) for this worktree. */
    branch: string;
    /** The ticket's display id — what makes a checked-out branch this ticket's. */
    displayId: string;
  },
): Promise<WorktreeResult<ReconcileDecision>> {
  const targetCanonical = canonicalize(input.worktreePath);

  let listOutput: string;
  try {
    listOutput = await git(["worktree", "list", "--porcelain"], input.projectPath);
  } catch (caught) {
    const detail = caught instanceof GitError ? caught.stderr || caught.message : String(caught);
    return err(`Couldn't read the project's worktrees: ${detail}`);
  }
  const entries = parseWorktreeList(listOutput);

  const registered = entries.find((entry) => canonicalize(entry.path) === targetCanonical);
  const checkout = registered
    ? classifyTicketWorktreeCheckout({
        displayId: input.displayId,
        expectedBranch: input.branch,
        checkedOutBranch: registered.branch,
      })
    : null;
  // The branch this worktree stands on from here on. Only a same-ticket branch
  // replaces the requested one; every other mismatch is refused below.
  const branch = checkout?.kind === "adopt" ? checkout.branch : input.branch;

  // Proactive: our branch checked out anywhere BUT our own target path is a
  // hard collision — never resolved with `--force`. Measured against the branch
  // the worktree will actually stand on: once a same-ticket branch is adopted,
  // the recorded one being checked out elsewhere no longer collides with it.
  const branchElsewhere = entries.find(
    (entry) => entry.branch === branch && !samePath(entry.path, input.worktreePath),
  );
  if (branchElsewhere) {
    return err(
      `Branch ${branch} is already checked out at ${branchElsewhere.path}. ` +
        `Close or move that checkout before reusing this ticket's worktree.`,
    );
  }

  const diskExists = existsSync(input.worktreePath);

  if (registered) {
    // Git knows this path. Another ticket's branch, a branch outside the
    // `volli/` convention, or a DETACHED HEAD (branch === null) checked out
    // here is a collision we refuse rather than reset: whose work a foreign
    // branch carries cannot be known from here, and a detached HEAD has no
    // branch to record and would strand a Session's commits off any branch —
    // so both take the hard-fail path (never an auto-checkout).
    if (checkout?.kind === "foreign" || checkout?.kind === "detached") {
      const state =
        checkout.kind === "detached" ? "in detached HEAD state" : `on branch ${checkout.branch}`;
      return err(
        `A worktree already exists at ${input.worktreePath} ${state}, not ${input.branch}. ` +
          `Check out ${input.branch} there (or remove the worktree), then retry.`,
      );
    }
    if (diskExists) return ok({ kind: "already-present", branch });
    // Registered but the directory is gone — stale metadata; prune, then
    // recreate on the branch last checked out here, which is where the
    // ticket's latest work is.
    return ok({ kind: "create", prune: true, branch });
  }

  if (!diskExists) return ok({ kind: "create", prune: false, branch });

  // Dir exists but git doesn't know it. `git worktree add` accepts an existing
  // EMPTY directory but hard-fails on a non-empty one (verified empirically),
  // so a leftover populated dir can never be silently recreated over — and we
  // never blind-rm -rf on the user's behalf. The orphan sweep (or the user) is
  // the sanctioned cleanup path; distinguish the orphaned-worktree fingerprint
  // (a `.git` FILE) so the message says what the thing actually is.
  if (readdirSync(input.worktreePath).length === 0) {
    return ok({ kind: "create", prune: false, branch });
  }
  if (looksLikeWorktree(input.worktreePath)) {
    return err(
      `An orphaned worktree already exists at ${input.worktreePath} but git no longer tracks it. ` +
        `Remove it from Settings → Worktrees (or delete the folder), then retry.`,
    );
  }
  return err(
    `A directory already exists at ${input.worktreePath} and is not a Volli worktree. ` +
      `Move or remove it, then retry.`,
  );
}
