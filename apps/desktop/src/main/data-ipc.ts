import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import type Database from "better-sqlite3";
import type { SessionEngine } from "@volli/session-engine";
import {
  derivePrefix,
  errorMessage,
  LEGACY_BACKUP_APP_STATE_KEY,
  PROJECT_COLORS,
  sanitizeLegacyProjects,
  USER_ACTOR,
  validateUniquePrefix,
} from "@volli/shared";
import { DATA_CHANNELS, DATA_IPC } from "./ipc-descriptors";
import type {
  Label,
  Project,
  SessionListingRow,
  SessionProjection,
  Ticket,
  TicketStatus,
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
  LabelResult,
  LabelSetColorInput,
  LegacyImportRequest,
  LegacyImportResult,
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
  TicketCommentResult,
  TicketCommentsResult,
  TicketCreateInput,
  TicketEventsResult,
  TicketIdInput,
  TicketLatestSignalsResult,
  TicketMoveInput,
  TicketResult,
  TicketSetLabelsInput,
  TicketSetPriorityInput,
  TicketStatusEntriesResult,
  TicketUpdateInput,
  TicketsResult,
  WorktreeBaseReadInput,
  WorktreeBaseReadResult,
  WorktreeBranchesResult,
  WorktreeChangeSetResult,
  WorktreeCommitInput,
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
} from "../ipc/contract";
import { getAllAppState, setAppState } from "./db/app-state-repo";
import { deleteComment, getComment, listComments, updateComment } from "./db/comments-repo";
import { listTicketEvents, listTicketStatusEntries } from "./db/events-repo";
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
import {
  chatSessionRecord,
  createDesktopSessionEngine,
  terminalSessionRecord,
} from "./session-control";
import {
  getTicket,
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
  type AgentSiteReleaseReport,
  archiveAndClean,
  commitTicketRemaining,
  ensure,
  getRetentionTtlDays,
  listBranches,
  publishTicketBranch,
  readWorktreeBaseFile,
  readWorktreeChangeSet,
  readWorktreeDiff,
  readWorktreeStatus,
  remove as removeWorktree,
  runNet,
  setRetentionTtlDays,
  WorktreeChangeWatchManager,
} from "./worktree";
import { createCoalescer } from "./worktree/coalesce";
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
 * A directory something is doing work in right now, and which surface is doing
 * it. The surface travels with the directory because the refusal has to name an
 * action the user can actually reach, and stopping an agent and closing a
 * terminal are different doors.
 */
export interface BusyWorktreeSite {
  directory: string;
  surface: "terminal" | "agent";
}

/**
 * The busy site sitting at or under `target`, or `null`. `isInside`
 * canonicalizes both operands, so a terminal running inside a worktree — or an
 * agent mid-turn in it — blocks a remove/orphan-delete that would pull the
 * directory out from under it.
 *
 * The supplier is already asked about one target, so this is a second filter
 * over an answer that should already be scoped: it is what makes the guard
 * independent of how carefully the supplier reads `target`, and terminals in
 * particular are reported unscoped because a live PTY holds its cwd whatever it
 * is doing.
 */
function busySiteWithin(
  target: string,
  sites: readonly BusyWorktreeSite[],
): BusyWorktreeSite | null {
  return sites.find((site) => isInsideWorktreeHome(target, site.directory)) ?? null;
}

/**
 * Why a destructive worktree action was refused: one line, and one recovery the
 * user can reach from where they are. It never names the act it refused — every
 * caller already frames that ("Couldn't remove worktree: …") — so this says only
 * what is in the way and what clears it.
 *
 * It used to say "Close the live sessions running in this worktree", which named
 * an action that does not exist for a chat: there is no close, and the Session
 * it was talking about was routinely one nobody had ever sent a message to. A
 * chat is stopped (the composer's Stop, or Esc); a terminal is closed.
 */
function busyRefusal(site: BusyWorktreeSite): string {
  return site.surface === "agent"
    ? "An agent is still running in this worktree. Stop it first."
    : "A terminal is still running in this worktree. Close it first.";
}

/**
 * The renderer's Session listing: a discriminated row per Session, so a
 * structured-only Session is visible instead of silently dropping out.
 *
 * PRECEDENCE: a Session that has ever opened a terminal attachment renders as
 * its terminal row, byte-for-byte what `terminalSessionRecord` always
 * returned; only an attachment-less or structured-only Session renders as a
 * chat row. The CLI socket (`agent-commands.ts`) applies the same precedence
 * to its own `session.list` since VC-13; its ADDRESSABLE snapshot (identify,
 * peek, the hooks) stays terminal-only on purpose and never reaches here.
 */
function sessionListingRows(sessions: readonly SessionProjection[]): SessionListingRow[] {
  return sessions.map((session): SessionListingRow => {
    const terminal = terminalSessionRecord(session);
    return terminal !== null
      ? { kind: "terminal", record: terminal }
      : { kind: "chat", record: chatSessionRecord(session) };
  });
}

/**
 * Materializes the worktree of a ticket that was just switched INTO worktree
 * scope (VC-98).
 *
 * `ensure` had exactly two callers, both Session boots, so switching scope on
 * for a ticket whose Session already existed recorded `usesWorktree: true` and
 * then had nothing create the checkout. Everything downstream believed the
 * flag: the board showed the ticket as isolated, `volli worktree status`
 * reported no worktree, and the agent already running went on writing to the
 * main checkout. Scope is now a promise this keeps.
 *
 * Deliberately NOT inside `updateTicketFieldsCommand`'s transaction: `ensure`
 * is git work, and no DB write may straddle it (ensure.ts). The flag is the
 * user's recorded intent and stands committed whatever git does next — which
 * is safe, because a ticket left worktree-scoped with no worktree refuses to
 * bind a Session anywhere else (`prepare`, #38) rather than quietly falling
 * back to the main checkout.
 *
 * Live Session bindings are left exactly where they are. A binding is fixed at
 * attach and re-pointing one under a running agent would move its working
 * directory mid-turn; the next attach picks up the materialized worktree on
 * its own, and `volli identify` warns any agent still standing outside it.
 */
async function materializeSwitchedOnWorktree(
  db: Database.Database,
  ticketId: string,
  committed: Ticket,
): Promise<TicketResult> {
  const outcome = await ensure(worktreeDeps(db), ticketId);
  // Broadcast on BOTH outcomes, and before the answer on purpose. Success has a
  // new identity stamp to show. Failure has a scope flag that really did change
  // under a renderer that is about to revert it optimistically off the back of
  // the error below — and the re-hydrate is what puts the true value back. It
  // lands last by construction rather than by luck: this event is sent before
  // the reply, so the renderer starts its bootstrap round-trip before it sees
  // the error, and a round-trip cannot outrun a message already queued.
  broadcastDataChanged({ ticketId, projectId: committed.projectId, kind: "worktree" });
  if (!outcome.ok) {
    // Surfaced as a failed mutation so it reaches a toast rather than living
    // only in the phase stream (CLAUDE.md: never swallow a failed mutation).
    // The ticket stays worktree-scoped with no worktree, which is a state the
    // app already knows how to be in — it is what every ticket looks like
    // before its first Session — and the next session start retries `ensure`.
    return { ok: false, error: `worktree scope is on, but ${outcome.error}` };
  }
  // Re-read: `ensure` stamped path/branch/base after `committed` was captured.
  return { ok: true, ticket: getTicket(db, ticketId) ?? committed };
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
     * Every directory a local execution surface is doing work in that could
     * block destroying `target`: the cwd of each live PTY, plus the worktree of
     * each agent binding under `target` with a turn open. The worktree
     * remove/orphan-delete/archive guards refuse to touch a directory named
     * here. Absent (tests, degraded boot) means "assume none" — the guards then
     * rely on the git/dirtiness checks.
     *
     * Async because agent busyness is a fact about the Session's ledger, not
     * about the binding holding the directory: a binding stays open across an
     * idle chat and outlives its tab, so reading "attached" as "busy" is what
     * made a ticket with one empty chat in it permanently unarchivable.
     *
     * It takes the target because that read is the expensive one — one durable
     * projection per binding — and a launch with a dozen chats open would
     * otherwise pay for all of them, plus the cache eviction that costs, on
     * every destructive action. The guard filters the answer again anyway.
     */
    busyWorktreeSites?: (target: string) => Promise<readonly BusyWorktreeSite[]>;
    /**
     * Ends every structured binding rooted at a directory that is about to stop
     * existing, so no Session is left dispatching an agent into a deleted path.
     * `remove` runs it inside the ticket paths; orphan-delete calls it here.
     * Absent (tests, degraded boot) means there is nothing structured to end.
     */
    releaseAgentSites?: (directory: string) => Promise<AgentSiteReleaseReport>;
    /**
     * Interrupts every live agent attachment of a ticket after a committed
     * backward move. The manager records intent and confirmed Esc delivery in
     * each Session ledger; it does not close the attachment or emit a planner
     * lifecycle event. Absent (tests, degraded boot) means a no-op.
     */
    interruptTicketSessions?: (ticketId: string) => string[] | Promise<string[]>;
    /** The app's single durable Session Engine. */
    sessionEngine?: SessionEngine;
  } = {},
): void {
  if (!handle.ok) {
    registerDegradedIpcHandlers(DATA_CHANNELS, handle.error);
    return;
  }

  const db = handle.db;
  const sessionEngine = options.sessionEngine ?? createDesktopSessionEngine(db);
  const changeWatchManager = new WorktreeChangeWatchManager();
  const coalesceChangeSet = createCoalescer();

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
    },

    "volli:project-remove": (id: string): ProjectMutationResult => {
      deleteProject(db, id);
      return { ok: true };
    },

    "volli:project-update": (input: ProjectUpdateInput): ProjectUpdateResult => {
      const now = Date.now();
      let project = updateProjectBaseBranch(db, input.id, input.baseBranch, now);
      if (!project) return { ok: false, error: "Unknown project" };
      if (input.setupCommand !== undefined) {
        // Same trim-to-null-on-empty semantics as the ticket-update worktree
        // identity fields: an empty command means "skip the setup step".
        const trimmed = input.setupCommand === null ? null : input.setupCommand.trim();
        const normalized = trimmed === "" ? null : trimmed;
        project = updateProjectSetupCommand(db, input.id, normalized, now);
        if (!project) return { ok: false, error: "Unknown project" };
      }
      return { ok: true, project };
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
            baseBranch: input.baseBranch,
          },
          { now, actor: { kind: "user" } },
        ),
      };
    },

    "volli:ticket-move": (input: TicketMoveInput): TicketsResult | Promise<TicketsResult> => {
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
        const interrupt = interruptOnBackwardMove(
          {
            ticketId: input.ticketId,
            fromStatus: before.status as TicketStatus,
            toStatus: input.toStatus,
          },
          options.interruptTicketSessions,
        );
        if (interrupt instanceof Promise) {
          return interrupt.then(
            () => ({ ok: true, tickets }),
            (error: unknown) => {
              // The board mutation already committed. An after-the-fact Esc
              // delivery failure is operational evidence, not grounds to lie
              // to the renderer that its deliberate move failed.
              console.error(
                `[volli] failed to interrupt ticket sessions after committed move: ${errorMessage(error)}`,
              );
              return { ok: true, tickets };
            },
          );
        }
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

    "volli:ticket-update": (input: TicketUpdateInput): TicketResult | Promise<TicketResult> => {
      const now = Date.now();
      // Read BEFORE the write: the returned ticket shows scope as it now stands,
      // which cannot tell "just switched on" from "was already on" — and only
      // the transition materializes.
      const before = getTicketRow(db, input.ticketId);
      const ticket = updateTicketFieldsCommand(db, input, { now, actor: { kind: "user" } });
      // Only the one transition goes async. Every other update — a title, a
      // body, a branch stamp — stays the synchronous write it has always been,
      // the same split `volli:ticket-move` makes for its interrupt side effect.
      const switchedOn =
        before !== undefined && before.uses_worktree === 0 && ticket.usesWorktree === true;
      if (!switchedOn) return { ok: true, ticket };
      return materializeSwitchedOnWorktree(db, input.ticketId, ticket);
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

    "volli:ticket-latest-signals": async (
      input: ProjectIdInput,
    ): Promise<TicketLatestSignalsResult> => {
      return {
        ok: true,
        signals: [...(await sessionEngine.listLatestTicketSignals({ projectId: input.projectId }))],
      };
    },

    "volli:ticket-status-entries": (input: ProjectIdInput): TicketStatusEntriesResult => {
      return { ok: true, entries: listTicketStatusEntries(db, input.projectId) };
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

    "volli:session-list": async (input: ProjectIdInput): Promise<SessionsResult> => {
      const sessions = await sessionEngine.listSessions({
        projectId: input.projectId,
        scope: "all",
      });
      return { ok: true, sessions: sessionListingRows(sessions) };
    },

    "volli:session-list-for-ticket": async (input: TicketIdInput): Promise<SessionsResult> => {
      const ticket = getTicketRow(db, input.ticketId);
      if (ticket === undefined) return { ok: true, sessions: [] };
      const sessions = await sessionEngine.listSessions({
        projectId: ticket.project_id,
        scope: "ticket",
        ticketId: input.ticketId,
      });
      return { ok: true, sessions: sessionListingRows(sessions) };
    },

    "volli:session-rename": async (input: SessionRenameInput): Promise<SessionRenameResult> => {
      const existing = await sessionEngine.getSession({ sessionId: input.sessionId });
      if (existing === null) return { ok: false, error: "Unknown session" };
      const submitted = await sessionEngine.submit({
        commandId: randomUUID(),
        sessionId: input.sessionId,
        intent: { kind: "session.retitle", title: input.title.trim() },
        provenance: {
          source: { kind: "user", id: "renderer", detail: null },
          venue: { id: "local", kind: "local" },
        },
      });
      if (submitted.receipt?.status !== "completed") {
        return { ok: false, error: "Session rename was not completed" };
      }
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
      // Main-side busy guard (the renderer context menu's disable is a stale
      // client-side hint only): never yank a worktree out from under work in
      // flight. Canonicalized containment, same as the orphan-delete guard below.
      const ticket = getTicketRow(db, input.ticketId);
      const worktreePath = ticket?.worktree_path ?? null;
      const busy =
        worktreePath === null
          ? null
          : busySiteWithin(worktreePath, (await options.busyWorktreeSites?.(worktreePath)) ?? []);
      if (busy !== null) return { ok: false, error: busyRefusal(busy) };
      // `remove` ends the bindings rooted in the checkout as its last act before
      // deleting it — after its own dirty re-check, so a refusal costs the user
      // no chat.
      const result = await removeWorktree(worktreeDeps(db), input.ticketId, {
        force: input.force,
        releaseAgentSites: options.releaseAgentSites,
      });
      if (!result.ok) return { ok: false, error: result.error };
      // The directory is gone; every window's recursive watch on it must go
      // with it. Renderers never unwatch here — from their side the ticket
      // simply stopped having a worktree.
      changeWatchManager.unwatchTicket(input.ticketId);
      // The worktree identity changed (path cleared) for THIS ticket — re-hydrate
      // every board, and let this ticket's own surfaces refresh promptly.
      broadcastDataChanged({
        ticketId: input.ticketId,
        projectId: ticket?.project_id,
        kind: "worktree",
      });
      return { ok: true };
    },

    "volli:worktree-branches": (input: ProjectIdInput): WorktreeBranchesResult => {
      const result = listBranches(worktreeDeps(db), input.projectId);
      return result.ok ? { ok: true, ...result.value } : { ok: false, error: result.error };
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
      //   (c) never delete out from under work still in flight in it.
      const busy = busySiteWithin(target, (await options.busyWorktreeSites?.(target)) ?? []);
      if (busy !== null) return { ok: false, error: busyRefusal(busy) };
      // A ticket delete only nulls `sessions.ticket_id`, so a Session can still
      // be bound to an orphan — end it here, in the same beat as the delete, the
      // way `remove` does on the ticket paths. Nothing gates on the result: the
      // Settings row that reached this channel printed the orphan's own
      // dirtiness reason behind a confirm, and this is the ONLY way to clear one.
      await options.releaseAgentSites?.(target);
      await rm(target, { recursive: true, force: true });
      // A dirty orphan left the board's attention list. An orphan is by
      // definition unlinked from any live ticket, so there's no ticket to
      // target — untargeted (everyone re-hydrates).
      broadcastDataChanged({ kind: "worktree" });
      return { ok: true };
    },

    // ---- Done flow (docs/plans/done-flow.md) --------------------------------
    // The Details-rail diff/commit/push-PR affordances. `status`/`diff` are
    // read-only (no broadcast); `commit` records an event and `push-pr` writes
    // `pr_url`, so both broadcast to re-hydrate every board.

    "volli:worktree-status": (input: TicketIdInput): WorktreeStatusResult => {
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
    },

    "volli:worktree-diff": (input: WorktreeDiffInput): WorktreeDiffResult => {
      const read = readWorktreeDiff(worktreeDeps(db), input.ticketId, input.mode);
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
    },

    "volli:worktree-change-set": async (input: TicketIdInput): Promise<WorktreeChangeSetResult> => {
      // Coalesced per ticket: a burst of filesystem events can have several
      // panels and windows asking at once, and each snapshot is five git
      // commands over the whole worktree.
      const read = await coalesceChangeSet(input.ticketId, () =>
        readWorktreeChangeSet(worktreeDeps(db), input.ticketId),
      );
      switch (read.kind) {
        case "missing-ticket":
          return { ok: false, error: "Unknown ticket" };
        case "no-worktree":
          return { ok: false, error: "This ticket has no worktree." };
        case "missing-on-disk":
          return { ok: false, error: "This ticket's worktree directory is missing on disk." };
        case "change-set-error":
          return { ok: false, error: read.error };
        case "ok":
          return { ok: true, changeSet: read.changeSet };
      }
    },

    "volli:worktree-base-read": async (
      input: WorktreeBaseReadInput,
    ): Promise<WorktreeBaseReadResult> => {
      const read = await readWorktreeBaseFile(
        worktreeDeps(db),
        input.ticketId,
        input.path,
        input.baseRevision,
      );
      switch (read.kind) {
        case "missing-ticket":
          return { ok: false, error: "Unknown ticket" };
        case "no-worktree":
          return { ok: false, error: "This ticket has no worktree." };
        case "missing-on-disk":
          return { ok: false, error: "This ticket's worktree directory is missing on disk." };
        case "base-read-error":
          return { ok: false, error: read.error };
        case "ok": {
          const file = read.file;
          if (file.missing === true) return { ok: true, missing: true };
          if (file.binary === true) return { ok: true, binary: true };
          return { ok: true, content: file.content, truncated: file.truncated };
        }
      }
    },

    "volli:worktree-change-watch": (input: TicketIdInput, sender): Result => {
      const status = readWorktreeStatus(worktreeDeps(db), input.ticketId);
      switch (status.kind) {
        case "missing-ticket":
          return { ok: false, error: "Unknown ticket" };
        case "no-worktree":
          return { ok: false, error: "This ticket has no worktree." };
        case "missing-on-disk":
          return { ok: false, error: "This ticket's worktree directory is missing on disk." };
        case "ok":
          return changeWatchManager.watch(sender, input.ticketId, status.worktreePath);
      }
    },

    "volli:worktree-change-unwatch": (input: TicketIdInput, sender): Result => {
      changeWatchManager.unwatch(sender, input.ticketId);
      return { ok: true };
    },

    "volli:worktree-commit": async (input: WorktreeCommitInput): Promise<WorktreeCommitResult> => {
      // The async runner matters here: `git commit` runs unbounded hook code,
      // which must never block the main process (net.ts's freeze rationale).
      // The two choices are forwarded RAW: the descriptor guard has already
      // shape-checked them at the door, and what "blank" and "absent" mean is
      // commit.ts's to decide, in one place, for every caller.
      const result = await commitTicketRemaining(
        { ...worktreeDeps(db), net: runNet },
        input.ticketId,
        { message: input.message, includeUnstaged: input.includeUnstaged },
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
    },

    "volli:worktree-push-pr": async (input: TicketIdInput): Promise<WorktreePushPrResult> => {
      const result = await publishTicketBranch(
        { ...worktreeDeps(db), net: runNet },
        input.ticketId,
      );
      if (!result.ok) return { ok: false, error: result.error };
      // `pr_url` was written (and a `pr_opened` event recorded) on THIS ticket —
      // target it so its rail refreshes promptly, same as the commit path.
      broadcastDataChanged({ ticketId: input.ticketId, kind: "worktree" });
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
      // The pin exempts both retention paths for THIS ticket — target it so its
      // retention surface updates promptly.
      broadcastDataChanged({ ticketId: input.ticketId, kind: "retention" });
      return { ok: true, keep: input.keep };
    },

    "volli:retention-dismiss": (input: TicketIdInput): RetentionDismissResult => {
      // In-memory, launch-scoped: the prompt is re-offered next launch.
      getRetentionWatcher(db).dismiss(input.ticketId);
      broadcastDataChanged({ ticketId: input.ticketId, kind: "retention" });
      return { ok: true };
    },

    "volli:retention-archive-clean": async (
      input: TicketIdInput,
    ): Promise<RetentionArchiveCleanResult> => {
      // Busy guard, mirroring worktree-remove: never yank a worktree out from
      // under work still in flight in it.
      const worktreePath = getTicketRow(db, input.ticketId)?.worktree_path ?? null;
      const busy =
        worktreePath === null
          ? null
          : busySiteWithin(worktreePath, (await options.busyWorktreeSites?.(worktreePath)) ?? []);
      if (busy !== null) return { ok: false, error: busyRefusal(busy) };
      const result = await archiveAndClean(worktreeDeps(db), input.ticketId, {
        releaseAgentSites: options.releaseAgentSites,
      });
      if (!result.ok) return { ok: false, error: result.error };
      // Same as worktree-remove: the archived worktree's directory is gone, so
      // no window may keep a recursive watch pinned to it.
      changeWatchManager.unwatchTicket(input.ticketId);
      // The ticket archived + its worktree was removed — target it so its own
      // still-open surfaces refresh (the full re-hydrate drops the card).
      broadcastDataChanged({ ticketId: input.ticketId, kind: "retention" });
      return { ok: true };
    },

    "volli:retention-ttl-get": (): RetentionTtlResult => {
      return { ok: true, days: getRetentionTtlDays(db) };
    },

    "volli:retention-ttl-set": (input: RetentionTtlSetInput): RetentionTtlResult => {
      const stored = setRetentionTtlDays(db, input.days, Date.now());
      // The TTL clock is GLOBAL — it moves every Done ticket's archive-readiness
      // at once, so this is untargeted: every retention surface must re-evaluate.
      broadcastDataChanged({ kind: "retention" });
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
