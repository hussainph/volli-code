import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import {
  derivePrefix,
  errorMessage,
  isHarnessId,
  isTicketPriority,
  isTicketStatus,
  isValidBranchName,
  LEGACY_BACKUP_APP_STATE_KEY,
  PROJECT_COLORS,
  sanitizeLegacyProjects,
  USER_ACTOR,
  validateUniquePrefix,
} from "@volli/shared";
import type {
  AppStateSetResult,
  ArchivedTicketsResult,
  BootstrapPayload,
  BootstrapResult,
  HarnessId,
  Label,
  LabelResult,
  LegacyImportRequest,
  LegacyImportResult,
  Project,
  ProjectCreateResult,
  ProjectMutationResult,
  ProjectUpdateResult,
  Result,
  SessionsResult,
  SessionRenameResult,
  Ticket,
  TicketCommentResult,
  TicketCommentsResult,
  TicketEventsResult,
  TicketPriority,
  TicketResult,
  TicketsResult,
  TicketStatus,
  VolliIpcChannel,
  WorktreeBranchesResult,
  WorktreeCommitResult,
  WorktreeDiffMode,
  WorktreeDiffResult,
  WorktreeOrphanDeleteResult,
  WorktreeOrphansResult,
  WorktreePushPrResult,
  WorktreeRemoveResult,
  WorktreeStatusResult,
  RetentionArchiveCleanResult,
  RetentionDismissResult,
  RetentionKeepResult,
  RetentionPollResult,
  RetentionStateResult,
  RetentionTtlResult,
} from "@volli/shared";
import { getAllAppState, setAppState } from "./db/app-state-repo";
import { deleteComment, getComment, listComments, updateComment } from "./db/comments-repo";
import { listTicketEvents } from "./db/events-repo";
import { listAllLabels, setLabelColor } from "./db/labels-repo";
import {
  countProjects,
  deleteProject,
  findProjectByPath,
  insertProject,
  listProjects,
  nextSortOrder,
  reorderProjects,
  updateProjectBaseBranch,
  updateProjectSetupCommand,
} from "./db/projects-repo";
import { listSessions, listTicketSessions, updateTitle } from "./db/sessions-repo";
import {
  getTicketRow,
  listAllTickets,
  listArchivedTicketsByProject,
  listWorktreePaths,
  setTicketRetentionKeep,
} from "./db/tickets-repo";
import {
  archiveTicketCommand,
  createTicketCommand,
  createTicketCommentCommand,
  deleteTicketCommand,
  interruptOnBackwardMove,
  moveTicketCommand,
  setTicketLabelsCommand,
  setTicketPriorityCommand,
  unarchiveTicketCommand,
  updateTicketFieldsCommand,
} from "./ticket-commands";
import { detectProjectBaseBranch } from "./project-base-branch";
import { broadcastDataChanged } from "./broadcast";
import { orphanReport } from "./orphan-sweep";
import {
  archiveAndClean,
  commitTicketRemaining,
  getRetentionTtlDays,
  listBranches,
  publishTicketBranch,
  readWorktreeDiff,
  readWorktreeStatus,
  remove as removeWorktree,
  runNet,
  setRetentionTtlDays,
  type DiffMode,
} from "./worktree";
import { getRetentionWatcher } from "./retention-runtime";
import {
  canonicalize as canonicalizeWorktreePath,
  isInside as isInsideWorktreeHome,
  samePath as samePathAs,
} from "./worktree/paths";
import { worktreeDeps, worktreesHome } from "./worktree-runtime";

/** The result of the main-process open+migrate attempt (`src/main/index.ts`), fed into {@link registerDataIpcHandlers}. */
export type DbHandle = { ok: true; db: Database.Database } | { ok: false; error: string };

/** Every channel this module owns — used to register the uniform degraded-DB failure path. */
const DATA_CHANNELS: readonly VolliIpcChannel[] = [
  "volli:data-bootstrap",
  "volli:legacy-import",
  "volli:project-create",
  "volli:project-update",
  "volli:project-remove",
  "volli:project-reorder",
  "volli:ticket-create",
  "volli:ticket-move",
  "volli:ticket-set-priority",
  "volli:ticket-update",
  "volli:ticket-set-labels",
  "volli:ticket-archive",
  "volli:ticket-unarchive",
  "volli:ticket-delete",
  "volli:ticket-list-archived",
  "volli:ticket-events",
  "volli:comment-list",
  "volli:comment-create",
  "volli:comment-update",
  "volli:comment-remove",
  "volli:session-list",
  "volli:session-list-for-ticket",
  "volli:session-rename",
  "volli:label-set-color",
  "volli:app-state-set",
  "volli:worktree-remove",
  "volli:worktree-branches",
  "volli:worktree-orphans",
  "volli:worktree-orphan-delete",
  "volli:worktree-status",
  "volli:worktree-diff",
  "volli:worktree-commit",
  "volli:worktree-push-pr",
  "volli:retention-state",
  "volli:retention-keep",
  "volli:retention-dismiss",
  "volli:retention-archive-clean",
  "volli:retention-ttl-get",
  "volli:retention-ttl-set",
  "volli:retention-poll",
];

// ---- input validation -------------------------------------------------
// The status/priority vocabulary guards live in @volli/shared next to the
// TICKET_STATUSES/TICKET_PRIORITIES constants they guard (isTicketStatus/
// isTicketPriority), imported above.

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Whether `value` is a `Record<string, string>` (the appState/rawBackup payload shape). */
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string")
  );
}

function isLegacyImportRequest(value: unknown): value is LegacyImportRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate["projects"]) &&
    isStringRecord(candidate["appState"]) &&
    isStringRecord(candidate["rawBackup"])
  );
}

interface ProjectCreateInput {
  path: string;
  name: string;
}

function isProjectCreateInput(value: unknown): value is ProjectCreateInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["path"] === "string" && typeof candidate["name"] === "string";
}

interface ProjectUpdateInput {
  id: string;
  baseBranch: string | null;
  /** `undefined` (untouched), `null` (clear), or a `string` (set) — the same shape as ticket-update's worktree-identity fields. */
  setupCommand?: string | null;
}

function isProjectUpdateInput(value: unknown): value is ProjectUpdateInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["id"] === "string" &&
    (candidate["baseBranch"] === null ||
      (typeof candidate["baseBranch"] === "string" &&
        isValidBranchName(candidate["baseBranch"]))) &&
    isOptionalNullableString(candidate["setupCommand"])
  );
}

interface TicketCreateInput {
  projectId: string;
  status: TicketStatus;
  title: string;
  priority?: TicketPriority;
  /** Markdown; defaults to `""`. Becomes the agent prompt on kickoff. */
  body?: string;
  /** Label names; defaults to `[]`. Persisted as shared, name-deduped label rows (the setLabels path). */
  labels?: string[];
  /** Whether the ticket boots its agent in an isolated worktree; defaults to `true`. */
  usesWorktree?: boolean;
  /** The ticket's persisted default harness (set on kickoff); defaults to the DB default. */
  preferredHarnessId?: HarnessId;
}

function isTicketCreateInput(value: unknown): value is TicketCreateInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["projectId"] === "string" &&
    typeof candidate["title"] === "string" &&
    candidate["title"].trim().length > 0 &&
    isTicketStatus(candidate["status"]) &&
    (candidate["priority"] === undefined || isTicketPriority(candidate["priority"])) &&
    (candidate["body"] === undefined || typeof candidate["body"] === "string") &&
    (candidate["labels"] === undefined || isStringArray(candidate["labels"])) &&
    (candidate["usesWorktree"] === undefined || typeof candidate["usesWorktree"] === "boolean") &&
    (candidate["preferredHarnessId"] === undefined || isHarnessId(candidate["preferredHarnessId"]))
  );
}

interface TicketMoveInput {
  projectId: string;
  ticketId: string;
  toStatus: TicketStatus;
  toIndex: number;
}

function isTicketMoveInput(value: unknown): value is TicketMoveInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["projectId"] === "string" &&
    typeof candidate["ticketId"] === "string" &&
    isTicketStatus(candidate["toStatus"]) &&
    typeof candidate["toIndex"] === "number" &&
    Number.isInteger(candidate["toIndex"])
  );
}

interface TicketSetPriorityInput {
  ticketId: string;
  priority: TicketPriority;
}

function isTicketSetPriorityInput(value: unknown): value is TicketSetPriorityInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["ticketId"] === "string" && isTicketPriority(candidate["priority"]);
}

interface TicketUpdateInput {
  ticketId: string;
  title?: string;
  body?: string;
  /** First-class worktree identity (migration 003); `null` explicitly clears the field, `undefined` leaves it untouched. */
  worktreePath?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
}

/** `undefined` (untouched), `null` (clear), or a `string` (set) — the worktree-identity field shape. */
function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isTicketUpdateInput(value: unknown): value is TicketUpdateInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["ticketId"] === "string" &&
    (candidate["title"] === undefined || typeof candidate["title"] === "string") &&
    (candidate["body"] === undefined || typeof candidate["body"] === "string") &&
    isOptionalNullableString(candidate["worktreePath"]) &&
    isOptionalNullableString(candidate["branch"]) &&
    isOptionalNullableString(candidate["baseBranch"])
  );
}

interface TicketSetLabelsInput {
  ticketId: string;
  labels: string[];
}

function isTicketSetLabelsInput(value: unknown): value is TicketSetLabelsInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["ticketId"] === "string" && isStringArray(candidate["labels"]);
}

interface TicketIdInput {
  ticketId: string;
}

/** The `{ ticketId }` shape shared by the archive/unarchive/delete handlers. */
function isTicketIdInput(value: unknown): value is TicketIdInput {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>)["ticketId"] === "string";
}

/** The `{ ticketId, keep }` shape for `volli:retention-keep`. */
function isRetentionKeepInput(value: unknown): value is { ticketId: string; keep: boolean } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["ticketId"] === "string" && typeof candidate["keep"] === "boolean";
}

interface CommentCreateInput {
  ticketId: string;
  body: string;
  sessionId?: string | null;
}

function isCommentCreateInput(value: unknown): value is CommentCreateInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["ticketId"] === "string" &&
    typeof candidate["body"] === "string" &&
    candidate["body"].trim().length > 0 &&
    (candidate["sessionId"] === undefined ||
      candidate["sessionId"] === null ||
      typeof candidate["sessionId"] === "string")
  );
}

interface CommentUpdateInput {
  commentId: string;
  body: string;
}

function isCommentUpdateInput(value: unknown): value is CommentUpdateInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["commentId"] === "string" &&
    typeof candidate["body"] === "string" &&
    candidate["body"].trim().length > 0
  );
}

interface CommentIdInput {
  commentId: string;
}

function isCommentIdInput(value: unknown): value is CommentIdInput {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>)["commentId"] === "string";
}

interface SessionRenameInput {
  sessionId: string;
  title: string;
}

/** `{ sessionId, title }` with a non-blank title — the rename handler trims before persisting. */
function isSessionRenameInput(value: unknown): value is SessionRenameInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["sessionId"] === "string" &&
    typeof candidate["title"] === "string" &&
    candidate["title"].trim().length > 0
  );
}

interface ProjectIdInput {
  projectId: string;
}

function isProjectIdInput(value: unknown): value is ProjectIdInput {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>)["projectId"] === "string";
}

interface WorktreeRemoveInput {
  ticketId: string;
  force: boolean;
}

function isWorktreeRemoveInput(value: unknown): value is WorktreeRemoveInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["ticketId"] === "string" && typeof candidate["force"] === "boolean";
}

interface WorktreeDiffInput {
  ticketId: string;
  mode: WorktreeDiffMode;
}

function isWorktreeDiffInput(value: unknown): value is WorktreeDiffInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["ticketId"] === "string" &&
    (candidate["mode"] === "working-tree" || candidate["mode"] === "merge-base")
  );
}

interface LabelSetColorInput {
  labelId: string;
  color: string | null;
}

function isLabelSetColorInput(value: unknown): value is LabelSetColorInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["labelId"] === "string" &&
    (candidate["color"] === null || typeof candidate["color"] === "string")
  );
}

// ---- bootstrap payload --------------------------------------------------

function buildBootstrapPayload(db: Database.Database): BootstrapPayload {
  const projects = listProjects(db);
  const appState = getAllAppState(db);

  const ticketsByProject: Record<string, Ticket[]> = {};
  const labelsByProject: Record<string, Label[]> = {};
  for (const project of projects) {
    ticketsByProject[project.id] = [];
    labelsByProject[project.id] = [];
  }
  for (const ticket of listAllTickets(db)) {
    (ticketsByProject[ticket.projectId] ??= []).push(ticket);
  }
  for (const label of listAllLabels(db)) {
    (labelsByProject[label.projectId] ??= []).push(label);
  }

  return { projects, ticketsByProject, labelsByProject, appState };
}

/**
 * Whether any live session's cwd sits at or under `target`. `isInside`
 * canonicalizes both operands, so a terminal running inside a worktree blocks
 * a remove/orphan-delete that would pull the directory out from under it.
 */
function liveSessionWithin(target: string, cwds: string[]): boolean {
  return cwds.some((cwd) => isInsideWorktreeHome(target, cwd));
}

// ---- registration --------------------------------------------------------

/**
 * Registers every `volli:data-*`/`volli:project-*`/`volli:ticket-*`/
 * `volli:label-*`/`volli:app-state-*` handler. When the db failed to open
 * (`handle.ok === false`), every channel instead resolves with `{ ok: false,
 * error: handle.error }` — main never crashes and invoke() never hangs; the
 * renderer surfaces the error itself. Failures never throw across the IPC
 * boundary either way — every handler below catches and converts.
 */
export function registerDataIpcHandlers(
  handle: DbHandle,
  options: {
    detectBaseBranch?: (projectPath: string) => string | null;
    /**
     * The resolved cwds of every live PTY session (from the PtyManager). The
     * worktree remove/orphan-delete guards refuse to touch a directory that
     * still has a session running at or under it. Absent (tests, degraded boot)
     * means "assume none" — the guard then relies on the git/dirtiness checks.
     */
    liveSessionCwds?: () => string[];
    /**
     * Interrupts every live agent session of a ticket, returning their ids (from
     * the PtyManager). The backward-move choke point (issue #78): after a
     * user-initiated move that leaves the active columns commits, its ticket's
     * running agents are Esc'd and one `sessions_interrupted` event is recorded.
     * Absent (tests, degraded boot) means the interrupt is a no-op.
     */
    interruptTicketSessions?: (ticketId: string) => string[];
  } = {},
): void {
  if (!handle.ok) {
    const error = handle.error;
    for (const channel of DATA_CHANNELS) {
      ipcMain.handle(channel, () => ({ ok: false, error }));
    }
    return;
  }

  const db = handle.db;

  ipcMain.handle("volli:data-bootstrap" satisfies VolliIpcChannel, (): BootstrapResult => {
    try {
      return { ok: true, data: buildBootstrapPayload(db) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(
    "volli:legacy-import" satisfies VolliIpcChannel,
    (_event, request: unknown): LegacyImportResult => {
      if (!isLegacyImportRequest(request)) {
        return { ok: false, error: "Invalid legacy import payload" };
      }
      try {
        // Idempotent-safe: only import into a genuinely empty projects
        // table; a second call (e.g. a relaunch racing the renderer) just
        // hands back the current state instead of re-importing over it.
        if (countProjects(db) > 0) {
          return { ok: true, data: buildBootstrapPayload(db), imported: 0 };
        }
        const legacyProjects = sanitizeLegacyProjects(request.projects);
        const now = Date.now();
        const run = db.transaction(() => {
          // Back up the raw source FIRST, in the same transaction: whatever
          // else happens, once this commits the untouched localStorage strings
          // live in SQLite, so boot can clear localStorage without ever making
          // a lossy/unreadable import unrecoverable (decision #29).
          if (Object.keys(request.rawBackup).length > 0) {
            setAppState(db, LEGACY_BACKUP_APP_STATE_KEY, JSON.stringify(request.rawBackup), now);
          }
          legacyProjects.forEach((legacy, index) => {
            insertProject(db, {
              id: legacy.id,
              name: legacy.name,
              path: legacy.path,
              ticketPrefix: legacy.ticketPrefix,
              colorIndex: legacy.colorIndex,
              sortOrder: index,
              createdAt: legacy.createdAt,
              updatedAt: now,
            });
          });
          for (const [key, value] of Object.entries(request.appState)) {
            setAppState(db, key, value, now);
          }
        });
        run();
        return { ok: true, data: buildBootstrapPayload(db), imported: legacyProjects.length };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:project-create" satisfies VolliIpcChannel,
    (_event, input: unknown): ProjectCreateResult => {
      if (!isProjectCreateInput(input)) {
        return { ok: false, error: "Invalid project" };
      }
      try {
        const existing = findProjectByPath(db, input.path);
        if (existing) {
          return { ok: true, project: existing, created: false };
        }
        let stats;
        try {
          stats = statSync(input.path);
        } catch {
          return { ok: false, error: "Project path does not exist" };
        }
        if (!stats.isDirectory()) {
          return { ok: false, error: "Project path is not a directory" };
        }
        const now = Date.now();
        const ticketPrefix = derivePrefix(input.name);
        const prefixValidation = validateUniquePrefix(ticketPrefix, listProjects(db));
        if (!prefixValidation.ok) return { ok: false, error: prefixValidation.error };
        const project: Project = {
          id: randomUUID(),
          name: input.name,
          path: input.path,
          ticketPrefix,
          baseBranch: (options.detectBaseBranch ?? detectProjectBaseBranch)(input.path),
          colorIndex: countProjects(db) % PROJECT_COLORS.length,
          sortOrder: nextSortOrder(db),
          createdAt: now,
          updatedAt: now,
        };
        insertProject(db, project);
        return { ok: true, project, created: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:project-remove" satisfies VolliIpcChannel,
    (_event, id: unknown): ProjectMutationResult => {
      if (typeof id !== "string") {
        return { ok: false, error: "Invalid project id" };
      }
      try {
        deleteProject(db, id);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:project-update" satisfies VolliIpcChannel,
    (_event, input: unknown): ProjectUpdateResult => {
      if (!isProjectUpdateInput(input)) {
        return { ok: false, error: "Invalid project base branch" };
      }
      try {
        const now = Date.now();
        const project = updateProjectBaseBranch(db, input.id, input.baseBranch, now);
        if (!project) return { ok: false, error: "Unknown project" };
        if (input.setupCommand === undefined) return { ok: true, project };
        // Same trim-to-null-on-empty semantics as the ticket-update worktree
        // identity fields: an empty command means "skip the setup step".
        const trimmed = input.setupCommand === null ? null : input.setupCommand.trim();
        const normalized = trimmed === "" ? null : trimmed;
        const updated = updateProjectSetupCommand(db, input.id, normalized, now);
        return updated ? { ok: true, project: updated } : { ok: false, error: "Unknown project" };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:project-reorder" satisfies VolliIpcChannel,
    (_event, orderedIds: unknown): ProjectMutationResult => {
      if (!isStringArray(orderedIds)) {
        return { ok: false, error: "Invalid project order" };
      }
      try {
        reorderProjects(db, orderedIds, Date.now());
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-create" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketResult => {
      if (!isTicketCreateInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        const now = Date.now();
        return {
          ok: true,
          ticket: createTicketCommand(
            db,
            {
              id: randomUUID(),
              projectId: input.projectId,
              title: input.title,
              status: input.status,
              priority: input.priority,
              body: input.body,
              labels: input.labels,
              usesWorktree: input.usesWorktree,
              preferredHarnessId: input.preferredHarnessId,
            },
            { now, actor: { kind: "user" } },
          ),
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-move" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketsResult => {
      if (!isTicketMoveInput(input)) {
        return { ok: false, error: "Invalid ticket move" };
      }
      try {
        const now = Date.now();
        const actor = { kind: "user" } as const;
        // Snapshot the pre-move status BEFORE the move so the backward-move
        // interrupt can decide whether the move left the active columns. Reading
        // the raw row (never trusting the renderer) keeps the from-status honest.
        const before = getTicketRow(db, input.ticketId);
        const tickets = moveTicketCommand(db, input, { now, actor });
        // The move committed above (its own transaction); the interrupt is the
        // side effect, fired only for a real backward move (issue #78).
        if (before !== undefined) {
          interruptOnBackwardMove(
            db,
            {
              ticketId: input.ticketId,
              fromStatus: before.status as TicketStatus,
              toStatus: input.toStatus,
            },
            { now, actor },
            options.interruptTicketSessions,
          );
        }
        return { ok: true, tickets };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-set-priority" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketResult => {
      if (!isTicketSetPriorityInput(input)) {
        return { ok: false, error: "Invalid priority change" };
      }
      try {
        const now = Date.now();
        return {
          ok: true,
          ticket: setTicketPriorityCommand(db, input, { now, actor: { kind: "user" } }),
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-update" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketResult => {
      if (!isTicketUpdateInput(input)) {
        return { ok: false, error: "Invalid ticket update" };
      }
      try {
        const now = Date.now();
        return {
          ok: true,
          ticket: updateTicketFieldsCommand(db, input, { now, actor: { kind: "user" } }),
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-set-labels" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketResult => {
      if (!isTicketSetLabelsInput(input)) {
        return { ok: false, error: "Invalid labels" };
      }
      try {
        const now = Date.now();
        return {
          ok: true,
          ticket: setTicketLabelsCommand(db, input, { now, actor: { kind: "user" } }),
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-archive" satisfies VolliIpcChannel,
    (_event, input: unknown): Result => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        const now = Date.now();
        archiveTicketCommand(db, input.ticketId, { now, actor: { kind: "user" } });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-unarchive" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketResult => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        const ticket = unarchiveTicketCommand(db, input.ticketId, {
          now: Date.now(),
          actor: { kind: "user" },
        });
        return { ok: true, ticket };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-delete" satisfies VolliIpcChannel,
    (_event, input: unknown): Result => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        deleteTicketCommand(db, input.ticketId);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-list-archived" satisfies VolliIpcChannel,
    (_event, projectId: unknown): ArchivedTicketsResult => {
      if (typeof projectId !== "string") {
        return { ok: false, error: "Invalid project id" };
      }
      try {
        return { ok: true, tickets: listArchivedTicketsByProject(db, projectId) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-events" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketEventsResult => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        return { ok: true, events: listTicketEvents(db, input.ticketId) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:comment-list" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketCommentsResult => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        return { ok: true, comments: listComments(db, input.ticketId) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:comment-create" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketCommentResult => {
      if (!isCommentCreateInput(input)) {
        return { ok: false, error: "Invalid comment" };
      }
      try {
        const comment = createTicketCommentCommand(
          db,
          {
            ticketId: input.ticketId,
            body: input.body,
            // UI-originated: every comment posted through this renderer-facing
            // channel is authored by the user. Agent-posted session summaries
            // arrive later via the volli CLI, a different (not-yet-built) path.
            commentActor: USER_ACTOR,
            sessionId: input.sessionId,
          },
          { now: Date.now(), actor: { kind: "user" } },
        );
        return { ok: true, comment };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:comment-update" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketCommentResult => {
      if (!isCommentUpdateInput(input)) {
        return { ok: false, error: "Invalid comment update" };
      }
      try {
        const comment = updateComment(
          db,
          { commentId: input.commentId, body: input.body },
          Date.now(),
        );
        if (!comment) return { ok: false, error: "Unknown comment" };
        return { ok: true, comment };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:comment-remove" satisfies VolliIpcChannel,
    (_event, input: unknown): Result => {
      if (!isCommentIdInput(input)) {
        return { ok: false, error: "Invalid comment" };
      }
      try {
        if (!getComment(db, input.commentId)) return { ok: false, error: "Unknown comment" };
        deleteComment(db, input.commentId);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:session-list" satisfies VolliIpcChannel,
    (_event, input: unknown): SessionsResult => {
      if (!isProjectIdInput(input)) {
        return { ok: false, error: "Invalid project" };
      }
      try {
        return { ok: true, sessions: listSessions(db, input.projectId) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:session-list-for-ticket" satisfies VolliIpcChannel,
    (_event, input: unknown): SessionsResult => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        return { ok: true, sessions: listTicketSessions(db, input.ticketId) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:session-rename" satisfies VolliIpcChannel,
    (_event, input: unknown): SessionRenameResult => {
      if (!isSessionRenameInput(input)) {
        return { ok: false, error: "Invalid session title" };
      }
      try {
        const changed = updateTitle(db, input.sessionId, input.title.trim());
        if (changed === 0) return { ok: false, error: "Unknown session" };
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:label-set-color" satisfies VolliIpcChannel,
    (_event, input: unknown): LabelResult => {
      if (!isLabelSetColorInput(input)) {
        return { ok: false, error: "Invalid label color" };
      }
      try {
        const label = setLabelColor(db, input.labelId, input.color, Date.now());
        if (!label) return { ok: false, error: "Unknown label" };
        return { ok: true, label };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:app-state-set" satisfies VolliIpcChannel,
    (_event, key: unknown, value: unknown): AppStateSetResult => {
      if (typeof key !== "string" || typeof value !== "string") {
        return { ok: false, error: "Invalid app state" };
      }
      try {
        setAppState(db, key, value, Date.now());
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:worktree-remove" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<WorktreeRemoveResult> => {
      if (!isWorktreeRemoveInput(input)) {
        return { ok: false, error: "Invalid worktree removal" };
      }
      try {
        // Main-side liveness guard (the renderer context menu's disable is a
        // stale client-side hint only): never yank a worktree out from under a
        // terminal still running in it. Canonicalized containment, same as the
        // orphan-delete guard below.
        const ticket = getTicketRow(db, input.ticketId);
        const worktreePath = ticket?.worktree_path ?? null;
        if (
          worktreePath !== null &&
          liveSessionWithin(worktreePath, options.liveSessionCwds?.() ?? [])
        ) {
          return {
            ok: false,
            error: "Close the terminal sessions running in this worktree before removing it.",
          };
        }
        const result = await removeWorktree(worktreeDeps(db), input.ticketId, {
          force: input.force,
        });
        if (!result.ok) return { ok: false, error: result.error };
        // The worktree identity changed (path cleared) for THIS ticket — re-hydrate
        // every board, and let this ticket's own surfaces refresh promptly.
        broadcastDataChanged({
          ticketId: input.ticketId,
          projectId: ticket?.project_id,
          kind: "worktree",
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:worktree-branches" satisfies VolliIpcChannel,
    (_event, input: unknown): WorktreeBranchesResult => {
      if (!isProjectIdInput(input)) {
        return { ok: false, error: "Invalid project" };
      }
      try {
        const result = listBranches(worktreeDeps(db), input.projectId);
        return result.ok
          ? { ok: true, branches: result.value }
          : { ok: false, error: result.error };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:worktree-orphans" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<WorktreeOrphansResult> => {
      // The startup sweep is DESTRUCTIVE and runs once per launch (index.ts
      // kicks it off after first paint); this returns that cached report so a
      // renderer reload never re-sweeps and races the launch sweep. Only an
      // explicit Settings → Worktrees rescan (`{ rescan: true }`) re-sweeps.
      const rescan =
        typeof input === "object" &&
        input !== null &&
        (input as Record<string, unknown>)["rescan"] === true;
      try {
        const report = await orphanReport(worktreeDeps(db), { rescan });
        return {
          ok: true,
          pruned: report.pruned,
          removedClean: report.removedClean,
          dirty: report.dirty,
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:worktree-orphan-delete" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<WorktreeOrphanDeleteResult> => {
      const path =
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>)["path"]
          : undefined;
      if (typeof path !== "string" || path.length === 0) {
        return { ok: false, error: "Invalid orphan path" };
      }
      // The ONLY dir this channel may touch is a leaf inside the app-owned
      // worktree home — canonicalized on both sides, so no symlink or
      // `../escape` can point the recursive delete anywhere else. The Settings
      // dialog has already shown the dirtiness reason and taken explicit
      // confirmation; this is the one sanctioned rm -rf in the app.
      const home = worktreesHome();
      const target = canonicalizeWorktreePath(path);
      if (!isInsideWorktreeHome(home, target) || samePathAs(home, target)) {
        return { ok: false, error: "Path is outside the worktree home" };
      }
      // Re-verify RIGHT before the irreversible delete — the Settings report is
      // a snapshot that can have gone stale since it was shown.
      //   (b) never delete a worktree the DB still tracks (live OR archived —
      //       listWorktreePaths includes archived rows by design), else a still-
      //       linked ticket dead-ends at a vanished path.
      // `isInside` returns true on equality too, so testing both directions
      // covers target == a tracked path, target inside one, and target being an
      // ancestor of one.
      const knownPaths = listWorktreePaths(db);
      if (
        knownPaths.some(
          (known) => isInsideWorktreeHome(target, known) || isInsideWorktreeHome(known, target),
        )
      ) {
        return {
          ok: false,
          error: "This worktree is still linked to a ticket and can't be deleted here.",
        };
      }
      //   (c) never delete out from under a terminal still running in it.
      if (liveSessionWithin(target, options.liveSessionCwds?.() ?? [])) {
        return {
          ok: false,
          error: "Close the terminal sessions running in this worktree before deleting it.",
        };
      }
      try {
        await rm(target, { recursive: true, force: true });
        // A dirty orphan left the board's attention list. An orphan is by
        // definition unlinked from any live ticket, so there's no ticket to
        // target — untargeted (everyone re-hydrates).
        broadcastDataChanged({ kind: "worktree" });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  // ---- Done flow (docs/plans/done-flow.md) --------------------------------
  // The Details-rail diff/commit/push-PR affordances. `status`/`diff` are
  // read-only (no broadcast); `commit` records an event and `push-pr` writes
  // `pr_url`, so both broadcast to re-hydrate every board.

  ipcMain.handle(
    "volli:worktree-status" satisfies VolliIpcChannel,
    (_event, input: unknown): WorktreeStatusResult => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        // Thin adapter over the ticketId-in read verb (CONCEPT #42): it owns the
        // ticket→identity resolution, the no-worktree discrimination, AND the
        // stamped-but-deleted disk check the CLI door always did but this one
        // used to skip — which fed a deleted path into the errs-dirty status
        // read and lied `uncommitted: true` to the renderer.
        const read = readWorktreeStatus(worktreeDeps(db), input.ticketId);
        switch (read.kind) {
          case "missing-ticket":
            return { ok: false, error: "Unknown ticket" };
          case "no-worktree":
            return { ok: false, error: "This ticket has no worktree." };
          case "missing-on-disk":
            return { ok: false, error: "This ticket's worktree directory is missing on disk." };
          case "ok":
            return { ok: true, status: read.status };
        }
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:worktree-diff" satisfies VolliIpcChannel,
    (_event, input: unknown): WorktreeDiffResult => {
      if (!isWorktreeDiffInput(input)) {
        return { ok: false, error: "Invalid worktree diff request" };
      }
      try {
        const read = readWorktreeDiff(worktreeDeps(db), input.ticketId, input.mode as DiffMode);
        switch (read.kind) {
          case "missing-ticket":
            return { ok: false, error: "Unknown ticket" };
          case "no-worktree":
            return { ok: false, error: "This ticket has no worktree." };
          case "missing-on-disk":
            return { ok: false, error: "This ticket's worktree directory is missing on disk." };
          case "diff-error":
            return { ok: false, error: read.error };
          case "ok":
            return { ok: true, diff: read.diff };
        }
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:worktree-commit" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<WorktreeCommitResult> => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        // The async runner matters here: `git commit` runs unbounded hook code,
        // which must never block the main process (net.ts's freeze rationale).
        const result = await commitTicketRemaining(
          { ...worktreeDeps(db), net: runNet },
          input.ticketId,
        );
        if (!result.ok) return { ok: false, error: result.error };
        if (!result.value.committed) {
          // Clean-tree no-op: nothing landed, no event, nothing to re-hydrate.
          return { ok: true, committed: false, message: null };
        }
        // No ticket row changed, but a `worktree_committed` event landed on THIS
        // ticket. Targeting it is what lets the Details rail's git summary refresh
        // promptly (the CLI/rail-side commit → rail guarantee, issue #80) instead
        // of riding the debounced untargeted arm.
        broadcastDataChanged({ ticketId: input.ticketId, kind: "worktree" });
        return { ok: true, committed: true, message: result.value.message };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:worktree-push-pr" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<WorktreePushPrResult> => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        const result = await publishTicketBranch(
          { ...worktreeDeps(db), net: runNet },
          input.ticketId,
        );
        if (!result.ok) return { ok: false, error: result.error };
        // `pr_url` was written (and a `pr_opened` event recorded) on THIS ticket —
        // target it so its rail refreshes promptly, same as the commit path.
        broadcastDataChanged({ ticketId: input.ticketId, kind: "worktree" });
        return { ok: true, url: result.value.url, existing: result.value.existing };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  // ---- retention (CONCEPT #16, issue #76) ---------------------------------
  // The merge-watch/Done-TTL surface. `state` is a read; `keep`/`dismiss`/
  // `archive-clean`/`ttl-set` mutate and re-hydrate; `poll` triggers an
  // immediate watch poll (e.g. on window focus). The watch singleton
  // (retention-runtime.ts) is shared with index.ts's start/stop + focus wiring.

  ipcMain.handle(
    "volli:retention-state" satisfies VolliIpcChannel,
    (_event, input: unknown): RetentionStateResult => {
      if (!isTicketIdInput(input)) return { ok: false, error: "Invalid ticket" };
      try {
        const state = getRetentionWatcher(db).getState(input.ticketId);
        if (state === null) return { ok: false, error: "Unknown ticket" };
        return { ok: true, state };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:retention-keep" satisfies VolliIpcChannel,
    (_event, input: unknown): RetentionKeepResult => {
      if (!isRetentionKeepInput(input)) return { ok: false, error: "Invalid keep request" };
      try {
        if (!getTicketRow(db, input.ticketId)) return { ok: false, error: "Unknown ticket" };
        setTicketRetentionKeep(db, input.ticketId, input.keep, Date.now());
        // The pin exempts both retention paths for THIS ticket — target it so its
        // retention surface updates promptly.
        broadcastDataChanged({ ticketId: input.ticketId, kind: "retention" });
        return { ok: true, keep: input.keep };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:retention-dismiss" satisfies VolliIpcChannel,
    (_event, input: unknown): RetentionDismissResult => {
      if (!isTicketIdInput(input)) return { ok: false, error: "Invalid ticket" };
      try {
        // In-memory, launch-scoped: the prompt is re-offered next launch.
        getRetentionWatcher(db).dismiss(input.ticketId);
        broadcastDataChanged({ ticketId: input.ticketId, kind: "retention" });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:retention-archive-clean" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<RetentionArchiveCleanResult> => {
      if (!isTicketIdInput(input)) return { ok: false, error: "Invalid ticket" };
      try {
        // Liveness guard, mirroring worktree-remove: never yank a worktree out
        // from under a terminal still running in it.
        const worktreePath = getTicketRow(db, input.ticketId)?.worktree_path ?? null;
        if (
          worktreePath !== null &&
          liveSessionWithin(worktreePath, options.liveSessionCwds?.() ?? [])
        ) {
          return {
            ok: false,
            error: "Close the terminal sessions running in this worktree before archiving it.",
          };
        }
        const result = await archiveAndClean(worktreeDeps(db), input.ticketId);
        if (!result.ok) return { ok: false, error: result.error };
        // The ticket archived + its worktree was removed — target it so its own
        // still-open surfaces refresh (the full re-hydrate drops the card).
        broadcastDataChanged({ ticketId: input.ticketId, kind: "retention" });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle("volli:retention-ttl-get" satisfies VolliIpcChannel, (): RetentionTtlResult => {
    try {
      return { ok: true, days: getRetentionTtlDays(db) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(
    "volli:retention-ttl-set" satisfies VolliIpcChannel,
    (_event, input: unknown): RetentionTtlResult => {
      const days =
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>)["days"]
          : undefined;
      if (typeof days !== "number" || !Number.isFinite(days)) {
        return { ok: false, error: "Invalid TTL" };
      }
      try {
        const stored = setRetentionTtlDays(db, days, Date.now());
        // The TTL clock is GLOBAL — it moves every Done ticket's archive-readiness
        // at once, so this is untargeted: every retention surface must re-evaluate.
        broadcastDataChanged({ kind: "retention" });
        return { ok: true, days: stored };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle("volli:retention-poll" satisfies VolliIpcChannel, (): RetentionPollResult => {
    try {
      // Fire-and-forget: the poll runs async and broadcasts on change itself.
      getRetentionWatcher(db).triggerNow();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });
}
