/** Person-facing projections of the durable move journal. No credentials or row contents. */
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
  counts: CloudMoveCounts;
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
  "remove-local",
] as const;
export type CloudMoveAction = (typeof CLOUD_MOVE_ACTIONS)[number];

export interface CloudMoveCommand {
  moveId: string;
  action: CloudMoveAction;
  /** Required for manual removal or discarding changed cloud data; main checks the exact project name again. */
  confirmation?: string;
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
}
