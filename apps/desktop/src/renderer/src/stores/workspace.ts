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
 * Persistence is FIELD-SELECTIVE: `boardView` and `boardSort` survive relaunch
 * (they're deliberate view preferences a user sets once per project), while
 * `nav` and `expandedDirs` stay session-only — nav resetting to Board on
 * relaunch is a settled decision (see ui.ts's history) and now applies per
 * workspace. The partialize below prunes each record down to the persisted
 * pair; merge rehydrates them back over `DEFAULT_WORKSPACE_UI`, sanitizing
 * stale values so old localStorage can never smuggle in an invalid view/sort.
 */
import { DEFAULT_TICKET_SORT, TICKET_SORT_KEYS, type TicketSort } from "@volli/shared";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

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
}

export const DEFAULT_WORKSPACE_UI: WorkspaceUiState = {
  nav: "board",
  expandedDirs: [],
  boardView: "board",
  boardSort: DEFAULT_TICKET_SORT,
};

interface WorkspaceState {
  byProject: Record<string, WorkspaceUiState>;
  setNav(projectId: string, nav: NavKey): void;
  setDirExpanded(projectId: string, dirPath: string, expanded: boolean): void;
  setBoardView(projectId: string, view: BoardView): void;
  setBoardSort(projectId: string, sort: TicketSort): void;
  /** Drop a removed project's record so re-adding it starts fresh. */
  forget(projectId: string): void;
}

/** The slice of a workspace record that survives relaunch. */
type PersistedWorkspaceUi = Pick<WorkspaceUiState, "boardView" | "boardSort">;

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
  return {
    boardView: view,
    // Rebuild rather than spread so stray keys in old JSON never enter state.
    boardSort: sortValid
      ? { key: sort.key, direction: sort.direction }
      : DEFAULT_WORKSPACE_UI.boardSort,
  };
}

/** Whether a record's persisted pair still matches the defaults (by value). */
function isDefaultPersistedUi(ui: WorkspaceUiState): boolean {
  return (
    ui.boardView === DEFAULT_WORKSPACE_UI.boardView &&
    ui.boardSort.key === DEFAULT_TICKET_SORT.key &&
    ui.boardSort.direction === DEFAULT_TICKET_SORT.direction
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

/** Factory so tests can supply an in-memory storage instead of localStorage. */
export function createWorkspaceStore(storage?: StateStorage) {
  return create<WorkspaceState>()(
    persist(
      (set) => ({
        byProject: {},

        setNav(projectId, nav) {
          set((state) => patchWorkspace(state, projectId, { nav }));
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

        forget(projectId) {
          set((state) => {
            if (!(projectId in state.byProject)) return state;
            const byProject = { ...state.byProject };
            delete byProject[projectId];
            return { byProject };
          });
        },
      }),
      {
        name: "volli:workspace",
        version: 1,
        storage: createJSONStorage(() => storage ?? localStorage),
        // Persist ONLY the view prefs per record (see module doc); records
        // that still match the defaults are dropped entirely so the stored
        // map never accretes entries for projects that were merely visited.
        partialize: (state): PersistedWorkspaceState => ({
          byProject: Object.fromEntries(
            Object.entries(state.byProject)
              .filter(([, ui]) => !isDefaultPersistedUi(ui))
              .map(([projectId, ui]) => [
                projectId,
                { boardView: ui.boardView, boardSort: ui.boardSort },
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
