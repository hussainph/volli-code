/**
 * Per-workspace UI state, keyed by project id. Holds whatever should survive
 * switching to another project and back — the active nav page, and any future
 * per-workspace UI memory — so ten workspace switches later you land exactly
 * where you left each project.
 *
 * One `WorkspaceUiState` record per project (not parallel per-field maps), so
 * everything a workspace remembers lives and dies together: `forget` stays a
 * single delete no matter how many fields the record grows.
 *
 * Persistence is FIELD-SELECTIVE: `boardView`, `boardSort`, `openTicketId`,
 * `ticketTabs`, `homeActiveTab`, the Diff-tab view-state map
 * (`ticketDiffViewStates`), and the Project Files pair (`projectFiles` +
 * `projectFileViewStates`) survive relaunch (they're deliberate per-project
 * state — a view preference, the ticket-detail-mvp decision that the open
 * ticket persists across restart, decision #3, the Home tab that was in front
 * so Home has the same relaunch parity a Ticket workspace already had, VC-54,
 * Diff tabs landing where you left them after lazy content reload, issue #109,
 * or the Project Files workspace that must resume where you left it, decisions
 * #55/#56), while `nav`, `expandedSessionGroups`, and Home's close-return
 * `homeTabHistory` stay session-only — nav resetting to Home on
 * relaunch is a settled decision (see ui.ts's history) and now applies per
 * workspace. The partialize below prunes each record down to that persisted
 * set; merge rehydrates them back over `DEFAULT_WORKSPACE_UI`, sanitizing stale
 * values so old localStorage can never smuggle in an invalid view/sort/ticket
 * id — or an unusable tab record.
 *
 * What is persisted for Project Files / Diff tabs is deliberately only
 * IDENTITY (relPath) and the editor's own opaque view state: file CONTENTS are
 * never stored, they reload lazily from the checkout on return (decision #55).
 */
import {
  activateFile,
  closeFile,
  DEFAULT_TICKET_SORT,
  EMPTY_FILE_WORKSPACE,
  markFileEdited,
  pinFile,
  previewFile,
  sanitizeFileWorkspace,
  TICKET_SORT_KEYS,
  type FileWorkspaceState,
  type FileWorkspaceTab,
  type TicketSort,
} from "@volli/shared";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { appStateStorage } from "@renderer/lib/app-state-storage";
import {
  HOME_BOARD_TAB_ID,
  closeHomeTabHistory,
  isHomeBoardTab,
  sanitizeHomeActiveTab,
  visitHomeTab,
} from "@renderer/components/home/home-tabs";
import {
  TICKET_BODY_TAB_ID,
  normalizeTicketBodyTabId,
} from "@renderer/components/ticket/ticket-body-tab";
import { diffTabId, parseDiffTabId } from "@renderer/components/ticket/ticket-diff-tab";
import { fileTabId, parseFileTabId } from "@renderer/components/ticket/ticket-file-tab";
import {
  EMPTY_NAV_HISTORY,
  goBack,
  goForward,
  recordNav,
  type NavHistory,
  type NavSnapshot,
} from "@renderer/lib/nav-history";
import { useBoardStore } from "@renderer/stores/board";
import { useSessionsStore } from "@renderer/stores/sessions";

/**
 * The per-workspace nav pages (NAV_ITEMS). `home` is the tabbed environment
 * that holds the permanent Board tab plus the project's own Sessions (VC-54);
 * `configure` holds the selected project's scoped settings (base branch, setup
 * command, worktrees); app-wide Settings is separate chrome — see stores/ui.ts.
 * Ticket detail is a state of Home's BOARD TAB, so only a Home selection made
 * while that tab is in front clears `openTicketId` (see setNav).
 *
 * `nav` is session-only (never persisted — see the module doc), so no
 * shipped build ever wrote one of these keys into `volli:workspace`. `"files"`
 * named the primary nav item through VC-121, then retired once every file
 * click had somewhere to land inside a session (VC-122). {@link
 * resolvePersistedNav} still maps a persisted `"files"` onto `"home"` on read
 * — the same tolerant-read `RETIRED_TICKET_RAIL_MODES` gives a retired rail
 * page — as insurance against a foreign or hand-edited `volli:workspace`
 * blob, even though no build actually needs the migration.
 */
export type NavKey = "home" | "configure";

/** Kanban columns vs. Linear-style grouped list — same data, filter, selection. */
export type BoardView = "board" | "list";

/**
 * Optional rename/status metadata for an open ticket diff tab (issue #109).
 * Needed later for descriptors that show rename provenance; not a UI concern
 * of this store.
 */
export interface TicketDiffTabMeta {
  previousPath?: string | null;
  status?: string;
  /** Change Set binary flag from the row that opened the tab (issue #109). */
  binary?: boolean;
}

/** Options accepted by {@link WorkspaceState.openTicketDiff}. */
export interface OpenTicketDiffOpts {
  previousPath?: string | null;
  status?: string;
  binary?: boolean;
}

/**
 * A ticket's open file/diff tabs and its active tab (global-artifacts decision
 * #5; CONCEPT #48/#51/#56). `files` reuses `@volli/shared`'s
 * {@link FileWorkspaceTab} (preview/pin) so ticket File tabs share the same
 * reducer as Project Files; `diffs` stay an ordered relPath list of always-
 * persistent Change Set tabs. `active` is the active tab id — Ticket Body
 * (`"doc"`), `file:<relPath>`, `diff:<relPath>`, or a session id (sessions
 * rehydrate separately, so a persisted session id that no longer exists falls
 * back to the Ticket Body in ticket-detail). Diff tabs are never preview slots.
 */
export interface TicketTabsState {
  /** Open File tabs with preview/pin flags (decision #56). */
  files: FileWorkspaceTab[];
  /** Ordered relPaths of open Change Set diff tabs (`diff:<relPath>`). */
  diffs: string[];
  /** Rename/status metadata for open diffs, keyed by current relPath. */
  diffMeta: Record<string, TicketDiffTabMeta>;
  active: string;
}

export interface WorkspaceUiState {
  nav: NavKey;
  /**
   * Ticket ids whose Previous-band group is open in the sidebar (collapsed =
   * absent, so the band's steady state is collapsed and a fresh project starts
   * that way without a migration).
   *
   * Here rather than in the component because `ActiveSessions` is not keyed by
   * project — it is render-hidden across nav switches, not unmounted — so
   * component state would follow the reader from one project to the next and
   * open groups belonging to tickets they are no longer looking at.
   *
   * Session-only: which stacks you opened while hunting for something is a
   * fact about this sitting, not a preference worth restoring, and
   * "collapsed" is the answer this band is designed around.
   */
  expandedSessionGroups: readonly string[];
  /** Board vs. list rendering of the ticket set. Persisted. */
  boardView: BoardView;
  /** Column ordering shared by both views; "manual" is the drag-reorder mode. Persisted. */
  boardSort: TicketSort;
  /**
   * The ticket open in the full-page detail view (ticket-detail-mvp decision
   * #1/#3); `null` on the plain board. Persisted — survives restart.
   */
  openTicketId: string | null;
  /** Open file/diff tabs + active tab, per ticket (global-artifacts decision #5;
   * CONCEPT #48/#51). Persisted. */
  ticketTabs: Record<string, TicketTabsState>;
  /**
   * Serialized Monaco view state for open ticket Diff tabs (cursor / scroll on
   * the modified side), keyed `ticketId → relPath → opaque state`. Path-stable
   * identity — `baseRevision` is NOT part of the key (issue #109). Persisted;
   * contents still reload lazily when DiffView mounts. Typed `unknown` so the
   * store stays editor-agnostic.
   */
  ticketDiffViewStates: Record<string, Record<string, unknown>>;
  /**
   * Home's Main-checkout File-tab workspace for this project (decisions
   * #55/#56) — always rooted in the project's Main checkout. Persisted, so
   * the strip survives navigation, project switches, and relaunch; contents
   * reload lazily on return.
   *
   * Named `projectFiles` rather than `homeFiles`: the field predates Home's
   * adoption of it (VC-121) — it was the retired Files page's only tab list —
   * and renaming a persisted JSON key would need a migration a field rename
   * buys nothing for. The Home-prefixed actions below (`previewHomeFile` &co)
   * are its only writers now; nothing outside Home reads or writes it.
   */
  projectFiles: FileWorkspaceState;
  /**
   * Serialized Monaco per-tab view state (cursor, selection, folding, scroll)
   * for Home's File tabs, keyed by relPath — what makes returning to a tab
   * land exactly where you left it after the contents reload lazily
   * (decision #55). Persisted, and NEVER file contents: only the editor's own
   * opaque snapshot. Typed `unknown` on purpose so this store stays
   * editor-agnostic.
   */
  projectFileViewStates: Record<string, unknown>;
  /**
   * Which tab is in front on Home. {@link HOME_BOARD_TAB_ID} for the permanent
   * Board tab, a terminal session id, a `chat:<sessionId>` id, or a
   * `file:<relPath>` id. Prefixes separate chat/File identity from UUID-shaped
   * terminals and from the bare permanent word.
   *
   * PERSISTED, and that is the whole of VC-54's scope 4. What it points at is
   * resident (`chat-sessions.ts`'s `openTabs`), so this is not a receipt for
   * live state — it is the one durable fact needed to put the same Session back
   * in front on relaunch, exactly as a Ticket workspace's `ticketTabs[].active`
   * already did. A stale id is never repaired at boot: `home-tabs.ts`'s
   * `resolveHomeTabs` asks the project's durable Session listing first, so
   * "not hydrated yet" can never be mistaken for "gone".
   *
   * Terminals deliberately do NOT come back — a PTY dies with the app, exactly
   * as it does for a Ticket. Full strip restoration is VC-105.
   */
  homeActiveTab: string;
  /**
   * Home tabs in least-to-most-recent visit order. Session-only: it answers
   * where closing an active File tab returns during this app run, while VC-105
   * owns durable restoration of the whole strip.
   */
  homeTabHistory: readonly string[];
}

export const DEFAULT_WORKSPACE_UI: WorkspaceUiState = {
  nav: "home",
  expandedSessionGroups: [],
  boardView: "board",
  boardSort: DEFAULT_TICKET_SORT,
  openTicketId: null,
  ticketTabs: {},
  ticketDiffViewStates: {},
  projectFiles: EMPTY_FILE_WORKSPACE,
  projectFileViewStates: {},
  homeActiveTab: HOME_BOARD_TAB_ID,
  homeTabHistory: [],
};

/**
 * Retired `NavKey` values a past build could have written, mapped onto the
 * page that absorbed them — same idiom as `ticket-rail-model.ts`'s
 * `RETIRED_TICKET_RAIL_MODES`. A Map rather than an object literal for the
 * same reason that one is: the lookup key came from a past build's JSON, and
 * an object would answer `"toString"` with a function off the prototype
 * chain.
 */
const RETIRED_NAV_KEYS: ReadonlyMap<string, NavKey> = new Map([["files", "home"]]);

/**
 * Rehydrate a persisted `nav` value onto the page this build should open.
 *
 * There is deliberately NO "a key this build still offers stands" branch, and
 * that is the one place this parts company with `ticket-rail-model.ts`'s
 * `resolvePersistedRailMode`, the idiom it otherwise mirrors. `railMode` is
 * genuinely persisted, so keeping a still-valid key is the whole point there.
 * `nav` is session-only and "nav resets to Home on relaunch" is a settled
 * decision (see the module doc), so a stored value must never be able to
 * choose the landing page — honouring a `"configure"` here would quietly
 * reverse that decision for exactly the hand-edited blob this read exists to
 * survive.
 *
 * So every input lands on Home today: a retired key through {@link
 * RETIRED_NAV_KEYS}, everything else through {@link DEFAULT_WORKSPACE_UI}. The
 * map still earns its place by recording WHERE a retired page went, so a key
 * that ever retires onto something other than the default resolves correctly
 * rather than silently stranding on it.
 */
export function resolvePersistedNav(stored: { nav?: unknown }): NavKey {
  if (typeof stored.nav === "string") {
    const landing = RETIRED_NAV_KEYS.get(stored.nav);
    if (landing !== undefined) return landing;
  }
  return DEFAULT_WORKSPACE_UI.nav;
}

/** The active-tab id of the always-present Ticket Body tab — the fallback when a
 * file/session tab closes. Persisted wire value is still `"doc"`. */
const BODY_TAB_ID = TICKET_BODY_TAB_ID;

/** Empty ticket-tabs record — Ticket Body alone, nothing open. */
function emptyTicketTabs(active: string = BODY_TAB_ID): TicketTabsState {
  return { files: [], diffs: [], diffMeta: Object.create(null), active };
}

/**
 * Clone a `diffMeta` map onto a null prototype. Object-literal spreads
 * (`{ ...map }`) reintroduce `Object.prototype`, so a runtime `__proto__`
 * path key would hit the special setter — same defense sanitizers use on
 * rehydrate.
 */
function cloneDiffMeta(
  source: Record<string, TicketDiffTabMeta>,
): Record<string, TicketDiffTabMeta> {
  return Object.assign(Object.create(null), source) as Record<string, TicketDiffTabMeta>;
}

/**
 * View a ticket's File-tab list as a {@link FileWorkspaceState} so the shared
 * preview/pin reducers can run unchanged. `activeRelPath` is derived from the
 * ticket's unified `active` id only when that id names an open file tab —
 * sitting on Doc/session/diff must not invent a file focus for the reducer.
 */
function ticketFilesWorkspace(tabs: TicketTabsState): FileWorkspaceState {
  const activePath = parseFileTabId(tabs.active);
  return {
    tabs: tabs.files,
    activeRelPath:
      activePath !== null && tabs.files.some((tab) => tab.relPath === activePath)
        ? activePath
        : null,
  };
}

/**
 * Apply a pure File-workspace transition to a ticket's `files` side. Returns
 * `null` when the reducer returns by identity (no store write / no re-render).
 * When the reducer's `activeRelPath` changes, the ticket's unified `active` is
 * synced to `file:<relPath>` (or Doc when cleared); pin-without-focus leaves
 * `active` alone.
 */
export function applyTicketFileTransition(
  existing: TicketTabsState,
  transition: (files: FileWorkspaceState) => FileWorkspaceState,
): TicketTabsState | null {
  const before = ticketFilesWorkspace(existing);
  const after = transition(before);
  if (after === before) return null;
  let active = existing.active;
  if (after.activeRelPath !== before.activeRelPath) {
    active = after.activeRelPath === null ? BODY_TAB_ID : fileTabId(after.activeRelPath);
  }
  return { ...existing, files: [...after.tabs], active };
}

/**
 * Validate rehydrated ticket `files`: legacy `string[]` entries become pinned
 * persistent tabs (pre-#56 writes had no preview flag), and object entries go
 * through {@link sanitizeFileWorkspace} so path safety + the one-preview
 * invariant match Project Files.
 */
function sanitizeTicketFiles(raw: unknown): FileWorkspaceTab[] {
  if (!Array.isArray(raw)) return [];
  const tabs: { relPath: string; pinned: boolean }[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) {
      // Legacy shape: every open file was persistent.
      tabs.push({ relPath: entry, pinned: true });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const { relPath, pinned } = entry as { relPath?: unknown; pinned?: unknown };
    if (typeof relPath !== "string" || typeof pinned !== "boolean") continue;
    tabs.push({ relPath, pinned });
  }
  return [...sanitizeFileWorkspace({ tabs, activeRelPath: null }).tabs];
}

interface WorkspaceState {
  byProject: Record<string, WorkspaceUiState>;
  /**
   * Slack-style workspace navigation history (the chrome-bar ←/→ buttons and
   * ⌘[ / ⌘]). In-memory only — deliberately excluded from `partialize`, so it
   * starts empty on every relaunch and never reaches persisted storage.
   */
  navHistory: NavHistory;
  /**
   * Select a top-level page. Selecting Home while its Board tab is in front
   * exits any open ticket detail — see the action for why that condition is the
   * whole of the rule.
   */
  setNav(projectId: string, nav: NavKey): void;
  /** Opens or closes one ticket's Previous-band group in the sidebar. */
  setSessionGroupExpanded(projectId: string, ticketId: string, expanded: boolean): void;
  setBoardView(projectId: string, view: BoardView): void;
  setBoardSort(projectId: string, sort: TicketSort): void;
  /**
   * Records which tab is in front on Home. A plain record and nothing else —
   * `home-surface.tsx` writes back whatever it derived, and the derivation
   * lands on the Board tab whenever the last Session tab closes. If that write
   * also closed the open ticket, closing a chat would discard the ticket
   * remembered behind it. {@link WorkspaceState.openHomeBoard} is where
   * "the Board tab means the plain board" lives.
   */
  setHomeActiveTab(projectId: string, tabId: string): void;
  /** Preview a Main-checkout file and bring its Home tab to the front atomically. */
  previewHomeFile(projectId: string, relPath: string): void;
  /** Pin a Main-checkout file and bring its Home tab to the front atomically. */
  pinHomeFile(projectId: string, relPath: string): void;
  /** Bring an already-open Main-checkout File tab to the front. */
  activateHomeFile(projectId: string, relPath: string): void;
  /**
   * Close a Home File tab. When active, return through MRU Home-tab history,
   * considering `openSessionTabIds` as the live non-file tabs in the strip.
   */
  closeHomeFile(projectId: string, relPath: string, openSessionTabIds: readonly string[]): void;
  /**
   * THE seam for "Home is now in front", optionally bringing `tabId` forward.
   *
   * Never touches `openTicketId`, and that is the point: a Home Session tab is
   * its own place with the ticket remembered behind it (VC-54 decision 1), so
   * the sidebar's bands, ⌘K and ⌘T can all put a Session in front without any
   * of them silently throwing a ticket away. Every surface that means "show
   * this Project Session" routes through here rather than pairing `setNav` with
   * `setHomeActiveTab` itself — which would also flash one frame of Home with
   * the OLD tab in front.
   */
  openHome(projectId: string, tabId?: string): void;
  /**
   * The permanent Board tab's own act: Home, the Board tab, no open ticket.
   *
   * Exactly the semantics the Board NAV ITEM carried before Home existed, which
   * is what makes this a zero-regression mapping. It is the one tab that
   * discards state rather than preserving it (VC-54 decision 2, accepted cost);
   * the ticket is one ⌘[ or one card click away.
   */
  openHomeBoard(projectId: string): void;
  /**
   * Opens `ticketId`'s full-page detail view for `projectId` (rendered in
   * place of the board — see components/ticket/ticket-detail.tsx) and selects
   * the same ticket in the board store, so returning to the board shows the
   * card already selected (ticket-detail-mvp decision #1).
   */
  openTicket(projectId: string, ticketId: string): void;
  /**
   * THE navigation-intent seam: makes `ticketId`'s workspace visible right
   * now, no matter where the project's nav currently is. Switches this
   * project onto Home AND onto Home's Board tab (ticket detail renders only
   * there — `home-surface.tsx` — so a caller that skips either step can set
   * `openTicketId` while nav stays on Configure, or while a Home Session tab is in
   * front, and the promised detail view never appears; the nav half was the
   * composer kickoff bug, and the tab half is its VC-54 twin), opens the
   * ticket's full-page detail, and selects the same ticket in the board
   * store (same ordering `openTicketSession` below already used internally).
   *
   * `opts.tabId`, when given, also activates that tab (Ticket Body / `"doc"`, a
   * `file:<relPath>`, or a session id). Omit it to leave the ticket's
   * current tab untouched — e.g. Active Sessions activating a ticket with no
   * live session to focus. For a SESSION tab specifically, call
   * `openTicketSession` instead of passing its id here: it wraps this seam
   * and additionally syncs the sessions store's active session/pane so the
   * terminal actually in view matches.
   *
   * Every surface that promises "the user is now looking at this ticket" —
   * the command palette, Active Sessions, and the new-ticket kickoff — routes
   * through this one seam instead of hand-rolling setNav+openTicket(+tab)
   * themselves.
   */
  openTicketWorkspace(projectId: string, ticketId: string, opts?: { tabId?: string }): void;
  /**
   * Opens a ticket's exact live terminal tab, optionally focusing one split
   * pane. A thin wrapper over {@link openTicketWorkspace}'s ordering, plus the
   * sessions-store sync a session tab (unlike Doc/file tabs) needs.
   */
  openTicketSession(projectId: string, ticketId: string, tabId: string, paneId?: string): void;
  /** Closes the detail view, returning to the plain board. Leaves the board's selection as-is. */
  closeTicket(projectId: string): void;
  /**
   * Opens a persistent `file` tab for `relPath` in `ticketId`'s tab strip
   * (pins it if already a preview; appends pinned when missing) and makes it
   * the active tab (global-artifacts decision #5; CONCEPT #56). Used by @file
   * chips and other explicit "keep this open" paths — Files-panel glances go
   * through {@link previewTicketFile} instead.
   */
  openTicketFile(projectId: string, ticketId: string, relPath: string): void;
  /**
   * Single-click in the ticket Files navigator: open `relPath` in the
   * replaceable preview slot and focus it (decision #56). Thin delegation to
   * `previewFile` — every tab rule lives in @volli/shared, never here.
   */
  previewTicketFile(projectId: string, ticketId: string, relPath: string): void;
  /**
   * Double-click or an explicit Pin action on a ticket File tab: make
   * `relPath` persistent (opening it when it isn't open yet). Delegates to
   * `pinFile`.
   */
  pinTicketFile(projectId: string, ticketId: string, relPath: string): void;
  /**
   * The first edit of a ticket File preview tab promotes it to persistent
   * (decision #56: a dirty tab is never replaced). Safe to fire on every
   * keystroke — `markFileEdited` returns unchanged state once pinned.
   */
  markTicketFileEdited(projectId: string, ticketId: string, relPath: string): void;
  /**
   * Opens a persistent Change Set `diff` tab for `relPath` (appends if missing,
   * focuses if present — never duplicates). Tab id is path-stable
   * `diff:<relPath>` (CONCEPT #48/#51; issue #109). Optional `opts` stash
   * rename/status metadata for later descriptors. Diff tabs stay always-
   * persistent — no preview slot (decision #56 v1 clarification).
   */
  openTicketDiff(
    projectId: string,
    ticketId: string,
    relPath: string,
    opts?: OpenTicketDiffOpts,
  ): void;
  /**
   * Closes `relPath`'s file tab; if it was the active tab, falls back to Doc.
   * Prunes the ticket's record entirely once nothing but Doc remains.
   */
  closeTicketFile(projectId: string, ticketId: string, relPath: string): void;
  /**
   * Closes `relPath`'s diff tab; if it was the active tab, falls back to Doc
   * (same pattern as {@link closeTicketFile}). Drops any rename/status meta
   * for that path. Prunes the ticket record once nothing but Doc remains.
   */
  closeTicketDiff(projectId: string, ticketId: string, relPath: string): void;
  /** Sets the active tab for `ticketId` (Ticket Body / `"doc"`, a
   * `file:<relPath>`, a `diff:<relPath>`, or a session id). */
  setTicketActiveTab(projectId: string, ticketId: string, tabId: string): void;
  /**
   * The first edit of a preview tab promotes it to persistent (decision #56:
   * a dirty tab is never replaced). Safe to fire on every keystroke — the pure
   * `markFileEdited` returns unchanged state once the tab is persistent.
   */
  markProjectFileEdited(projectId: string, relPath: string): void;
  /**
   * Remember the editor's serialized view state for `relPath` (cursor,
   * selection, folding, scroll). `viewState` stays `unknown`: it is Monaco's
   * opaque JSON, written back verbatim on return, and this store never
   * inspects it — nor does it ever hold file contents.
   *
   * Ignored for a path that is not an open tab, which upholds the same
   * invariant `closeHomeFile` and the rehydrate sanitizer do: view state
   * exists only for tabs that exist.
   */
  setProjectFileViewState(projectId: string, relPath: string, viewState: unknown): void;
  /**
   * Remember the Diff editor's opaque view state for an open ticket Diff tab
   * (`ticketId` + `relPath`). Ignored when that Diff tab is not open — same
   * close-race guard as {@link setProjectFileViewState}.
   */
  setTicketDiffViewState(
    projectId: string,
    ticketId: string,
    relPath: string,
    viewState: unknown,
  ): void;
  /** Drop a removed project's record so re-adding it starts fresh. */
  forget(projectId: string): void;
  /**
   * Record an organic navigation to `snapshot` (the choke point fed by
   * hooks/use-nav-history.ts). Deduped against the current location; a snapshot
   * equal to the current one is a no-op. Applying a history step must NOT call
   * this (that's what would clobber the forward stack) — the wiring suppresses
   * recording while it applies.
   */
  recordNav(snapshot: NavSnapshot): void;
  /**
   * Advance the history one step back/forward and return the snapshot the
   * caller must apply to the live stores, or `null` when that stack is empty.
   * The store only owns the stacks; applying the snapshot (project switch + nav
   * + open/close ticket) lives in the wiring to avoid a projects-store import
   * cycle here.
   */
  stepNavBack(): NavSnapshot | null;
  stepNavForward(): NavSnapshot | null;
}

/** The slice of a workspace record that survives relaunch. */
type PersistedWorkspaceUi = Pick<
  WorkspaceUiState,
  | "boardView"
  | "boardSort"
  | "openTicketId"
  | "ticketTabs"
  | "ticketDiffViewStates"
  | "projectFiles"
  | "projectFileViewStates"
  | "homeActiveTab"
>;

interface PersistedWorkspaceState {
  byProject: Record<string, PersistedWorkspaceUi>;
}

/**
 * Rehydrated records come from JSON a past (possibly older) build wrote —
 * validate rather than trust, falling back per-field to the defaults so a
 * renamed sort key or view can never render an impossible state.
 */
/**
 * Validate a rehydrated `ticketTabs` map: keep only records whose `files` /
 * `diffs` sanitize cleanly and `active` is a string, and prune anything
 * carrying nothing worth restoring (no open files/diffs and Ticket Body
 * active) so the map never accretes empty entries. A persisted `active`
 * that's a session id is preserved — ticket-detail falls back to the Ticket
 * Body when it matches no live tab. Legacy `"doc"` values are normalized
 * through {@link normalizeTicketBodyTabId}. Missing `diffs`/`diffMeta`
 * (pre-#109 writes) default to empty. Legacy `files: string[]` (pre-#56)
 * rehydrates as pinned persistent tabs.
 */
function sanitizeTicketTabs(raw: unknown): Record<string, TicketTabsState> {
  if (typeof raw !== "object" || raw === null) return {};
  // Null-prototype accumulator: persisted keys come straight from JSON, and a
  // `__proto__` key assigned onto an object literal hits Object.prototype's
  // setter instead of becoming an own property.
  const out = Object.create(null) as Record<string, TicketTabsState>;
  for (const [ticketId, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as {
      files?: unknown;
      diffs?: unknown;
      diffMeta?: unknown;
      active?: unknown;
    };
    const files = sanitizeTicketFiles(record.files);
    const diffs = Array.isArray(record.diffs)
      ? record.diffs.filter((path): path is string => typeof path === "string" && path.length > 0)
      : [];
    const diffMeta = sanitizeDiffMeta(record.diffMeta, diffs);
    let active =
      typeof record.active === "string" ? normalizeTicketBodyTabId(record.active) : BODY_TAB_ID;
    // A persisted active pointing at a file/diff that did not survive sanitize
    // falls back to Ticket Body — soft recovery rather than a stranded focus.
    const activeFilePath = parseFileTabId(active);
    if (activeFilePath !== null && !files.some((tab) => tab.relPath === activeFilePath)) {
      active = BODY_TAB_ID;
    }
    const activeDiffPath = parseDiffTabId(active);
    if (activeDiffPath !== null && !diffs.includes(activeDiffPath)) active = BODY_TAB_ID;
    if (files.length === 0 && diffs.length === 0 && active === BODY_TAB_ID) continue;
    out[ticketId] = { files, diffs, diffMeta, active };
  }
  return out;
}

/** Keep only meta entries whose key is an open diff and whose value is a plain object. */
function sanitizeDiffMeta(
  raw: unknown,
  diffs: readonly string[],
): Record<string, TicketDiffTabMeta> {
  // Null-prototype: a persisted `__proto__` path must land as an own property,
  // not mutate Object.prototype via the `__proto__` setter on `{}`.
  const out = Object.create(null) as Record<string, TicketDiffTabMeta>;
  if (typeof raw !== "object" || raw === null) return out;
  const open = new Set(diffs);
  for (const [path, value] of Object.entries(raw)) {
    if (!open.has(path) || typeof value !== "object" || value === null) continue;
    const entry = value as { previousPath?: unknown; status?: unknown; binary?: unknown };
    const meta: TicketDiffTabMeta = {};
    if (entry.previousPath === null || typeof entry.previousPath === "string") {
      meta.previousPath = entry.previousPath;
    }
    if (typeof entry.status === "string") meta.status = entry.status;
    if (typeof entry.binary === "boolean") meta.binary = entry.binary;
    if (meta.previousPath !== undefined || meta.status !== undefined || meta.binary !== undefined) {
      out[path] = meta;
    }
  }
  return out;
}

/** Whether a ticket-tabs record still carries anything worth keeping. */
function isEmptyTicketTabs(tabs: TicketTabsState): boolean {
  return tabs.files.length === 0 && tabs.diffs.length === 0 && tabs.active === BODY_TAB_ID;
}

/**
 * Validate a rehydrated `projectFileViewStates` map against the workspace's
 * surviving tabs. Every value here is Monaco's opaque JSON, so the guard can
 * only check shape: a non-object raw map degrades to `{}`, and an entry is
 * kept only when its value is a plain object (a string/number/array is not a
 * serialized view state, and feeding one back to `restoreViewState` is how the
 * editor throws on the restore path). Entries with no surviving tab are pruned
 * — a closed tab's cursor is dead weight, and dropping it here also cleans up
 * anything an older build leaked. Keys always arrive as strings from JSON;
 * `Object.entries` skips symbols, so a non-string key cannot survive either.
 */
function sanitizeFileViewStates(
  raw: unknown,
  workspace: FileWorkspaceState,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  // See sanitizeTicketTabs: a `__proto__` key out of persisted JSON must land
  // as an own property, not on the accumulator's prototype.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [relPath, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    if (!workspace.tabs.some((tab) => tab.relPath === relPath)) continue;
    out[relPath] = value;
  }
  return out;
}

/**
 * Validate a rehydrated `ticketDiffViewStates` map against surviving Diff tabs.
 * Same shape rules as {@link sanitizeFileViewStates}: non-object values and
 * orphans for closed diffs are dropped. Nested under ticketId so path-stable
 * identity stays `ticketId + relPath` without encoding baseRevision.
 */
function sanitizeTicketDiffViewStates(
  raw: unknown,
  ticketTabs: Record<string, TicketTabsState>,
): Record<string, Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const [ticketId, value] of Object.entries(raw)) {
    const diffs = ticketTabs[ticketId]?.diffs;
    if (diffs === undefined || diffs.length === 0) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const open = new Set(diffs);
    const perTicket = Object.create(null) as Record<string, unknown>;
    for (const [relPath, viewState] of Object.entries(value)) {
      if (!open.has(relPath)) continue;
      if (typeof viewState !== "object" || viewState === null || Array.isArray(viewState)) {
        continue;
      }
      perTicket[relPath] = viewState;
    }
    if (Object.keys(perTicket).length > 0) out[ticketId] = perTicket;
  }
  return out;
}

function sanitizePersistedUi(persisted: Partial<PersistedWorkspaceUi>): PersistedWorkspaceUi {
  const view: BoardView =
    persisted.boardView === "board" || persisted.boardView === "list"
      ? persisted.boardView
      : DEFAULT_WORKSPACE_UI.boardView;
  // Runtime JSON can hold anything — `null` in particular passes a bare
  // `!== undefined` check and then throws on `.key`, taking the renderer down
  // during store creation. Require a real object before touching fields.
  const sort = persisted.boardSort;
  const sortValid =
    typeof sort === "object" &&
    sort !== null &&
    TICKET_SORT_KEYS.includes(sort.key) &&
    (sort.direction === "asc" || sort.direction === "desc");
  const openTicketId = persisted.openTicketId;
  // Tab validation belongs to the pure core (@volli/shared), which degrades an
  // unusable shape to EMPTY_FILE_WORKSPACE rather than throwing — a corrupt
  // record must never keep Project Files (or the renderer) from starting.
  const projectFiles = sanitizeFileWorkspace(persisted.projectFiles);
  const ticketTabs = sanitizeTicketTabs(persisted.ticketTabs);
  return {
    boardView: view,
    // Rebuild rather than spread so stray keys in old JSON never enter state.
    boardSort: sortValid
      ? { key: sort.key, direction: sort.direction }
      : DEFAULT_WORKSPACE_UI.boardSort,
    openTicketId:
      typeof openTicketId === "string" || openTicketId === null
        ? openTicketId
        : DEFAULT_WORKSPACE_UI.openTicketId,
    ticketTabs,
    ticketDiffViewStates: sanitizeTicketDiffViewStates(persisted.ticketDiffViewStates, ticketTabs),
    projectFiles,
    projectFileViewStates: sanitizeFileViewStates(persisted.projectFileViewStates, projectFiles),
    // Shape only. Whether the id still names a Session is asked LIVE, against
    // the project's durable listing (`home-tabs.ts`) — a boot-time guess here
    // could only be the "not hydrated yet reads as gone" bug.
    homeActiveTab: sanitizeHomeActiveTab(persisted.homeActiveTab),
  };
}

/** Whether a record's persisted fields still match the defaults (by value) — such records are dropped. */
function isDefaultPersistedUi(ui: WorkspaceUiState): boolean {
  return (
    ui.boardView === DEFAULT_WORKSPACE_UI.boardView &&
    ui.boardSort.key === DEFAULT_TICKET_SORT.key &&
    ui.boardSort.direction === DEFAULT_TICKET_SORT.direction &&
    ui.openTicketId === DEFAULT_WORKSPACE_UI.openTicketId &&
    Object.keys(ui.ticketTabs).length === 0 &&
    Object.keys(ui.ticketDiffViewStates).length === 0 &&
    ui.projectFiles.tabs.length === 0 &&
    Object.keys(ui.projectFileViewStates).length === 0 &&
    ui.homeActiveTab === DEFAULT_WORKSPACE_UI.homeActiveTab
  );
}

/** Record the current Home tab and then the one being brought forward. */
function homeHistoryAfterVisit(current: WorkspaceUiState, nextTabId: string): readonly string[] {
  return visitHomeTab(visitHomeTab(current.homeTabHistory, current.homeActiveTab), nextTabId);
}

/** The project's record merged with `changes` — spread into `set()`. */
function patchWorkspace(
  state: WorkspaceState,
  projectId: string,
  changes: Partial<WorkspaceUiState>,
): Pick<WorkspaceState, "byProject"> {
  const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
  return { byProject: { ...state.byProject, [projectId]: { ...current, ...changes } } };
}

/**
 * Run one pure Project Files transition (@volli/shared's `previewFile` &co)
 * over `projectId`'s workspace. `markProjectFileEdited` is its one remaining
 * caller — the Home-prefixed actions read/write `projectFiles` directly, and
 * the Files-page actions this helper used to also serve retired with the page
 * (VC-122) — but the shape stays: a transition that returns its input by
 * identity (marking a tab that is already pinned) must leave the store
 * untouched so subscribers don't re-render for a no-op.
 */
function applyProjectFiles(
  state: WorkspaceState,
  projectId: string,
  transition: (files: FileWorkspaceState) => FileWorkspaceState,
): WorkspaceState | Pick<WorkspaceState, "byProject"> {
  const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
  const projectFiles = transition(current.projectFiles);
  if (projectFiles === current.projectFiles) return state;
  return patchWorkspace(state, projectId, { projectFiles });
}

/**
 * Factory so tests can supply an in-memory storage instead of the real
 * app_state bridge. `skipHydration` only applies to the real singleton (no
 * `storage` injected) — see ui.ts's factory doc for why.
 */
export function createWorkspaceStore(storage?: StateStorage) {
  return create<WorkspaceState>()(
    persist(
      (set, get) => ({
        byProject: {},
        navHistory: EMPTY_NAV_HISTORY,

        setNav(projectId, nav) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            // Ticket detail is a state of Home's BOARD TAB, not a separate
            // top-level nav key — so a deliberate Home selection means the plain
            // board even when `nav` is already "home", which is the only reason
            // clicking Home from inside a ticket does anything at all.
            //
            // Gated on the Board tab being in front rather than applied to
            // every Home selection, because the clear belongs to that TAB
            // (decision 2), not to the nav item. With a Session tab in front the
            // ticket is not on screen to be left, and the ordinary round trip
            // Home → Configure → Home would otherwise discard it for nothing
            // visible.
            const clearsTicket = nav === "home" && isHomeBoardTab(current.homeActiveTab);
            return patchWorkspace(
              state,
              projectId,
              clearsTicket ? { nav, openTicketId: null } : { nav },
            );
          });
        },

        setSessionGroupExpanded(projectId, ticketId, expanded) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            // No-op guard: this fires from a row in a band that re-renders on
            // every activity refresh, and a `set` that changes nothing still
            // notifies subscribers.
            if (current.expandedSessionGroups.includes(ticketId) === expanded) return state;
            return patchWorkspace(state, projectId, {
              expandedSessionGroups: expanded
                ? [...current.expandedSessionGroups, ticketId]
                : current.expandedSessionGroups.filter((id) => id !== ticketId),
            });
          });
        },

        setBoardView(projectId, view) {
          set((state) => patchWorkspace(state, projectId, { boardView: view }));
        },

        setBoardSort(projectId, sort) {
          set((state) => patchWorkspace(state, projectId, { boardSort: sort }));
        },

        setHomeActiveTab(projectId, tabId) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            if (current.homeActiveTab === tabId) return state;
            return patchWorkspace(state, projectId, {
              homeActiveTab: tabId,
              homeTabHistory: homeHistoryAfterVisit(current, tabId),
            });
          });
        },

        previewHomeFile(projectId, relPath) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const projectFiles = previewFile(current.projectFiles, relPath);
            const tabId = fileTabId(relPath);
            return patchWorkspace(state, projectId, {
              nav: "home",
              projectFiles,
              homeActiveTab: tabId,
              homeTabHistory: homeHistoryAfterVisit(current, tabId),
            });
          });
        },

        pinHomeFile(projectId, relPath) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const projectFiles = activateFile(pinFile(current.projectFiles, relPath), relPath);
            const tabId = fileTabId(relPath);
            return patchWorkspace(state, projectId, {
              nav: "home",
              projectFiles,
              homeActiveTab: tabId,
              homeTabHistory: homeHistoryAfterVisit(current, tabId),
            });
          });
        },

        activateHomeFile(projectId, relPath) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            if (!current.projectFiles.tabs.some((tab) => tab.relPath === relPath)) return state;
            const projectFiles = activateFile(current.projectFiles, relPath);
            const tabId = fileTabId(relPath);
            return patchWorkspace(state, projectId, {
              nav: "home",
              projectFiles,
              homeActiveTab: tabId,
              homeTabHistory: homeHistoryAfterVisit(current, tabId),
            });
          });
        },

        closeHomeFile(projectId, relPath, openSessionTabIds) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const projectFiles = closeFile(current.projectFiles, relPath);
            if (projectFiles === current.projectFiles) return state;

            const closedTabId = fileTabId(relPath);
            const projectFileViewStates = { ...current.projectFileViewStates };
            delete projectFileViewStates[relPath];
            if (current.homeActiveTab !== closedTabId) {
              return patchWorkspace(state, projectId, {
                projectFiles,
                projectFileViewStates,
                homeTabHistory: current.homeTabHistory.filter((tabId) => tabId !== closedTabId),
              });
            }

            const close = closeHomeTabHistory({
              history: current.homeTabHistory,
              closedTabId,
              openTabIds: [
                HOME_BOARD_TAB_ID,
                ...openSessionTabIds,
                ...projectFiles.tabs.map((tab) => fileTabId(tab.relPath)),
              ],
            });
            const activeFile = parseFileTabId(close.active);
            return patchWorkspace(state, projectId, {
              projectFiles:
                activeFile === null ? projectFiles : activateFile(projectFiles, activeFile),
              projectFileViewStates,
              homeActiveTab: close.active,
              homeTabHistory: close.history,
            });
          });
        },

        openHome(projectId, tabId) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            return patchWorkspace(
              state,
              projectId,
              tabId === undefined
                ? { nav: "home" }
                : {
                    nav: "home",
                    homeActiveTab: tabId,
                    homeTabHistory: homeHistoryAfterVisit(current, tabId),
                  },
            );
          });
        },

        openHomeBoard(projectId) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            return patchWorkspace(state, projectId, {
              nav: "home",
              homeActiveTab: HOME_BOARD_TAB_ID,
              homeTabHistory: homeHistoryAfterVisit(current, HOME_BOARD_TAB_ID),
              openTicketId: null,
            });
          });
        },

        openTicket(projectId, ticketId) {
          // The Board tab too: `openTicketId` alone renders nothing while a Home
          // Session tab is in front (`home-surface.tsx`). Nav is deliberately
          // NOT touched here — that is `openTicketWorkspace`'s job, and the
          // difference between the two is exactly which promise each makes.
          set((state) =>
            patchWorkspace(state, projectId, {
              homeActiveTab: HOME_BOARD_TAB_ID,
              openTicketId: ticketId,
            }),
          );
          // Cross-store orchestration lives here (same precedent as
          // projects.ts's removeProject touching board/workspace directly):
          // opening a ticket always selects its card too, so returning to the
          // board — breadcrumb click, Escape, restart-then-close — shows it
          // selected rather than landing on a blank board.
          useBoardStore.getState().selectTicket(projectId, ticketId);
        },

        openTicketWorkspace(projectId, ticketId, opts) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const tabId = opts?.tabId;
            // Home AND its Board tab: a ticket takes Home over from that tab and
            // from no other, so both halves are the promise this seam makes.
            const surface = {
              nav: "home",
              homeActiveTab: HOME_BOARD_TAB_ID,
              openTicketId: ticketId,
            } as const;
            if (tabId === undefined) return patchWorkspace(state, projectId, surface);
            const existing = current.ticketTabs[ticketId] ?? emptyTicketTabs();
            return patchWorkspace(state, projectId, {
              ...surface,
              ticketTabs: {
                ...current.ticketTabs,
                [ticketId]: { ...existing, active: tabId },
              },
            });
          });
          useBoardStore.getState().selectTicket(projectId, ticketId);
        },

        openTicketSession(projectId, ticketId, tabId, paneId) {
          get().openTicketWorkspace(projectId, ticketId, { tabId });
          const sessions = useSessionsStore.getState();
          sessions.setActiveSession(ticketId, tabId);
          if (paneId !== undefined) sessions.setActivePane(ticketId, tabId, paneId);
        },

        closeTicket(projectId) {
          set((state) => patchWorkspace(state, projectId, { openTicketId: null }));
        },

        openTicketFile(projectId, ticketId, relPath) {
          // Explicit open (@file chips, create-artifact): pin + activate so
          // the tab is persistent and focused — never a replaceable glance.
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId] ?? emptyTicketTabs();
            const next = applyTicketFileTransition(existing, (files) =>
              activateFile(pinFile(files, relPath), relPath),
            );
            if (next === null) return state;
            return patchWorkspace(state, projectId, {
              ticketTabs: { ...current.ticketTabs, [ticketId]: next },
            });
          });
        },

        previewTicketFile(projectId, ticketId, relPath) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId] ?? emptyTicketTabs();
            const next = applyTicketFileTransition(existing, (files) =>
              previewFile(files, relPath),
            );
            if (next === null) return state;
            return patchWorkspace(state, projectId, {
              ticketTabs: { ...current.ticketTabs, [ticketId]: next },
            });
          });
        },

        pinTicketFile(projectId, ticketId, relPath) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId] ?? emptyTicketTabs();
            const next = applyTicketFileTransition(existing, (files) => pinFile(files, relPath));
            if (next === null) return state;
            return patchWorkspace(state, projectId, {
              ticketTabs: { ...current.ticketTabs, [ticketId]: next },
            });
          });
        },

        markTicketFileEdited(projectId, ticketId, relPath) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId] ?? emptyTicketTabs();
            const next = applyTicketFileTransition(existing, (files) =>
              markFileEdited(files, relPath),
            );
            if (next === null) return state;
            return patchWorkspace(state, projectId, {
              ticketTabs: { ...current.ticketTabs, [ticketId]: next },
            });
          });
        },

        openTicketDiff(projectId, ticketId, relPath, opts) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId] ?? emptyTicketTabs();
            const diffs = existing.diffs.includes(relPath)
              ? existing.diffs
              : [...existing.diffs, relPath];
            let diffMeta = existing.diffMeta;
            if (
              opts !== undefined &&
              (opts.previousPath !== undefined ||
                opts.status !== undefined ||
                opts.binary !== undefined)
            ) {
              const meta: TicketDiffTabMeta = { ...diffMeta[relPath] };
              if (opts.previousPath !== undefined) meta.previousPath = opts.previousPath;
              if (opts.status !== undefined) meta.status = opts.status;
              if (opts.binary !== undefined) meta.binary = opts.binary;
              diffMeta = cloneDiffMeta(diffMeta);
              diffMeta[relPath] = meta;
            }
            return patchWorkspace(state, projectId, {
              ticketTabs: {
                ...current.ticketTabs,
                [ticketId]: { ...existing, diffs, diffMeta, active: diffTabId(relPath) },
              },
            });
          });
        },

        closeTicketFile(projectId, ticketId, relPath) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId];
            if (existing === undefined) return state;
            // Reuse closeFile for the list mutation; ticket strips fall back to
            // Doc (not the file neighbour) when the closed tab was active —
            // Doc/session/diff coexist in the same strip.
            const before = ticketFilesWorkspace(existing);
            const after = closeFile(before, relPath);
            if (after === before) return state;
            const active = existing.active === fileTabId(relPath) ? BODY_TAB_ID : existing.active;
            const next: TicketTabsState = {
              ...existing,
              files: [...after.tabs],
              active,
            };
            const nextTabs = { ...current.ticketTabs };
            if (isEmptyTicketTabs(next)) delete nextTabs[ticketId];
            else nextTabs[ticketId] = next;
            return patchWorkspace(state, projectId, { ticketTabs: nextTabs });
          });
        },

        closeTicketDiff(projectId, ticketId, relPath) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId];
            if (existing === undefined) return state;
            const diffs = existing.diffs.filter((path) => path !== relPath);
            const diffMeta = cloneDiffMeta(existing.diffMeta);
            delete diffMeta[relPath];
            const active = existing.active === diffTabId(relPath) ? BODY_TAB_ID : existing.active;
            const next: TicketTabsState = { ...existing, diffs, diffMeta, active };
            const nextTabs = { ...current.ticketTabs };
            if (isEmptyTicketTabs(next)) delete nextTabs[ticketId];
            else nextTabs[ticketId] = next;

            const ticketDiffViewStates = { ...current.ticketDiffViewStates };
            const perTicket = { ...ticketDiffViewStates[ticketId] };
            delete perTicket[relPath];
            if (Object.keys(perTicket).length === 0) delete ticketDiffViewStates[ticketId];
            else ticketDiffViewStates[ticketId] = perTicket;

            return patchWorkspace(state, projectId, {
              ticketTabs: nextTabs,
              ticketDiffViewStates,
            });
          });
        },

        setTicketActiveTab(projectId, ticketId, tabId) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId] ?? emptyTicketTabs();
            if (existing.active === tabId) return state; // no-op keeps empty records from forming
            return patchWorkspace(state, projectId, {
              ticketTabs: { ...current.ticketTabs, [ticketId]: { ...existing, active: tabId } },
            });
          });
        },

        markProjectFileEdited(projectId, relPath) {
          set((state) =>
            applyProjectFiles(state, projectId, (files) => markFileEdited(files, relPath)),
          );
        },

        setProjectFileViewState(projectId, relPath, viewState) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            // Only an OPEN tab may hold view state. A closing tab's editor
            // unmounts AFTER `closeHomeFile` has already dropped its entry
            // and emits one last view state bound to the path it was showing;
            // accepting that write would re-insert exactly what the close just
            // pruned, and the map would grow without bound as tabs churn.
            if (!current.projectFiles.tabs.some((tab) => tab.relPath === relPath)) return state;
            return patchWorkspace(state, projectId, {
              projectFileViewStates: { ...current.projectFileViewStates, [relPath]: viewState },
            });
          });
        },

        setTicketDiffViewState(projectId, ticketId, relPath, viewState) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const diffs = current.ticketTabs[ticketId]?.diffs;
            if (diffs === undefined || !diffs.includes(relPath)) return state;
            return patchWorkspace(state, projectId, {
              ticketDiffViewStates: {
                ...current.ticketDiffViewStates,
                [ticketId]: {
                  ...current.ticketDiffViewStates[ticketId],
                  [relPath]: viewState,
                },
              },
            });
          });
        },

        forget(projectId) {
          set((state) => {
            if (!(projectId in state.byProject)) return state;
            const byProject = { ...state.byProject };
            delete byProject[projectId];
            return { byProject };
          });
        },

        recordNav(snapshot) {
          set((state) => {
            const navHistory = recordNav(state.navHistory, snapshot);
            // recordNav returns the SAME reference when the snapshot is a
            // duplicate — bail so we don't notify subscribers for a no-op.
            return navHistory === state.navHistory ? state : { navHistory };
          });
        },

        stepNavBack() {
          const step = goBack(get().navHistory);
          if (step === null) return null;
          set({ navHistory: step.history });
          return step.snapshot;
        },

        stepNavForward() {
          const step = goForward(get().navHistory);
          if (step === null) return null;
          set({ navHistory: step.history });
          return step.snapshot;
        },
      }),
      {
        name: "volli:workspace",
        version: 1,
        storage: createJSONStorage(() => storage ?? appStateStorage),
        skipHydration: storage === undefined,
        // Persist ONLY the view prefs + open ticket per record (see module
        // doc); records that still match the defaults are dropped entirely so
        // the stored map never accretes entries for projects that were merely
        // visited.
        partialize: (state): PersistedWorkspaceState => ({
          byProject: Object.fromEntries(
            Object.entries(state.byProject)
              .filter(([, ui]) => !isDefaultPersistedUi(ui))
              .map(([projectId, ui]) => [
                projectId,
                {
                  boardView: ui.boardView,
                  boardSort: ui.boardSort,
                  openTicketId: ui.openTicketId,
                  ticketTabs: ui.ticketTabs,
                  // Tab identities + Diff/Project Files view state only —
                  // file CONTENTS are never persisted (decision #55: a returning
                  // tab reloads its text lazily from the checkout).
                  ticketDiffViewStates: ui.ticketDiffViewStates,
                  projectFiles: ui.projectFiles,
                  projectFileViewStates: ui.projectFileViewStates,
                  // The Home tab that was in front — an id, never the Session
                  // behind it, which is recovered from its own durable record.
                  homeActiveTab: ui.homeActiveTab,
                },
              ]),
          ),
        }),
        // Rebuild full records from the pruned persisted pair: everything not
        // persisted (nav, expandedSessionGroups) rehydrates to the defaults.
        merge: (persisted, current) => {
          // Null-prototype for the same reason the sanitizers use one: project
          // ids are persisted JSON keys, and `__proto__` among them must not
          // reach an object literal's prototype (nor may a lookup of an
          // unvisited project ever resolve to an inherited member).
          const byProject = Object.create(null) as Record<string, WorkspaceUiState>;
          const persistedByProject = (persisted as PersistedWorkspaceState | undefined)?.byProject;
          for (const [projectId, ui] of Object.entries(persistedByProject ?? {})) {
            // A non-object record (null from a corrupt write) would throw
            // inside sanitizePersistedUi's property reads — treat it as empty.
            const record = typeof ui === "object" && ui !== null ? ui : {};
            byProject[projectId] = {
              ...DEFAULT_WORKSPACE_UI,
              ...sanitizePersistedUi(record),
              // `nav` is not part of `PersistedWorkspaceUi` (it is session-only —
              // see the module doc), so no shipped build wrote one here. Read
              // and mapped anyway, the same tolerant-read every other field in
              // this record gets, in case a foreign or hand-edited blob carries
              // a retired page name.
              nav: resolvePersistedNav(record),
            };
          }
          return { ...current, byProject };
        },
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useWorkspaceStore = createWorkspaceStore();
