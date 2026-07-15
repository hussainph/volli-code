// Type-only module: the Electron preload may only `import type` from
// @volli/shared — the pack config requires main and preload to stay
// dependency-disjoint (see CAUTION in apps/desktop/vite.config.ts). Adding a
// runtime export here is fine for main, but preload must never import it at
// runtime.

import type { ArtifactEntry } from "./artifact";
import type { DirEntry } from "./fs-entries";
import type { Label } from "./label";
import type { LegacyProject } from "./legacy-import";
import type { Project } from "./project-identity";
import type { SessionRecord } from "./session";
import type { ArchivedTicket, Ticket } from "./ticket";
import type { TicketComment } from "./ticket-comment";
import type { TicketEvent } from "./ticket-events";

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
  | "volli:terminal-busy"
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
  | "volli:ticket-archive"
  | "volli:ticket-unarchive"
  | "volli:ticket-delete"
  | "volli:ticket-list-archived"
  | "volli:ticket-events"
  | "volli:comment-list"
  | "volli:comment-create"
  | "volli:comment-update"
  | "volli:comment-remove"
  | "volli:session-list"
  | "volli:session-list-for-ticket"
  | "volli:session-rename"
  | "volli:label-set-color"
  | "volli:app-state-set"
  | "volli:artifact-list"
  | "volli:artifact-read"
  | "volli:artifact-read-image"
  | "volli:artifact-write"
  | "volli:artifact-create"
  | "volli:artifact-promote"
  | "volli:artifact-reveal-dir"
  | "volli:artifact-subscribe"
  | "volli:artifact-unsubscribe";

/** Channel names for main→renderer push events (`webContents.send`). */
export type VolliIpcEvent =
  | "volli:fullscreen-changed"
  | "volli:terminal-data"
  | "volli:terminal-exit"
  | "volli:ghostty-config-changed"
  // Fired by the native View menu's zoom items. The renderer applies CSS zoom
  // to the content row (below the chrome band) rather than letting Electron
  // scale the whole page — see menu.ts for why the zoom roles are replaced.
  | "volli:ui-zoom-command"
  // Debounced fs.watch broadcast (~250ms) for a subscribed ticket's two
  // artifact-tier directories — see volli-fs.ts's ArtifactWatchManager.
  | "volli:artifacts-changed";

/** Direction of a `volli:ui-zoom-command` event: step in/out one rung, or reset. */
export type UiZoomCommand = "in" | "out" | "reset";

/**
 * Result types below travel as typed discriminated unions rather than
 * thrown errors: `ipcMain.handle` rejections serialize into useless
 * strings across the IPC boundary, and every failure must be surfaceable
 * in the UI.
 *
 * {@link Result} is the shared shape every one of them had by hand: a success
 * carrying payload `T`, or a failure carrying an `error` string. Bare
 * `Result` (no payload) is a plain ok/error ack.
 */
export type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

export type PickFolderResult =
  | { canceled: true }
  | { canceled: false; path: string; defaultName: string };

export type ListDirectoryResult = Result<{ entries: DirEntry[] }>;

export type RevealResult = Result;

/**
 * The full data snapshot handed to the renderer on boot
 * (`volli:data-bootstrap`): projects/tickets/labels from SQLite, plus the raw
 * `app_state` JSON the ui/workspace persist stores rehydrate from.
 */
export interface BootstrapPayload {
  /** Ordered by `sort_order`. An empty list is the sole signal boot uses to
   * decide whether to attempt the one-time legacy import (see lib/boot.ts) —
   * deliberately NOT coupled to `app_state` emptiness, since normal UI use
   * (sidebar resize, zoom) writes app_state and must not suppress a pending
   * import after a transient failure. */
  projects: Project[];
  ticketsByProject: Record<string, Ticket[]>;
  labelsByProject: Record<string, Label[]>;
  /** Raw JSON strings by key (`'volli:ui'`, `'volli:workspace'`, `'volli:projects-ui'`). */
  appState: Record<string, string>;
}

export type BootstrapResult = Result<{ data: BootstrapPayload }>;

export interface LegacyImportRequest {
  projects: LegacyProject[];
  appState: Record<string, string>;
  /**
   * The raw, untouched `volli:*` localStorage strings, keyed by their original
   * key. Persisted verbatim into `app_state` (under `LEGACY_BACKUP_APP_STATE_KEY`,
   * exported from `legacy-import.ts`) inside the import transaction, so the
   * source survives in SQLite even after boot clears localStorage — a
   * recoverable backup against a lossy or unreadable import (decision #29:
   * automation never destroys data).
   */
  rawBackup: Record<string, string>;
}

export type LegacyImportResult = Result<{ data: BootstrapPayload; imported: number }>;

/** `created: false` means an existing project at that path was selected instead of inserted. */
export type ProjectCreateResult = Result<{ project: Project; created: boolean }>;

export type ProjectMutationResult = Result;

/**
 * A single ticket, returned by a mutation that affects only that one ticket —
 * create, set-priority, update, set-labels. The renderer patches it into the
 * project's list by id (cheaper than, and non-clobbering versus, re-reading the
 * whole list). Contrast {@link TicketsResult}, which move returns because a move
 * genuinely reorders many rows.
 */
export type TicketResult = Result<{ ticket: Ticket }>;

/** The full authoritative project ticket list — returned by `ticket-move`, which reorders many rows. */
export type TicketsResult = Result<{ tickets: Ticket[] }>;

/**
 * A project's archived tickets, newest-archived first — returned by
 * `ticket-list-archived`, which the Archive view loads on demand (archived
 * tickets never ride along in the boot payload; the board only holds live ones).
 */
export type ArchivedTicketsResult = Result<{ tickets: ArchivedTicket[] }>;

export type LabelResult = Result<{ label: Label }>;

export type AppStateSetResult = Result;

/** A ticket's full event history, chronological — returned by `ticket-events` (the Activity feed read). */
export type TicketEventsResult = Result<{ events: TicketEvent[] }>;

/** A single comment, returned by a mutation that affects only that one comment — create, update. */
export type TicketCommentResult = Result<{ comment: TicketComment }>;

/** A ticket's comments, chronological — returned by `comment-list` (the work-log read). */
export type TicketCommentsResult = Result<{ comments: TicketComment[] }>;

/** A project's or a ticket's durable session records, newest first — returned by `session-list`/`session-list-for-ticket`. */
export type SessionsResult = Result<{ sessions: SessionRecord[] }>;

/** Ack for a session title rename (`session-rename`); the caller already holds the new title optimistically. */
export type SessionRenameResult = Result;

// ---- artifacts (.volli filesystem, ticket-detail-mvp decisions #13-17) --

/** Both artifact tiers for a ticket, flat (tier discriminates) — returned by `artifact-list`. */
export type ArtifactListResult = Result<{ entries: ArtifactEntry[] }>;

/** A markdown artifact's raw utf8 content — returned by `artifact-read`. */
export type ArtifactReadResult = Result<{ content: string }>;

/** An image artifact's content as an inline `data:` URI — returned by `artifact-read-image`. */
export type ArtifactReadImageResult = Result<{ dataUrl: string }>;

/** A newly-created ticket-tier artifact's listing row — returned by `artifact-create`. */
export type ArtifactCreateResult = Result<{ entry: ArtifactEntry }>;

/** The promoted artifact's project-tier listing row — returned by `artifact-promote`. */
export type ArtifactPromoteResult = Result<{ entry: ArtifactEntry }>;

/** The `{projectId, ticketId}` a `volli:artifacts-changed` push event fired for. */
export interface ArtifactsChangedEvent {
  projectId: string;
  ticketId: string;
}
