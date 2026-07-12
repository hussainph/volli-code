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
  TicketCreateResult,
  TicketPriority,
  TicketsResult,
  TicketStatus,
  UiZoomCommand,
} from "@volli/shared";

export interface Api {
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  data: {
    /** Reads the full SQLite snapshot (projects/tickets/labels/app_state) the renderer boots from. */
    bootstrap: () => Promise<BootstrapResult>;
    /** One-time localStorage → SQLite import; a no-op (returns current state) once the db is non-empty. */
    importLegacy: (req: LegacyImportRequest) => Promise<LegacyImportResult>;
  };
  projects: {
    /** Native folder picker; resolves canceled or with the chosen path + basename. */
    pickFolder: () => Promise<PickFolderResult>;
    /** Registers the set of project roots the fs handlers may operate inside. */
    syncRoots: (paths: string[]) => Promise<void>;
    /** Creates a project row, or (`created: false`) returns the existing one already tracked at `path`. */
    create: (input: { path: string; name: string }) => Promise<ProjectCreateResult>;
    /** Deletes a project; cascades its tickets/labels/events in SQLite. */
    remove: (id: string) => Promise<ProjectMutationResult>;
    /** Rewrites rail `sort_order` to `0..n-1` following `orderedIds`. */
    reorder: (orderedIds: string[]) => Promise<ProjectMutationResult>;
  };
  tickets: {
    create: (input: {
      projectId: string;
      status: TicketStatus;
      title: string;
      priority?: TicketPriority;
    }) => Promise<TicketCreateResult>;
    /** Runs the shared board move + persists it; resolves with the project's full authoritative ticket list. */
    move: (input: {
      projectId: string;
      ticketId: string;
      toStatus: TicketStatus;
      toIndex: number;
    }) => Promise<TicketsResult>;
    setPriority: (input: { ticketId: string; priority: TicketPriority }) => Promise<TicketsResult>;
    update: (input: { ticketId: string; title?: string; body?: string }) => Promise<TicketsResult>;
    /** Replaces a ticket's labels by name; unknown names are created (`color: null`) per project. */
    setLabels: (input: { ticketId: string; labels: string[] }) => Promise<TicketsResult>;
  };
  labels: {
    setColor: (input: { labelId: string; color: string | null }) => Promise<LabelResult>;
  };
  appState: {
    /** Upserts one `app_state` key — the async write-through the ui/workspace persist stores' storage adapter uses. */
    set: (key: string, value: string) => Promise<AppStateSetResult>;
  };
  fs: {
    /** Lists one directory level (dirs-first, `.git` hidden, symlinks as files). */
    listDirectory: (absPath: string) => Promise<ListDirectoryResult>;
    /** Reveals the path in Finder. */
    revealInFinder: (absPath: string) => Promise<RevealResult>;
  };
  window: {
    /** Whether the window is currently in macOS fullscreen. */
    isFullScreen: () => Promise<boolean>;
    /** Subscribes to fullscreen enter/leave; returns the unsubscribe function. */
    onFullScreenChange: (callback: (isFullScreen: boolean) => void) => () => void;
    /** Subscribes to native View-menu zoom commands; returns the unsubscribe function. */
    onZoomCommand: (callback: (cmd: UiZoomCommand) => void) => () => void;
  };
  terminal: {
    /** Boots a PTY session; resolves with its id or a typed error. */
    create: (req: CreateTerminalSessionRequest) => Promise<CreateTerminalSessionResult>;
    /** Writes raw input bytes to a session's PTY. */
    write: (sessionId: string, data: string) => Promise<TerminalIoResult>;
    /** Resizes a session's PTY to the given grid. */
    resize: (sessionId: string, cols: number, rows: number) => Promise<TerminalIoResult>;
    /** Kills a session's PTY. */
    kill: (sessionId: string) => Promise<TerminalIoResult>;
    /** Flow-control ack: fire-and-forget count of consumed output chars. */
    ack: (sessionId: string, chars: number) => void;
    /** Subscribes to PTY output; returns the unsubscribe function. */
    onData: (callback: (event: TerminalDataEvent) => void) => () => void;
    /** Subscribes to PTY exit; returns the unsubscribe function. */
    onExit: (callback: (event: TerminalExitEvent) => void) => () => void;
    /** Reads the user's resolved Ghostty config, mapped onto restty's appearance model. */
    ghosttyConfig: () => Promise<GhosttyConfigResult>;
    /** Subscribes to live Ghostty config reloads; returns the unsubscribe function. */
    onGhosttyConfigChanged: (callback: (payload: GhosttyAppearancePayload) => void) => () => void;
  };
}

declare global {
  interface Window {
    api: Api;
  }
}
