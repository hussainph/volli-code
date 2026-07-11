import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  GhosttyAppearancePayload,
  GhosttyConfigResult,
  ListDirectoryResult,
  PickFolderResult,
  RevealResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalIoResult,
} from "@volli/shared";

export interface Api {
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  projects: {
    /** Native folder picker; resolves canceled or with the chosen path + basename. */
    pickFolder: () => Promise<PickFolderResult>;
    /** Registers the set of project roots the fs handlers may operate inside. */
    syncRoots: (paths: string[]) => Promise<void>;
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
