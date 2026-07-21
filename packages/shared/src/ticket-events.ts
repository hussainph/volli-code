/**
 * The append-only ticket event log (`ticket_events` table, migration 001):
 * every mutation records one event in the same transaction as its row
 * write. `actor` is `"user"` for everything today; `"agent"`/`"automation"`
 * arrive with the volli CLI.
 */

import type { SessionLaunchKind, SessionPlacement } from "./session";
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
  // Sessions & comments (ticket-detail-mvp #18/#22): a comment's body lives
  // in `ticket_comments` (`ticket-comment.ts`) — this event only makes it
  // discoverable from the event log without duplicating it. Session events
  // are recorded from main on PTY boot/exit.
  "commented",
  "session_started",
  "session_ended",
  // Worktree identity (ticket-detail-mvp #14 vision anchor): settable now,
  // automated later — `from`/`to` snapshot the ticket's worktree identity
  // fields (`ticket.ts`) around the change.
  "worktree_changed",
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
  // Session lifecycle signal (`session done|blocked`, volli CLI): the agent
  // reporting its own outcome on the ticket it's working. Written with an
  // `automation` actor; `reason` becomes the Needs Review badge when the loop
  // milestone lands.
  "session_signal",
  // Attachments (`ticket_attachments`, migration 011, issue #77): spec
  // material — a file or URL — attached to a ticket. Mirrors `commented`'s
  // shape (the attachment itself lives in `ticket_attachments`, `label` here
  // is just enough for the event log to read without a join).
  "attachment_added",
  "attachment_removed",
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
 * (`??`), never in the numstat output, so the working-tree diff can list it with
 * null counts rather than dropping it.
 */
export interface DiffFileStat {
  path: string;
  insertions: number | null;
  deletions: number | null;
  untracked: boolean;
}

/**
 * A worktree diff summary (Done-flow `diff.ts`): the per-file breakdown plus
 * repo-wide totals. `insertions`/`deletions` sum only the non-null (text) files
 * — binary and untracked entries carry null counts and never contribute to the
 * totals, so the totals stay honest line counts.
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
  | {
      kind: "session_started";
      sessionId: string;
      title: string;
      /** Optional for records written before migration 006. */
      launchKind?: SessionLaunchKind;
      /** Optional for records written before migration 006. */
      placement?: SessionPlacement;
      /** Present only when the session actually launched an agent harness. */
      harnessId?: HarnessId;
    }
  | { kind: "session_ended"; sessionId: string }
  | { kind: "worktree_changed"; from: WorktreeIdentity; to: WorktreeIdentity }
  | { kind: "worktree_failed"; stage: WorktreeFailureStage; stderr: string }
  | { kind: "worktree_committed"; message: string }
  | { kind: "pr_opened"; url: string }
  | { kind: "pr_merged"; url: string }
  | { kind: "session_signal"; signal: "done" | "blocked"; reason: string | null }
  | { kind: "attachment_added"; attachmentId: string; label: string }
  | { kind: "attachment_removed"; attachmentId: string; label: string };

/**
 * The `ensure`-pipeline stage a `worktree_failed` event aborted at
 * (worktree-support §3): `create` covers identity resolution, reconciliation,
 * base resolution and `git worktree add`; `copy` the `.worktreeinclude` step;
 * `setup` the post-spawn sentinel-gated setup command. The Done-flow stages
 * (done-flow §8) extend it with the manual rail affordances: `commit` (the
 * one-click safety-net commit refused/errored), `push` (a rejected or
 * remote-less `git push`), and `pr` (a `gh` draft-PR create that failed the
 * taxonomy — not-installed, not-authenticated, and friends).
 */
export type WorktreeFailureStage = "create" | "copy" | "setup" | "commit" | "push" | "pr";

/**
 * The stable prefix a non-forced worktree removal's DIRTY refusal starts with
 * (main's `worktree/remove.ts`). The remove dialog matches on it to decide
 * whether an error may escalate to the explicit force step — any OTHER failure
 * (git broke, path vanished) must never offer "discard work" as the remedy.
 */
export const WORKTREE_DIRTY_REFUSAL_PREFIX = "Worktree has uncommitted work";

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
