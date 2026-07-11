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
 * Deliberately session-only (no `persist`): nav resetting to Board on relaunch
 * is a settled decision (see ui.ts's history) and now applies per workspace.
 * Board view mode and sort ride here too and are therefore also session-only —
 * whether the chosen view/ordering should survive relaunch is a future call
 * (it'd move here or into SQLite alongside the ticket layer, not localStorage).
 */
import { DEFAULT_TICKET_SORT, type TicketSort } from "@volli/shared";
import { create } from "zustand";

/** The per-workspace nav pages (NAV_ITEMS). Settings is app-wide chrome — see stores/ui.ts. */
export type NavKey = "board" | "sessions" | "files";

/** Kanban columns vs. Linear-style grouped list — same data, filter, selection. */
export type BoardView = "board" | "list";

export interface WorkspaceUiState {
  nav: NavKey;
  /** Absolute paths of expanded file-tree directories (collapsed = absent). */
  expandedDirs: readonly string[];
  /** Board vs. list rendering of the ticket set. */
  boardView: BoardView;
  /** Column ordering shared by both views; "manual" is the drag-reorder mode. */
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

/** The project's record merged with `changes` — spread into `set()`. */
function patchWorkspace(
  state: WorkspaceState,
  projectId: string,
  changes: Partial<WorkspaceUiState>,
): Pick<WorkspaceState, "byProject"> {
  const current = state.byProject[projectId] ?? DEFAULT_WORKSPACE_UI;
  return { byProject: { ...state.byProject, [projectId]: { ...current, ...changes } } };
}

/** Factory so tests get isolated instances. */
export function createWorkspaceStore() {
  return create<WorkspaceState>()((set) => ({
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
  }));
}

/** App-wide singleton; components import this directly. */
export const useWorkspaceStore = createWorkspaceStore();
