/** Person-facing projections of the durable move journal. No credentials or row contents. */
import type { TicketStatus } from "./ticket";
export interface CloudMoveCounts {
  tickets: number;
  sessions: number;
  events: number;
  attachments: number;
  attachmentBytes: number;
  transcriptBytes: number;
  piLogBytes: number;
}

export interface CloudMoveExclusion {
  label: string;
  reason: string;
  count?: number;
}

export interface CloudMoveBlocker {
  message: string;
  sessionId?: string;
  ticketId?: string;
}

export interface CloudMoveProject {
  id: string;
  name: string;
  removed: boolean;
  counts: CloudMoveCounts | null;
  estimateSeconds: number | null;
  blockers: CloudMoveBlocker[];
  exclusions: CloudMoveExclusion[];
  warnings: string[];
}

export interface CloudMovePreflightInput {
  /** Omitted for Move all. Removed projects are excluded unless explicitly requested. */
  projectIds?: string[];
  workspaceId: string | null;
  includeRemoved: boolean;
}

export interface CloudMovePreflight {
  /** Main binds this dry run to its person, target and selection; start rechecks liveness. */
  id: string;
  projects: CloudMoveProject[];
  backupDirectory: string;
  disk: { requiredBytes: number; freeBytes: number };
  stopAtFirstProblem: boolean;
  exclusions: CloudMoveExclusion[];
}

/**
 * What a running dry run is doing, in the order it does it. `snapshot` to
 * `history` are the export's own steps; `checking` and `planning` are the
 * dry run's checks around it; `sizing` is the profile-wide disk estimate.
 */
export const CLOUD_MOVE_PREFLIGHT_PHASES = [
  "starting",
  "checking",
  "snapshot",
  "reading",
  "exporting",
  "history",
  "verifying",
  "planning",
  "sizing",
] as const;
export type CloudMovePreflightPhase = (typeof CLOUD_MOVE_PREFLIGHT_PHASES)[number];

/** A running dry run's progress: names and counts only, never record content. */
export interface CloudMovePreflightProgress {
  phase: CloudMovePreflightPhase;
  /** 1-based position of the project being checked; 0 before the first and while sizing. */
  projectIndex: number;
  projectCount: number;
  projectName: string | null;
  /** Work done of `total` inside this phase, when the phase can count it. */
  done: number | null;
  total: number | null;
  unit: "records" | "files" | null;
  startedAt: number;
}

export interface CloudMoveStartInput {
  preflightId: string;
  projectIds: string[];
  workspaceId: string;
  stopAtFirstProblem: boolean;
}

export const CLOUD_MOVE_ACTIONS = [
  "pause",
  "resume",
  "cancel",
  "roll-back",
  "retry",
  "skip",
  "finish",
  "open-cloud",
  "go-back",
  // Reserved wire value; removal stays unavailable until archived-copy cleanup preserves runner state.
  "remove-local",
  "re-arm",
] as const;
export type CloudMoveAction = (typeof CLOUD_MOVE_ACTIONS)[number];

export type CloudMoveRearmTarget =
  | { kind: "column"; automationId: string; status: TicketStatus }
  | { kind: "schedule"; automationId: string };

export interface CloudMoveAutomationRearm {
  columns: { automationId: string; name: string; status: TicketStatus }[];
  schedules: { automationId: string; name: string }[];
  /** Personal definitions are inert, never re-arm targets. May include earlier profile moves. */
  inertGlobals: { id: string; name: string }[];
  canRearmOnThisMac: boolean;
  unavailable: string | null;
  retryable: boolean;
}

export interface CloudMoveCommand {
  moveId: string;
  action: CloudMoveAction;
  /** Required to discard changed cloud data during Roll back; main checks the exact project name again. */
  confirmation?: string;
  /** One currently paused moved record; main re-reads it before calling the ordinary arming door. */
  rearm?: CloudMoveRearmTarget;
}

export const CLOUD_MOVE_STEPS = [
  "backup",
  "freeze",
  "export",
  "upload",
  "copy",
  "history",
  "verify",
  "handover",
  "check",
] as const;
export type CloudMoveStep = (typeof CLOUD_MOVE_STEPS)[number];

export const CLOUD_MOVE_VIEW_STATES = [
  "queued",
  "moving",
  "waiting",
  "problem",
  "check",
  "finished",
  "rolled-back",
  "returned",
] as const;

export interface CloudMoveCheck {
  label: string;
  passed: boolean;
  sourceCount?: number;
  cloudCount?: number;
}

export interface CloudMoveStatus {
  moveId: string;
  queueId: string;
  projectId: string;
  projectName: string;
  workspaceName: string;
  state: (typeof CLOUD_MOVE_VIEW_STATES)[number];
  step: CloudMoveStep;
  completedSteps: CloudMoveStep[];
  /** Plain recovery copy, projected from engine codes, never raw exceptions or row contents. */
  message: string;
  progress: { completed: number; total: number; unit: "bytes" | "rows" | "sessions" } | null;
  estimateSeconds: number | null;
  /** Authoritative availability from main; the renderer never enables unsafe transitions. */
  actions: CloudMoveAction[];
  localReadOnly: boolean;
  confirmedAt: number | null;
  backupPath: string | null;
  /** Destination shown before Go back to local; actual readable export shown afterwards. */
  returnExportPath: string | null;
  /** Post-commit rollback is distinct from the non-destructive preview escape hatch. */
  rollback: { changes: string[]; requiresConfirmation: boolean } | null;
  checks: CloudMoveCheck[];
  counts: CloudMoveCounts | null;
  pausedAutomations: string[];
  automationRearm?: CloudMoveAutomationRearm;
  localCredentials: string[];
}

export interface CloudMoveSnapshot {
  revision: number;
  account: { userId: string; displayName: string } | null;
  workspaces: { id: string; name: string; canMove: boolean }[];
  /** Oldest first. Only the latest move for a project can own its local read-only marker. */
  moves: CloudMoveStatus[];
  /** A missing dependency, sign-in or access problem. Null when new moves can be prepared. */
  unavailable: string | null;
  /** The dry run running now, if any. */
  preflight: CloudMovePreflightProgress | null;
}
