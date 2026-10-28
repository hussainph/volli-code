/**
 * Board events (v1): the immutable board history of a cloud project and the
 * activity feed's single source.
 *
 * Written only by backend mutations, in the same transaction as the row change
 * each one records; `seq` is a per-project total order allocated from the
 * project's counter document. Ids and the format are ours: nothing here names
 * a backend row id, so an export is the rows minus backend fields.
 *
 * Today's local ticket event kinds keep their names and payloads, with these
 * changes for the cloud:
 * - `worktree_changed` is retired on write (it carried an absolute path) and
 *   replaced by `working_copy_changed`. Migrated rows keep the old kind with
 *   the path replaced by `{runnerId, basename}`, so it stays readable.
 * - `worktree_scope_changed` becomes `checkout_mode_changed`.
 * - The worktree outcome kinds gain `runnerId` and `workingCopyId`.
 *
 * Kinds are the unit of evolution: a kind's meaning never changes, a new field
 * is optional, anything else is a new kind. Readers drop a kind they do not
 * know ({@link isBoardEventKind}).
 *
 * The board functions write the ticket kinds and the project kinds
 * (`project_created`, `project_renamed`, `project_archived`,
 * `project_unarchived`). The payloads of the other kinds new to the cloud are
 * provisional until their first writer ships (the activity feed, assignees and
 * links, project moves and environments, Session outcomes, Automations), so
 * the owning ticket may still reshape them here. Once a kind is written by a
 * deployed backend it is frozen.
 */

import type { SessionOrigin } from "../session-origin";
import type { HarnessId, TicketPriority, TicketStatus } from "../ticket";
import type { TicketSignalKind, TicketSignalVerdict, WorktreeFailureStage } from "../ticket-events";
import type { Actor } from "./actor";
import type {
  AutomationId,
  BoardEventId,
  CommentId,
  LabelId,
  ProjectId,
  ProjectRepoId,
  RunnerId,
  SessionId,
  TicketId,
  UserId,
  WorkingCopyId,
  WorkspaceId,
} from "./ids";

/** Kinds a backend mutation may write. */
export const BOARD_EVENT_WRITE_KINDS = [
  // Unchanged from the local ticket event log.
  "created",
  "status_changed",
  "priority_changed",
  "harness_changed",
  "retitled",
  "body_edited",
  "labels_changed",
  "archived",
  "unarchived",
  "commented",
  "signaled",
  "pr_opened",
  "pr_merged",
  "attachment_added",
  "attachment_removed",
  "session_started",
  "session_resumed",
  // Worktree outcomes, now naming the runner and Working copy.
  "worktree_failed",
  "worktree_committed",
  "worktree_reclaimed",
  "worktree_trimmed",
  // Replacements for the path-bearing local kinds.
  "working_copy_changed",
  "checkout_mode_changed",
  // New in the cloud.
  "assigned",
  "linked",
  "unlinked",
  "place_changed",
  "project_created",
  "project_moved",
  "project_renamed",
  "project_archived",
  "project_unarchived",
  "label_merged",
  "automation_changed",
  "automation_armed",
  "automation_schedule_armed",
  "automation_run_started",
  "automation_run_skipped",
  "automation_run_failed",
  "session_signaled",
  "session_stopped",
  "session_failed",
  "environment_recipe_changed",
  "environment_setup_failed",
  "environment_verified",
  "environment_snapshot_built",
  "environment_snapshot_failed",
] as const;

/** Kinds that exist only on migrated rows: readable, never written. */
export const BOARD_EVENT_MIGRATED_KINDS = ["worktree_changed"] as const;

/** Every kind a reader of this build understands. */
export const BOARD_EVENT_KINDS = [
  ...BOARD_EVENT_WRITE_KINDS,
  ...BOARD_EVENT_MIGRATED_KINDS,
] as const;

export type BoardEventWriteKind = (typeof BOARD_EVENT_WRITE_KINDS)[number];
export type BoardEventKind = (typeof BOARD_EVENT_KINDS)[number];

/** Whether a stored kind is one this build reads. Readers drop the rest. */
export function isBoardEventKind(value: unknown): value is BoardEventKind {
  return typeof value === "string" && (BOARD_EVENT_KINDS as readonly string[]).includes(value);
}

/** Whether a kind may be written by this build (excludes migrated-only kinds). */
export function isBoardEventWriteKind(value: unknown): value is BoardEventWriteKind {
  return (
    typeof value === "string" && (BOARD_EVENT_WRITE_KINDS as readonly string[]).includes(value)
  );
}

export const CHECKOUT_MODES = ["worktree", "main_checkout"] as const;
export type CheckoutMode = (typeof CHECKOUT_MODES)[number];

export const WORKING_COPY_STATES = [
  "requested",
  "materializing",
  "ready",
  "failed",
  "trimmed",
  "reclaimed",
] as const;
export type WorkingCopyState = (typeof WORKING_COPY_STATES)[number];

export const TICKET_LINK_KINDS = ["mention", "relates", "blocks", "duplicates"] as const;
export type TicketLinkKind = (typeof TICKET_LINK_KINDS)[number];

/** A Working copy's identity as `working_copy_changed` snapshots it. No path, ever. */
export interface WorkingCopySnapshot {
  branch: string | null;
  baseBranch: string | null;
  state: WorkingCopyState;
}

/** A migrated `worktree_changed` side: the absolute path is reduced to its basename. */
export interface MigratedWorktreeIdentity {
  runnerId: RunnerId | null;
  basename: string | null;
  branch: string | null;
  baseBranch: string | null;
}

interface WorkingCopyRef {
  runnerId: RunnerId;
  workingCopyId: WorkingCopyId;
}

export type BoardEventPayload =
  | { kind: "created"; status: TicketStatus; title: string }
  | { kind: "status_changed"; from: TicketStatus; to: TicketStatus }
  | { kind: "priority_changed"; from: TicketPriority; to: TicketPriority }
  | { kind: "harness_changed"; from: HarnessId; to: HarnessId }
  | { kind: "retitled"; from: string; to: string }
  | { kind: "body_edited" }
  | { kind: "labels_changed"; added: string[]; removed: string[] }
  | { kind: "archived" }
  | { kind: "unarchived" }
  | { kind: "commented"; commentId: CommentId }
  | {
      kind: "signaled";
      signalKind: TicketSignalKind;
      verdict: TicketSignalVerdict;
      detail: string | null;
    }
  | { kind: "pr_opened"; url: string }
  | { kind: "pr_merged"; url: string }
  | { kind: "attachment_added"; attachmentId: string; label: string }
  | { kind: "attachment_removed"; attachmentId: string; label: string }
  | { kind: "session_started"; sessionId: SessionId; origin?: SessionOrigin }
  | {
      kind: "session_resumed";
      sessionId: SessionId;
      attachmentId: string;
      origin: SessionOrigin | null;
    }
  | ({ kind: "worktree_failed"; stage: WorktreeFailureStage; stderr: string } & WorkingCopyRef)
  | ({ kind: "worktree_committed"; message: string } & WorkingCopyRef)
  | ({ kind: "worktree_reclaimed"; branch: string | null; daysInDone: number } & WorkingCopyRef)
  | ({ kind: "worktree_trimmed"; entries: number; bytes: number; kept: number } & WorkingCopyRef)
  | ({
      kind: "working_copy_changed";
      projectRepoId: ProjectRepoId;
      /** `null` when the Working copy did not exist before. */
      from: WorkingCopySnapshot | null;
      to: WorkingCopySnapshot;
    } & WorkingCopyRef)
  | { kind: "checkout_mode_changed"; from: CheckoutMode; to: CheckoutMode }
  | { kind: "worktree_changed"; from: MigratedWorktreeIdentity; to: MigratedWorktreeIdentity }
  | { kind: "assigned"; from: UserId | null; to: UserId | null }
  | { kind: "linked"; toTicketId: TicketId; linkKind: TicketLinkKind }
  | { kind: "unlinked"; toTicketId: TicketId; linkKind: TicketLinkKind }
  | { kind: "place_changed"; runnerId: RunnerId | null }
  | { kind: "project_created"; name: string; ticketPrefix: string }
  | { kind: "project_moved"; fromWorkspaceId: WorkspaceId; toWorkspaceId: WorkspaceId }
  | { kind: "project_renamed"; from: string; to: string }
  | { kind: "project_archived" }
  | { kind: "project_unarchived" }
  | { kind: "label_merged"; labelId: LabelId; intoLabelId: LabelId }
  | {
      kind: "automation_changed";
      automationId: AutomationId;
      change: "created" | "updated" | "deleted";
    }
  | {
      kind: "automation_armed";
      status: TicketStatus;
      /** `null` disarms the column. */
      automationId: AutomationId | null;
      runnerId: RunnerId | null;
    }
  | {
      kind: "automation_schedule_armed";
      automationId: AutomationId;
      /** null disarms the project-level schedule (ticketId is null). */
      runnerId: RunnerId | null;
    }
  | {
      kind: "automation_run_started";
      automationId: AutomationId;
      runId: string;
      sessionId: SessionId;
    }
  | { kind: "automation_run_skipped"; automationId: AutomationId; runId: string; reason: string }
  | {
      kind: "automation_run_failed";
      automationId: AutomationId;
      runId: string;
      code: string;
      detail: string | null;
    }
  | {
      kind: "session_signaled";
      sessionId: SessionId;
      signal: "done" | "blocked";
      reason: string | null;
    }
  | { kind: "session_stopped"; sessionId: SessionId; reason: string | null }
  | { kind: "session_failed"; sessionId: SessionId; turnId: string | null; code: string | null }
  | {
      kind: "environment_recipe_changed";
      projectRepoId: ProjectRepoId | null;
      script: "setup" | "resume";
      source: "repo" | "stored" | "legacy_command";
    }
  | { kind: "environment_setup_failed"; runId: string; runnerId: RunnerId; exitCode: number | null }
  | { kind: "environment_verified"; runId: string; runnerId: RunnerId }
  | { kind: "environment_snapshot_built"; snapshotId: string; size: string }
  | { kind: "environment_snapshot_failed"; snapshotId: string | null; detail: string };

// Every kind has exactly one payload arm, and every arm a kind (compile-time).
type PayloadKind = BoardEventPayload["kind"];
type MissingPayload = Exclude<BoardEventKind, PayloadKind>;
type MissingKind = Exclude<PayloadKind, BoardEventKind>;
const everyKindHasAPayload: [MissingPayload, MissingKind] extends [never, never] ? true : never =
  true;
void everyKindHasAPayload;

/** One board event. `payload.kind` always equals `kind`; `kind` is copied out for indexing. */
export interface BoardEvent<K extends BoardEventKind = BoardEventKind> {
  id: BoardEventId;
  projectId: ProjectId;
  /** `null` for project-level facts: label merges, Automation changes, project moves. */
  ticketId: TicketId | null;
  /** Per-project total order, from the project's counter document. Starts at 1. */
  seq: number;
  kind: K;
  actor: Actor;
  /** Set by the mutation. Ordering never comes from it; it comes from `seq`. */
  occurredAt: number;
  payload: Extract<BoardEventPayload, { kind: K }>;
}
