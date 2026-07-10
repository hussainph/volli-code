import { contextBridge, ipcRenderer } from "electron";
// Type-only imports ONLY: the pack config keeps main and preload
// dependency-disjoint (see CAUTION in vite.config.ts) — a runtime import
// from @volli/shared here could split a shared chunk out of preload.cjs.
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
  projects: {
    pickFolder: (): Promise<PickFolderResult> =>
      ipcRenderer.invoke("volli:pick-project-folder" satisfies VolliIpcChannel),
    syncRoots: (paths: string[]): Promise<void> =>
      ipcRenderer.invoke("volli:sync-project-roots" satisfies VolliIpcChannel, paths),
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

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts) — only reachable if contextIsolation is disabled
  window.api = api;
}
