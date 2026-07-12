import { contextBridge, ipcRenderer } from "electron";
// Type-only imports ONLY: the pack config keeps main and preload
// dependency-disjoint (see CAUTION in vite.config.ts) — a runtime import
// from @volli/shared here could split a shared chunk out of preload.cjs.
import type {
  AppStateSetResult,
  BootstrapResult,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  GhosttyAppearancePayload,
  GhosttyConfigResult,
  LabelResult,
  LegacyImportRequest,
  LegacyImportResult,
  ListDirectoryResult,
  PickFolderResult,
  ProjectCreateResult,
  ProjectMutationResult,
  RevealResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalIoResult,
  TicketPriority,
  TicketResult,
  TicketsResult,
  TicketStatus,
  UiZoomCommand,
  VolliIpcChannel,
  VolliIpcEvent,
} from "@volli/shared";

// Minimal typed API surface exposed to the renderer.
const api = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  data: {
    /** Reads the full SQLite snapshot (projects/tickets/labels/app_state) the renderer boots from. */
    bootstrap: (): Promise<BootstrapResult> =>
      ipcRenderer.invoke("volli:data-bootstrap" satisfies VolliIpcChannel),
    /** One-time localStorage → SQLite import; a no-op (returns current state) once the db is non-empty. */
    importLegacy: (req: LegacyImportRequest): Promise<LegacyImportResult> =>
      ipcRenderer.invoke("volli:legacy-import" satisfies VolliIpcChannel, req),
  },
  projects: {
    pickFolder: (): Promise<PickFolderResult> =>
      ipcRenderer.invoke("volli:pick-project-folder" satisfies VolliIpcChannel),
    syncRoots: (paths: string[]): Promise<void> =>
      ipcRenderer.invoke("volli:sync-project-roots" satisfies VolliIpcChannel, paths),
    /** Creates a project row, or (`created: false`) returns the existing one already tracked at `path`. */
    create: (input: { path: string; name: string }): Promise<ProjectCreateResult> =>
      ipcRenderer.invoke("volli:project-create" satisfies VolliIpcChannel, input),
    /** Deletes a project; cascades its tickets/labels/events in SQLite. */
    remove: (id: string): Promise<ProjectMutationResult> =>
      ipcRenderer.invoke("volli:project-remove" satisfies VolliIpcChannel, id),
    /** Rewrites rail `sort_order` to `0..n-1` following `orderedIds`. */
    reorder: (orderedIds: string[]): Promise<ProjectMutationResult> =>
      ipcRenderer.invoke("volli:project-reorder" satisfies VolliIpcChannel, orderedIds),
  },
  tickets: {
    create: (input: {
      projectId: string;
      status: TicketStatus;
      title: string;
      priority?: TicketPriority;
    }): Promise<TicketResult> =>
      ipcRenderer.invoke("volli:ticket-create" satisfies VolliIpcChannel, input),
    /** Runs the shared board move + persists it; resolves with the project's full authoritative ticket list. */
    move: (input: {
      projectId: string;
      ticketId: string;
      toStatus: TicketStatus;
      toIndex: number;
    }): Promise<TicketsResult> =>
      ipcRenderer.invoke("volli:ticket-move" satisfies VolliIpcChannel, input),
    /** Resolves with just the mutated ticket (patched into the list by id), not the whole project. */
    setPriority: (input: { ticketId: string; priority: TicketPriority }): Promise<TicketResult> =>
      ipcRenderer.invoke("volli:ticket-set-priority" satisfies VolliIpcChannel, input),
    update: (input: { ticketId: string; title?: string; body?: string }): Promise<TicketResult> =>
      ipcRenderer.invoke("volli:ticket-update" satisfies VolliIpcChannel, input),
    /** Replaces a ticket's labels by name; unknown names are created (`color: null`) per project. Resolves with just that ticket. */
    setLabels: (input: { ticketId: string; labels: string[] }): Promise<TicketResult> =>
      ipcRenderer.invoke("volli:ticket-set-labels" satisfies VolliIpcChannel, input),
  },
  labels: {
    setColor: (input: { labelId: string; color: string | null }): Promise<LabelResult> =>
      ipcRenderer.invoke("volli:label-set-color" satisfies VolliIpcChannel, input),
  },
  appState: {
    /** Upserts one `app_state` key — the async write-through the ui/workspace persist stores' storage adapter uses. */
    set: (key: string, value: string): Promise<AppStateSetResult> =>
      ipcRenderer.invoke("volli:app-state-set" satisfies VolliIpcChannel, key, value),
  },
  fs: {
    listDirectory: (absPath: string): Promise<ListDirectoryResult> =>
      ipcRenderer.invoke("volli:list-directory" satisfies VolliIpcChannel, absPath),
    revealInFinder: (absPath: string): Promise<RevealResult> =>
      ipcRenderer.invoke("volli:reveal-in-finder" satisfies VolliIpcChannel, absPath),
  },
  window: {
    isFullScreen: (): Promise<boolean> =>
      ipcRenderer.invoke("volli:window-is-fullscreen" satisfies VolliIpcChannel),
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
      ipcRenderer.invoke("volli:terminal-create" satisfies VolliIpcChannel, req),
    /** Writes raw input bytes to a session's PTY. */
    write: (sessionId: string, data: string): Promise<TerminalIoResult> =>
      ipcRenderer.invoke("volli:terminal-write" satisfies VolliIpcChannel, sessionId, data),
    /** Resizes a session's PTY to the given grid. */
    resize: (sessionId: string, cols: number, rows: number): Promise<TerminalIoResult> =>
      ipcRenderer.invoke("volli:terminal-resize" satisfies VolliIpcChannel, sessionId, cols, rows),
    /** Kills a session's PTY. */
    kill: (sessionId: string): Promise<TerminalIoResult> =>
      ipcRenderer.invoke("volli:terminal-kill" satisfies VolliIpcChannel, sessionId),
    /** Flow-control ack: fire-and-forget count of consumed output chars. */
    ack: (sessionId: string, chars: number): void => {
      ipcRenderer.send("volli:terminal-ack" satisfies VolliIpcChannel, sessionId, chars);
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
    ghosttyConfig: (): Promise<GhosttyConfigResult> =>
      ipcRenderer.invoke("volli:ghostty-config-get" satisfies VolliIpcChannel),
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
