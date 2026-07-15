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

/** The per-workspace nav pages (NAV_ITEMS). Settings is app-wide chrome — see stores/ui.ts. */
export type NavKey = "board" | "sessions" | "files";

/** Kanban columns vs. Linear-style grouped list — same data, filter, selection. */
export type BoardView = "board" | "list";

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
}

export const DEFAULT_WORKSPACE_UI: WorkspaceUiState = {
  nav: "board",
  expandedDirs: [],
  boardView: "board",
  boardSort: DEFAULT_TICKET_SORT,
  openTicketId: null,
};

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
  /** Closes the detail view, returning to the plain board. Leaves the board's selection as-is. */
  closeTicket(projectId: string): void;
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
type PersistedWorkspaceUi = Pick<WorkspaceUiState, "boardView" | "boardSort" | "openTicketId">;

interface PersistedWorkspaceState {
  byProject: Record<string, PersistedWorkspaceUi>;
}

/**
 * Rehydrated records come from JSON a past (possibly older) build wrote —
 * validate rather than trust, falling back per-field to the defaults so a
 * renamed sort key or view can never render an impossible state.
 */
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
  };
}

/** Whether a record's persisted trio still matches the defaults (by value). */
function isDefaultPersistedUi(ui: WorkspaceUiState): boolean {
  return (
    ui.boardView === DEFAULT_WORKSPACE_UI.boardView &&
    ui.boardSort.key === DEFAULT_TICKET_SORT.key &&
    ui.boardSort.direction === DEFAULT_TICKET_SORT.direction &&
    ui.openTicketId === DEFAULT_WORKSPACE_UI.openTicketId
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

        closeTicket(projectId) {
          set((state) => patchWorkspace(state, projectId, { openTicketId: null }));
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
                { boardView: ui.boardView, boardSort: ui.boardSort, openTicketId: ui.openTicketId },
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
