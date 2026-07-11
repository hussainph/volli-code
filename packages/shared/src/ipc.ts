// Type-only module: the Electron preload may only `import type` from
// @volli/shared — the pack config requires main and preload to stay
// dependency-disjoint (see CAUTION in apps/desktop/vite.config.ts). Adding a
// runtime export here is fine for main, but preload must never import it at
// runtime.

import type { DirEntry } from "./fs-entries";

/** Channel names for the preload's `contextBridge` API. */
export type VolliIpcChannel =
  | "volli:pick-project-folder"
  | "volli:sync-project-roots"
  | "volli:list-directory"
  | "volli:reveal-in-finder"
  | "volli:window-is-fullscreen"
  | "volli:terminal-create"
  | "volli:terminal-write"
  | "volli:terminal-resize"
  | "volli:terminal-kill"
  // Send-based (ipcRenderer.send, not invoke): a fire-and-forget flow-control
  // ack needs no reply, and awaiting one per data event would defeat it.
  | "volli:terminal-ack"
  | "volli:ghostty-config-get";

/** Channel names for main→renderer push events (`webContents.send`). */
export type VolliIpcEvent =
  | "volli:fullscreen-changed"
  | "volli:terminal-data"
  | "volli:terminal-exit"
  | "volli:ghostty-config-changed";

/**
 * Result types below travel as typed discriminated unions rather than
 * thrown errors: `ipcMain.handle` rejections serialize into useless
 * strings across the IPC boundary, and every failure must be surfaceable
 * in the UI.
 */

export type PickFolderResult =
  | { canceled: true }
  | { canceled: false; path: string; defaultName: string };

export type ListDirectoryResult = { ok: true; entries: DirEntry[] } | { ok: false; error: string };

export type RevealResult = { ok: true } | { ok: false; error: string };
