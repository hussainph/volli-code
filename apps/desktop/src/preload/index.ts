import { contextBridge, ipcRenderer } from "electron";
// Type-only imports ONLY: the pack config keeps main and preload
// dependency-disjoint (see CAUTION in vite.config.ts) — a runtime import
// from @volli/shared here could split a shared chunk out of preload.cjs.
import type {
  AppStateSetResult,
  ArchivedTicketsResult,
  ArtifactCreateInput,
  ArtifactCreateResult,
  BootstrapResult,
  CommentCreateInput,
  CommentIdInput,
  CommentUpdateInput,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  DataChangedEvent,
  FileChangedEvent,
  FileIndexInput,
  FileIndexResult,
  FilePathInput,
  FileReadResult,
  FileWriteInput,
  FileWriteResult,
  GhosttyAppearancePayload,
  GhosttyConfigResult,
  IpcArgs,
  IpcResult,
  LabelResult,
  LabelSetColorInput,
  LegacyImportRequest,
  LegacyImportResult,
  ListDirectoryResult,
  PickFolderResult,
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectIdInput,
  ProjectMutationResult,
  ProjectUpdateInput,
  ProjectUpdateResult,
  Result,
  RevealResult,
  SessionRenameInput,
  SessionRenameResult,
  SessionsInterruptedEvent,
  SessionsResult,
  TerminalBusyResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalIoResult,
  TerminalParkStateEvent,
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
  TicketUpdateInput,
  UiZoomCommand,
  VolliInvokeContract,
  VolliIpcEvent,
  VolliSendContract,
  WorktreeBranchesResult,
  WorktreeCommitResult,
  WorktreeDiffMode,
  WorktreeDiffResult,
  WorktreeOrphanDeleteResult,
  WorktreeOrphansInput,
  WorktreeOrphansResult,
  WorktreePhaseEvent,
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

/** Typed `ipcRenderer.invoke` bound to the shared contract: the channel literal fixes both the argument tuple and the result type, so a wrong pairing is a compile error. */
const invoke = <C extends keyof VolliInvokeContract>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<IpcResult<C>> => ipcRenderer.invoke(channel, ...args);

/** Typed `ipcRenderer.send` for the 2 fire-and-forget channels, bound the same way. */
const send = <C extends keyof VolliSendContract>(
  channel: C,
  ...args: VolliSendContract[C]["args"]
): void => {
  ipcRenderer.send(channel, ...args);
};

// Minimal typed API surface exposed to the renderer.
const api = {
  app: {
    launchedByCli: process.env["VOLLI_LAUNCHED_BY_CLI"] === "1",
  },
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  data: {
    /** Reads the full SQLite snapshot (projects/tickets/labels/app_state) the renderer boots from. */
    bootstrap: (): Promise<BootstrapResult> => invoke("volli:data-bootstrap"),
    /** One-time localStorage → SQLite import; a no-op (returns current state) once the db is non-empty. */
    importLegacy: (req: LegacyImportRequest): Promise<LegacyImportResult> =>
      invoke("volli:legacy-import", req),
    /** Subscribes to invalidations produced by socket-originated planning mutations. */
    onChanged: (callback: (event: DataChangedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: DataChangedEvent) =>
        callback(payload);
      ipcRenderer.on("volli:data-changed" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:data-changed" satisfies VolliIpcEvent, listener);
    },
  },
  projects: {
    pickFolder: (): Promise<PickFolderResult> => invoke("volli:pick-project-folder"),
    syncRoots: (paths: string[]): Promise<void> => invoke("volli:sync-project-roots", paths),
    /** Creates a project row, or (`created: false`) returns the existing one already tracked at `path`. */
    create: (input: ProjectCreateInput): Promise<ProjectCreateResult> =>
      invoke("volli:project-create", input),
    /** Updates the project's pinned automation base branch and/or worktree setup command. */
    update: (input: ProjectUpdateInput): Promise<ProjectUpdateResult> =>
      invoke("volli:project-update", input),
    /** Deletes a project; cascades its tickets/labels/events in SQLite. */
    remove: (id: string): Promise<ProjectMutationResult> => invoke("volli:project-remove", id),
    /** Rewrites rail `sort_order` to `0..n-1` following `orderedIds`. */
    reorder: (orderedIds: string[]): Promise<ProjectMutationResult> =>
      invoke("volli:project-reorder", orderedIds),
  },
  tickets: {
    create: (input: TicketCreateInput): Promise<TicketResult> =>
      invoke("volli:ticket-create", input),
    /** Runs the shared board move + persists it; resolves with the project's full authoritative ticket list. */
    move: (input: TicketMoveInput): Promise<TicketsResult> => invoke("volli:ticket-move", input),
    /** Resolves with just the mutated ticket (patched into the list by id), not the whole project. */
    setPriority: (input: TicketSetPriorityInput): Promise<TicketResult> =>
      invoke("volli:ticket-set-priority", input),
    update: (input: TicketUpdateInput): Promise<TicketResult> =>
      invoke("volli:ticket-update", input),
    /** Replaces a ticket's labels by name; unknown names are created (`color: null`) per project. Resolves with just that ticket. */
    setLabels: (input: TicketSetLabelsInput): Promise<TicketResult> =>
      invoke("volli:ticket-set-labels", input),
    /** Archives a ticket — it leaves the board but the row, labels, and event log survive (reversible). */
    archive: (input: TicketIdInput): Promise<Result> => invoke("volli:ticket-archive", input),
    /** Returns an archived ticket to the board (appended to its retained column); resolves with the revived live ticket. */
    unarchive: (input: TicketIdInput): Promise<TicketResult> =>
      invoke("volli:ticket-unarchive", input),
    /** Hard-deletes an archived ticket (cascades its labels + events). The only destructive act — rejects a live ticket. */
    delete: (input: TicketIdInput): Promise<Result> => invoke("volli:ticket-delete", input),
    /** The project's archived tickets, newest first — loaded on demand for the Archive view. */
    listArchived: (projectId: string): Promise<ArchivedTicketsResult> =>
      invoke("volli:ticket-list-archived", projectId),
    /** A ticket's full event history, chronological — backs the Activity feed. */
    events: (input: TicketIdInput): Promise<TicketEventsResult> =>
      invoke("volli:ticket-events", input),
  },
  comments: {
    /** A ticket's comments, chronological — the work-log feed. */
    list: (input: TicketIdInput): Promise<TicketCommentsResult> =>
      invoke("volli:comment-list", input),
    /** Posts a comment as the human user; also records a `commented` event in the same transaction. */
    create: (input: CommentCreateInput): Promise<TicketCommentResult> =>
      invoke("volli:comment-create", input),
    /** Edits a comment's body; touches `updatedAt` only, no event. */
    update: (input: CommentUpdateInput): Promise<TicketCommentResult> =>
      invoke("volli:comment-update", input),
    /** Hard-deletes a comment; no event. */
    remove: (input: CommentIdInput): Promise<Result> => invoke("volli:comment-remove", input),
  },
  sessions: {
    /** Every durable session record in a project (ticket-scoped and project-scoped scratch), newest first. */
    list: (input: ProjectIdInput): Promise<SessionsResult> => invoke("volli:session-list", input),
    /** A ticket's durable session records, newest first — backs the right-rail linked-sessions list. */
    listForTicket: (input: TicketIdInput): Promise<SessionsResult> =>
      invoke("volli:session-list-for-ticket", input),
    /** Renames a session (scratch or ticket-scoped); the title is trimmed and must be non-empty in main. */
    rename: (input: SessionRenameInput): Promise<SessionRenameResult> =>
      invoke("volli:session-rename", input),
    /**
     * Subscribes to backward-move interrupt announcements (issue #78, CONCEPT
     * #20): fired only when a ticket move out of the active columns actually
     * Esc'd live agent sessions — the renderer toasts it, never silently.
     */
    onInterrupted: (callback: (event: SessionsInterruptedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionsInterruptedEvent) =>
        callback(payload);
      ipcRenderer.on("volli:sessions-interrupted" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:sessions-interrupted" satisfies VolliIpcEvent, listener);
    },
  },
  labels: {
    setColor: (input: LabelSetColorInput): Promise<LabelResult> =>
      invoke("volli:label-set-color", input),
  },
  files: {
    /** The whole-project file index the `@` picker ranks over (git-listed + `.volli/artifacts/`). Fetched fresh per picker open. */
    index: (input: FileIndexInput): Promise<FileIndexResult> => invoke("volli:file-index", input),
    /** Reads any repo/artifact file worktree-awarely: text (capped), image (data URI), or binary stub. */
    read: (input: FilePathInput): Promise<FileReadResult> => invoke("volli:file-read", input),
    /** Writes markdown content; markdown-only, `expectedMtime` conflict-guarded. Resolves with the fresh mtime. */
    write: (input: FileWriteInput): Promise<FileWriteResult> => invoke("volli:file-write", input),
    /** Creates a new, minimally-templated `.md` in `.volli/artifacts/`; `name` is forced to `.md`. Resolves with its `@ref`-able relPath. */
    createArtifact: (input: ArtifactCreateInput): Promise<ArtifactCreateResult> =>
      invoke("volli:artifact-create", input),
    /** Reveals the resolved file in Finder. */
    reveal: (input: FilePathInput): Promise<Result> => invoke("volli:file-reveal", input),
    /** Watches one open file tab (debounced main→renderer change events); pair with `unwatch` on unmount. */
    watch: (input: FilePathInput): Promise<Result> => invoke("volli:file-watch", input),
    unwatch: (input: FilePathInput): Promise<Result> => invoke("volli:file-unwatch", input),
    /** Subscribes to debounced per-file change events; returns the unsubscribe function. */
    onChanged: (callback: (event: FileChangedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: FileChangedEvent) =>
        callback(payload);
      ipcRenderer.on("volli:file-changed" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:file-changed" satisfies VolliIpcEvent, listener);
    },
  },
  appState: {
    /** Upserts one `app_state` key — the async write-through the ui/workspace persist stores' storage adapter uses. */
    set: (key: string, value: string): Promise<AppStateSetResult> =>
      invoke("volli:app-state-set", key, value),
  },
  worktree: {
    /** The "Remove worktree…" escape hatch; `force` discards uncommitted work when the caller has confirmed. */
    remove: (ticketId: string, force: boolean): Promise<WorktreeRemoveResult> =>
      invoke("volli:worktree-remove", { ticketId, force }),
    /** A project's local branch names, for the base-branch picker. */
    branches: (projectId: string): Promise<WorktreeBranchesResult> =>
      invoke("volli:worktree-branches", { projectId }),
    /**
     * The launch's cached orphan report — the destructive sweep runs once per
     * launch (main), so this never re-sweeps. Pass `{ rescan: true }` for the
     * explicit Settings → Worktrees rescan, which forces a fresh sweep.
     */
    orphans: (opts?: WorktreeOrphansInput): Promise<WorktreeOrphansResult> =>
      invoke("volli:worktree-orphans", opts ?? {}),
    /** User-confirmed deletion of one dirty orphan dir; main re-validates it lives inside the worktree home. */
    deleteOrphan: (path: string): Promise<WorktreeOrphanDeleteResult> =>
      invoke("volli:worktree-orphan-delete", { path }),
    /** Done flow: the finer rail status (uncommitted/sequencer/ahead-behind) for the worktree. */
    status: (ticketId: string): Promise<WorktreeStatusResult> =>
      invoke("volli:worktree-status", { ticketId }),
    /** Done flow: a diff summary — `"working-tree"` (uncommitted now) or `"merge-base"` (the PR delta). */
    diff: (ticketId: string, mode: WorktreeDiffMode): Promise<WorktreeDiffResult> =>
      invoke("volli:worktree-diff", { ticketId, mode }),
    /** Done flow: the one-click "commit remaining work" safety net (fixed chore message). */
    commit: (ticketId: string): Promise<WorktreeCommitResult> =>
      invoke("volli:worktree-commit", { ticketId }),
    /** Done flow: push the branch and open (or re-discover) its draft PR; persists `pr_url`. */
    pushPr: (ticketId: string): Promise<WorktreePushPrResult> =>
      invoke("volli:worktree-push-pr", { ticketId }),
    /** Subscribes to transient worktree-ensure phase transitions; returns the unsubscribe function. */
    onPhase: (callback: (event: WorktreePhaseEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WorktreePhaseEvent) =>
        callback(payload);
      ipcRenderer.on("volli:worktree-phase" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:worktree-phase" satisfies VolliIpcEvent, listener);
    },
  },
  retention: {
    /**
     * The composed retention state for a ticket (merge/conflict/failing-checks +
     * archive-ready + reason + keep + dismissed). Everything but `keep` is
     * transient (recomputed from the merge-watch's last poll + the live TTL
     * clock); re-fetch on a `data-changed` push to stay current.
     */
    state: (ticketId: string): Promise<RetentionStateResult> =>
      invoke("volli:retention-state", { ticketId }),
    /** Sets/clears the durable Keep pin — exempts the ticket from BOTH retention paths. */
    setKeep: (ticketId: string, keep: boolean): Promise<RetentionKeepResult> =>
      invoke("volli:retention-keep", { ticketId, keep }),
    /** Dismisses the Archive prompt for this launch (re-offered next launch — NOT the Keep pin). */
    dismiss: (ticketId: string): Promise<RetentionDismissResult> =>
      invoke("volli:retention-dismiss", { ticketId }),
    /** Archive & clean: archives the ticket + removes its worktree (dirty refuses); branch retained. */
    archiveAndClean: (ticketId: string): Promise<RetentionArchiveCleanResult> =>
      invoke("volli:retention-archive-clean", { ticketId }),
    /** The global Done-TTL in days. */
    getTtlDays: (): Promise<RetentionTtlResult> => invoke("volli:retention-ttl-get"),
    /** Sets the global Done-TTL (clamped to ≥ 1 day); resolves with the stored value. */
    setTtlDays: (days: number): Promise<RetentionTtlResult> =>
      invoke("volli:retention-ttl-set", { days }),
    /** Triggers an immediate merge-watch poll (e.g. on window focus / manual refresh). */
    poll: (): Promise<RetentionPollResult> => invoke("volli:retention-poll"),
  },
  fs: {
    listDirectory: (absPath: string): Promise<ListDirectoryResult> =>
      invoke("volli:list-directory", absPath),
    revealInFinder: (absPath: string): Promise<RevealResult> =>
      invoke("volli:reveal-in-finder", absPath),
  },
  window: {
    isFullScreen: (): Promise<boolean> => invoke("volli:window-is-fullscreen"),
    onFullScreenChange: (callback: (isFullScreen: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isFullScreen: boolean) =>
        callback(isFullScreen);
      ipcRenderer.on("volli:fullscreen-changed" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:fullscreen-changed" satisfies VolliIpcEvent, listener);
    },
    /** Subscribes to native View-menu zoom commands; returns the unsubscribe function. */
    onZoomCommand: (callback: (cmd: UiZoomCommand) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, cmd: UiZoomCommand) => callback(cmd);
      ipcRenderer.on("volli:ui-zoom-command" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:ui-zoom-command" satisfies VolliIpcEvent, listener);
    },
  },
  terminal: {
    /** Boots a PTY session; resolves with its id or a typed error. */
    create: (req: CreateTerminalSessionRequest): Promise<CreateTerminalSessionResult> =>
      invoke("volli:terminal-create", req),
    /** Writes raw input bytes to a session's PTY. */
    write: (sessionId: string, data: string): Promise<TerminalIoResult> =>
      invoke("volli:terminal-write", sessionId, data),
    /** Resizes a session's PTY to the given grid. */
    resize: (sessionId: string, cols: number, rows: number): Promise<TerminalIoResult> =>
      invoke("volli:terminal-resize", sessionId, cols, rows),
    /** Kills a session's PTY. */
    kill: (sessionId: string): Promise<TerminalIoResult> =>
      invoke("volli:terminal-kill", sessionId),
    /** Foreground-process probe: is the session running something beyond its shell? */
    busy: (sessionId: string): Promise<TerminalBusyResult> =>
      invoke("volli:terminal-busy", sessionId),
    /** Flow-control ack: fire-and-forget count of consumed output chars. */
    ack: (sessionId: string, chars: number): void => {
      send("volli:terminal-ack", sessionId, chars);
    },
    /** Parks a session (SIGSTOP its tree) on user request; bypasses the auto-park guards. */
    park: (sessionId: string): Promise<TerminalIoResult> =>
      invoke("volli:terminal-park", sessionId),
    /** Wakes a parked session (SIGCONT its tree). */
    wake: (sessionId: string): Promise<TerminalIoResult> =>
      invoke("volli:terminal-wake", sessionId),
    /** Pins/unpins a session against auto-park; waking it if already parked. */
    setKeepAwake: (sessionId: string, keepAwake: boolean): Promise<TerminalIoResult> =>
      invoke("volli:terminal-keep-awake", sessionId, keepAwake),
    /** Reports pane visibility: fire-and-forget, since it flips on every nav. */
    setVisible: (sessionId: string, visible: boolean): void => {
      send("volli:terminal-set-visible", sessionId, visible);
    },
    /** Subscribes to park/wake/pin state pushes; returns the unsubscribe function. */
    onParkState: (callback: (event: TerminalParkStateEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TerminalParkStateEvent) =>
        callback(payload);
      ipcRenderer.on("volli:terminal-park-state" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:terminal-park-state" satisfies VolliIpcEvent, listener);
    },
    /** Subscribes to PTY output; returns the unsubscribe function. */
    onData: (callback: (event: TerminalDataEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) =>
        callback(payload);
      ipcRenderer.on("volli:terminal-data" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:terminal-data" satisfies VolliIpcEvent, listener);
    },
    /** Subscribes to PTY exit; returns the unsubscribe function. */
    onExit: (callback: (event: TerminalExitEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent) =>
        callback(payload);
      ipcRenderer.on("volli:terminal-exit" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:terminal-exit" satisfies VolliIpcEvent, listener);
    },
    /** Reads the user's resolved Ghostty config, mapped onto restty's appearance model. */
    ghosttyConfig: (): Promise<GhosttyConfigResult> => invoke("volli:ghostty-config-get"),
    /** Subscribes to live Ghostty config reloads; returns the unsubscribe function. */
    onGhosttyConfigChanged: (
      callback: (payload: GhosttyAppearancePayload) => void,
    ): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: GhosttyAppearancePayload) =>
        callback(payload);
      ipcRenderer.on("volli:ghostty-config-changed" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener(
          "volli:ghostty-config-changed" satisfies VolliIpcEvent,
          listener,
        );
    },
  },
};

/**
 * The renderer-facing shape of `window.api`, derived from the implementation
 * so the two can't drift (consumed by the global augmentation in index.d.ts).
 * Type-only — erased at compile, so it doesn't pull a runtime @volli/shared
 * import into preload.cjs.
 */
export type Api = typeof api;

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // Only reachable if contextIsolation is disabled. Object.assign (rather than
  // `window.api = api`) avoids depending on the index.d.ts global augmentation,
  // which the preload's own tsconfig doesn't load — so this typechecks the same
  // under both the node and web compiles.
  Object.assign(window, { api });
}
