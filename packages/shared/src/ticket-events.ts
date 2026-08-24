/**
 * The append-only ticket event log (`ticket_events` table, migration 001):
 * every mutation records one event in the same transaction as its row
 * write. `actor` is `"user"` for everything today; `"agent"`/`"automation"`
 * arrive with the volli CLI.
 */

import type { HarnessId, TicketPriority, TicketStatus } from "./ticket";

export const TICKET_EVENT_KINDS = [
  "created",
  "status_changed",
  "priority_changed",
  "harness_changed",
  "retitled",
  "body_edited",
  "labels_changed",
  // Lifecycle: leaving/returning to the board. Archiving is reversible and
  // retains everything (event log, transcripts, branch, PR — CONCEPT #16/#92);
  // the ticket's `status` is untouched, so no from/to is recorded. Hard delete
  // is the only destructive act and records nothing — the row and its events
  // vanish together in the FK cascade.
  "archived",
  "unarchived",
  // Comments live in `ticket_comments` (`ticket-comment.ts`); this fact only
  // makes one discoverable from planner history without duplicating it.
  "commented",
  // Worktree identity (ticket-detail-mvp #14 vision anchor): settable now,
  // automated later — `from`/`to` snapshot the ticket's worktree identity
  // fields (`ticket.ts`) around the change.
  "worktree_changed",
  // Worktree scoping (VC-16): the ticket's isolated-worktree ↔ Main-checkout
  // choice flipped, before any worktree materialized — the command layer
  // refuses the flip once `worktree_path` is stamped.
  "worktree_scope_changed",
  // Worktree creation failure (worktree-support §3/§8): the `ensure` pipeline
  // aborted at `create`/`copy`/`setup`. Records the failing `stage` and a
  // trimmed `stderr` excerpt so the History feed shows the real git error
  // rather than a swallowed toast. The session never falls back to the main
  // checkout — the worktree toggle is the only sanctioned path there (#38).
  "worktree_failed",
  // Done-flow (done-flow §"Persistence, IPC, events"): the two manual rail
  // affordances that touch git. `worktree_committed` records the one-click
  // "commit remaining work" safety net's fixed-message commit (#14's explicit
  // exception to "the app never commits"); `pr_opened` records the push +
  // draft-PR flow reaching a durable PR url — written exactly once per branch
  // (a re-entry that only re-discovers an existing PR does not spam a second).
  "worktree_committed",
  "pr_opened",
  // Retention merge-watch (CONCEPT #16, issue #76): the background poll's FIRST
  // observation that the ticket's PR merged. Written with an `automation` actor
  // (no session — the system-level watch), exactly once per branch (a dedup set
  // guards re-firing), and paired with the single native "PR merged" notification.
  "pr_merged",
  // Retention reclaim (VC-113): the background watch removed a Done ticket's
  // worktree DIRECTORY after it sat clean and finished for the whole retention
  // window. Written with an `automation` actor, and paired with the
  // `worktree_changed` the removal itself records — that one says the pointer
  // moved, this one says WHY, and names the branch the deletion kept. A
  // deletion nobody can account for is how VC-113 read as lost work.
  "worktree_reclaimed",
  // Attachments (`ticket_attachments`, migration 011, issue #77): spec
  // material — a file or URL — attached to a ticket. Mirrors `commented`'s
  // shape (the attachment itself lives in `ticket_attachments`, `label` here
  // is just enough for the event log to read without a join).
  "attachment_added",
  "attachment_removed",
  // A structured chat Session started on this ticket (VC-13). Written in the
  // shared Ticket Session creation path, so a start from the app's own UI and
  // one from the CLI socket both land in planner history with door-derived
  // provenance (the actor). The legacy terminal-era kind of this name was
  // purged in migration 018, so re-minting it is clean. The payload cites the
  // started Session; surfaces shorten the id before showing it (full Session
  // UUIDs never cross the socket).
  "session_started",
] as const;

export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];

/**
 * A ticket's worktree identity, as snapshotted by `worktree_changed`. Mirrors
 * the `Ticket.worktreePath`/`branch`/`baseBranch` fields (`ticket.ts`).
 */
export interface WorktreeIdentity {
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
}

/**
 * One file's line-delta in a {@link DiffStat} (Done-flow `diff.ts`). Crosses the
 * IPC boundary (main computes it, the Details rail renders it), so it lives in
 * shared. `insertions`/`deletions` are `null` for binary files — `git diff
 * --numstat` prints `-\t-` for them, and inventing a `0` would read as "no
 * change". `untracked` marks a file present only in `git status --porcelain`
 * (`??`), never in numstat output. A direct working-tree diff lists it with
 * unknown counts; the composed Change Set counts readable text against an empty file.
 */
export interface DiffFileStat {
  path: string;
  insertions: number | null;
  deletions: number | null;
  untracked: boolean;
}

/**
 * A worktree diff summary (Done-flow `diff.ts`): the per-file breakdown plus
 * repo-wide totals. `insertions`/`deletions` sum only files with known text
 * counts. Binary files and paths that could not be read carry null counts and
 * never contribute, so the totals stay honest line counts.
 */
export interface DiffStat {
  files: DiffFileStat[];
  insertions: number;
  deletions: number;
}

export type TicketEventPayload =
  | { kind: "created"; status: TicketStatus; title: string }
  | { kind: "status_changed"; from: TicketStatus; to: TicketStatus }
  | { kind: "priority_changed"; from: TicketPriority; to: TicketPriority }
  | { kind: "harness_changed"; from: HarnessId; to: HarnessId }
  | { kind: "retitled"; from: string; to: string }
  | { kind: "body_edited" }
  | { kind: "labels_changed"; added: string[]; removed: string[] }
  | { kind: "archived" }
  | { kind: "unarchived" }
  | { kind: "commented"; commentId: string }
  | { kind: "worktree_changed"; from: WorktreeIdentity; to: WorktreeIdentity }
  /** The ticket's worktree scoping flipped (isolated worktree ↔ Main checkout) before any worktree existed. */
  | { kind: "worktree_scope_changed"; from: boolean; to: boolean }
  | { kind: "worktree_failed"; stage: WorktreeFailureStage; stderr: string }
  | { kind: "worktree_committed"; message: string }
  | { kind: "pr_opened"; url: string }
  | { kind: "pr_merged"; url: string }
  /**
   * The retention watch reclaimed the worktree directory (VC-113). `branch` is
   * what survived it — the checkout can be put back on that branch at any time,
   * which is what makes the reclaim a cache eviction rather than a destruction.
   * `daysInDone` is the dwell that earned it, so the History line can say what
   * rule fired instead of leaving the reader to infer one.
   */
  | { kind: "worktree_reclaimed"; branch: string | null; daysInDone: number }
  | { kind: "attachment_added"; attachmentId: string; label: string }
  | { kind: "attachment_removed"; attachmentId: string; label: string }
  | { kind: "session_started"; sessionId: string };

/**
 * The `ensure`-pipeline stage a `worktree_failed` event aborted at
 * (worktree-support §3): `create` covers identity resolution, reconciliation,
 * base resolution and `git worktree add`; `copy` the `.worktreeinclude` step;
 * `attachments` the post-copy attachment-materialize step (CONCEPT decision
 * #19, issue #77 PR 2 — copying a ticket's file attachments into the fresh
 * worktree's `.volli/attachments/`); `setup` the post-spawn sentinel-gated
 * setup command. The Done-flow stages (done-flow §8) extend it with the
 * manual rail affordances: `commit` (the one-click safety-net commit
 * refused/errored), `push` (a rejected or remote-less `git push`), and `pr`
 * (a `gh` draft-PR create that failed the taxonomy — not-installed,
 * not-authenticated, and friends).
 */
export type WorktreeFailureStage =
  | "create"
  | "copy"
  | "attachments"
  | "setup"
  | "commit"
  | "push"
  | "pr";

/**
 * The stable prefix a non-forced worktree removal's DIRTY refusal starts with
 * (main's `worktree/remove.ts`). The remove dialog matches on it to decide
 * whether an error may escalate to the explicit force step — any OTHER failure
 * (git broke, path vanished) must never offer "discard work" as the remedy.
 */
export const WORKTREE_DIRTY_REFUSAL_PREFIX = "Worktree has uncommitted work";

/**
 * The stable prefix a removal's UNVERIFIABLE refusal starts with (VC-113): git
 * no longer tracks the folder, so its contents can't be read at all. It escalates
 * to the same confirm step {@link WORKTREE_DIRTY_REFUSAL_PREFIX} does, and it is
 * a separate sentence because that one states a fact Volli cannot establish here
 * — a dialog that names the wrong cause is how people learn to stop reading them.
 */
export const WORKTREE_UNVERIFIABLE_REFUSAL_PREFIX = "Volli can't check what's inside this worktree";

/**
 * The stable sentence every worktree read answers with when the ticket still
 * points at a checkout that is no longer on disk (main's `worktree/read.ts`
 * `missing-on-disk` arm). The rail matches on it to offer RECREATE instead of
 * Retry: a directory somebody deleted is not a transient read failure, and a
 * Retry that can only fail again is what made a swept worktree read as lost
 * work (VC-113). The branch and its commits survive in git, so the recovery is
 * real — `ensure` puts the checkout back where it was, on the branch it was on.
 */
export const WORKTREE_MISSING_ON_DISK = "This ticket's worktree folder is missing.";

/**
 * Upper bound on a stored `worktree_failed` `stderr` excerpt. Git can emit a
 * lot of progress noise on stderr; the actual error line is at the very end,
 * so {@link trimWorktreeFailureStderr} keeps the TRAILING slice rather than the
 * head. Kept here (not in main) so the invariant travels with the payload type.
 */
export const MAX_WORKTREE_FAILURE_STDERR = 2000;

/** Trims `stderr` to the trailing {@link MAX_WORKTREE_FAILURE_STDERR} characters. */
export function trimWorktreeFailureStderr(stderr: string): string {
  return stderr.length <= MAX_WORKTREE_FAILURE_STDERR
    ? stderr
    : stderr.slice(stderr.length - MAX_WORKTREE_FAILURE_STDERR);
}

export type TicketEventActorKind = "user" | "session" | "automation";

export interface TicketEventActorContext {
  sessionId: string;
  ticketId: string | null;
}

// `session` always carries its context; `automation` may (a session-driven
// automation) or may NOT (a system-level automation — the worktree ensure/
// remove/sweep pipeline has no session and stores as a bare token, like `user`).
// Each `kind` lives in exactly one arm so it stays a clean discriminant.
export type TicketEventActor =
  | { kind: "user" }
  | ({ kind: "session" } & TicketEventActorContext)
  | ({ kind: "automation" } & Partial<TicketEventActorContext>);

export interface TicketEvent {
  id: string;
  ticketId: string;
  actor: TicketEventActorKind;
  /** Present for session/automation actors; omitted by legacy callers constructing fixtures. */
  actorContext?: TicketEventActorContext | null;
  /** Epoch milliseconds. */
  createdAt: number;
  payload: TicketEventPayload;
}

/**
 * The latest durable Session outcome for one ticket, denormalized for the
 * sidebar's batched attention read. It crosses the existing IPC seam without
 * making immutable Session facts planner history.
 */
export interface LatestSessionSignal {
  ticketId: string;
  sessionId: string | null;
  signal: "done" | "blocked";
  reason: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
}

/**
 * When one of a project's non-archived tickets entered its CURRENT status —
 * one batched read backing the sidebar. `enteredAt` is the `created_at` of
 * the ticket's newest `status_changed` event; a same-column reorder writes no
 * event, so this stays stable across reorders. Falls back to the ticket's own
 * `createdAt` when it has never changed status (born into its current column).
 */
export interface TicketStatusEntry {
  ticketId: string;
  status: TicketStatus;
  /** Epoch milliseconds. */
  enteredAt: number;
}
