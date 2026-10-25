/**
 * The record shapes the migration exporter writes: today's `volli.db` rows
 * already mapped onto the Volli Cloud data model, one NDJSON line each.
 *
 * These are the export's own record shapes, faithful to the source; the
 * backend document each one becomes (defaults, renames, export-only fields
 * dropped) is `migrationDocument` in `@volli/shared/cloud`, and the backend's
 * `test/migration.test.ts` holds every stream to the real schema.
 * TODO(VC-927 follow-up): type `Actor` and the ids from `@volli/shared/cloud`
 * instead of the local subset below.
 *
 * Three rules hold for every record:
 *
 * - **Ids are carried verbatim.** A row's id, a ticket number, a Session
 *   event id and sequence are never regenerated. The few records that have no
 *   source row of their own (a project's primary repo, a ticket's Working
 *   copy, a config entry made from a column) get a DERIVED id
 *   (`derivedId` in `transform.ts`), so a re-run of the export names them identically.
 * - **No machine path enters a Convex-bound record.** Absolute paths go to the
 *   runner-local streams (`projectCheckoutPaths`, `workingCopyPaths`) and
 *   nowhere else. Session event payloads and transcripts are content, not
 *   structure, and keep whatever they recorded.
 * - **Who did it is an `Actor`.** The exporter cannot know the cloud user,
 *   runner or Workspace the import will land in, so it writes the
 *   {@link MIGRATION_PLACEHOLDERS} in their place and the importer substitutes
 *   them. A placeholder is always a whole field value, never part of a string.
 *
 * Fields the local database does not determine (a project's ship behaviour,
 * a Session's folded status, timestamps the backend stamps on accept) are
 * absent: the importer or the backend fold supplies them.
 */

import { MIGRATION_PLACEHOLDERS } from "@volli/shared/cloud";

/** The manifest's format marker; a reader checks it before anything else. */
export const MIGRATION_EXPORT_FORMAT = "volli.migration-export/1";

/**
 * Stand-ins the importer replaces with the identities the migration lands
 * under. Defined beside the importer's mapping in `@volli/shared/cloud`, so
 * the two sides cannot spell them differently.
 */
export { MIGRATION_PLACEHOLDERS };

export type UserRef = typeof MIGRATION_PLACEHOLDERS.userId;
export type RunnerRef = typeof MIGRATION_PLACEHOLDERS.runnerId;
export type WorkspaceRef = typeof MIGRATION_PLACEHOLDERS.workspaceId;

/** Any value a parsed JSON column can hold. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** The cloud `VolliReason`, narrowed to the reasons a migrated row can carry. */
export type MigratedVolliReason = "retention" | "merge_watch";

/** The cloud Actor (v1): who did it. */
export type Actor =
  | { kind: "person"; userId: UserRef }
  | { kind: "agent"; userId: UserRef; sessionId: string; ticketId?: string | null }
  | {
      kind: "automation";
      userId: UserRef;
      automationId: string;
      runId: string;
      sessionId?: string;
    }
  | { kind: "volli"; reason: MigratedVolliReason; onBehalfOf?: UserRef; runnerId?: RunnerRef }
  | {
      kind: "legacy";
      was: "user" | "session" | "automation" | "unauthenticated";
      sessionId?: string;
    };

// ---- projects ---------------------------------------------------------------

export interface ProjectRecord {
  id: string;
  workspaceId: WorkspaceRef;
  name: string;
  colorIndex: number;
  ticketPrefix: string;
  origin: "migrated";
  /** A migrated project never counts toward a project limit. */
  countsTowardCap: false;
  createdByUserId: UserRef;
  createdAt: number;
  updatedAt: number;
  archivedAt: null;
  /**
   * Export-only: when the person removed the project from the rail, or null.
   * Not a cloud column. A removed project is not migrated by default;
   * the importer offers it.
   */
  removedAt: number | null;
}

export interface ProjectCounterRecord {
  projectId: string;
  /** `max(next_ticket_number, MAX(ticket_number) + 1)`, so no number is reused. */
  nextTicketNumber: number;
  /** How many board events this project carries; the next one takes `boardSeq + 1`. */
  boardSeq: number;
}

export interface ProjectRepoRecord {
  id: string;
  projectId: string;
  role: "primary";
  position: string;
  /** `none` until the GitHub App connects the checkout's remote. */
  provider: "none";
  githubRepoId: null;
  installationId: null;
  owner: null;
  name: string;
  baseBranch: string | null;
  defaultBranchCache: null;
  dirName: string;
}

export interface ProjectEnvironmentRecord {
  projectId: string;
  storedSetup: string | null;
  storedResume: null;
  storedSetupMode: "legacy_command";
  revision: number;
}

export interface MemberProjectPrefsRecord {
  userId: UserRef;
  projectId: string;
  commitEmail: null;
  coAuthor: null;
  /** Fractional key, in the old rail `sort_order`. */
  railPosition: string;
  themeCanvas?: JsonValue;
  themeAppearance?: string;
}

/** Convex `projectCheckouts`: this runner can host the project's main checkout. No path. */
export interface ProjectCheckoutRecord {
  runnerId: RunnerRef;
  projectId: string;
  projectRepoId: string;
  kind: "main";
  headBranch: null;
  reportedAt: number;
}

/** Runner-local `project_checkout_paths`: today's `projects.path`. Never uploaded. */
export interface ProjectCheckoutPathRecord {
  projectRepoId: string;
  projectId: string;
  absPath: string;
  kind: "main";
}

/**
 * Convex `configEntries`. `scopeKey` is absent on purpose: it is a pure
 * function of `level` and the ids beside it, and spelling it here
 * would put a placeholder inside a string.
 */
export interface ConfigEntryRecord {
  id: string;
  level: "personal" | "project";
  userId: UserRef | null;
  workspaceId: null;
  projectId: string | null;
  kind: string;
  name: string;
  state: "on" | "off";
  definition: JsonValue;
  revision: number;
  updatedBy: Actor;
  updatedAt: number;
}

// ---- board ------------------------------------------------------------------

export interface LabelRecord {
  id: string;
  projectId: string;
  name: string;
  nameKey: string;
  color: string | null;
  mergedIntoId: string | null;
  mergedAt: number | null;
  mergedBy: Actor | null;
  createdAt: number;
  updatedAt: number;
}

export interface PullRequestRecord {
  projectRepoId: string;
  url: string;
  number: number | null;
  state: "open" | "merged";
  mergedAt: number | null;
}

export interface TicketRecord {
  id: string;
  projectId: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  /** Fractional key within `(projectId, status)`, in the old integer order. */
  position: string;
  labelIds: string[];
  assigneeUserId: null;
  checkoutMode: "worktree" | "main_checkout";
  preferredHarnessId: string;
  branch: string | null;
  /** Only when it differs from the project's base branch. */
  baseBranch: string | null;
  pullRequests: PullRequestRecord[];
  retentionKeep: boolean;
  /** The migrating Mac when the ticket's worktree is still on disk there. */
  placeRunnerId: RunnerRef | null;
  createdBy: Actor;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface TicketBodyRecord {
  ticketId: string;
  body: string;
  revision: number;
  updatedBy: Actor;
  updatedAt: number;
}

export interface BoardEventRecord {
  id: string;
  projectId: string;
  ticketId: string;
  /** 1-based rank within the project, in the durable local event order. */
  seq: number;
  kind: string;
  actor: Actor;
  occurredAt: number;
  payload: JsonValue;
}

export interface TicketCommentRecord {
  id: string;
  ticketId: string;
  projectId: string;
  sessionId: string | null;
  author: Actor;
  body: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: null;
}

export interface TicketSignalRecord {
  id: string;
  ticketId: string;
  projectId: string;
  sessionId: string | null;
  actor: Actor;
  kind: string;
  verdict: string;
  detail: string | null;
  createdAt: number;
}

export interface BlobRecord {
  projectId: string;
  sha256: string;
  mime: string;
  sizeBytes: number;
  originalName: string;
  width: number | null;
  height: number | null;
  /** The R2 key the bytes upload to. */
  key: string;
  uploadedBy: Actor;
  createdAt: number;
}

export interface BlobLinkRecord {
  id: string;
  projectId: string;
  sha256: string;
  owner: { kind: "ticket" | "session"; id: string };
  label: string;
  createdAt: number;
}

// ---- runners and Working copies ---------------------------------------------

export interface WorkingCopyRecord {
  id: string;
  ticketId: string;
  projectId: string;
  runnerId: RunnerRef;
  projectRepoId: string;
  kind: "worktree";
  /** `ready` when the worktree directory exists on this Mac, else `reclaimed`. */
  state: "ready" | "reclaimed";
  branch: string | null;
  baseBranch: string | null;
  reportedAt: number;
  createdAt: number;
}

/** Runner-local `working_copy_paths`. Never uploaded. */
export interface WorkingCopyPathRecord {
  workingCopyId: string;
  ticketId: string;
  projectRepoId: string;
  absPath: string;
}

// ---- Sessions ---------------------------------------------------------------

export interface SessionRecord {
  id: string;
  projectId: string;
  ticketId: string | null;
  role: string;
  parentSessionId: string | null;
  ownerUserId: UserRef;
  title: string | null;
  visibility: "shared" | "private";
  visibilityReason: "ticket" | "adhoc" | "inherited";
  placeRunnerId: RunnerRef;
  createdAt: number;
  /** The newest event's `recordedAt`, or `createdAt` for a Session with none. */
  lastActivityAt: number;
  /** Export-only: the last sequence, which `acceptedThrough` must reach. */
  lastSequence: number;
  /** Export-only: how many events the `sessionEvents` stream carries for it. */
  eventCount: number;
}

/** The Session event envelope, verbatim, with provenance re-inflated from `session_provenances`. */
export interface SessionEventRecord {
  id: string;
  sessionId: string;
  sequence: number;
  occurredAt: number;
  recordedAt: number;
  provenance: JsonValue;
  attachmentId: string | null;
  commandId: string | null;
  payload: JsonValue;
}

export interface ReadMarkerRecord {
  userId: UserRef;
  sessionId: string;
  unreadSince: number | null;
  readThroughSequence: null;
}

export interface DelegationRecord {
  childSessionId: string;
  parentSessionId: string | null;
  ticketId: string | null;
  depth: number;
  /** From the fan-out claim that minted the child; null for a delegation older than claims. */
  toolCallId: string | null;
  createCommandId: string | null;
  createdAt: number | null;
}

export interface SessionGrantRecord {
  sessionId: string;
  verb: string;
  scope: string;
  maxDepth: number;
  maxChildren: number;
}

export interface DelegationExtensionRecord {
  parentSessionId: string;
  toolCallId: string;
  approvedByUserId: UserRef;
  createdAt: number;
}

// ---- Automations ------------------------------------------------------------

export interface AutomationRecord {
  id: string;
  projectId: string;
  name: string;
  instructions: string;
  runtime: JsonValue;
  triggerSpec: JsonValue;
  createdBy: Actor;
  createdAt: number;
  updatedAt: number;
  deletedAt: null;
}

export interface AutomationRunRecord {
  id: string;
  automationId: string | null;
  automationName: string | null;
  projectId: string;
  ticketId: string | null;
  sessionId: string | null;
  /** `manual` when local history does not say what started the Run. */
  trigger: "schedule" | "manual" | "arrival";
  status: "started" | "skipped" | "failed";
  skipReason?: JsonValue;
  missedCount: number | null;
  dueAt: number | null;
  model?: { providerId: string; modelId: string; reasoningLevel: string };
  /** A failed arrival attempt's error, kept for the Retry it offered. */
  error?: string;
  /** The failed attempt's command id: the key a Retry replays under. */
  retryCommandId?: string;
  attendance: string | null;
  armedByUserId: UserRef | null;
  runnerId: RunnerRef | null;
  createdAt: number;
}

export interface AutomationArmingRecord {
  projectId: string;
  status: string;
  automationId: string;
  armedByUserId: UserRef;
  runnerId: RunnerRef;
  armedAt: number;
}

export interface AutomationColumnOrderRecord {
  projectId: string;
  status: string;
  rankedIds: string[];
  orderedAt: number;
}

/** An arrival counting down at cutover, as the `automation.run` job that still fires it. */
export interface AutomationRunJobRecord {
  id: string;
  runnerId: RunnerRef;
  kind: "automation.run";
  projectId: string;
  sessionId: null;
  ticketId: string;
  workingCopyId: null;
  payload: {
    automationId: string;
    automationName: string;
    ticketDisplayId: string;
    status: string;
    origin: string;
  };
  priority: "normal";
  createdBy: Actor;
  createdAt: number;
  availableAt: number;
}

export interface AuditLogRecord {
  id: string;
  workspaceId: WorkspaceRef;
  actor: Actor;
  kind: string;
  targetKind: "mcp_server";
  targetId: string;
  at: number;
  detail: JsonValue;
}

/**
 * How far this Mac's scheduler has evaluated one schedule: the occurrence
 * (epoch ms) it has evaluated through. The importer derives the schedule's
 * next fire time from it and the Automation's trigger spec.
 */
export interface AutomationScheduleCursorRecord {
  automationId: string;
  evaluatedThrough: number;
  armedByUserId: UserRef;
  runnerId: RunnerRef;
}

/** Runner-local cache of an MCP server's tool catalog (stdio servers run on the runner). */
export interface McpCatalogCacheRecord {
  configEntryId: string;
  projectId: string;
  catalog: JsonValue;
  stale: boolean;
  error: string | null;
  refreshedAt: number | null;
}

// ---- legacy archives --------------------------------------------------------

/** A row no cloud table takes, kept verbatim for `v1/p/{projectId}/legacy/…`. */
export interface LegacyRowRecord {
  table: string;
  /** The owning project, when one can be named; null for a host-wide row. */
  projectId: string | null;
  /** Why it is here rather than in a cloud table. */
  reason: string;
  row: Record<string, JsonValue>;
}
