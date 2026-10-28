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

export type CloudMoveAction =
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "skip"
  | "finish"
  | "open-cloud"
  | "go-back"
  | "remove-local";

export interface CloudMoveCommand {
  moveId: string;
  action: CloudMoveAction;
  /** Required for manual removal; main checks the exact project name again. */
  confirmation?: string;
}

export type CloudMoveStep =
  | "backup"
  | "freeze"
  | "export"
  | "upload"
  | "copy"
  | "history"
  | "verify"
  | "handover"
  | "check";

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
  state:
    | "queued"
    | "moving"
    | "waiting"
    | "problem"
    | "check"
    | "finished"
    | "rolled-back"
    | "returned";
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
  checks: CloudMoveCheck[];
  counts: CloudMoveCounts | null;
  pausedAutomations: string[];
  localCredentials: string[];
}

export interface CloudMoveSnapshot {
  revision: number;
  account: { userId: string; displayName: string } | null;
  workspaces: { id: string; name: string; canMove: boolean }[];
  moves: CloudMoveStatus[];
  /** A missing dependency, sign-in or access problem. Null when new moves can be prepared. */
  unavailable: string | null;
}

/** App-only, person-authorized door. The host owns all steps, safety rules and persistence. */
export interface CloudMovesApi {
  snapshot(): Promise<CloudMoveSnapshot>;
  preflight(input: CloudMovePreflightInput): Promise<CloudMovePreflight>;
  start(input: CloudMoveStartInput): Promise<void>;
  command(input: CloudMoveCommand): Promise<void>;
  report(moveId: string): Promise<string>;
  onChanged(listener: () => void, failed?: () => void): () => void;
}
