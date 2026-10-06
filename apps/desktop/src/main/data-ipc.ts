import { clientEventSink } from "./client-event-sink";
import { assertRendererAppStateKey } from "./app-state-key-guard";
import { randomUUID } from "node:crypto";
import {
  withTransaction,
  createBlobLink,
  deleteBlobLink,
  listLinkViews,
  listMaterializableLinks,
  listMcpOperations,
  getAllAppState,
  setAppState,
  MIN_READER_VERSION_KEY,
  deleteComment,
  getComment,
  listComments,
  updateComment,
  listTicketEvents,
  listTicketStatusEntries,
  listAllLabels,
  listLabelsByProject,
  setLabelColor,
  countProjects,
  deleteProject,
  getProjectById,
  insertProject,
  listProjects,
  updateProjectAuthorityPolicy,
  updateProjectBaseBranch,
  updateProjectSessionDefaults,
  updateProjectSetupCommand,
  updateProjectSkillModes,
  readSessionUnread,
  writeSessionUnread,
  prepared,
  getTicket,
  getTicketBody,
  getTicketRow,
  listAllTickets,
  listArchivedTicketsByProject,
  listTicketRosterByProject,
  listWorktreePaths,
  setTicketRetentionKeep,
} from "@volli/host-core/db";
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { shell } from "electron";
import type Database from "better-sqlite3";
import type { DbHandle } from "@volli/host-core";
import {
  type DetachedWorkPort,
  createProject,
  inspectProjectFolder,
  relinkProject,
  archiveTicketCommand,
  createTicketCommand,
  createTicketCommentCommand,
  deleteTicketCommand,
  setTicketLabelsCommand,
  setTicketPriorityCommand,
  unarchiveTicketCommand,
  updateTicketFieldsCommand,
  trimFinishedTicketInBackground,
  withTicketWake,
} from "@volli/host-core/board";
import {
  type HostMaintenance,
  invalidateOrphanScan,
  orphanScanReport,
  resolveCleanupPlan,
  getRetentionWatcher,
} from "@volli/host-core/maintenance";
import type { OpenNativeBinding, SessionEngine } from "@volli/session-engine";
import {
  parseSkillModes,
  errorMessage,
  validateAuthorityPolicyOverride,
  LEGACY_BACKUP_APP_STATE_KEY,
  sanitizeLegacyProjects,
  USER_ACTOR,
  WORKTREE_MISSING_ON_DISK,
} from "@volli/shared";
import { attachBlob, sessionLinkBudgetRefusal } from "@volli/host-core/files";

import { DATA_CHANNELS, DATA_IPC } from "./ipc-descriptors";
import {
  type AutoTitleRequest,
  removeTicketToolOutput,
  type StopSessionByIdPorts,
} from "@volli/host-core/session-runtime";
import { McpSettingsService } from "@volli/host-core/integrations";
import type { AuthorityPolicyOverride, DataChangedEvent, Label, Ticket } from "@volli/shared";
import type {
  AppStateSetResult,
  ArchivedTicketsResult,
  BlobAttachInput,
  BlobAttachResult,
  BlobLinkDraftsInput,
  BlobLinkIdInput,
  BlobLinksResult,
  BlobListInput,
  BlobMaterializedInput,
  BlobMaterializedResult,
  BootstrapPayload,
  BootstrapResult,
  CommentCreateInput,
  CommentIdInput,
  CommentUpdateInput,
  DatabaseAction,
  DatabaseResult,
  DataIpcChannel,
  LabelResult,
  LabelSetColorInput,
  LegacyImportRequest,
  LegacyImportResult,
  McpProjectInput,
  McpSaveInput,
  McpServerIdInput,
  McpServerInput,
  McpSetEnabledInput,
  McpSetToolsInput,
  McpSignInInput,
  McpSignInResult,
  ProjectAuthorityPolicyInput,
  ProjectAuthorityPolicyResult,
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectFolderResult,
  ProjectIdInput,
  ProjectMutationResult,
  ProjectRelinkInput,
  ProjectRelinkResult,
  ProjectSessionDefaultsInput,
  ProjectSkillModesInput,
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
  SessionPeekContentInput,
  SessionPeekContentResult,
  SessionReadSetInput,
  SessionReadSetResult,
  SessionRenameInput,
  SessionRenameResult,
  SessionsResult,
  SessionStartsInput,
  SessionStartsResult,
  ProjectRosterResult,
  UsageReportInput,
  UsageReportResult,
  TicketBodyResult,
  TicketCommentResult,
  TicketCommentsResult,
  TicketCreateInput,
  TicketEventsResult,
  TicketIdInput,
  TicketLatestSignalsResult,
  TicketMoveRequest,
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
  WorktreeOrphanCleanupInput,
  WorktreeOrphanCleanupResult,
  WorktreeOrphanDeleteInput,
  WorktreeOrphanDeleteResult,
  WorktreeOrphansInput,
  WorktreeOrphansResult,
  WorktreePushPrResult,
  WorktreeRemoveInput,
  WorktreeRecreateResult,
  WorktreeRemoveResult,
  WorktreeStatusResult,
  WorktreeTrimResult,
  WorktreeTrimScanResult,
  WorktreeTrimSettingsInput,
  WorktreeTrimSettingsResult,
  VenueSnapshotInput,
  VenueSnapshotResult,
} from "../ipc/contract";
/**
 * Both listing channels build their rows through one roster-shaped read
 * (VC-131, VC-392). The provenance question lives beside the other Session read
 * models rather than here, so this handler stays dumb transport and the
 * performance harness can measure the same function the handler calls.
 */
import {
  publishSessionListingRow,
  readSessionPeekContent,
  sessionListingRowsForRoster,
  type SessionPeekContentPorts,
} from "@volli/host-core/sessions";
import { broadcastDataChanged, broadcastSessionActivity, windowEventBus } from "./broadcast";
import { deliverNotification } from "./notifications/runtime";
import { exportDatabase } from "./menu";
import {
  acquireDeletionLease,
  type AgentSiteReleaseReport,
  archiveAndClean,
  busyRefusal,
  busySiteWithin,
  type BusyWorktreeSite,
  type BusyWorktreeSites,
  cleanupOrphans,
  commitTicketRemaining,
  ensure,
  getRetentionTtlDays,
  listBranches,
  OrphanCleanupRefused,
  publishTicketBranch,
  readWorktreeBaseFile,
  readWorktreeChangeSet,
  readVenue,
  readWorktreeDiff,
  readWorktreeStatus,
  resolveWorktreeTarget,
  remove as removeWorktree,
  runNet,
  scanTrimTargets,
  setRetentionTtlDays,
  setTrimSettings,
  trimAllWorktrees,
  WorktreeChangeWatchManager,
  createCoalescer,
  RAIL_READ_SHARE_WINDOW_MS,
  getWorktreeSnapshots,
  credentialHelperIssues,
  canonicalize as canonicalizeWorktreePath,
  isInside as isInsideWorktreeHome,
  isOwnedWorktreePath,
  ownedContainers,
  orphanCleanupEngine,
  worktreeHomeDir,
} from "@volli/host-core/worktree";
import { worktreeDeps } from "./worktree-host";
import {
  DESKTOP_WINDOW_POLICY,
  invokeHandler,
  type HostHandlerMap,
} from "@volli/host-core/handlers";
import type { HandlerCall } from "@volli/shared";

/** The person at this desktop's own window, whose reply carries the board. */
const DESKTOP_WINDOW_CALL: HandlerCall = { actor: { kind: "user" }, origin: "desktop-window" };
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "./ipc-registry";
import type { IpcHandlerTable } from "./ipc-registry";

/** The result of the host's open+migrate attempt (`createHostCore`), fed into {@link registerDataIpcHandlers}. */
export type { DbHandle };

/**
 * The live SQLite database is its main file plus WAL-mode sidecars. A WAL
 * holds committed pages until checkpoint, so `db.name` alone can be much
 * smaller than the storage the database currently occupies. Migration backups
 * are separate recovery files and do not belong to this live footprint.
 */
function databaseStorageBytes(dbPath: string): number {
  let sizeBytes = statSync(dbPath).size;
  for (const suffix of ["-wal", "-shm"]) {
    sizeBytes += statSync(`${dbPath}${suffix}`, { throwIfNoEntry: false })?.size ?? 0;
  }
  return sizeBytes;
}

// ---- bootstrap payload --------------------------------------------------

/**
 * The `projectId` a ticket-scoped invalidation should carry, or nothing when the
 * ticket is unknown (VC-387).
 *
 * A broadcast that names only a `ticketId` costs every window a WHOLE-BOARD
 * re-read, because a scoped refresh cannot ask "which project?" without a
 * second round trip. Main already has the row, so it answers here — one indexed
 * primary-key read, against the bootstrap it saves. Spread it into the scope so
 * an unknown ticket simply omits the key rather than asserting `undefined`.
 */
function ticketScope(db: Database.Database, ticketId: string): { projectId?: string } {
  const projectId = getTicketRow(db, ticketId)?.project_id;
  return projectId === undefined ? {} : { projectId };
}

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

// `BusyWorktreeSite`, `busySiteWithin` and `busyRefusal` moved into the worktree
// module (`worktree/activity.ts`) when VC-284 gave the orphan cleanup the same
// activity protection this file's manual Delete always had: one definition of
// "something is running in there", asked by every destructive route. The type is
// re-exported here because index.ts builds the supplier against it.
export type { BusyWorktreeSite };

/*
 * The renderer's Session listing rows are built by `session-control/listing-row.ts`,
 * which is also what the `volli:session-activity` push uses — the fetch and the
 * push must produce the identical row or a Session changes appearance the moment
 * it moves. The CLI socket (`agent-commands.ts`) applies the same precedence to
 * its own `session.list` since VC-13; its ADDRESSABLE snapshot (identify, peek,
 * the hooks) stays terminal-only on purpose and never reaches here.
 */

/**
 * Tickets whose worktree is being materialized RIGHT NOW (VC-98).
 *
 * `ensure` is git work measured in seconds, and the rail control that starts it
 * is the same one that can switch scope straight back off. That switch-off used
 * to be permitted mid-flight: `updateTicketFieldsCommand` freezes scope only
 * once `worktree_path` is stamped, and the stamp lands at the END of `ensure`.
 * So the off-write committed against a still-null path, `ensure` then stamped a
 * worktree onto a ticket that had just been scoped to the main checkout, and
 * the freeze made the contradiction PERMANENT — `uses_worktree` 0 beside a real
 * worktree on disk, with the destination control gone and no way back through
 * the UI. Holding the ticket here for the duration closes that window.
 */
const materializingWorktrees = new Set<string>();

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
  // Held across the whole await so a concurrent scope-off is refused rather
  // than racing the identity stamp; released in `finally` so a throw cannot
  // strand the ticket un-switchable forever.
  materializingWorktrees.add(ticketId);
  const outcome = await ensure(worktreeDeps(db), ticketId).finally(() => {
    materializingWorktrees.delete(ticketId);
  });
  // A checkout appeared (or the attempt left one half-made): a last-known
  // snapshot taken while the ticket had no worktree cannot describe it (VC-372).
  getWorktreeSnapshots().invalidate(ticketId);
  // Broadcast on BOTH outcomes, and before the answer on purpose. Success has a
  // new identity stamp to show. Failure has a scope flag that really did change
  // under a renderer that is about to revert it optimistically off the back of
  // the error below — and the re-hydrate is what puts the true value back.
  //
  // It lands last because it is COARSER, not because it is queued first. That
  // used to be an ordering argument — sent before the reply, so a round-trip
  // could not outrun a message already on the wire — and the frame-window
  // coalescer in `broadcast.ts` retired it: the invalidation now leaves up to
  // 8ms after the reply, so the optimistic revert wins that race. The outcome is
  // unchanged because the re-hydrate is a full SQLite bootstrap and the revert
  // is one field: whichever order they arrive in, the bootstrap is the last word
  // on that field. Nothing here may be rewritten to depend on arriving first.
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
    detectBaseBranch?: (projectPath: string) => Promise<string | null>;
    detachedWork?: DetachedWorkPort;
    maintenance?: Pick<HostMaintenance, "retention" | "triggerRetention">;
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
     * The host's handler map (VC-668), as far as this legacy channel table
     * still serves catalog commands: `volli:ticket-move` is the IPC projection
     * of `handlers["ticket.move"]`, the one move every door reaches, its
     * interrupts and armed arrival included, invoked under the desktop
     * window's policy. VC-565 deletes the channel when the renderer moves onto
     * the board router.
     */
    handlers: HostHandlerMap;
    /** The app's single durable Session Engine. */
    sessionEngine: SessionEngine | null;
    /**
     * The structured executor bindings this process holds right now. Session
     * attachments stay durably open across relaunch for lazy rehydration, so a
     * listing must project `live` from this host fact rather than from the
     * attachment's durable status. Absent means no executor is currently bound.
     */
    listOpenNativeBindings?: () => readonly Pick<OpenNativeBinding, "attachmentId">[];
    /**
     * The renderer door of model-call titling (VC-81): kicks one refinement
     * off behind a just-written heuristic title. Absent (tests, degraded
     * boot) means the rename succeeds and nothing is refined.
     */
    autoTitle?: (input: AutoTitleRequest) => void;
    /** Budgeted utility refinement, invoked only by the hover-peek content door. */
    summarizePeek?: SessionPeekContentPorts["summarize"];
    /**
     * The live Session runtime's command door, for the person's stop
     * (VC-269): the interrupt and the release a stop performs after its
     * durable record. Absent (tests, degraded boot) means the stop is refused
     * with the reason — nothing is running for it to end.
     */
    sessionRuntime?: StopSessionByIdPorts["runtime"];
    /**
     * Reads one durable transcript artifact, for the peek card's fold (VC-30).
     * The same port `session peek` on the CLI socket is given, from the same
     * store. Absent (tests, degraded boot) means a peek answers with its counts
     * and no entries — honest about having no artifact store, rather than
     * claiming a store looked and failed.
     */
    readTranscriptArtifact?: SessionPeekContentPorts["readArtifact"];
    /**
     * The userData Blob-bytes root (VC-50). Absent in tests that never attach;
     * the attach handler is the only thing that reads it, and it fails honestly
     * rather than writing somewhere arbitrary.
     */
    blobsRoot?: string;
    /** Main-owned MCP settings/discovery service; injected in focused IPC tests. */
    mcpSettings?: McpSettingsService;
    /**
     * Where Pi keeps its sidecars and the tool output saved beside them
     * (VC-469). Archiving or deleting a ticket removes its Sessions' saved
     * output. Absent (tests, degraded boot) means nothing is removed.
     */
    piSessionsDirectory?: string;
  },
): void {
  if (!handle.ok) {
    registerDegradedIpcHandlers(DATA_CHANNELS, handle.error);
    return;
  }

  const db = handle.db;
  const sessionEngine = options.sessionEngine;
  if (sessionEngine === null) throw new Error("Session Engine is unavailable");
  const liveAttachmentIds = (): ReadonlySet<string> =>
    new Set((options.listOpenNativeBindings?.() ?? []).map((binding) => binding.attachmentId));
  const blobsRootPath = options.blobsRoot ?? "";
  const mcpSettings = options.mcpSettings ?? new McpSettingsService({ db });
  const retentionWatcher = () =>
    options.maintenance?.retention ??
    getRetentionWatcher(
      db,
      { events: windowEventBus, attention: { deliver: deliverNotification } },
      () => worktreeDeps(db),
    );

  const changeWatchManager = new WorktreeChangeWatchManager({
    // The rail's last-known snapshot (VC-372) listens to the same watch the
    // renderers do: coverage says whether an answer can be trusted at all, and
    // a relevant change (reported before the debounced broadcast, which is the
    // earliest this process knows) says the answer is already stale.
    onCoverageChange: (ticketId, covered) => {
      const snapshots = getWorktreeSnapshots();
      if (covered) snapshots.noteCovered(ticketId);
      else snapshots.noteUncovered(ticketId);
    },
    onRelevantChange: (ticketIds) => {
      const snapshots = getWorktreeSnapshots();
      for (const ticketId of ticketIds) snapshots.invalidate(ticketId);
    },
  });
  const coalesceChangeSet = createCoalescer();
  /**
   * The rail's status and diff reads, coalesced per ticket the way the Change
   * Set is — and with a share window, because the two rail surfaces
   * (`ticket-repository-summary` and `ticket-changes-panel`, both mounted at
   * once in split view) each fire `worktree.status` on mount for the same
   * ticket. Without the window the second mount queued a second full five-child
   * spawn set behind the first; with it, one read serves both. The window is far
   * below the 250ms watch debounce, so a refresh reacting to a real filesystem
   * change still gets its own fresh run (VC-369).
   */
  const coalesceStatus = createCoalescer({ shareWindowMs: RAIL_READ_SHARE_WINDOW_MS });
  const coalesceDiff = createCoalescer({ shareWindowMs: RAIL_READ_SHARE_WINDOW_MS });

  /**
   * Trims a just-finished ticket's worktree (VC-340), beside the reply rather
   * than inside it: enumerating and removing an ignored tree is a filesystem
   * walk, and a board move must not wait on one.
   *
   * Fire-and-forget is the right shape for it, and the reason is the repo's own
   * rule about failed mutations: nobody asked for this and nothing is waiting on
   * it, so a refusal (a live agent, a changed tracked file) has no recovery to
   * offer and stays in the log. What it does NOT do quietly is succeed — a trim
   * writes `worktree_trimmed` into the ticket's History and broadcasts, so the
   * card it belongs to can account for the files that went.
   */
  /**
   * The sweep's deps: the worktree bundle plus the ONE busy question every
   * destructive worktree route asks. Built per call, like `worktreeDeps(db)`
   * everywhere else here, so nothing caches a stale db handle.
   */
  const busySeam = (): { busySites?: BusyWorktreeSites } =>
    options.busyWorktreeSites === undefined ? {} : { busySites: options.busyWorktreeSites };
  const trimSweepDeps = () => ({ worktree: worktreeDeps(db), ...busySeam() });

  /**
   * Drops a finished ticket's saved tool output (VC-469). Nobody asked for
   * this and the archive or delete already happened, so a failure is logged
   * rather than raised: the runtime's own bound still removes the files,
   * oldest first, when room is needed.
   */
  const releaseTicketToolOutput = (ticketId: string): void => {
    if (options.piSessionsDirectory === undefined) return;
    try {
      removeTicketToolOutput(db, options.piSessionsDirectory, ticketId);
    } catch (error) {
      console.warn(`[volli] Could not remove ticket ${ticketId}'s saved tool output:`, error);
    }
  };

  // An archive's best-effort trim: the move's own lives in its handler.
  const archiveTrimPorts = () => ({
    worktree: worktreeDeps(db),
    now: () => Date.now(),
    detachedWork: options.detachedWork,
    ...busySeam(),
    // The board projection travels in the IPC reply. Only the detached trim
    // needs a push; preserve flag-off renderer invalidation behavior.
    onMutation: (change: Omit<DataChangedEvent, "entity">) => {
      if (change.kind === "worktree") broadcastDataChanged(change);
    },
  });

  const handlers: IpcHandlerTable<DataIpcChannel> = {
    "volli:data-bootstrap": (): BootstrapResult => {
      return { ok: true, data: buildBootstrapPayload(db) };
    },

    /**
     * The steady-state refresh read (VC-387): one project's live board, no
     * bodies. `volli:data-bootstrap` remains what a WINDOW boots from — it
     * carries every project, the app_state rows, and the bodies that make an
     * opened Body editor instant — and this is what a targeted
     * `volli:data-changed` re-reads instead of all of it.
     *
     * An unknown project is refused rather than answered with an empty board:
     * an empty list is indistinguishable from "this project has no tickets",
     * and hydrating that would clear a live slice off the board.
     */
    "volli:data-project-roster": (input: ProjectIdInput): ProjectRosterResult => {
      if (getProjectById(db, input.projectId) === undefined) {
        return { ok: false, error: "Unknown project" };
      }
      return {
        ok: true,
        tickets: listTicketRosterByProject(db, input.projectId),
        labels: listLabelsByProject(db, input.projectId),
      };
    },

    "volli:database": async (action?: DatabaseAction): Promise<DatabaseResult> => {
      // `db.name` is better-sqlite3's opened file, so the renderer never learns
      // or submits a filesystem path for either operation.
      const sizeBytes = databaseStorageBytes(db.name);
      switch (action) {
        case "reveal":
          shell.showItemInFolder(db.name);
          break;
        case "export":
          await exportDatabase({ ok: true, db });
          break;
      }
      return { ok: true, sizeBytes };
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
      withTransaction(db, () => {
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
          // Never the schema floor (VC-602): localStorage never held it, and a
          // renderer-supplied value could lock builds out or let one in.
          if (key === MIN_READER_VERSION_KEY) continue;
          assertRendererAppStateKey(key);
          setAppState(db, key, value, now);
        }
      });
      return { ok: true, data: buildBootstrapPayload(db), imported: legacyProjects.length };
    },

    // The rules live in host-core (VC-623), shared with the operator's
    // `volli project add` on a headless host: one validation, every door.
    "volli:project-create": (input: ProjectCreateInput): Promise<ProjectCreateResult> =>
      createProject({ db, detectBaseBranch: options.detectBaseBranch }, input),

    /**
     * Whether one project's registered folder is still there (VC-430) — the
     * read the recovery path hangs off. Cheap by construction: one row and one
     * `stat`, so a surface may ask it whenever a project comes into view. The
     * `stat` is awaited rather than blocking: a folder on an unmounted volume
     * is exactly the case this channel exists for, and exactly the case where a
     * synchronous read freezes the window.
     */
    "volli:project-folder-check": (input: ProjectIdInput): Promise<ProjectFolderResult> =>
      inspectProjectFolder(db, input.projectId),

    /**
     * Points an existing project at the folder it moved to (VC-430).
     *
     * The whole judgement lives in `relinkProject`, including the refusal that
     * matters most: a folder another project already tracks is never taken,
     * because the alternative a person reaches for — adding the new folder —
     * is exactly what mints the duplicate this channel exists to avoid.
     *
     * `busyWorktreeSites` is threaded through so the answer can warn about
     * Sessions still running in the folder being left; it is the same supplier
     * the destructive worktree paths ask, because "what is live in this
     * directory" must have one answer in this process.
     */
    "volli:project-relink": async (input: ProjectRelinkInput): Promise<ProjectRelinkResult> => {
      const outcome = await relinkProject(
        { db, busyWorktreeSites: options.busyWorktreeSites },
        { projectId: input.id, path: input.path },
      );
      if (!outcome.ok) return outcome;
      // Every surface that reads a project path has to re-read: the rail, the
      // file browsers, Configure, and the renderer's own root allowlist mirror.
      broadcastDataChanged({ projectId: outcome.project.id });
      return { ok: true, project: outcome.project, aftermath: outcome.aftermath };
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

    /**
     * Replaces this project's per-skill rules (VC-111). The whole map, because
     * the surface holds every switch at once — see `ProjectSkillModesInput`.
     * `updateProjectSkillModes` normalises, so an unknown mode or unspellable
     * slug that somehow cleared the guard still cannot reach the column.
     */
    "volli:project-skill-modes": (input: ProjectSkillModesInput): ProjectUpdateResult => {
      const project = updateProjectSkillModes(
        db,
        input.id,
        parseSkillModes(input.modes),
        Date.now(),
      );
      if (!project) return { ok: false, error: "Unknown project" };
      return { ok: true, project };
    },

    /** Replaces this project's Chat model default (VC-111). */
    "volli:project-session-defaults": (input: ProjectSessionDefaultsInput): ProjectUpdateResult => {
      const project = updateProjectSessionDefaults(
        db,
        input.id,
        { model: input.model },
        Date.now(),
      );
      if (!project) return { ok: false, error: "Unknown project" };
      return { ok: true, project };
    },

    /**
     * Records this project's authority departures (VC-172) — the write migration
     * 025 was missing, and the only door to it.
     *
     * THIS is where a policy document is judged. `resolveAuthorityPolicy` runs on
     * the attach path and degrades a bad document to the defaults rather than
     * costing a Session its attachment; that bargain is only honest if something
     * refuses the bad document earlier, where a person is present to be told.
     * This is that place, and `validateAuthorityPolicyOverride` refuses what the
     * read path would have silently dropped — an unknown key above all, which
     * otherwise stores cleanly, reads back cleanly and governs nothing.
     *
     * `null` clears every departure, which is not the same as writing an empty
     * document and is stored identically to a project that never spoke.
     */
    "volli:project-authority-policy": (
      input: ProjectAuthorityPolicyInput,
    ): ProjectAuthorityPolicyResult => {
      // `null` is the caller CLEARING every departure, and it is not a document
      // to be judged — there is nothing in it to be wrong about.
      let override: AuthorityPolicyOverride | null = null;
      if (input.override !== null) {
        const validation = validateAuthorityPolicyOverride(input.override);
        if (!validation.ok) {
          return {
            ok: false,
            error: "This authority policy cannot be saved.",
            errors: validation.errors,
          };
        }
        override = validation.override;
      }
      const project = updateProjectAuthorityPolicy(db, input.id, override, Date.now());
      if (!project) return { ok: false, error: "Unknown project" };
      return { ok: true, project };
    },

    "volli:mcp-list": (input: McpProjectInput) => ({
      ok: true as const,
      servers: mcpSettings.list(input.projectId),
      operations: listMcpOperations(db, input.projectId),
      access: mcpSettings.accessFor(input.projectId),
    }),
    "volli:mcp-test": (input: McpServerInput) => mcpSettings.test(input),
    "volli:mcp-save": (input: McpSaveInput) => mcpSettings.save(input),
    "volli:mcp-refresh": (input: McpServerIdInput) => mcpSettings.refresh(input),
    "volli:mcp-set-enabled": (input: McpSetEnabledInput) => mcpSettings.setEnabled(input),
    "volli:mcp-set-tools": (input: McpSetToolsInput) => mcpSettings.setTools(input),
    "volli:mcp-remove": (input: McpServerIdInput) => mcpSettings.remove(input),
    // A sign-in waits on the person's browser for up to five minutes. It is
    // not tied to this request: the pane's Cancel stops it for everyone
    // waiting on it, an agent's question included.
    "volli:mcp-sign-in": async (input: McpSignInInput): Promise<McpSignInResult> => {
      // Only the fields a renderer may set: nothing it sends can stand in for
      // the cancellation main owns.
      const outcome = await mcpSettings.signIn({
        projectId: input.projectId,
        ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
        ...(input.server === undefined ? {} : { server: input.server }),
        ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
      });
      return outcome.ok
        ? { ok: true, message: outcome.message }
        : { ok: false, cancelled: outcome.cancelled, error: outcome.message };
    },
    "volli:mcp-cancel-sign-in": (input: McpServerIdInput) => mcpSettings.cancelSignIn(input),
    "volli:mcp-sign-out": (input: McpServerIdInput) => mcpSettings.signOut(input),
    "volli:mcp-discard-draft": (input: McpServerIdInput) => mcpSettings.discardDraft(input),

    // Every ticket write below announces what it committed on the ticket wake
    // bus (VC-85). The renderer door has to feed it for the same reason the
    // agent door does: a waiter cares that a ticket moved, not who moved it,
    // and a person dragging a card is a legitimate wake. `broadcastDataChanged`
    // is untouched — the bus is additive, and a UI refresh and an agent wake
    // are different needs that only look alike today.
    "volli:ticket-create": (input: TicketCreateInput): TicketResult => {
      const now = Date.now();
      const ticketId = randomUUID();
      return {
        ok: true,
        ticket: withTicketWake(db, ticketId, () =>
          createTicketCommand(
            db,
            {
              id: ticketId,
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
        ),
      };
    },

    // The desktop window's projection of the host's move, admitted by the
    // desktop window's policy before the handler runs (synchronously, so the
    // reply stays synchronous where the move's is). The reply carries the
    // committed board, so the handler echoes it no board change.
    "volli:ticket-move": (input: TicketMoveRequest): TicketsResult | Promise<TicketsResult> => {
      const moved = invokeHandler(
        options.handlers,
        DESKTOP_WINDOW_POLICY,
        "ticket.move",
        input,
        DESKTOP_WINDOW_CALL,
      );
      return moved instanceof Promise
        ? moved.then((tickets) => ({ ok: true, tickets }))
        : { ok: true, tickets: moved };
    },

    "volli:ticket-set-priority": (input: TicketSetPriorityInput): TicketResult => {
      const now = Date.now();
      return {
        ok: true,
        ticket: withTicketWake(db, input.ticketId, () =>
          setTicketPriorityCommand(db, input, { now, actor: { kind: "user" } }),
        ),
      };
    },

    "volli:ticket-update": (input: TicketUpdateInput): TicketResult | Promise<TicketResult> => {
      const now = Date.now();
      // The one write that can race the `ensure` a previous call is still
      // running: switching scope back OFF before the identity stamp lands.
      // Refused rather than queued — the user is asking to undo something that
      // is already half-done on disk, and the honest answer is to say so while
      // it finishes. Re-asserting `true` is a no-op and passes through.
      if (input.usesWorktree === false && materializingWorktrees.has(input.ticketId)) {
        return {
          ok: false,
          error:
            "The ticket's worktree is still being created, so its worktree scoping can't change yet. Try again once it's ready.",
        };
      }
      // Read BEFORE the write: the returned ticket shows scope as it now stands,
      // which cannot tell "just switched on" from "was already on" — and only
      // the transition materializes.
      const before = getTicketRow(db, input.ticketId);
      const ticket = withTicketWake(db, input.ticketId, () =>
        updateTicketFieldsCommand(db, input, { now, actor: { kind: "user" } }),
      );
      // Only the one transition goes async. Every other update — a title, a
      // body, a branch stamp — stays the synchronous write it has always been,
      // the same split `volli:ticket-move` makes for its interrupt side effect.
      const switchedOn =
        before !== undefined && before.uses_worktree === 0 && ticket.usesWorktree === true;
      if (switchedOn) return materializeSwitchedOnWorktree(db, input.ticketId, ticket);
      // Switching OFF moves the ticket's Session destination too — from "an
      // isolated worktree, not yet made" to the main checkout — with nothing
      // async behind it. The same `worktree` broadcast the switch-on makes is
      // what lets a ticket venue reader (the empty chat) stop waiting on a
      // checkout that will never arrive and measure the one it now binds
      // (VC-286). Only the transition broadcasts: re-asserting `false` moved
      // nothing.
      const switchedOff =
        before !== undefined && before.uses_worktree !== 0 && ticket.usesWorktree === false;
      if (switchedOff) {
        broadcastDataChanged({
          ticketId: input.ticketId,
          projectId: ticket.projectId,
          kind: "worktree",
        });
      }
      return { ok: true, ticket };
    },

    "volli:ticket-set-labels": (input: TicketSetLabelsInput): TicketResult => {
      const now = Date.now();
      return {
        ok: true,
        ticket: withTicketWake(db, input.ticketId, () =>
          setTicketLabelsCommand(db, input, { now, actor: { kind: "user" } }),
        ),
      };
    },

    "volli:ticket-archive": (input: TicketIdInput): Result => {
      const now = Date.now();
      const ticket = getTicketRow(db, input.ticketId);
      withTicketWake(db, input.ticketId, () =>
        archiveTicketCommand(db, input.ticketId, { now, actor: { kind: "user" } }),
      );
      releaseTicketToolOutput(input.ticketId);
      // An archive KEEPS the checkout, which makes an archived ticket the
      // longest-lived carrier of a dead dependency tree in the app (VC-340).
      trimFinishedTicketInBackground(archiveTrimPorts(), input.ticketId, ticket?.project_id);
      return { ok: true };
    },

    "volli:ticket-unarchive": (input: TicketIdInput): TicketResult => {
      const ticket = withTicketWake(db, input.ticketId, () =>
        unarchiveTicketCommand(db, input.ticketId, {
          now: Date.now(),
          actor: { kind: "user" },
        }),
      );
      return { ok: true, ticket };
    },

    "volli:ticket-delete": (input: TicketIdInput): Result => {
      // Before the delete, which detaches the Sessions from the ticket; and
      // only for an archived ticket, the one kind the delete accepts.
      if (getTicketRow(db, input.ticketId)?.archived_at != null) {
        releaseTicketToolOutput(input.ticketId);
      }
      deleteTicketCommand(db, input.ticketId);
      return { ok: true };
    },

    "volli:ticket-list-archived": (projectId: string): ArchivedTicketsResult => {
      return { ok: true, tickets: listArchivedTicketsByProject(db, projectId) };
    },

    "volli:ticket-events": (input: TicketIdInput): TicketEventsResult => {
      return { ok: true, events: listTicketEvents(db, input.ticketId) };
    },

    /**
     * One ticket's body — what the refresh roster stopped carrying (VC-387).
     * Read by the ticket that is OPEN, on arrival and on each planning change
     * that names it, which is the only place a body is ever rendered.
     */
    "volli:ticket-body": (input: TicketIdInput): TicketBodyResult => {
      const body = getTicketBody(db, input.ticketId);
      if (body === undefined) return { ok: false, error: "Unknown ticket" };
      return { ok: true, body };
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
      const comment = withTicketWake(db, input.ticketId, () =>
        createTicketCommentCommand(
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
        ),
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

    "volli:blob-attach": async (input: BlobAttachInput): Promise<BlobAttachResult> => {
      try {
        // The workspace an `@` ref resolves against is a fact about the
        // Ticket's worktree and the project's checkout, so for an owned attach
        // it is derived here — a renderer that guessed it wrong would silently
        // turn repository files into frozen copies. The renderer supplies it
        // only for an unowned attach (the new-Ticket composer), whose Ticket
        // does not exist to derive from yet.
        const refRoot = input.refRoot ?? resolveRefRoot(db, input.owner);
        const outcome = await attachBlob(
          db,
          blobsRootPath,
          { ...input, ...(refRoot === undefined ? {} : { refRoot }) },
          Date.now(),
        );
        // Flattened to two nullable fields rather than passed through as the
        // tagged union: every refusal on this channel already travels as
        // `{ ok: false }`, and a second discriminant beside it would give the
        // renderer two different shapes to branch on for one answer.
        return {
          ok: true,
          relPath: outcome.kind === "blob" ? null : outcome.relPath,
          blob: outcome.kind === "ref" ? null : outcome.blob,
        };
      } catch (error) {
        // Attach failures are sentences written for a person — a file over the
        // size ceiling, a chat at its image budget — so the message is the
        // point and is surfaced verbatim.
        return { ok: false, error: errorMessage(error) };
      }
    },

    "volli:blob-list": (input: BlobListInput): BlobLinksResult => {
      if (input.ticketId !== undefined) {
        return { ok: true, blobs: listLinkViews(db, { ticketId: input.ticketId }) };
      }
      if (input.sessionId !== undefined) {
        return { ok: true, blobs: listLinkViews(db, { sessionId: input.sessionId }) };
      }
      return { ok: false, error: "Attachments belong to a ticket or a session" };
    },

    "volli:blob-materialized": (input: BlobMaterializedInput): BlobMaterializedResult => {
      if (input.ticketId === undefined && input.sessionId === undefined) {
        return { ok: false, error: "Attachments belong to a ticket or a session" };
      }
      // The SAME query `blob-materialize.ts` copies from, deliberately: the
      // renderer is resolving names that must match the files on disk, and a
      // second derivation would eventually disagree with the first exactly
      // where it matters — two attachments sharing a basename.
      return {
        ok: true,
        links: listMaterializableLinks(db, input.sessionId ?? null, input.ticketId ?? null),
      };
    },

    "volli:blob-remove": (input: BlobLinkIdInput): Result => {
      const removed = deleteBlobLink(db, input.linkId, Date.now(), { kind: "user" });
      if (!removed) return { ok: false, error: "Unknown attachment" };
      return { ok: true };
    },

    "volli:blob-link-drafts": (input: BlobLinkDraftsInput): BlobLinksResult => {
      try {
        const now = Date.now();
        // A chat's image budget is per Session, so an import made while the
        // chat was still a Draft could not be held to it — there was no
        // Session to measure (VC-358). This is the boundary where those bytes
        // become a Session's, and so the last place that rule can be applied
        // at all; refusing here keeps a promoted Draft to the same ceiling a
        // durable chat has enforced at every import.
        if (input.sessionId !== undefined) {
          const refusal = sessionLinkBudgetRefusal(
            db,
            input.sessionId,
            input.blobs.map((draft) => draft.blobHash),
          );
          if (refusal !== null) return { ok: false, error: refusal };
        }
        // One transaction: a composer's attachments arrive together, and a
        // Ticket that kept three of five would be worse than one that kept none
        // and said so. The same atomicity is what a promoted Draft needs
        // (VC-358): the Session it names already exists by the time this runs,
        // and its staged blobs must adopt it all-or-nothing — a retry that
        // half-adopted would leave the chat unsure what it is holding.
        withTransaction(db, () => {
          for (const draft of input.blobs) {
            createBlobLink(
              db,
              {
                blobHash: draft.blobHash,
                ...(draft.label === undefined ? {} : { label: draft.label }),
                // Exactly one owner, admitted by the descriptor; a session
                // link simply leaves `eventActor` unused — `createBlobLink`
                // attributes ticket links only.
                ...(input.ticketId !== undefined
                  ? { ticketId: input.ticketId }
                  : { sessionId: input.sessionId }),
                eventActor: { kind: "user" },
              },
              now,
            );
          }
        });
        // The caller reads back the owner it named: the Ticket composer its
        // strip, the promoted chat its Session's — the links it just made and
        // any that were already there.
        return {
          ok: true,
          blobs:
            input.ticketId !== undefined
              ? listLinkViews(db, { ticketId: input.ticketId })
              : listLinkViews(db, { sessionId: input.sessionId }),
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    "volli:session-list": async (input: ProjectIdInput): Promise<SessionsResult> => {
      const sessions = await sessionEngine.listSessions({
        projectId: input.projectId,
        scope: "all",
      });
      return {
        ok: true,
        sessions: sessionListingRowsForRoster(db, sessions, liveAttachmentIds()),
      };
    },

    "volli:session-list-for-ticket": async (input: TicketIdInput): Promise<SessionsResult> => {
      const ticket = getTicketRow(db, input.ticketId);
      if (ticket === undefined) return { ok: true, sessions: [] };
      const sessions = await sessionEngine.listSessions({
        projectId: ticket.project_id,
        scope: "ticket",
        ticketId: input.ticketId,
      });
      return {
        ok: true,
        sessions: sessionListingRowsForRoster(db, sessions, liveAttachmentIds()),
      };
    },

    /**
     * A person's own read decision (VC-30).
     *
     * Two acts, in this order and for two different audiences. The receipt is
     * persisted first, because it is the durable answer and everything else is
     * a projection of it. Then the Session's listing row is re-published on
     * `volli:session-activity` — the same broadcast the push channel uses,
     * carrying a row built by the same `sessionListingRow` — because this write
     * moves no ledger fact, so the activity watch has nothing to notice and the
     * OTHER sidebar, the ticket rail and the second window would otherwise keep
     * drawing the dot until something unrelated refreshed them.
     *
     * The caller already moved its own row optimistically; the answer is what it
     * reverts to if this failed.
     */
    "volli:session-read-set": async (input: SessionReadSetInput): Promise<SessionReadSetResult> => {
      const existing = await sessionEngine.getSession({ sessionId: input.sessionId });
      if (existing === null) return { ok: false, error: "Unknown session" };
      // Main's clock, never the renderer's: the receipt is main's record, and a
      // stamp from a window with a skewed clock would date the dot wrongly for
      // every other window.
      writeSessionUnread(db, input.sessionId, input.unread ? Date.now() : null);
      await publishSessionListingRow(
        {
          db,
          getSession: (query) => sessionEngine.getSession(query),
          liveAttachmentIds,
          publish: broadcastSessionActivity,
        },
        input.sessionId,
      );
      return { ok: true, read: readSessionUnread(db, input.sessionId) };
    },

    /**
     * One peek's content (VC-30): the Session's transcript tail plus its question.
     * The default local read is immediate; an explicit refinement read can
     * spend the host's utility budget while the client keeps local content visible.
     *
     * Straight through to `peek-content.ts`, which composes the engine fold the
     * CLI's `session peek` already uses. No Session adoption or stream.
     */
    "volli:session-peek-content": async (
      input: SessionPeekContentInput,
    ): Promise<SessionPeekContentResult> => {
      const content = await readSessionPeekContent(
        {
          listEvents: (query) => sessionEngine.listEvents(query),
          ...(options.readTranscriptArtifact === undefined
            ? {}
            : { readArtifact: options.readTranscriptArtifact }),
          getSession: (query) => sessionEngine.getSession(query),
          ...(options.summarizePeek === undefined ? {} : { summarize: options.summarizePeek }),
        },
        input,
      );
      return { ok: true, content };
    },

    "volli:session-starts": async (input: SessionStartsInput): Promise<SessionStartsResult> => {
      // Straight through to the ledger's own unscoped read: the window is the
      // caller's (it draws a fixed number of days), and every project counts,
      // because the chart is about the person rather than the project.
      const startedAt = await sessionEngine.listSessionStarts({ sinceMs: input.sinceMs });
      return { ok: true, startedAt: [...startedAt] };
    },

    "volli:usage-report": async (input: UsageReportInput): Promise<UsageReportResult> => {
      // Straight through as well. The engine owns what a mixed basis means and
      // when a total is only partial (`summarizeSessionUsage`); re-deciding any
      // of that here would be a second opinion about the same money, which is
      // exactly what `session-usage-report.ts` refuses to allow.
      const report = await sessionEngine.reportUsage({
        scope: input.scope,
        since: input.sinceMs,
        until: input.untilMs,
        groupBy: input.groupBy,
      });
      return { ok: true, report };
    },

    "volli:venue-snapshot": async (input: VenueSnapshotInput): Promise<VenueSnapshotResult> => {
      // `readVenue` owns which directory this is — the same rule the Session
      // runtime binds one by — so a renderer never names a path for main to run
      // git in, and the drawing can never be of a tree the agent is not in.
      const read = await readVenue(worktreeDeps(db), input);
      if (!read.ok) return { ok: false, error: read.error };
      return { ok: true, reading: read.value };
    },

    "volli:session-rename": async (input: SessionRenameInput): Promise<SessionRenameResult> => {
      const existing = await sessionEngine.getSession({ sessionId: input.sessionId });
      if (existing === null) return { ok: false, error: "Unknown session" };
      const submitted = await sessionEngine.submit({
        commandId: randomUUID(),
        sessionId: input.sessionId,
        intent: { kind: "session.retitle", title: input.title.trim() },
        provenance: {
          source: { kind: "user", id: "renderer", detail: { sessionOrigin: { kind: "user" } } },
          venue: { id: "local", kind: "local" },
        },
      });
      if (submitted.receipt?.status !== "completed") {
        return { ok: false, error: "Session rename was not completed" };
      }
      // The auto-title rider (VC-81), fired only once the heuristic title it
      // names as its baseline has actually stuck. Detached and never awaited:
      // the ack answers the rename, and every refinement failure keeps the
      // title just written. The descriptor guard has already refused a blank.
      if (input.refineFrom !== undefined) {
        options.autoTitle?.({
          sessionId: input.sessionId,
          firstMessage: input.refineFrom,
          heuristicTitle: input.title.trim(),
        });
      }
      return { ok: true };
    },

    "volli:label-set-color": (input: LabelSetColorInput): LabelResult => {
      const label = setLabelColor(db, input.labelId, input.color, Date.now());
      if (!label) return { ok: false, error: "Unknown label" };
      return { ok: true, label };
    },

    "volli:app-state-set": (key: string, value: string): AppStateSetResult => {
      // The schema floor is the migration runner's alone (VC-602): a renderer
      // write could lock older builds out of this database, or let them in.
      if (key === MIN_READER_VERSION_KEY) {
        return { ok: false, error: "This app state key is owned by the database." };
      }
      assertRendererAppStateKey(key);
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
      getWorktreeSnapshots().invalidate(input.ticketId);
      // The worktree identity changed (path cleared) for THIS ticket — re-hydrate
      // every board, and let this ticket's own surfaces refresh promptly.
      broadcastDataChanged({
        ticketId: input.ticketId,
        projectId: ticket?.project_id,
        kind: "worktree",
      });
      return { ok: true };
    },

    /**
     * Recreate (VC-113): put a ticket's worktree back after something outside
     * this app took the directory away — a sweep from a second install, a
     * `git worktree remove` in a terminal, a `rm -rf` while tidying.
     *
     * The branch is the identity and it survives all of those, so this is a
     * real recovery rather than a fresh start: `ensure` reuses the stamped
     * branch and path, and its reconcile already owns "registered, directory
     * missing → prune, then recreate". It is the same pipeline a Session boot
     * runs, exposed as its own verb because the rail could previously offer
     * only Retry — a read that had no way of succeeding — and starting a
     * whole Session was the only unwritten route back.
     *
     * Idempotent by construction (`ensure` is single-flight and answers
     * `already-present` for a live checkout), so a double-click costs a git
     * read, not a second worktree.
     */
    "volli:worktree-recreate": async (input: TicketIdInput): Promise<WorktreeRecreateResult> => {
      const ticket = getTicketRow(db, input.ticketId);
      if (!ticket) return { ok: false, error: "Unknown ticket" };
      if (ticket.uses_worktree === 0) {
        return { ok: false, error: "This ticket runs in the main checkout." };
      }
      const outcome = await ensure(worktreeDeps(db), input.ticketId);
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const worktreePath = outcome.value.identity.worktreePath;
      if (worktreePath === null) return { ok: false, error: "Worktree path was not resolved" };
      // A checkout came back (or was replaced): whatever this ticket's watch was
      // serving describes the directory that was missing (VC-372).
      getWorktreeSnapshots().invalidate(input.ticketId);
      // The identity moved (or came back), so every board re-hydrates and this
      // ticket's own surfaces refresh promptly — same targeting the scope
      // switch and the terminal boot use.
      broadcastDataChanged({
        ticketId: input.ticketId,
        projectId: ticket.project_id,
        kind: "worktree",
      });
      return { ok: true, worktreePath };
    },

    "volli:worktree-branches": async (input: ProjectIdInput): Promise<WorktreeBranchesResult> => {
      const result = await listBranches(worktreeDeps(db), input.projectId);
      return result.ok ? { ok: true, ...result.value } : { ok: false, error: result.error };
    },

    "volli:worktree-orphans": async (
      opts?: WorktreeOrphansInput,
    ): Promise<WorktreeOrphansResult> => {
      // READ-ONLY in every shape (VC-284). The launch scan is cached so a
      // renderer reload doesn't re-walk every project, and `{ refresh: true }`
      // — the Storage pane's Scan — simply asks again. Nothing here removes a
      // directory or prunes git metadata; that is `worktree-orphan-cleanup`.
      const refresh = opts?.refresh === true;
      const report = await orphanScanReport(worktreeDeps(db), {
        refresh,
        // Read-only, and the same supplier the destructive paths use: an
        // occupied checkout is reported as KEPT rather than proposed and then
        // refused after the confirmation (review C5).
        busyWorktreeSites: options.busyWorktreeSites,
      });
      // The durable history, so Storage can say who removed a directory and
      // when — and show a run the app never finished. A record that cannot be
      // read FAILS this channel rather than answering with an empty list: the
      // old blob's "unreadable means no history" made a damaged record
      // indistinguishable from an app that had never deleted anything, which is
      // the one thing a deletion log must never do.
      let runs;
      try {
        runs = await orphanCleanupEngine(db).recentRuns();
      } catch (error) {
        return {
          ok: false,
          error: `Couldn't read the cleanup history: ${errorMessage(error)}`,
        };
      }
      return {
        ok: true,
        revision: report.revision,
        scannedAt: report.scannedAt,
        retentionDays: report.retentionDays,
        prunable: report.prunable,
        removable: report.removable,
        keptRecent: report.keptRecent,
        keptMetadata: report.keptMetadata,
        unreadableProjects: report.unreadableProjects,
        dirty: report.dirty,
        runs,
      };
    },

    "volli:worktree-orphan-cleanup": async (
      input: WorktreeOrphanCleanupInput,
    ): Promise<WorktreeOrphanCleanupResult> => {
      // The confirmed half, and a transport adapter over a command — nothing
      // more (review S1). The renderer names a scan revision and item ids; main
      // resolves them against the proposal IT minted, so no client can point
      // this channel at a directory no completed scan offered (review C1).
      const engine = orphanCleanupEngine(db);
      // FIRST, before any live fact is consulted: has this exact command id
      // already been answered? (VC-284 re-review S1, the rule
      // `automations/service.ts` follows.) A completed cleanup invalidates the
      // scan it ran against, so validating a retry against the CURRENT scan
      // would tell a caller whose reply was lost that its command was
      // superseded — a completed deletion reported as a failure, with a second
      // deletion as the obvious next step. The durable record answers instead,
      // and it needs no scan to do it.
      const replayed = await engine.replay({
        commandId: input.commandId,
        scanRevision: input.scanRevision,
        itemIds: input.itemIds,
      });
      if (replayed !== null) {
        return replayed.ok
          ? { ok: true, run: replayed.run, receipt: replayed.receipt }
          : { ok: false, error: replayed.error, code: replayed.code };
      }
      const plan = await resolveCleanupPlan({
        scanRevision: input.scanRevision,
        itemIds: input.itemIds,
      });
      if (!plan.ok) {
        // Refused requests are durable too: "something asked to delete against a
        // scan we no longer hold" is exactly what an audit wants to find.
        await engine.reject({
          commandId: input.commandId,
          scanRevision: input.scanRevision,
          requestedItemIds: input.itemIds,
          code: plan.code,
          error: plan.error,
        });
        return { ok: false, error: plan.error, code: plan.code };
      }
      // `cleanupOrphans` re-checks ownership, the ticket link, dirtiness, age,
      // and live work for each path immediately before it touches anything,
      // holds a deletion lease across its awaits, and records every outcome.
      let outcome;
      try {
        outcome = await cleanupOrphans(
          {
            worktree: worktreeDeps(db),
            engine,
            busyWorktreeSites: options.busyWorktreeSites,
            releaseAgentSites: options.releaseAgentSites,
          },
          {
            commandId: input.commandId,
            scanRevision: input.scanRevision,
            requestedItemIds: input.itemIds,
            // The window the confirmation was MEASURED against, carried from the
            // scan itself rather than re-read here: if the setting has moved
            // since, the executor must skip rather than apply a policy nobody
            // confirmed (review C1/C2).
            retentionDays: plan.retentionDays,
            items: plan.items,
            source: "settings",
          },
        );
      } catch (error) {
        if (error instanceof OrphanCleanupRefused) {
          return { ok: false, error: error.message, code: error.code };
        }
        throw error;
      }
      // The cached scan describes a world that no longer exists.
      invalidateOrphanScan();
      // Orphans are by definition unlinked from any live ticket, so there is no
      // ticket to target — untargeted (everyone re-hydrates). Their directories
      // are gone, so no last-known snapshot may outlive them either (VC-372).
      if (outcome.run.items.some((item) => item.state === "completed")) {
        getWorktreeSnapshots().invalidateAll();
        broadcastDataChanged({ kind: "worktree" });
      }
      return { ok: true, run: outcome.run, receipt: outcome.receipt };
    },

    "volli:worktree-orphan-delete": async (
      input: WorktreeOrphanDeleteInput,
    ): Promise<WorktreeOrphanDeleteResult> => {
      const { path } = input;
      // The ONLY dir this channel may touch is a leaf inside a container THIS
      // database owns — canonicalized on both sides, so no symlink or
      // `../escape` can point the recursive delete anywhere else, and (VC-113)
      // no second install's container under the same shared root is reachable
      // from this app's Settings list either. The dialog has already shown the
      // dirtiness reason and taken explicit confirmation; this is the one
      // sanctioned rm -rf in the app.
      const target = canonicalizeWorktreePath(path);
      if (!isOwnedWorktreePath(ownedContainers(db, worktreeHomeDir()), target)) {
        return { ok: false, error: "That path is outside this project's worktree folder." };
      }
      // This is a destructive worktree act, so it takes the same lease the
      // confirmed cleanup takes (VC-284 re-review C4). Without it, "serialized
      // against every start" was only true of one of the two routes that
      // delete a checkout — and two acts removing one directory, or a terminal
      // being born inside this one mid-delete, were both still possible.
      const lease = acquireDeletionLease(target);
      if (lease === null) {
        return { ok: false, error: "Something else is already changing this folder." };
      }
      try {
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
        // Asked once more after that await, for the same reason the cleanup
        // asks: the release takes time, and the lease keeps new work out but
        // says nothing about work that was already there.
        const stillBusy = busySiteWithin(target, (await options.busyWorktreeSites?.(target)) ?? []);
        if (stillBusy !== null) return { ok: false, error: busyRefusal(stillBusy) };
        await rm(target, { recursive: true, force: true });
      } finally {
        lease.release();
      }
      // The cached scan still lists this directory; the next read must not.
      invalidateOrphanScan();
      // A dirty orphan left the board's attention list. An orphan is by
      // definition unlinked from any live ticket, so there's no ticket to
      // target — untargeted (everyone re-hydrates), and no last-known snapshot
      // of the vanished directory may be served either (VC-372).
      getWorktreeSnapshots().invalidateAll();
      broadcastDataChanged({ kind: "worktree" });
      return { ok: true };
    },

    // ---- build artifacts (VC-340) ------------------------------------------

    "volli:worktree-trim-scan": async (): Promise<WorktreeTrimScanResult> => {
      const scan = await scanTrimTargets(trimSweepDeps());
      return { ok: true, worktrees: scan.worktrees };
    },

    "volli:worktree-trim": async (): Promise<WorktreeTrimResult> => {
      const report = await trimAllWorktrees(trimSweepDeps());
      // Nothing about any ticket's identity moved — the checkouts are all still
      // there, on the same branches, and git's own records are untouched — but
      // the Settings table and any surface reading worktree state should re-read
      // what is now on disk. Files went from tickets this call cannot name, so
      // every last-known snapshot goes with them (VC-372).
      if (!report.dryRun && report.removedCount > 0) {
        getWorktreeSnapshots().invalidateAll();
        broadcastDataChanged({ kind: "worktree" });
      }
      return { ok: true, report };
    },

    "volli:worktree-trim-settings-set": (
      input: WorktreeTrimSettingsInput,
    ): WorktreeTrimSettingsResult => {
      return { ok: true, settings: setTrimSettings(db, input, Date.now()) };
    },

    // ---- Done flow ----------------------------------------------------------
    // The Details-rail diff/commit/push-PR affordances. `status`/`diff` are
    // read-only (no broadcast); `commit` records an event and `push-pr` writes
    // `pr_url`, so both broadcast to re-hydrate every board.

    "volli:worktree-status": async (input: TicketIdInput): Promise<WorktreeStatusResult> => {
      // Thin adapter over the ticketId-in read verb (CONCEPT #42): it owns the
      // ticket→identity resolution, the no-worktree discrimination, AND the
      // stamped-but-deleted disk check the CLI door always did but this one
      // used to skip — which fed a deleted path into the errs-dirty status
      // read and lied `uncommitted: true` to the renderer.
      //
      // Coalesced per ticket: the read is five git children, and both rail
      // surfaces ask for it on mount (VC-369). Served from the last-known
      // snapshot while a watch covers the worktree (VC-372), so the Now↔Diffs
      // page flip — one surface unmounting as the other mounts — asks git
      // nothing at all.
      const read = await getWorktreeSnapshots().readStatus(input.ticketId, () =>
        coalesceStatus(input.ticketId, () => readWorktreeStatus(worktreeDeps(db), input.ticketId)),
      );
      switch (read.kind) {
        case "missing-ticket":
          return { ok: false, error: "Unknown ticket" };
        case "no-worktree":
          return { ok: false, error: "This ticket has no worktree." };
        case "missing-on-disk":
          return { ok: false, error: WORKTREE_MISSING_ON_DISK };
        case "ok":
          return { ok: true, status: read.status };
      }
    },

    "volli:worktree-diff": async (input: WorktreeDiffInput): Promise<WorktreeDiffResult> => {
      // Keyed by mode as well as ticket: the two modes are different questions
      // ("what would the PR contain" vs "what is uncommitted now"), so sharing
      // one answer between them would return the wrong diff.
      const read = await coalesceDiff(`${input.ticketId}:${input.mode}`, () =>
        readWorktreeDiff(worktreeDeps(db), input.ticketId, input.mode),
      );
      switch (read.kind) {
        case "missing-ticket":
          return { ok: false, error: "Unknown ticket" };
        case "no-worktree":
          return { ok: false, error: "This ticket has no worktree." };
        case "missing-on-disk":
          return { ok: false, error: WORKTREE_MISSING_ON_DISK };
        case "diff-error":
          return { ok: false, error: read.error };
        case "ok":
          return { ok: true, diff: read.diff };
      }
    },

    "volli:worktree-change-set": async (input: TicketIdInput): Promise<WorktreeChangeSetResult> => {
      // Coalesced per ticket: a burst of filesystem events can have several
      // panels and windows asking at once, and each snapshot is five git
      // commands over the whole worktree. Served from the last-known snapshot
      // while a watch covers the worktree (VC-372) — which is also what keeps a
      // diff tab's mount read free: the Diffs page it opened from just read the
      // same Change Set.
      const read = await getWorktreeSnapshots().readChangeSet(input.ticketId, () =>
        coalesceChangeSet(input.ticketId, () =>
          readWorktreeChangeSet(worktreeDeps(db), input.ticketId),
        ),
      );
      switch (read.kind) {
        case "missing-ticket":
          return { ok: false, error: "Unknown ticket" };
        case "no-worktree":
          return { ok: false, error: "This ticket has no worktree." };
        case "missing-on-disk":
          return { ok: false, error: WORKTREE_MISSING_ON_DISK };
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
          return { ok: false, error: WORKTREE_MISSING_ON_DISK };
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

    "volli:worktree-change-watch": async (input: TicketIdInput, sender): Promise<Result> => {
      // Only the PATH is wanted here, so this resolves the target rather than
      // reading the status: the full read spawns five git children and this
      // handler discarded every one of their answers. Both rail surfaces
      // subscribe on mount, so that waste landed twice on the main process at
      // exactly the moment a ticket workspace opens (VC-369). Same three
      // failure arms — `resolveWorktreeTarget` is the verb's own resolution
      // step, not a second copy of it.
      const resolved = resolveWorktreeTarget(worktreeDeps(db), input.ticketId);
      switch (resolved.kind) {
        case "missing-ticket":
          return { ok: false, error: "Unknown ticket" };
        case "no-worktree":
          return { ok: false, error: "This ticket has no worktree." };
        case "missing-on-disk":
          return { ok: false, error: WORKTREE_MISSING_ON_DISK };
        case "ok":
          return changeWatchManager.watch(
            clientEventSink(sender),
            input.ticketId,
            resolved.target.worktreePath,
          );
      }
    },

    "volli:worktree-change-watch-pause": (input: TicketIdInput, sender): Result =>
      changeWatchManager.pause(clientEventSink(sender), input.ticketId),

    "volli:worktree-change-watch-resume": async (input: TicketIdInput, sender): Promise<Result> =>
      changeWatchManager.resume(clientEventSink(sender), input.ticketId),

    "volli:worktree-change-unwatch": (input: TicketIdInput, sender): Result => {
      changeWatchManager.unwatch(clientEventSink(sender), input.ticketId);
      return { ok: true };
    },

    "volli:worktree-commit": async (input: WorktreeCommitInput): Promise<WorktreeCommitResult> => {
      // The async runner matters here: `git commit` runs unbounded hook code,
      // which must never block the main process (net.ts's freeze rationale).
      // The two choices are forwarded RAW: the descriptor guard has already
      // shape-checked them at the door, and what "blank" and "absent" mean is
      // commit.ts's to decide, in one place, for every caller.
      const result = await commitTicketRemaining(
        { ...worktreeDeps(db), net: runNet, explainCredentialHelpers: credentialHelperIssues },
        input.ticketId,
        { message: input.message, includeUnstaged: input.includeUnstaged },
      );
      if (!result.ok) return { ok: false, error: result.error };
      if (!result.value.committed) {
        // Clean-tree no-op: nothing landed, no event, nothing to re-hydrate.
        return { ok: true, committed: false, message: null };
      }
      // The commit moved HEAD and the working tree: the last-known snapshot this
      // ticket's watch was serving is stale (VC-372).
      getWorktreeSnapshots().invalidate(input.ticketId);
      // No ticket row changed, but a `worktree_committed` event landed on THIS
      // ticket. Targeting it is what lets the Details rail's git summary refresh
      // promptly (the CLI/rail-side commit → rail guarantee, issue #80) instead
      // of riding the debounced untargeted arm.
      broadcastDataChanged({
        ticketId: input.ticketId,
        ...ticketScope(db, input.ticketId),
        kind: "worktree",
      });
      return { ok: true, committed: true, message: result.value.message };
    },

    "volli:worktree-push-pr": async (input: TicketIdInput): Promise<WorktreePushPrResult> => {
      const result = await publishTicketBranch(
        { ...worktreeDeps(db), net: runNet, explainCredentialHelpers: credentialHelperIssues },
        input.ticketId,
      );
      if (!result.ok) return { ok: false, error: result.error };
      // The branch moved on the remote (and `pr_url` may have been written):
      // this ticket's last-known snapshot is stale (VC-372).
      getWorktreeSnapshots().invalidate(input.ticketId);
      // `pr_url` was written (and a `pr_opened` event recorded) on THIS ticket —
      // target it so its rail refreshes promptly, same as the commit path.
      broadcastDataChanged({
        ticketId: input.ticketId,
        ...ticketScope(db, input.ticketId),
        kind: "worktree",
      });
      return { ok: true, url: result.value.url, existing: result.value.existing };
    },

    // ---- retention (CONCEPT #16, issue #76) ---------------------------------
    // The merge-watch/Done-TTL surface. `state` is a read; `keep`/`dismiss`/
    // `archive-clean`/`ttl-set` mutate and re-hydrate; `poll` triggers an
    // immediate watch poll (e.g. on window focus). The watch singleton
    // (retention-runtime.ts) is shared with index.ts's start/stop + focus wiring.

    "volli:retention-state": (input: TicketIdInput): RetentionStateResult => {
      const state = retentionWatcher().getState(input.ticketId);
      if (state === null) return { ok: false, error: "Unknown ticket" };
      return { ok: true, state };
    },

    "volli:retention-keep": (input: RetentionKeepInput): RetentionKeepResult => {
      if (!getTicketRow(db, input.ticketId)) return { ok: false, error: "Unknown ticket" };
      setTicketRetentionKeep(db, input.ticketId, input.keep, Date.now());
      // The pin exempts both retention paths for THIS ticket — target it so its
      // retention surface updates promptly.
      broadcastDataChanged({
        ticketId: input.ticketId,
        ...ticketScope(db, input.ticketId),
        kind: "retention",
      });
      return { ok: true, keep: input.keep };
    },

    "volli:retention-dismiss": (input: TicketIdInput): RetentionDismissResult => {
      // In-memory, launch-scoped: the prompt is re-offered next launch.
      retentionWatcher().dismiss(input.ticketId);
      broadcastDataChanged({
        ticketId: input.ticketId,
        ...ticketScope(db, input.ticketId),
        kind: "retention",
      });
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
      releaseTicketToolOutput(input.ticketId);
      // Same as worktree-remove: the archived worktree's directory is gone, so
      // no window may keep a recursive watch pinned to it.
      changeWatchManager.unwatchTicket(input.ticketId);
      getWorktreeSnapshots().invalidate(input.ticketId);
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
      // Every eligibility date the cached scan proposed was measured against the
      // OLD window, so that proposal no longer describes this app's policy
      // (VC-284 re-review C1/C6). Dropping it supersedes the revision: a
      // confirmation still open from before the change is refused with
      // `scan-superseded` rather than silently applying a window nobody
      // reviewed, and the next read re-measures.
      invalidateOrphanScan();
      // The TTL clock is GLOBAL — it moves every Done ticket's archive-readiness
      // at once, so this is untargeted: every retention surface must re-evaluate.
      broadcastDataChanged({ kind: "retention" });
      return { ok: true, days: stored };
    },

    "volli:retention-poll": (): RetentionPollResult => {
      // Fire-and-forget: the poll runs async and broadcasts on change itself.
      if (options.maintenance === undefined) retentionWatcher().triggerNow();
      else options.maintenance.triggerRetention();
      return { ok: true };
    },
  };

  registerGuardedIpcHandlers(DATA_IPC, handlers);
}

/**
 * The workspace root an `@` reference from this owner would resolve against
 * (VC-50), or `undefined` when there is no such tree — which makes every file
 * a snapshot, the safe answer.
 *
 * A Ticket with a worktree is briefed inside it; a Ticket without one runs in
 * the project's own checkout, which is also where a ticketless Session runs. A
 * Session is resolved through the Ticket it belongs to for exactly that reason:
 * the tree is a fact about the work, not about the conversation.
 */
function resolveRefRoot(
  db: Database.Database,
  owner: BlobAttachInput["owner"],
): string | undefined {
  if ("unowned" in owner) return undefined;
  const ticketId =
    "ticketId" in owner
      ? owner.ticketId
      : (prepared<[string], { ticket_id: string | null }>(
          db,
          "SELECT ticket_id FROM sessions WHERE id = ?",
        ).get(owner.sessionId)?.ticket_id ?? null);
  if (ticketId === null) {
    if ("ticketId" in owner) return undefined;
    const projectId = prepared<[string], { project_id: string }>(
      db,
      "SELECT project_id FROM sessions WHERE id = ?",
    ).get(owner.sessionId)?.project_id;
    return projectId === undefined ? undefined : getProjectById(db, projectId)?.path;
  }
  const ticket = getTicketRow(db, ticketId);
  if (ticket === undefined) return undefined;
  return ticket.worktree_path ?? getProjectById(db, ticket.project_id)?.path;
}
