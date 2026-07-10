/**
 * Persisted store of tracked projects. Array order IS the rail order — drag
 * reorder writes it directly; there is no separate `sortOrder` field until
 * the SQLite layer lands (locked decision, see docs/CONCEPT.md #3).
 *
 * Persistence is localStorage via zustand's `persist` middleware, an interim
 * choice ahead of that SQLite layer. Known and accepted limitation: dev
 * (localhost:5173) and the packaged app (file://) are different origins, so
 * their localStorage — and therefore their tracked projects — do not share
 * data across the two.
 */
import { derivePrefix, PROJECT_COLORS, type Project } from "@volli/shared";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { useWorkspaceStore } from "./workspace";

interface ProjectsState {
  projects: Project[];
  selectedProjectId: string | null;
  addProject(input: { path: string; defaultName: string }): void;
  removeProject(id: string): void;
  reorder(activeId: string, overId: string): void;
  select(id: string): void;
  selectByIndex(index: number): void;
}

type PersistedProjectsState = Pick<ProjectsState, "projects" | "selectedProjectId">;

/** Factory so tests can supply an in-memory storage instead of localStorage. */
export function createProjectsStore(storage?: StateStorage) {
  return create<ProjectsState>()(
    persist(
      (set, get) => ({
        projects: [],
        selectedProjectId: null,

        addProject({ path, defaultName }) {
          const { projects } = get();
          const existing = projects.find((project) => project.path === path);
          if (existing) {
            set({ selectedProjectId: existing.id });
            return;
          }

          const project: Project = {
            id: crypto.randomUUID(),
            name: defaultName,
            path,
            ticketPrefix: derivePrefix(defaultName),
            colorIndex: projects.length % PROJECT_COLORS.length,
            createdAt: Date.now(),
          };
          set({ projects: [...projects, project], selectedProjectId: project.id });
        },

        removeProject(id) {
          const { projects, selectedProjectId } = get();
          const removedIndex = projects.findIndex((project) => project.id === id);
          if (removedIndex === -1) return;

          // Removal and per-workspace-UI cleanup are one invariant, enforced
          // here so no removal path (dialog today, context menu / CLI later)
          // can forget the forget. The one store→store call in the codebase.
          useWorkspaceStore.getState().forget(id);

          const nextProjects = projects.filter((project) => project.id !== id);
          if (selectedProjectId !== id) {
            set({ projects: nextProjects });
            return;
          }

          const nextSelectedId =
            nextProjects.length === 0
              ? null
              : nextProjects[Math.min(removedIndex, nextProjects.length - 1)]!.id;
          set({ projects: nextProjects, selectedProjectId: nextSelectedId });
        },

        reorder(activeId, overId) {
          if (activeId === overId) return;

          const { projects } = get();
          const activeIndex = projects.findIndex((project) => project.id === activeId);
          const overIndex = projects.findIndex((project) => project.id === overId);
          if (activeIndex === -1 || overIndex === -1) return;

          const next = projects.slice();
          const [moved] = next.splice(activeIndex, 1);
          next.splice(overIndex, 0, moved!);
          set({ projects: next });
        },

        select(id) {
          const exists = get().projects.some((project) => project.id === id);
          if (exists) set({ selectedProjectId: id });
        },

        selectByIndex(index) {
          const project = get().projects[index];
          if (project) set({ selectedProjectId: project.id });
        },
      }),
      {
        name: "volli:projects",
        version: 1,
        storage: createJSONStorage(() => storage ?? localStorage),
        partialize: (state): PersistedProjectsState => ({
          projects: state.projects,
          selectedProjectId: state.selectedProjectId,
        }),
      },
    ),
  );
}

/** App-wide singleton; components import this directly. */
export const useProjectsStore = createProjectsStore();
