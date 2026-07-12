// Type-only module: the Electron preload may only `import type` from
// @volli/shared — the pack config requires main and preload to stay
// dependency-disjoint (see CAUTION in apps/desktop/vite.config.ts). Adding a
// runtime export here is fine for main, but preload must never import it at
// runtime.

import type { DirEntry } from "./fs-entries";
import type { Label } from "./label";
import type { LegacyProject } from "./legacy-import";
import type { Project } from "./project-identity";
import type { Ticket } from "./ticket";

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
  | "volli:ghostty-config-get"
  | "volli:data-bootstrap"
  | "volli:legacy-import"
  | "volli:project-create"
  | "volli:project-remove"
  | "volli:project-reorder"
  | "volli:ticket-create"
  | "volli:ticket-move"
  | "volli:ticket-set-priority"
  | "volli:ticket-update"
  | "volli:ticket-set-labels"
  | "volli:label-set-color"
  | "volli:app-state-set";

/** Channel names for main→renderer push events (`webContents.send`). */
export type VolliIpcEvent =
  | "volli:fullscreen-changed"
  | "volli:terminal-data"
  | "volli:terminal-exit"
  | "volli:ghostty-config-changed"
  // Fired by the native View menu's zoom items. The renderer applies CSS zoom
  // to the content row (below the chrome band) rather than letting Electron
  // scale the whole page — see menu.ts for why the zoom roles are replaced.
  | "volli:ui-zoom-command";

/** Direction of a `volli:ui-zoom-command` event: step in/out one rung, or reset. */
export type UiZoomCommand = "in" | "out" | "reset";

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

/**
 * The full data snapshot handed to the renderer on boot
 * (`volli:data-bootstrap`): projects/tickets/labels from SQLite, plus the raw
 * `app_state` JSON the ui/workspace persist stores rehydrate from.
 */
export interface BootstrapPayload {
  /** `true` when the projects table is empty AND app_state is empty. */
  firstRun: boolean;
  /** Ordered by `sort_order`. */
  projects: Project[];
  ticketsByProject: Record<string, Ticket[]>;
  labelsByProject: Record<string, Label[]>;
  /** Raw JSON strings by key (`'volli:ui'`, `'volli:workspace'`, `'volli:projects-ui'`). */
  appState: Record<string, string>;
}

export type BootstrapResult = { ok: true; data: BootstrapPayload } | { ok: false; error: string };

export interface LegacyImportRequest {
  projects: LegacyProject[];
  appState: Record<string, string>;
}

export type LegacyImportResult =
  | { ok: true; data: BootstrapPayload }
  | { ok: false; error: string };

/** `created: false` means an existing project at that path was selected instead of inserted. */
export type ProjectCreateResult =
  | { ok: true; project: Project; created: boolean }
  | { ok: false; error: string };

export type ProjectMutationResult = { ok: true } | { ok: false; error: string };

/**
 * A single ticket, returned by a mutation that affects only that one ticket —
 * create, set-priority, update, set-labels. The renderer patches it into the
 * project's list by id (cheaper than, and non-clobbering versus, re-reading the
 * whole list). Contrast {@link TicketsResult}, which move returns because a move
 * genuinely reorders many rows.
 */
export type TicketResult = { ok: true; ticket: Ticket } | { ok: false; error: string };

/** The full authoritative project ticket list — returned by `ticket-move`, which reorders many rows. */
export type TicketsResult = { ok: true; tickets: Ticket[] } | { ok: false; error: string };

export type LabelResult = { ok: true; label: Label } | { ok: false; error: string };

export type AppStateSetResult = { ok: true } | { ok: false; error: string };
