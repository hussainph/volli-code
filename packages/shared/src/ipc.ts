// Type-only module: the Electron preload may only `import type` from
// @volli/shared — the pack config requires main and preload to stay
// dependency-disjoint (see CAUTION in apps/desktop/vite.config.ts). Adding a
// runtime export here is fine for main, but preload must never import it at
// runtime.

import type { FileKind, FileSource, IndexedFile } from "./file-ref";
import type { DirEntry } from "./fs-entries";
import type { Label } from "./label";
import type { LegacyProject } from "./legacy-import";
import type { Project } from "./project-identity";
import type { SessionRecord } from "./session";
import type { ArchivedTicket, Ticket } from "./ticket";
import type { TicketComment } from "./ticket-comment";
import type { DiffStat, TicketEvent } from "./ticket-events";

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
  | "volli:terminal-park"
  | "volli:terminal-wake"
  | "volli:terminal-keep-awake"
  | "volli:terminal-busy"
  // Send-based (ipcRenderer.send, not invoke): a fire-and-forget flow-control
  // ack needs no reply, and awaiting one per data event would defeat it.
  | "volli:terminal-ack"
  // Send-based (ipcRenderer.send, not invoke): visibility flips on every board
  // ⇄ session nav, needs no reply, and round-tripping an invoke per flip would
  // add latency to navigation for nothing.
  | "volli:terminal-set-visible"
  | "volli:ghostty-config-get"
  | "volli:data-bootstrap"
  | "volli:legacy-import"
  | "volli:project-create"
  | "volli:project-update"
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
  // Global artifacts + @file refs (docs/plans/global-artifacts.md).
  | "volli:file-index"
  | "volli:file-read"
  | "volli:file-write"
  | "volli:artifact-create"
  | "volli:file-reveal"
  | "volli:file-watch"
  | "volli:file-unwatch"
  // Ticket worktrees (docs/plans/worktree-support.md). `ensure` has no channel
  // on purpose — it only ever runs implicitly inside terminal-create (§1).
  | "volli:worktree-remove"
  | "volli:worktree-branches"
  | "volli:worktree-orphans"
  | "volli:worktree-orphan-delete"
  // Done flow (docs/plans/done-flow.md §"Persistence, IPC, events"): the
  // Details-rail diff/commit/push-PR affordances. `status`/`diff` are read-only;
  // `commit` records an event; `push-pr` composes fetch→push→PR and is async.
  | "volli:worktree-status"
  | "volli:worktree-diff"
  | "volli:worktree-commit"
  | "volli:worktree-push-pr"
  // Retention (CONCEPT #16, issue #76): the merge-watch/Done-TTL surface. `state`
  // is a read; `keep`/`dismiss`/`archive-clean`/`ttl-set` mutate; `poll` is the
  // renderer-side trigger of an immediate poll (e.g. on window focus).
  | "volli:retention-state"
  | "volli:retention-keep"
  | "volli:retention-dismiss"
  | "volli:retention-archive-clean"
  | "volli:retention-ttl-get"
  | "volli:retention-ttl-set"
  | "volli:retention-poll";

/** Channel names for main→renderer push events (`webContents.send`). */
export type VolliIpcEvent =
  | "volli:fullscreen-changed"
  | "volli:terminal-data"
  | "volli:terminal-exit"
  | "volli:terminal-park-state"
  | "volli:ghostty-config-changed"
  | "volli:data-changed"
  // Backward-move interrupt announcement (issue #78, CONCEPT #20): fired after
  // a ticket move out of the active columns actually Esc'd live agent sessions,
  // so every window can surface the automated de-escalation where the mover is
  // looking (a toast with a jump-to-ticket action) — never silently.
  | "volli:sessions-interrupted"
  // Fired by the native View menu's zoom items. The renderer applies CSS zoom
  // to the content row (below the chrome band) rather than letting Electron
  // scale the whole page — see menu.ts for why the zoom roles are replaced.
  | "volli:ui-zoom-command"
  // Debounced fs.watch broadcast (~250ms) for a single watched file tab —
  // see volli-fs.ts's FileWatchManager.
  | "volli:file-changed"
  // Transient worktree-ensure phase transitions (never persisted; the renderer
  // mirrors them in a keyed store map, the `starting[ticketId]` pattern).
  | "volli:worktree-phase";

/** Direction of a `volli:ui-zoom-command` event: step in/out one rung, or reset. */
export type UiZoomCommand = "in" | "out" | "reset";

/**
 * A coarse hint at WHAT a {@link DataChangedEvent} touched — advisory only
 * (diagnostics, possible future routing). Readers decide whether to refire from
 * `ticketId`, never from this. Kept a small closed union so every producer names
 * its change.
 */
export type DataChangeKind = "ticket" | "comment" | "session" | "worktree" | "retention";

/**
 * Main→renderer invalidation after a planning mutation that happened OUTSIDE the
 * renderer's own request/response cycle (a socket-originated agent command, a
 * session-lifecycle worktree boot, a worktree/retention side effect). The
 * renderer always re-hydrates the board wholesale on receipt (cheap SQLite reads
 * — the recovery guarantee); the optional scope only lets a per-ticket surface
 * skip a refetch when the change PROVABLY targets a different ticket.
 *
 * An UNTARGETED payload — one with no `ticketId` — means "anything may have
 * changed" and every reader must still react to it (the conservative arm). A
 * targeted payload carries the affected `ticketId` (and, when the producer knows
 * it, its `projectId`), so a reader watching that ticket refreshes promptly
 * while readers for other tickets stand down.
 */
export interface DataChangedEvent {
  entity: "tickets";
  /** The ticket the change targets; omitted for an untargeted (anything-changed) broadcast. */
  ticketId?: string;
  /** The project the change belongs to, when the producer knows it. */
  projectId?: string;
  /** Advisory hint at what changed — never the basis of a reader's refire decision. */
  kind?: DataChangeKind;
}

/**
 * Main→renderer announcement that a backward move interrupted live agent
 * sessions (issue #78, CONCEPT #20). Fired only when `sessionIds` is
 * non-empty — an empty interrupt announces nothing, mirroring the event log.
 */
export interface SessionsInterruptedEvent {
  ticketId: string;
  sessionIds: string[];
}

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

export type ProjectUpdateResult = Result<{ project: Project }>;

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

// ---- global artifacts + @file refs (docs/plans/global-artifacts.md) --------

/**
 * The whole-project file index the `@` picker ranks over — returned by
 * `volli:file-index`. Built fresh on each picker open from `git ls-files`
 * (gitignore-respecting) plus a walk of `.volli/artifacts/`; `truncated` is set
 * when the ~20k entry cap was hit.
 */
export type FileIndexResult = Result<{ files: IndexedFile[]; truncated: boolean }>;

/**
 * A read file's content, discriminated by how the renderer must render it:
 * `text` (utf8, `truncated` when the ~1 MiB cap was hit), `image` (inline
 * `data:` URI), or `binary` (NUL-sniffed or oversize — stub + reveal only).
 */
export type FileContent =
  | { type: "text"; text: string; truncated: boolean }
  | { type: "image"; dataUrl: string }
  | { type: "binary" };

/**
 * A resolved file read — returned by `volli:file-read`. `source` says which
 * checkout it came from (drives the worktree tab badge); `size`/`mtime` are the
 * on-disk stats; `content` carries the render-ready payload.
 */
export type FileReadResult = Result<{
  source: FileSource;
  kind: FileKind;
  size: number;
  mtime: number;
  content: FileContent;
}>;

/** The post-write mtime (the renderer's fresh conflict-guard baseline) — returned by `volli:file-write`. */
export type FileWriteResult = Result<{ mtime: number }>;

/**
 * A newly-created artifact's project-relative path (`.volli/artifacts/<name>.md`),
 * insertable directly as an `@ref` — returned by `volli:artifact-create`.
 */
export type ArtifactCreateResult = Result<{ relPath: string }>;

/** The single watched file a `volli:file-changed` push event fired for. */
export interface FileChangedEvent {
  projectId: string;
  relPath: string;
  source: FileSource;
}

// ---- ticket worktrees (docs/plans/worktree-support.md) ---------------------

/**
 * The transient lifecycle of a worktree `ensure` pipeline. NEVER persisted —
 * on boot, truth is recomputed from disk — so a phase only exists while (or
 * just after) an ensure ran in this app session.
 */
export type WorktreePhase = "creating" | "copying" | "setting-up" | "ready" | "failed";

/** One `volli:worktree-phase` push: the ticket whose ensure moved, and where to. */
export interface WorktreePhaseEvent {
  ticketId: string;
  phase: WorktreePhase;
}

/** Where a worktree dir stands relative to what git knows — the live half of worktree state. */
export type WorktreeDiskState = "present" | "missing" | "unregistered";

/** Ack for a `volli:worktree-remove` (the "Remove worktree…" escape hatch). */
export type WorktreeRemoveResult = Result;

/** A project's local branch names — returned by `volli:worktree-branches` for the base-branch picker. */
export type WorktreeBranchesResult = Result<{ branches: string[] }>;

/** One orphan the sweep refused to remove, for the Settings → Worktrees list. */
export interface DirtyWorktreeOrphan {
  path: string;
  projectId?: string;
  reason: string;
}

/**
 * A `volli:worktree-orphans` sweep report: metadata pruned per project, clean
 * orphan dirs auto-removed (branches retained), and dirty orphans left in
 * place for the user (§7 — never auto-removed).
 */
export type WorktreeOrphansResult = Result<{
  pruned: string[];
  removedClean: string[];
  dirty: DirtyWorktreeOrphan[];
}>;

/**
 * Ack for a `volli:worktree-orphan-delete` — the Settings list's explicit,
 * user-confirmed deletion of a dirty orphan dir. Main re-validates the path
 * lives inside the app-owned worktree home before touching anything.
 */
export type WorktreeOrphanDeleteResult = Result;

// ---- Done flow (docs/plans/done-flow.md) -----------------------------------

/**
 * The finer Details-rail worktree status (done-flow §7 "dirty predicate
 * split"), returned by `volli:worktree-status`. Mirrors main's
 * `getWorktreeStatus` report: is the tree uncommitted, is a sequencer op
 * mid-flight (blocks one-click commit), and how far the branch has moved from
 * its base (`null` when the base is unknown or the count could not be read).
 */
export type WorktreeStatusResult = Result<{
  status: {
    uncommitted: boolean;
    sequencerActive: boolean;
    aheadOfBase: number | null;
    behindBase: number | null;
    /** Commits not yet on `origin/<branch>`; null when never pushed / no remote. */
    unpushed: number | null;
  };
}>;

/**
 * A worktree diff summary for `volli:worktree-diff` (done-flow §"diff.ts", the
 * two-mode split): `"working-tree"` is "what the agent is doing right now",
 * `"merge-base"` is "what the PR would contain".
 */
export type WorktreeDiffMode = "working-tree" | "merge-base";
export type WorktreeDiffResult = Result<{ diff: DiffStat }>;

/**
 * Ack for `volli:worktree-commit`. `committed: true` carries the safety-net
 * commit's fixed message; `committed: false` is the clean-tree NO-OP — the
 * status snapshot that offered the commit was stale and there was nothing to
 * stage, which is not an error (a stacked commit→push flow proceeds to push).
 */
export type WorktreeCommitResult = Result<
  { committed: true; message: string } | { committed: false; message: null }
>;

/** Ack for `volli:worktree-push-pr` — the opened/re-discovered PR url, and whether it pre-existed. */
export type WorktreePushPrResult = Result<{ url: string; existing: boolean }>;

// ---- retention (CONCEPT #16, issue #76) ------------------------------------

/** Why a ticket is archive-ready — drives the retention prompt's copy. */
export type RetentionReason = "pr-merged" | "ttl-expired";

/**
 * The composed retention state for ONE ticket, returned by
 * `volli:retention-state`. Everything but `keep` is TRANSIENT (decision #42:
 * persist identity, compute state) — recomputed from the merge-watch's last
 * poll plus the live Done-TTL clock, never stored. `keep` is the durable pin
 * (migration 010). `hasConflicts`/`failingChecks` are surfacing-only (the
 * #44/#45 button-never-gate rule): they explain why a PR can't merge yet, they
 * do not block the wrap-up prompt.
 */
export interface TicketRetentionState {
  ticketId: string;
  /** The watched PR url, or `null` when the ticket has none yet. */
  prUrl: string | null;
  /** The watched PR's state, or `null` when unknown / no PR. */
  prState: "open" | "merged" | "closed" | null;
  /** The PR's base branch conflicts with it (`mergeStateStatus` DIRTY). */
  hasConflicts: boolean;
  /** Display names of the PR's failing/errored checks (may be empty). */
  failingChecks: string[];
  /** Whether the Archive & clean prompt should be offered right now. */
  archiveReady: boolean;
  /** The condition behind `archiveReady` (still set when suppressed by dismissal). */
  reason: RetentionReason | null;
  /** The durable Keep pin — exempts the ticket from BOTH retention paths. */
  keep: boolean;
  /** Whether the prompt was dismissed this launch (re-offered next launch). */
  dismissed: boolean;
}

/** The composed retention state for a ticket — returned by `volli:retention-state`. */
export type RetentionStateResult = Result<{ state: TicketRetentionState }>;

/** Ack for `volli:retention-keep` (set/clear the pin) — carries the new value. */
export type RetentionKeepResult = Result<{ keep: boolean }>;

/** Ack for `volli:retention-dismiss` — the prompt is suppressed until next launch. */
export type RetentionDismissResult = Result;

/** Ack for `volli:retention-archive-clean` — archives + removes the worktree (dirty refuses). */
export type RetentionArchiveCleanResult = Result;

/** The Done-TTL in days — returned by `volli:retention-ttl-get`/`-set`. */
export type RetentionTtlResult = Result<{ days: number }>;

/** Ack for `volli:retention-poll` — the on-focus/manual trigger of the merge-watch poll. */
export type RetentionPollResult = Result;
