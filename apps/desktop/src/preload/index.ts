import { contextBridge, ipcRenderer, webUtils } from "electron";
// Type-only imports ONLY, from BOTH sources below: the pack config keeps main
// and preload dependency-disjoint (see CAUTION in vite.config.ts) — a runtime
// import from @volli/shared here could split a shared chunk out of preload.cjs.
//
// Not a theoretical risk, and worth knowing before reaching for one: turning
// the three `import type` channel constants below into value imports was tried
// and measured. `vp pack` went from two output files to three, and preload.cjs
// gained `require("./src-<hash>.cjs")` — a sibling chunk the sandboxed preload
// (Electron ≥20 default) cannot resolve, so the door would fail to load at all
// and take every `window.api` call in the app with it. Rolldown moves whatever
// BOTH entries reach into a shared chunk, and reaching @volli/shared at all is
// enough to reach the module graph main is built out of — the cost has nothing
// to do with how small the imported value is.
//
// So agreement with main is proven the only way it can be from here: in the
// type system, which is erased. See the Session RPC channels below.
//
// The split below is by KIND, not by risk. Domain vocabulary comes from
// @volli/shared; the Electron channel contract comes from ../ipc/contract,
// which is type-only by construction and so has nothing to require either way.
import type {
  Appearance,
  Canvas,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  GhosttyAppearancePayload,
  GhosttyConfigResult,
  ModelAccessSignInType,
  ModelAccessSignInUpdate,
  OverlayEdits,
  ProjectThemeOverride,
  // Imported for `typeof` only — see the Session RPC door below. `import type`
  // of a const is legal and fully erased, which is exactly why these three can
  // be named here at all.
  SESSION_RPC_CANCEL_CHANNEL,
  SESSION_RPC_EVENT_CHANNEL,
  SESSION_RPC_IPC_CHANNEL,
  SessionRpcIpcEvent,
  SessionRpcIpcRequest,
  SessionRpcIpcResponse,
  TerminalBusyResult,
  TerminalCommandResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalIoResult,
  TerminalParkStateEvent,
} from "@volli/shared";
import type {
  AppStateSetResult,
  ArchivedTicketsResult,
  ArtifactCreateInput,
  ArtifactCreateResult,
  BootstrapResult,
  CliDoctorInput,
  CliDoctorResult,
  CliStatusInput,
  CliStatusResult,
  CommentCreateInput,
  BlobAttachInput,
  BlobAttachResult,
  BlobLinkDraftsInput,
  BlobLinkIdInput,
  BlobLinksResult,
  BlobListInput,
  CommentIdInput,
  CommentUpdateInput,
  DatabaseAction,
  DatabaseResult,
  DataChangedEvent,
  DirChangedEvent,
  DirPathInput,
  ExternalAppListResult,
  ExternalAppOpenFileInput,
  ExternalAppOpenWorktreeInput,
  FileChangedEvent,
  FileIndexInput,
  FileIndexResult,
  FilePathInput,
  FileReadResult,
  FileWriteInput,
  FileWriteResult,
  FirstPaintHint,
  HarnessEventNotice,
  HarnessPendingResult,
  HarnessRegisteredResult,
  HarnessTrustSetInput,
  IpcArgs,
  IpcResult,
  LabelResult,
  LabelSetColorInput,
  LegacyImportRequest,
  LegacyImportResult,
  ListDirectoryResult,
  ModelAccessSignInBeginResult,
  PickFolderResult,
  ProjectCanvasWriteResult,
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectIdInput,
  ProjectMutationResult,
  ProjectSessionDefaultsInput,
  ProjectSkillModesInput,
  ProjectUpdateInput,
  ProjectUpdateResult,
  PromptTemplateCreateInput,
  PromptTemplateCreateResult,
  PromptTemplateIndexInput,
  PromptTemplateIndexResult,
  Result,
  RetentionArchiveCleanResult,
  RetentionDismissResult,
  RetentionKeepResult,
  RetentionPollResult,
  RetentionStateResult,
  RetentionTtlResult,
  RevealResult,
  SessionActivityNotice,
  SessionHarnessNotice,
  SessionRenameInput,
  SessionRenameResult,
  SessionRetitledEvent,
  SessionsInterruptedEvent,
  SessionsResult,
  SessionStartedNotice,
  SessionStartsResult,
  TerminalOverlayWriteResult,
  ThemeSetProjectResult,
  ThemeStateInput,
  ThemeStateResult,
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
  UiZoomCommand,
  UnsavedDocumentsReport,
  UpdateChannel,
  UpdateChannelResult,
  UpdateLiveWorkResult,
  UpdateStateResult,
  UpdateUiState,
  VolliInvokeContract,
  WebAccessProvider,
  KeyedWebAccessProvider,
  WebAccessResult,
  VolliIpcChannel,
  VolliIpcEvent,
  VolliSendContract,
  VenueSnapshotResult,
  WorktreeBaseReadResult,
  WorktreeBranchesResult,
  WorktreeChangeSetResult,
  WorktreeChangedEvent,
  WorktreeCommitInput,
  WorktreeCommitResult,
  WorktreeDiffMode,
  WorktreeDiffResult,
  WorktreeOrphanDeleteResult,
  WorktreeOrphansInput,
  WorktreeOrphansResult,
  WorktreePhaseEvent,
  WorktreePushPrResult,
  WorktreeRecreateResult,
  WorktreeRemoveResult,
  WorktreeStatusResult,
  WorktreeWatchErrorEvent,
  WorktreeRevealInput,
} from "../ipc/contract";

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

/**
 * The flag main appends to this window's `process.argv` (`additionalArguments`)
 * carrying the appearance it resolved for first paint.
 *
 * A command-line flag rather than an IPC call because of WHEN it is needed: the
 * mode class has to be on `<html>` before the first frame, and `invoke()`
 * returns a promise — anything awaited is a frame too late, which is the light
 * flash the whole first-paint hint exists to prevent. `sendSync` would block
 * main; argv is already there when the preload's first statement runs.
 *
 * Must match `FIRST_PAINT_APPEARANCE_ARG` in `src/main/window-theme.ts`, which
 * builds it. Duplicated as a literal because preload may not import
 * @volli/shared at runtime (see CAUTION in vite.config.ts) and main is not
 * importable from here at all; a test in main pins the two together.
 */
const FIRST_PAINT_ARG_PREFIX = "--volli-first-paint-appearance=";

/**
 * The resolved mode main handed this window. Never `auto` — what main passes is
 * what it RESOLVED, because an unresolved mode is the one value a first paint
 * cannot act on.
 *
 * `null` means no window built by `createWindow` is behind this preload (the
 * flag is absent or unreadable), so the caller keeps whatever the document
 * already declares rather than guessing at a mode.
 */
function firstPaintAppearance(): "light" | "dark" | null {
  const flag = process.argv.find((arg) => arg.startsWith(FIRST_PAINT_ARG_PREFIX));
  if (flag === undefined) return null;
  const value = flag.slice(FIRST_PAINT_ARG_PREFIX.length);
  return value === "light" || value === "dark" ? value : null;
}

/**
 * The second flag main appends, carrying `nativeTheme.shouldUseDarkColors` —
 * what an `auto` appearance resolves against.
 *
 * It comes from main because the renderer has no way to ask. Chromium answers
 * `matchMedia("(prefers-color-scheme: dark)")` from the root element's used
 * `color-scheme`, which this app stamps for itself a few lines below — so over
 * there the query reports the mode already painted, not the system's. And it
 * comes over argv rather than IPC because the theme store's singleton is
 * constructed at import time, which is before any `invoke()` could settle.
 *
 * Must match `SYSTEM_DARK_ARG` in `src/main/window-theme.ts`, duplicated as a
 * literal for the same reason as the flag above and pinned by the same test.
 */
const SYSTEM_DARK_ARG_PREFIX = "--volli-system-dark=";

/**
 * What the system was asking for when this window was constructed. A snapshot,
 * not a subscription — argv never changes, so later flips arrive through
 * `onSystemAppearanceChanged` below.
 *
 * `null` means the flag is absent or unreadable, i.e. no window built by
 * `createWindow` is behind this preload; the caller picks its own default rather
 * than being handed a guess dressed as an answer.
 */
function systemPrefersDark(): boolean | null {
  const flag = process.argv.find((arg) => arg.startsWith(SYSTEM_DARK_ARG_PREFIX));
  if (flag === undefined) return null;
  const value = flag.slice(SYSTEM_DARK_ARG_PREFIX.length);
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

/**
 * Stamps the resolved mode class on `<html>` before the page's own scripts run.
 *
 * `index.html` no longer pins `class="dark"`, and the two obvious replacements
 * both fail. A `@media (prefers-color-scheme: light)` block knows the SYSTEM,
 * not the setting — a user on a light system who explicitly chose dark would get
 * a light first paint and then a flip, which is the flash the hint exists to
 * kill, arriving from the other side. And an inline `<script>` is blocked
 * outright: the CSP in `index.html` is `script-src 'self' 'wasm-unsafe-eval'`
 * with no `'unsafe-inline'`, so it would silently never run.
 *
 * Preload is the one place left that runs in the renderer before any page
 * script AND already has the answer synchronously, off `process.argv`. Main
 * additionally sets `BrowserWindow.backgroundColor` from the same hint, so the
 * window edge is right before the document paints anything at all.
 *
 * Guarded because the timing is not guaranteed: `document.documentElement` is
 * normally present by the time a preload's first statement runs, but a preload
 * that lands earlier would throw here and take the whole bridge with it. One
 * `readystatechange` listener is the fallback, and it is removed as soon as it
 * fires.
 *
 * `null` — no flag, or an unreadable one — leaves the document alone: nothing
 * built this window through `createWindow`, and guessing at a mode is worse
 * than deferring to whatever the stylesheet already declares (which is dark).
 */
function stampFirstPaintAppearance(): void {
  const appearance = firstPaintAppearance();
  if (appearance === null) return;
  const stamp = (): boolean => {
    const root = document.documentElement;
    if (root === null || root === undefined) return false;
    root.classList.remove(appearance === "dark" ? "light" : "dark");
    root.classList.add(appearance);
    return true;
  };
  if (stamp()) return;
  const onReady = (): void => {
    if (stamp()) document.removeEventListener("readystatechange", onReady);
  };
  document.addEventListener("readystatechange", onReady);
}

stampFirstPaintAppearance();

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
  /** Reads the database size or runs one main-owned action without exposing its path. */
  database: (action?: DatabaseAction): Promise<DatabaseResult> =>
    action === undefined ? invoke("volli:database") : invoke("volli:database", action),
  projects: {
    pickFolder: (): Promise<PickFolderResult> => invoke("volli:pick-project-folder"),
    syncRoots: (paths: string[]): Promise<void> => invoke("volli:sync-project-roots", paths),
    /** Creates a project row, or (`created: false`) returns the existing one already tracked at `path`. */
    create: (input: ProjectCreateInput): Promise<ProjectCreateResult> =>
      invoke("volli:project-create", input),
    /** Updates the project's pinned automation base branch and/or worktree setup command. */
    update: (input: ProjectUpdateInput): Promise<ProjectUpdateResult> =>
      invoke("volli:project-update", input),
    /** Replaces this project's per-skill rules wholesale — the Configure Skills table (VC-111). */
    setSkillModes: (input: ProjectSkillModesInput): Promise<ProjectUpdateResult> =>
      invoke("volli:project-skill-modes", input),
    /** Replaces this project's harness/model defaults for new Sessions (VC-111). */
    setSessionDefaults: (input: ProjectSessionDefaultsInput): Promise<ProjectUpdateResult> =>
      invoke("volli:project-session-defaults", input),
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
    /** The latest durable Session outcome per ticket — one batched read backing the sidebar's attention rows. */
    latestSignals: (input: ProjectIdInput): Promise<TicketLatestSignalsResult> =>
      invoke("volli:ticket-latest-signals", input),
    /** When each non-archived ticket entered its current status — one batched read backing the sidebar. */
    statusEntries: (input: ProjectIdInput): Promise<TicketStatusEntriesResult> =>
      invoke("volli:ticket-status-entries", input),
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
  attachments: {
    /**
     * Attaches one file (VC-50). Main decides whether it becomes an `@` ref to
     * a live repo file or a snapshot in the Blob store — the renderer knows
     * neither the project roots nor the bytes on disk, and should not.
     */
    attach: (input: BlobAttachInput): Promise<BlobAttachResult> =>
      invoke("volli:blob-attach", input),
    /** A ticket's or a session's attachments, chronological. */
    list: (input: BlobListInput): Promise<BlobLinksResult> => invoke("volli:blob-list", input),
    /** Detaches one attachment; the bytes stay until collection. */
    remove: (input: BlobLinkIdInput): Promise<Result> => invoke("volli:blob-remove", input),
    /** Attaches Blobs imported before their ticket existed, once it has an id. */
    linkDrafts: (input: BlobLinkDraftsInput): Promise<BlobLinksResult> =>
      invoke("volli:blob-link-drafts", input),
    /**
     * The absolute path behind a dropped `File`, or `""` when the drag did not
     * come from the filesystem.
     *
     * Electron 32 removed `File.path`, and `webUtils` is a renderer-side API
     * that context isolation puts out of the page's reach — so this crossing
     * exists purely to answer "where did this file come from?", which is what
     * decides between an `@` ref and a snapshot. It reads a path; it never
     * opens one.
     */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
  },
  sessions: {
    /** Every Session in a project (ticket-scoped and project-scoped), newest first — a terminal or chat row per Session, never dropped. */
    list: (input: ProjectIdInput): Promise<SessionsResult> => invoke("volli:session-list", input),
    /** A ticket's Session listing rows, newest first — backs the right-rail linked-sessions list. */
    listForTicket: (input: TicketIdInput): Promise<SessionsResult> =>
      invoke("volli:session-list-for-ticket", input),
    /**
     * Renames a session (project- or ticket-scoped); the title is trimmed and
     * must be non-empty in main.
     *
     * `refineFrom` rides along on the automatic heuristic rename only (VC-81):
     * main may then derive a sharper title with one model call. The result
     * still answers the rename — the refinement is best effort behind it, and
     * its failures keep the title this call just wrote.
     */
    rename: (input: SessionRenameInput): Promise<SessionRenameResult> =>
      invoke("volli:session-rename", input),
    /**
     * When Sessions were started, across every project, from `sinceMs` onward
     * — the Home empty chat's practice chart (VC-55). Stamps, not rows: a count
     * per day needs no titles and no histories.
     */
    starts: (sinceMs: number): Promise<SessionStartsResult> =>
      invoke("volli:session-starts", { sinceMs }),
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
    /**
     * Subscribes to retitles main performed itself (VC-81 auto-titling).
     * Renderer-originated renames move their own labels and never arrive
     * here; this carries the ones nothing on screen would otherwise learn.
     */
    onRetitled: (callback: (event: SessionRetitledEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionRetitledEvent) =>
        callback(payload);
      ipcRenderer.on("volli:session-retitled" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:session-retitled" satisfies VolliIpcEvent, listener);
    },
    /**
     * Subscribes to canonical harness events (harness-events): a hook the
     * launch wrapper configured fired, and main resolved which session it
     * belongs to. Harness-native event names never arrive here.
     */
    onHarnessEvent: (callback: (event: HarnessEventNotice) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: HarnessEventNotice) =>
        callback(payload);
      ipcRenderer.on("volli:harness-event" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:harness-event" satisfies VolliIpcEvent, listener);
    },
    /**
     * Subscribes to socket-originated Session starts (VC-13): `volli session
     * start` opened a chat Session on a ticket, and the renderer toasts it —
     * with an "Open session" action — instead of navigating anywhere itself.
     */
    onStarted: (callback: (event: SessionStartedNotice) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionStartedNotice) =>
        callback(payload);
      ipcRenderer.on("volli:session-started" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:session-started" satisfies VolliIpcEvent, listener);
    },
    /**
     * Subscribes to harness-change announcements: a different harness's launch
     * wrapper ran inside a session's terminal. Fired only on a change — the
     * wrapper announces every launch, and most announces agree with what main
     * already recorded.
     */
    onHarnessChange: (callback: (event: SessionHarnessNotice) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionHarnessNotice) =>
        callback(payload);
      ipcRenderer.on("volli:session-harness" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:session-harness" satisfies VolliIpcEvent, listener);
    },
    /**
     * Subscribes to Session listing rows re-derived after a Session's durable
     * history moved — the push that replaced the ten-second `list` poll. Every
     * project's Sessions arrive on this one channel; a listener scoped to one
     * project filters on `projectId` before it looks at the row.
     */
    onActivity: (callback: (event: SessionActivityNotice) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionActivityNotice) =>
        callback(payload);
      ipcRenderer.on("volli:session-activity" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:session-activity" satisfies VolliIpcEvent, listener);
    },
  },
  /**
   * The native Session tRPC edge. Three calls, deliberately shapeless: the
   * router declares what a procedure takes and returns, so this door only has
   * to carry a request there and frames back. The renderer speaks it through
   * its terminating tRPC link, never directly.
   *
   * Each channel literal is pinned with `satisfies typeof <the constant
   * `session-rpc-wire.ts` exports>`, which is the strongest statement this file
   * can make about it. `satisfies VolliIpcChannel` — what every other door here
   * uses — only proves the string is SOME channel; it says nothing about
   * whether it is the one main registered a handler for, and a typo landing on
   * another real channel is exactly the mistake that would pass it. Pinning to
   * the constant makes a disagreement between the two ends of this wire a
   * compile error, and the header explains why the constant cannot simply be
   * called instead.
   */
  sessionRpc: {
    /** Runs one routed procedure; `session.subscribe` acknowledges with the id its frames will carry. */
    request: (request: SessionRpcIpcRequest): Promise<SessionRpcIpcResponse> =>
      invoke("volli:session-rpc" satisfies typeof SESSION_RPC_IPC_CHANNEL, request),
    /**
     * Subscribes to the frames of EVERY live subscription; returns the
     * unsubscribe function. One listener rather than one per subscription
     * because the id main acknowledged with is what tells them apart, and it
     * can arrive after the first frame does.
     */
    onEvent: (callback: (event: SessionRpcIpcEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionRpcIpcEvent) =>
        callback(payload);
      const channel = "volli:session-rpc-event" satisfies typeof SESSION_RPC_EVENT_CHANNEL;
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    /** Ends one subscription: fire-and-forget, since the frames stopping is the answer. */
    cancel: (subscriptionId: string): void => {
      send("volli:session-rpc-cancel" satisfies typeof SESSION_RPC_CANCEL_CHANNEL, subscriptionId);
    },
  },
  /**
   * In-app provider sign-in. Its own door rather than a Session RPC namespace,
   * because one argument here is an API key: every RPC procedure is wrapped by
   * a diagnostic recorder with a live subscription tap on it, and a secret and
   * a log tap do not belong on one wire. Nothing on these four channels is
   * recorded, and an attempt lives no longer than the window that began it.
   */
  modelAccess: {
    /** Starts one attempt; the id it answers with is on every later message about it. */
    beginSignIn: (
      providerId: string,
      type: ModelAccessSignInType,
    ): Promise<ModelAccessSignInBeginResult> =>
      invoke("volli:model-access-sign-in-begin", providerId, type),
    /**
     * Answers the step an attempt is parked on — the one inbound secret in the
     * app, and one-way: main hands it to the provider's flow and it is never
     * read back out, echoed, or put in an error string. `promptId` is what
     * keeps a late answer off the next question.
     */
    respondToPrompt: (attemptId: string, promptId: string, value: string): Promise<Result> =>
      invoke("volli:model-access-sign-in-respond", attemptId, promptId, value),
    /** Abandons an attempt; the parked prompt rejects and the flow unwinds. */
    cancelSignIn: (attemptId: string): Promise<Result> =>
      invoke("volli:model-access-sign-in-cancel", attemptId),
    /** Deletes this profile's stored credential. Ambient environment sources are untouched. */
    signOut: (providerId: string): Promise<Result> =>
      invoke("volli:model-access-sign-out", providerId),
    /**
     * Subscribes to the frames of EVERY live attempt; returns the unsubscribe
     * function. One listener rather than one per attempt, for the same reason
     * the Session RPC door has one: main mints the id, so a prompt can arrive
     * before the renderer knows what to call it.
     */
    onSignInUpdate: (callback: (update: ModelAccessSignInUpdate) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ModelAccessSignInUpdate) =>
        callback(payload);
      const channel = "volli:model-access-sign-in" satisfies VolliIpcEvent;
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  },
  /**
   * Bring-your-own web search. Its own door beside `modelAccess`, for the same
   * reason that one has one: `setKey` carries an API key, and the instrumented
   * Session RPC wire is not where a secret belongs.
   *
   * One direction only. A key goes in; every call answers with the same
   * settings view, in which a key is three words about its state and never a
   * value. There is no call here that reads one back.
   */
  webAccess: {
    /** The current setting — provider, instance URL, and whether a key is held. */
    get: (): Promise<WebAccessResult> => invoke("volli:web-access-get"),
    /** Chooses the provider; the SearXNG URL is judged by policy before it is stored. */
    setProvider: (
      provider: WebAccessProvider,
      searxngUrl: string | null,
    ): Promise<WebAccessResult> => invoke("volli:web-access-set-provider", provider, searxngUrl),
    /**
     * Stores one provider's key. The one outbound secret in the app after
     * sign-in, and one-way: main encrypts it with the OS keychain and it is
     * never read back, echoed, or put in an error string.
     */
    setKey: (provider: KeyedWebAccessProvider, key: string): Promise<WebAccessResult> =>
      invoke("volli:web-access-set-key", provider, key),
    /** Forgets one provider's key. The provider choice, and the other key, are left alone. */
    clearKey: (provider: KeyedWebAccessProvider): Promise<WebAccessResult> =>
      invoke("volli:web-access-clear-key", provider),
  },
  labels: {
    setColor: (input: LabelSetColorInput): Promise<LabelResult> =>
      invoke("volli:label-set-color", input),
  },
  /**
   * Bring-your-own harness trust (docs/plans/harness-events.md §Trust). A
   * manifest on disk declares a command line Volli will execute and stays inert
   * until a human confirms it; these two calls are the question and the answer.
   */
  harness: {
    /** Every discovered manifest nobody has ruled on, re-read and re-hashed per call. */
    pending: (): Promise<HarnessPendingResult> => invoke("volli:harness-pending"),
    /**
     * Records a verdict about the exact bytes the confirmation described.
     * `manifestSha256` is the hash that was SHOWN — main refuses the write when
     * the file no longer hashes to it, so a manifest edited while the dialog was
     * open comes back as a new question instead of inheriting this answer.
     */
    setTrust: (input: HarnessTrustSetInput): Promise<Result> =>
      invoke("volli:harness-trust-set", input),
    /**
     * The registered harnesses this host will actually launch, whole adapters,
     * as main last resolved them. Built-ins are not in here — the renderer has
     * those compiled in. Fetched fresh rather than cached: a verdict recorded
     * while the app is open regenerates the wrappers on the spot, so the answer
     * has a shelf life.
     */
    registered: (): Promise<HarnessRegisteredResult> => invoke("volli:harness-registered"),
  },
  /**
   * The Settings → CLI detection surface (VC-52). The install is silent and
   * background, so this is the one place its truth can be read: link, PATH,
   * socket, wrappers, shell chain — measured fresh per call, never cached.
   */
  cli: {
    status: (input?: CliStatusInput): Promise<CliStatusResult> =>
      input === undefined ? invoke("volli:cli-status") : invoke("volli:cli-status", input),
    /** A real `volli doctor` run through the user's login shell; `fix` repairs first. */
    doctor: (input: CliDoctorInput): Promise<CliDoctorResult> => invoke("volli:cli-doctor", input),
  },
  files: {
    /** The whole-project file index the `@` picker ranks over (git-listed + `.volli/artifacts/`). Fetched fresh per picker open. */
    index: (input: FileIndexInput): Promise<FileIndexResult> => invoke("volli:file-index", input),
    /** Reads any repo/artifact file worktree-awarely: text (capped), image (data URI), or binary stub. */
    read: (input: FilePathInput): Promise<FileReadResult> => invoke("volli:file-read", input),
    /** Writes utf8 text to an EXISTING file (images/binary/oversize refused), `expectedMtime` conflict-guarded. Resolves with the fresh mtime. */
    write: (input: FileWriteInput): Promise<FileWriteResult> => invoke("volli:file-write", input),
    /** Creates a new, minimally-templated `.md` in `.volli/artifacts/`; `name` is forced to `.md`. Resolves with its `@ref`-able relPath. */
    createArtifact: (input: ArtifactCreateInput): Promise<ArtifactCreateResult> =>
      invoke("volli:artifact-create", input),
    /** The composer `/` picker's prompt templates: the project's `.volli/commands/` over the global `<userData>/commands/`. A missing directory is an empty list, not an error. */
    promptTemplates: (input: PromptTemplateIndexInput): Promise<PromptTemplateIndexResult> =>
      invoke("volli:prompt-templates", input),
    /** Creates one `<name>.md` prompt template, refusing rather than clobbering (VC-111). */
    createPromptTemplate: (input: PromptTemplateCreateInput): Promise<PromptTemplateCreateResult> =>
      invoke("volli:prompt-template-create", input),
    /** Reveals the resolved file in Finder. */
    reveal: (input: FilePathInput): Promise<Result> => invoke("volli:file-reveal", input),
    /** The installed subset of the allowlisted external-editor catalogue. */
    listExternalApps: (): Promise<ExternalAppListResult> => invoke("volli:external-app-list"),
    /** Opens a resolved main- or ticket-worktree file/folder in one known external app. */
    openInExternalApp: (input: ExternalAppOpenFileInput): Promise<Result> =>
      invoke("volli:external-app-open-file", input),
    /** Opens the ticket's live worktree root in one known external app. */
    openWorktreeInExternalApp: (input: ExternalAppOpenWorktreeInput): Promise<Result> =>
      invoke("volli:external-app-open-worktree", input),
    /** Reveals the ticket's live worktree root in Finder without accepting a renderer path. */
    revealWorktree: (input: WorktreeRevealInput): Promise<Result> =>
      invoke("volli:worktree-reveal", input),
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
    /** Watches ONE expanded Project Files directory (non-recursive, main checkout); `relPath: ""` is the project root. Pair with `unwatchDir` on collapse. */
    watchDir: (input: DirPathInput): Promise<Result> => invoke("volli:dir-watch", input),
    unwatchDir: (input: DirPathInput): Promise<Result> => invoke("volli:dir-unwatch", input),
    /** Subscribes to debounced per-directory change events; returns the unsubscribe function. */
    onDirChanged: (callback: (event: DirChangedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: DirChangedEvent) =>
        callback(payload);
      ipcRenderer.on("volli:dir-changed" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:dir-changed" satisfies VolliIpcEvent, listener);
    },
    /**
     * Tells main which open documents hold unsaved drafts, so ⌘Q can stop and
     * ask instead of discarding them. Fire-and-forget: main needs a synchronous
     * answer at quit time and cannot ask for one then, so it reads the last
     * report — see `main/quit-gate.ts`.
     */
    reportUnsaved: (report: UnsavedDocumentsReport): void => {
      ipcRenderer.send("volli:unsaved-documents" satisfies VolliIpcChannel, report);
    },
  },
  appState: {
    /** Upserts one `app_state` key — the async write-through the ui/workspace persist stores' storage adapter uses. */
    set: (key: string, value: string): Promise<AppStateSetResult> =>
      invoke("volli:app-state-set", key, value),
  },
  /**
   * The venue a Session runs in, measured (VC-55) — its own door rather than a
   * `worktree` verb, because the question is not about a worktree: a Project
   * Session's venue is the project's main checkout, and a ticket's may be too.
   */
  venue: {
    /** One reading of the checkout `{ projectId, ticketId }` names. `ticketId: null` is a Project Session. */
    snapshot: (projectId: string, ticketId: string | null): Promise<VenueSnapshotResult> =>
      invoke("volli:venue-snapshot", { projectId, ticketId }),
  },
  worktree: {
    /** The "Remove worktree…" escape hatch; `force` discards uncommitted work when the caller has confirmed. */
    remove: (ticketId: string, force: boolean): Promise<WorktreeRemoveResult> =>
      invoke("volli:worktree-remove", { ticketId, force }),
    /**
     * Puts a ticket's worktree back on its existing branch after the directory
     * went missing (VC-113). Idempotent — a checkout that is already there is
     * left exactly as it is.
     */
    recreate: (ticketId: string): Promise<WorktreeRecreateResult> =>
      invoke("volli:worktree-recreate", { ticketId }),
    /**
     * A project's branch refs for the base-branch pickers: local heads, the
     * checkout's own branch, remote-tracking refs, and when those last moved
     * (see `WorktreeBranchListing` — the remote half is a snapshot, not a live
     * reading, and the pickers label it as one).
     */
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
    /** Composed Change Set snapshot relative to the ticket's recorded base. */
    changeSet: (ticketId: string): Promise<WorktreeChangeSetResult> =>
      invoke("volli:worktree-change-set", { ticketId }),
    /**
     * Reads one path at the Change Set base revision without mutating the
     * checkout. Pass the `baseRevision` of the snapshot being rendered to pin
     * the read to it; omit it to read against the base as it resolves now.
     */
    baseRead: (
      ticketId: string,
      path: string,
      baseRevision?: string,
    ): Promise<WorktreeBaseReadResult> =>
      invoke("volli:worktree-base-read", { ticketId, path, baseRevision }),
    /** Debounced recursive watch on the ticket worktree; pair with `unwatchChangeSet` on leave. */
    watchChangeSet: (ticketId: string): Promise<Result> =>
      invoke("volli:worktree-change-watch", { ticketId }),
    unwatchChangeSet: (ticketId: string): Promise<Result> =>
      invoke("volli:worktree-change-unwatch", { ticketId }),
    /** Subscribes to debounced worktree filesystem changes for Change Set refresh. */
    onChanged: (callback: (event: WorktreeChangedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WorktreeChangedEvent) =>
        callback(payload);
      ipcRenderer.on("volli:worktree-changed" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:worktree-changed" satisfies VolliIpcEvent, listener);
    },
    /**
     * Subscribes to worktree watch FAULTS. After one of these the ticket sends
     * no further `onChanged`, so a listener must surface the stall rather than
     * keep showing a Change Set that can no longer refresh.
     */
    onWatchError: (callback: (event: WorktreeWatchErrorEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: WorktreeWatchErrorEvent) =>
        callback(payload);
      ipcRenderer.on("volli:worktree-watch-error" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:worktree-watch-error" satisfies VolliIpcEvent, listener);
    },
    /**
     * Done flow: the one-click "commit remaining work" safety net. `choices`
     * carries the rail dialog's two fields; omit either (or the argument) for
     * the command's own defaults — a generated `chore(<id>)` message and the
     * whole worktree staged.
     */
    commit: (
      ticketId: string,
      choices: Omit<WorktreeCommitInput, "ticketId"> = {},
    ): Promise<WorktreeCommitResult> =>
      invoke("volli:worktree-commit", {
        ticketId,
        message: choices.message,
        includeUnstaged: choices.includeUnstaged,
      }),
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
  updates: {
    /** The updater's current snapshot (VC-59) — primes the sidebar's store on boot. */
    state: (): Promise<UpdateStateResult> => invoke("volli:update-state-get"),
    /** Fire-and-forget explicit check (the idle icon's click); outcomes arrive over `onState`. */
    check: (): Promise<Result> => invoke("volli:update-check"),
    /**
     * The confirmed install — the ONE prompt's accept. Main raises the quit
     * latch and hands the staged update to Squirrel; on success the app is
     * already restarting by the time this resolves.
     */
    install: (): Promise<Result> => invoke("volli:update-install"),
    /** The live work the install dialog must name: busy PTYs, open agent Sessions, unsaved drafts. */
    liveWork: (): Promise<UpdateLiveWorkResult> => invoke("volli:update-live-work"),
    /** Which release line this install follows (VC-111). */
    channel: (): Promise<UpdateChannelResult> => invoke("volli:update-channel-get"),
    /** Moves this install between release lines; takes effect on the next check. */
    setChannel: (channel: UpdateChannel): Promise<UpdateChannelResult> =>
      invoke("volli:update-channel-set", channel),
    /** Subscribes to updater state transitions; returns the unsubscribe function. */
    onState: (callback: (state: UpdateUiState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: UpdateUiState) =>
        callback(payload);
      ipcRenderer.on("volli:update-state" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener("volli:update-state" satisfies VolliIpcEvent, listener);
    },
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
    /**
     * Runs one Volli-offered command in a live session's shell, resolving with
     * its exit code when it finishes. Deliberately long-lived: an install
     * takes as long as it takes, and its output streams to the pane meanwhile.
     */
    run: (sessionId: string, command: string): Promise<TerminalCommandResult> =>
      invoke("volli:terminal-run", sessionId, command),
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
  /**
   * Theming. Only AUTHORED inputs cross this door: the resolved token set is
   * generated in the renderer at render time and stored nowhere. A terminal
   * overlay write names a SCOPE, never a path, so no renderer request can
   * reach the user's own ghostty config (#67).
   */
  theme: {
    /** The resolved terminal chain for a scope, plus the project's per-surface override. */
    state: (input: ThemeStateInput = {}): Promise<ThemeStateResult> =>
      invoke("volli:theme-state", input),
    /**
     * Persists one project's per-surface override; `null` clears it back to inheriting.
     */
    setProject: (
      projectId: string,
      override: ProjectThemeOverride | null,
    ): Promise<ThemeSetProjectResult> => invoke("volli:theme-set-project", { projectId, override }),
    /**
     * The canvas (docs/plans/arc-theming-migration.md): five writes, no reads.
     * Everything these persist comes back through `data.bootstrap()` — the
     * global canvas and appearance as `app_state` rows, a project's as columns
     * on its row — so there is deliberately no `canvas.state()` twin.
     */
    setGlobalCanvas: (canvas: Canvas): Promise<Result> =>
      invoke("volli:theme-canvas-set-global", { canvas }),
    /** Persists the global light/dark/auto choice. */
    setGlobalAppearance: (appearance: Appearance): Promise<Result> =>
      invoke("volli:theme-appearance-set-global", { appearance }),
    /** Persists one workspace's canvas; `null` clears it back to inheriting the global one. */
    setProjectCanvas: (
      projectId: string,
      canvas: Canvas | null,
    ): Promise<ProjectCanvasWriteResult> =>
      invoke("volli:theme-canvas-set-project", { projectId, canvas }),
    /** Persists one workspace's appearance; `null` clears it back to inheriting. */
    setProjectAppearance: (
      projectId: string,
      appearance: Appearance | null,
    ): Promise<ProjectCanvasWriteResult> =>
      invoke("volli:theme-appearance-set-project", { projectId, appearance }),
    /**
     * Records the mode and background this paint resolved to, so the NEXT
     * launch constructs its window with both already known. A hint, not an
     * authority: `{canvas, appearance}` stays the pair everything is derived
     * from, and this row is overwritten on every paint.
     */
    setFirstPaint: (hint: FirstPaintHint): Promise<Result> =>
      invoke("volli:theme-first-paint-set", hint),
    /**
     * What main resolved for THIS window before the renderer existed — the
     * value the inline script in `index.html` stamps the mode class from, read
     * synchronously off the process arguments rather than over IPC because a
     * round trip cannot be awaited before first paint. `null` only when the
     * flag is missing — keep the document's declared mode in that case.
     */
    firstPaintAppearance,
    /**
     * What `nativeTheme` said when this window was built — the boolean an `auto`
     * appearance resolves against, read synchronously off the process arguments
     * because the theme store's initial state needs it before any round trip
     * could return. `null` when the flag is absent.
     */
    systemPrefersDark,
    /**
     * Subscribes to real OS light↔dark flips (`nativeTheme`'s `updated`, fanned
     * out by main); returns the unsubscribe function.
     *
     * The renderer cannot observe one for itself — its own
     * `prefers-color-scheme` query resolves against the mode this app stamped,
     * so it never moves — which is why the flip has to be pushed rather than
     * polled.
     */
    onSystemAppearanceChanged: (callback: (prefersDark: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, prefersDark: boolean) =>
        callback(prefersDark);
      ipcRenderer.on("volli:system-appearance-changed" satisfies VolliIpcEvent, listener);
      return () =>
        ipcRenderer.removeListener(
          "volli:system-appearance-changed" satisfies VolliIpcEvent,
          listener,
        );
    },
    /** Rewrites keys in Volli's global ghostty overlay (`null` removes a key). */
    writeGlobalOverlay: (edits: OverlayEdits): Promise<TerminalOverlayWriteResult> =>
      invoke("volli:theme-terminal-overlay-write", { scope: "global", edits }),
    /** Rewrites keys in one project's ghostty overlay. */
    writeProjectOverlay: (
      projectId: string,
      edits: OverlayEdits,
    ): Promise<TerminalOverlayWriteResult> =>
      invoke("volli:theme-terminal-overlay-write", { scope: "project", projectId, edits }),
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
