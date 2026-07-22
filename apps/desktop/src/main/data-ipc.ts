import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type Database from "better-sqlite3";
import {
  DATA_CHANNELS,
  DATA_IPC,
  derivePrefix,
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
  CommentCreateInput,
  CommentIdInput,
  CommentUpdateInput,
  DataIpcChannel,
  Label,
  LabelResult,
  LabelSetColorInput,
  LegacyImportRequest,
  LegacyImportResult,
  Project,
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectIdInput,
  ProjectMutationResult,
  ProjectUpdateInput,
  ProjectUpdateResult,
  Result,
  RetentionArchiveCleanResult,
  RetentionDismissResult,
  RetentionKeepInput,
  RetentionKeepResult,
  RetentionPollResult,
  RetentionStateResult,
  RetentionTtlResult,
  RetentionTtlSetInput,
  SessionRenameInput,
  SessionRenameResult,
  SessionsResult,
  Ticket,
  TicketCommentResult,
  TicketCommentsResult,
  TicketCreateInput,
  TicketEventsResult,
  TicketIdInput,
  TicketMoveInput,
  TicketResult,
  TicketSetLabelsInput,
  TicketSetPriorityInput,
  TicketsResult,
  TicketStatus,
  TicketUpdateInput,
  WorktreeBranchesResult,
  WorktreeCommitResult,
  WorktreeDiffInput,
  WorktreeDiffResult,
  WorktreeOrphanDeleteInput,
  WorktreeOrphanDeleteResult,
  WorktreeOrphansInput,
  WorktreeOrphansResult,
  WorktreePushPrResult,
  WorktreeRemoveInput,
  WorktreeRemoveResult,
  WorktreeStatusResult,
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
  diffStat,
  getRetentionTtlDays,
  getWorktreeStatus,
  listBranches,
  publishTicketBranch,
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
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "./ipc-registry";
import type { IpcHandlerTable } from "./ipc-registry";

/** The result of the main-process open+migrate attempt (`src/main/index.ts`), fed into {@link registerDataIpcHandlers}. */
export type DbHandle = { ok: true; db: Database.Database } | { ok: false; error: string };

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
 * boundary either way — the shared envelope (`registerGuardedIpcHandlers`)
 * catches and converts every handler's throw/rejection.
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
    registerDegradedIpcHandlers(DATA_CHANNELS, handle.error);
    return;
  }

  const db = handle.db;

  const handlers: IpcHandlerTable<DataIpcChannel> = {
    "volli:data-bootstrap": (): BootstrapResult => {
      return { ok: true, data: buildBootstrapPayload(db) };
    },

    "volli:legacy-import": (request: LegacyImportRequest): LegacyImportResult => {
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
    },

    "volli:project-create": (input: ProjectCreateInput): ProjectCreateResult => {
      const existing = findProjectByPath(db, input.path);
      if (existing) {
        return { ok: true, project: existing, created: false };
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
    },

    "volli:project-remove": (id: string): ProjectMutationResult => {
      deleteProject(db, id);
      return { ok: true };
    },

    "volli:project-update": (input: ProjectUpdateInput): ProjectUpdateResult => {
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
    },

    "volli:project-reorder": (orderedIds: string[]): ProjectMutationResult => {
      reorderProjects(db, orderedIds, Date.now());
      return { ok: true };
    },

    "volli:ticket-create": (input: TicketCreateInput): TicketResult => {
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
    },

    "volli:ticket-move": (input: TicketMoveInput): TicketsResult => {
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
    },

    "volli:ticket-set-priority": (input: TicketSetPriorityInput): TicketResult => {
      const now = Date.now();
      return {
        ok: true,
        ticket: setTicketPriorityCommand(db, input, { now, actor: { kind: "user" } }),
      };
    },

    "volli:ticket-update": (input: TicketUpdateInput): TicketResult => {
      const now = Date.now();
      return {
        ok: true,
        ticket: updateTicketFieldsCommand(db, input, { now, actor: { kind: "user" } }),
      };
    },

    "volli:ticket-set-labels": (input: TicketSetLabelsInput): TicketResult => {
      const now = Date.now();
      return {
        ok: true,
        ticket: setTicketLabelsCommand(db, input, { now, actor: { kind: "user" } }),
      };
    },

    "volli:ticket-archive": (input: TicketIdInput): Result => {
      const now = Date.now();
      archiveTicketCommand(db, input.ticketId, { now, actor: { kind: "user" } });
      return { ok: true };
    },

    "volli:ticket-unarchive": (input: TicketIdInput): TicketResult => {
      const ticket = unarchiveTicketCommand(db, input.ticketId, {
        now: Date.now(),
        actor: { kind: "user" },
      });
      return { ok: true, ticket };
    },

    "volli:ticket-delete": (input: TicketIdInput): Result => {
      deleteTicketCommand(db, input.ticketId);
      return { ok: true };
    },

    "volli:ticket-list-archived": (projectId: string): ArchivedTicketsResult => {
      return { ok: true, tickets: listArchivedTicketsByProject(db, projectId) };
    },

    "volli:ticket-events": (input: TicketIdInput): TicketEventsResult => {
      return { ok: true, events: listTicketEvents(db, input.ticketId) };
    },

    "volli:comment-list": (input: TicketIdInput): TicketCommentsResult => {
      return { ok: true, comments: listComments(db, input.ticketId) };
    },

    "volli:comment-create": (input: CommentCreateInput): TicketCommentResult => {
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
    },

    "volli:comment-update": (input: CommentUpdateInput): TicketCommentResult => {
      const comment = updateComment(
        db,
        { commentId: input.commentId, body: input.body },
        Date.now(),
      );
      if (!comment) return { ok: false, error: "Unknown comment" };
      return { ok: true, comment };
    },

    "volli:comment-remove": (input: CommentIdInput): Result => {
      if (!getComment(db, input.commentId)) return { ok: false, error: "Unknown comment" };
      deleteComment(db, input.commentId);
      return { ok: true };
    },

    "volli:session-list": (input: ProjectIdInput): SessionsResult => {
      return { ok: true, sessions: listSessions(db, input.projectId) };
    },

    "volli:session-list-for-ticket": (input: TicketIdInput): SessionsResult => {
      return { ok: true, sessions: listTicketSessions(db, input.ticketId) };
    },

    "volli:session-rename": (input: SessionRenameInput): SessionRenameResult => {
      const changed = updateTitle(db, input.sessionId, input.title.trim());
      if (changed === 0) return { ok: false, error: "Unknown session" };
      return { ok: true };
    },

    "volli:label-set-color": (input: LabelSetColorInput): LabelResult => {
      const label = setLabelColor(db, input.labelId, input.color, Date.now());
      if (!label) return { ok: false, error: "Unknown label" };
      return { ok: true, label };
    },

    "volli:app-state-set": (key: string, value: string): AppStateSetResult => {
      setAppState(db, key, value, Date.now());
      return { ok: true };
    },

    "volli:worktree-remove": async (input: WorktreeRemoveInput): Promise<WorktreeRemoveResult> => {
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
      // The worktree identity changed (path cleared) — re-hydrate every board.
      broadcastDataChanged();
      return { ok: true };
    },

    "volli:worktree-branches": (input: ProjectIdInput): WorktreeBranchesResult => {
      const result = listBranches(worktreeDeps(db), input.projectId);
      return result.ok ? { ok: true, branches: result.value } : { ok: false, error: result.error };
    },

    "volli:worktree-orphans": async (
      opts?: WorktreeOrphansInput,
    ): Promise<WorktreeOrphansResult> => {
      // The startup sweep is DESTRUCTIVE and runs once per launch (index.ts
      // kicks it off after first paint); this returns that cached report so a
      // renderer reload never re-sweeps and races the launch sweep. Only an
      // explicit Settings → Worktrees rescan (`{ rescan: true }`) re-sweeps.
      const rescan = opts?.rescan === true;
      const report = await orphanReport(worktreeDeps(db), { rescan });
      return {
        ok: true,
        pruned: report.pruned,
        removedClean: report.removedClean,
        dirty: report.dirty,
      };
    },

    "volli:worktree-orphan-delete": async (
      input: WorktreeOrphanDeleteInput,
    ): Promise<WorktreeOrphanDeleteResult> => {
      const { path } = input;
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
      await rm(target, { recursive: true, force: true });
      // A dirty orphan left the board's attention list — re-hydrate.
      broadcastDataChanged();
      return { ok: true };
    },

    // ---- Done flow (docs/plans/done-flow.md) --------------------------------
    // The Details-rail diff/commit/push-PR affordances. `status`/`diff` are
    // read-only (no broadcast); `commit` records an event and `push-pr` writes
    // `pr_url`, so both broadcast to re-hydrate every board.

    "volli:worktree-status": (input: TicketIdInput): WorktreeStatusResult => {
      const ticket = getTicketRow(db, input.ticketId);
      if (!ticket?.worktree_path) {
        return { ok: false, error: "This ticket has no worktree." };
      }
      const status = getWorktreeStatus(worktreeDeps(db).git, {
        worktreePath: ticket.worktree_path,
        branch: ticket.branch,
        baseBranch: ticket.base_branch,
      });
      return { ok: true, status };
    },

    "volli:worktree-diff": (input: WorktreeDiffInput): WorktreeDiffResult => {
      const ticket = getTicketRow(db, input.ticketId);
      if (!ticket?.worktree_path) {
        return { ok: false, error: "This ticket has no worktree." };
      }
      const result = diffStat(
        worktreeDeps(db).git,
        { worktreePath: ticket.worktree_path, baseBranch: ticket.base_branch },
        input.mode as DiffMode,
      );
      return result.ok ? { ok: true, diff: result.value } : { ok: false, error: result.error };
    },

    "volli:worktree-commit": async (input: TicketIdInput): Promise<WorktreeCommitResult> => {
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
      // No ticket row changed, but a `worktree_committed` event landed — the
      // Activity feed hydrates from the same bootstrap, so re-hydrate boards.
      broadcastDataChanged();
      return { ok: true, committed: true, message: result.value.message };
    },

    "volli:worktree-push-pr": async (input: TicketIdInput): Promise<WorktreePushPrResult> => {
      const result = await publishTicketBranch(
        { ...worktreeDeps(db), net: runNet },
        input.ticketId,
      );
      if (!result.ok) return { ok: false, error: result.error };
      // `pr_url` was written (and a `pr_opened` event recorded) — re-hydrate.
      broadcastDataChanged();
      return { ok: true, url: result.value.url, existing: result.value.existing };
    },

    // ---- retention (CONCEPT #16, issue #76) ---------------------------------
    // The merge-watch/Done-TTL surface. `state` is a read; `keep`/`dismiss`/
    // `archive-clean`/`ttl-set` mutate and re-hydrate; `poll` triggers an
    // immediate watch poll (e.g. on window focus). The watch singleton
    // (retention-runtime.ts) is shared with index.ts's start/stop + focus wiring.

    "volli:retention-state": (input: TicketIdInput): RetentionStateResult => {
      const state = getRetentionWatcher(db).getState(input.ticketId);
      if (state === null) return { ok: false, error: "Unknown ticket" };
      return { ok: true, state };
    },

    "volli:retention-keep": (input: RetentionKeepInput): RetentionKeepResult => {
      if (!getTicketRow(db, input.ticketId)) return { ok: false, error: "Unknown ticket" };
      setTicketRetentionKeep(db, input.ticketId, input.keep, Date.now());
      // The pin exempts both retention paths — re-hydrate so the surface updates.
      broadcastDataChanged();
      return { ok: true, keep: input.keep };
    },

    "volli:retention-dismiss": (input: TicketIdInput): RetentionDismissResult => {
      // In-memory, launch-scoped: the prompt is re-offered next launch.
      getRetentionWatcher(db).dismiss(input.ticketId);
      broadcastDataChanged();
      return { ok: true };
    },

    "volli:retention-archive-clean": async (
      input: TicketIdInput,
    ): Promise<RetentionArchiveCleanResult> => {
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
      broadcastDataChanged();
      return { ok: true };
    },

    "volli:retention-ttl-get": (): RetentionTtlResult => {
      return { ok: true, days: getRetentionTtlDays(db) };
    },

    "volli:retention-ttl-set": (input: RetentionTtlSetInput): RetentionTtlResult => {
      const stored = setRetentionTtlDays(db, input.days, Date.now());
      // The TTL clock moved — re-evaluate every ticket's archive-readiness.
      broadcastDataChanged();
      return { ok: true, days: stored };
    },

    "volli:retention-poll": (): RetentionPollResult => {
      // Fire-and-forget: the poll runs async and broadcasts on change itself.
      getRetentionWatcher(db).triggerNow();
      return { ok: true };
    },
  };

  registerGuardedIpcHandlers(DATA_IPC, handlers);
}
