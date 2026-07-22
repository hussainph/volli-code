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
 * Persistence is FIELD-SELECTIVE: `boardView`, `boardSort`, and `openTicketId`
 * survive relaunch (they're deliberate per-project state — a view preference,
 * or the ticket-detail-mvp decision that the open ticket persists across
 * restart, decision #3), while `nav` and `expandedDirs` stay session-only —
 * nav resetting to Board on relaunch is a settled decision (see ui.ts's
 * history) and now applies per workspace. The partialize below prunes each
 * record down to the persisted trio; merge rehydrates them back over
 * `DEFAULT_WORKSPACE_UI`, sanitizing stale values so old localStorage can
 * never smuggle in an invalid view/sort/ticket id.
 */
import { DEFAULT_TICKET_SORT, TICKET_SORT_KEYS, type TicketSort } from "@volli/shared";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { appStateStorage } from "@renderer/lib/app-state-storage";
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

/** The per-workspace nav pages (NAV_ITEMS). Settings is app-wide chrome — see stores/ui.ts. */
export type NavKey = "board" | "sessions" | "files";

/** Kanban columns vs. Linear-style grouped list — same data, filter, selection. */
export type BoardView = "board" | "list";

/**
 * A ticket's open `@file` tabs and its active tab (global-artifacts decision
 * #5). `files` is the ordered list of open relPaths; `active` is the active tab
 * id — `"doc"`, a `file:<relPath>`, or a session id (sessions rehydrate
 * separately, so a persisted session id that no longer exists falls back to Doc
 * in ticket-detail).
 */
export interface TicketTabsState {
  files: string[];
  active: string;
}

export interface WorkspaceUiState {
  nav: NavKey;
  /** Absolute paths of expanded file-tree directories (collapsed = absent). */
  expandedDirs: readonly string[];
  /** Board vs. list rendering of the ticket set. Persisted. */
  boardView: BoardView;
  /** Column ordering shared by both views; "manual" is the drag-reorder mode. Persisted. */
  boardSort: TicketSort;
  /**
   * The ticket open in the full-page detail view (ticket-detail-mvp decision
   * #1/#3); `null` on the plain board. Persisted — survives restart.
   */
  openTicketId: string | null;
  /** Open file tabs + active tab, per ticket (global-artifacts decision #5). Persisted. */
  ticketTabs: Record<string, TicketTabsState>;
}

export const DEFAULT_WORKSPACE_UI: WorkspaceUiState = {
  nav: "board",
  expandedDirs: [],
  boardView: "board",
  boardSort: DEFAULT_TICKET_SORT,
  openTicketId: null,
  ticketTabs: {},
};

/** The active-tab id of the always-present Doc tab — the fallback when a file/session tab closes. */
const DOC_TAB_ID = "doc";

/** A file tab's id from its relPath (`file:<relPath>`) — the persisted `active` form. */
function fileTabId(relPath: string): string {
  return `file:${relPath}`;
}

interface WorkspaceState {
  byProject: Record<string, WorkspaceUiState>;
  /**
   * Slack-style workspace navigation history (the chrome-bar ←/→ buttons and
   * ⌘[ / ⌘]). In-memory only — deliberately excluded from `partialize`, so it
   * starts empty on every relaunch and never reaches persisted storage.
   */
  navHistory: NavHistory;
  /** Select a top-level page. Selecting Board exits any open ticket detail. */
  setNav(projectId: string, nav: NavKey): void;
  setDirExpanded(projectId: string, dirPath: string, expanded: boolean): void;
  setBoardView(projectId: string, view: BoardView): void;
  setBoardSort(projectId: string, sort: TicketSort): void;
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
   * project onto the Board nav (ticket detail only renders there —
   * main-content.tsx — so a caller that skips this step can set
   * `openTicketId` while nav stays on Files/Sessions and the promised detail
   * view never appears; this was the composer kickoff bug), opens the
   * ticket's full-page detail, and selects the same ticket in the board
   * store (same ordering `openTicketSession` below already used internally).
   *
   * `opts.tabId`, when given, also activates that tab (`"doc"`, a
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
   * Opens a `file` tab for `relPath` in `ticketId`'s tab strip (appends it if
   * not already open) and makes it the active tab (global-artifacts decision
   * #5). Idempotent on the file list; re-opening an already-open file just
   * re-activates it.
   */
  openTicketFile(projectId: string, ticketId: string, relPath: string): void;
  /**
   * Closes `relPath`'s file tab; if it was the active tab, falls back to Doc.
   * Prunes the ticket's record entirely once nothing but Doc remains.
   */
  closeTicketFile(projectId: string, ticketId: string, relPath: string): void;
  /** Sets the active tab for `ticketId` (`"doc"`, a `file:<relPath>`, or a session id). */
  setTicketActiveTab(projectId: string, ticketId: string, tabId: string): void;
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
  "boardView" | "boardSort" | "openTicketId" | "ticketTabs"
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
 * Validate a rehydrated `ticketTabs` map: keep only records whose `files` is a
 * string[] and `active` a string, and prune anything carrying nothing worth
 * restoring (no open files and Doc active) so the map never accretes empty
 * entries. A persisted `active` that's a session id is preserved — ticket-detail
 * falls back to Doc when it matches no live tab.
 */
function sanitizeTicketTabs(raw: unknown): Record<string, TicketTabsState> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, TicketTabsState> = {};
  for (const [ticketId, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as { files?: unknown; active?: unknown };
    const files = Array.isArray(record.files)
      ? record.files.filter((file): file is string => typeof file === "string")
      : [];
    const active = typeof record.active === "string" ? record.active : DOC_TAB_ID;
    if (files.length === 0 && active === DOC_TAB_ID) continue;
    out[ticketId] = { files, active };
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
    ticketTabs: sanitizeTicketTabs(persisted.ticketTabs),
  };
}

/** Whether a record's persisted fields still match the defaults (by value) — such records are dropped. */
function isDefaultPersistedUi(ui: WorkspaceUiState): boolean {
  return (
    ui.boardView === DEFAULT_WORKSPACE_UI.boardView &&
    ui.boardSort.key === DEFAULT_TICKET_SORT.key &&
    ui.boardSort.direction === DEFAULT_TICKET_SORT.direction &&
    ui.openTicketId === DEFAULT_WORKSPACE_UI.openTicketId &&
    Object.keys(ui.ticketTabs).length === 0
  );
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
          // Ticket detail is a child of Board, not a separate top-level nav
          // key. A deliberate Board selection must therefore mean the plain
          // board even when `nav` is already "board".
          set((state) =>
            patchWorkspace(
              state,
              projectId,
              nav === "board" ? { nav, openTicketId: null } : { nav },
            ),
          );
        },

        setDirExpanded(projectId, dirPath, expanded) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            if (current.expandedDirs.includes(dirPath) === expanded) return state;
            return patchWorkspace(state, projectId, {
              expandedDirs: expanded
                ? [...current.expandedDirs, dirPath]
                : current.expandedDirs.filter((path) => path !== dirPath),
            });
          });
        },

        setBoardView(projectId, view) {
          set((state) => patchWorkspace(state, projectId, { boardView: view }));
        },

        setBoardSort(projectId, sort) {
          set((state) => patchWorkspace(state, projectId, { boardSort: sort }));
        },

        openTicket(projectId, ticketId) {
          set((state) => patchWorkspace(state, projectId, { openTicketId: ticketId }));
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
            if (tabId === undefined) {
              return patchWorkspace(state, projectId, { nav: "board", openTicketId: ticketId });
            }
            const existing = current.ticketTabs[ticketId] ?? { files: [], active: DOC_TAB_ID };
            return patchWorkspace(state, projectId, {
              nav: "board",
              openTicketId: ticketId,
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
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId] ?? { files: [], active: DOC_TAB_ID };
            const files = existing.files.includes(relPath)
              ? existing.files
              : [...existing.files, relPath];
            return patchWorkspace(state, projectId, {
              ticketTabs: {
                ...current.ticketTabs,
                [ticketId]: { files, active: fileTabId(relPath) },
              },
            });
          });
        },

        closeTicketFile(projectId, ticketId, relPath) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId];
            if (existing === undefined) return state;
            const files = existing.files.filter((file) => file !== relPath);
            // Closing the active file tab lands back on Doc; other closes keep
            // the current selection (which may itself be Doc or a session tab).
            const active = existing.active === fileTabId(relPath) ? DOC_TAB_ID : existing.active;
            const nextTabs = { ...current.ticketTabs };
            if (files.length === 0 && active === DOC_TAB_ID) delete nextTabs[ticketId];
            else nextTabs[ticketId] = { files, active };
            return patchWorkspace(state, projectId, { ticketTabs: nextTabs });
          });
        },

        setTicketActiveTab(projectId, ticketId, tabId) {
          set((state) => {
            const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
            const existing = current.ticketTabs[ticketId] ?? { files: [], active: DOC_TAB_ID };
            if (existing.active === tabId) return state; // no-op keeps empty records from forming
            return patchWorkspace(state, projectId, {
              ticketTabs: { ...current.ticketTabs, [ticketId]: { ...existing, active: tabId } },
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
                },
              ]),
          ),
        }),
        // Rebuild full records from the pruned persisted pair: everything not
        // persisted (nav, expandedDirs) rehydrates to the defaults.
        merge: (persisted, current) => {
          const byProject: Record<string, WorkspaceUiState> = {};
          const persistedByProject = (persisted as PersistedWorkspaceState | undefined)?.byProject;
          for (const [projectId, ui] of Object.entries(persistedByProject ?? {})) {
            // A non-object record (null from a corrupt write) would throw
            // inside sanitizePersistedUi's property reads — treat it as empty.
            const record = typeof ui === "object" && ui !== null ? ui : {};
            byProject[projectId] = { ...DEFAULT_WORKSPACE_UI, ...sanitizePersistedUi(record) };
          }
          return { ...current, byProject };
        },
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useWorkspaceStore = createWorkspaceStore();
