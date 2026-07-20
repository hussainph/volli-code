/**
 * Tracked projects (SQLite-backed, migration 001 — `projects.sort_order`
 * drives rail order). `hydrate` is the ONE place state is seeded wholesale,
 * from the boot payload (see lib/boot.ts); every mutation after that is an
 * async write-through via `gateway` that reconciles or reverts on failure,
 * surfacing every failure via a toast (CLAUDE.md: never silently swallow a
 * failed mutation — the Swift app's top systemic defect).
 *
 * `reorder` stays a synchronous, optimistic local array move for live drag
 * feedback (the rail calls it on every pointer-cross) and does NOT persist —
 * persistence is the separate `commitReorder`, which the rail calls once, on
 * drag end/cancel, so a single drag doesn't spam `api.projects.reorder`.
 */
import {
  errorMessage,
  type AppStateSetResult,
  type Project,
  type ProjectCreateResult,
  type ProjectMutationResult,
  type ProjectUpdateResult,
} from "@volli/shared";
import { create } from "zustand";

import { toastError } from "@renderer/lib/toast";
import {
  killProjectSessions,
  killProjectTicketSessions,
} from "@renderer/terminal/session-lifecycle";

import { useBoardStore } from "./board";
import { writeThrough } from "./mutate";
import { useWorkspaceStore } from "./workspace";

/** The `app_state` key `selectedProjectId` is persisted under — also read by lib/boot.ts. */
export const PROJECTS_UI_APP_STATE_KEY = "volli:projects-ui";

/** The shape persisted under {@link PROJECTS_UI_APP_STATE_KEY}. */
interface ProjectsUiState {
  selectedProjectId: string | null;
}

/**
 * The single encode/decode pair for the {@link PROJECTS_UI_APP_STATE_KEY}
 * payload — both writers (`persistSelection` below, `buildLegacyImportRequest`
 * in lib/boot.ts) and the one reader (`resolveSelectedProjectId`, also
 * lib/boot.ts) route through these so the shape can only ever change in one
 * place. `decode` is total: anything that isn't exactly `{ selectedProjectId:
 * string }` — missing, unparseable, wrong shape, non-string field — decodes to
 * `null`, matching what an absent selection means.
 */
export function encodeProjectsUiState(selectedProjectId: string | null): string {
  const state: ProjectsUiState = { selectedProjectId };
  return JSON.stringify(state);
}

export function decodeProjectsUiState(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const selectedProjectId = (parsed as Record<string, unknown>).selectedProjectId;
    return typeof selectedProjectId === "string" ? selectedProjectId : null;
  } catch {
    return null;
  }
}

/** The subset of the preload API the projects store needs — narrow and fake-able for tests. */
export interface ProjectsGateway {
  create(input: { path: string; name: string }): Promise<ProjectCreateResult>;
  update(input: {
    id: string;
    baseBranch: string | null;
    /** `undefined` leaves it untouched; `null`/empty clears it (setup step is skipped). */
    setupCommand?: string | null;
  }): Promise<ProjectUpdateResult>;
  remove(id: string): Promise<ProjectMutationResult>;
  reorder(orderedIds: string[]): Promise<ProjectMutationResult>;
  /** Fire-and-forget persistence of the current selection under {@link PROJECTS_UI_APP_STATE_KEY}. */
  setSelection(selectedProjectId: string | null): Promise<AppStateSetResult>;
}

const defaultGateway: ProjectsGateway = {
  create: (input) => window.api.projects.create(input),
  update: (input) => window.api.projects.update(input),
  remove: (id) => window.api.projects.remove(id),
  reorder: (orderedIds) => window.api.projects.reorder(orderedIds),
  setSelection: (selectedProjectId) =>
    window.api.appState.set(PROJECTS_UI_APP_STATE_KEY, encodeProjectsUiState(selectedProjectId)),
};

interface ProjectsState {
  projects: Project[];
  selectedProjectId: string | null;
  /** Seeds state from the boot payload — the ONE place state is set wholesale outside a mutation. */
  hydrate(projects: Project[], selectedProjectId: string | null): void;
  addProject(input: { path: string; defaultName: string }): Promise<void>;
  updateBaseBranch(id: string, baseBranch: string | null): Promise<boolean>;
  /** Settings → Worktrees' setup-command field; leaves `baseBranch` untouched (re-sends the current pinned value). */
  updateSetupCommand(id: string, setupCommand: string | null): Promise<boolean>;
  removeProject(id: string): Promise<void>;
  /** Optimistic local reorder for live drag feedback; does not persist — see `commitReorder`. */
  reorder(activeId: string, overId: string): void;
  /** Persists the rail's current order against `previousOrder` (captured at drag start); reverts + toasts on failure. */
  commitReorder(previousOrder: readonly Project[]): Promise<void>;
  select(id: string): void;
  selectByIndex(index: number): void;
}

/** Whether two orderings name the same ids in the same sequence. */
function sameOrder(a: readonly Project[], b: readonly Project[]): boolean {
  return a.length === b.length && a.every((project, index) => project.id === b[index]?.id);
}

/** Factory so tests can inject a fake gateway instead of the real preload bridge. */
export function createProjectsStore(gateway: ProjectsGateway = defaultGateway) {
  /**
   * Chains `gateway.update` calls for the SAME project id so only one is ever
   * in flight at a time. `updateBaseBranch` and `updateSetupCommand` write
   * disjoint DB columns, but main's `project-update` RPC always re-writes
   * `baseBranch` (it's a single pinned-fields write, not a per-field patch) —
   * so a setup-command save always re-sends the base branch it currently
   * knows about. Without serialization, a setup-command save started just
   * before a base-branch save could land its IPC round-trip AFTER it and
   * clobber the fresh base branch back to the stale value it captured.
   * Queuing per id guarantees each call only reads `baseBranch` (see
   * `updateSetupCommand` below) once every earlier-queued write for that
   * project has already landed in state.
   */
  const pendingProjectUpdates = new Map<string, Promise<unknown>>();
  function queueProjectUpdate<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = pendingProjectUpdates.get(id) ?? Promise.resolve();
    const started = previous.catch(() => undefined).then(run);
    pendingProjectUpdates.set(
      id,
      started.catch(() => undefined),
    );
    return started;
  }

  /**
   * Fire-and-forget persistence of the current selection under
   * {@link PROJECTS_UI_APP_STATE_KEY}. Every path that changes the selection —
   * `select`, `addProject` (auto-selects the new project), `removeProject`
   * (falls to a neighbor) — routes through here, so the choice always survives
   * relaunch. A failure only costs the persisted selection, so toast but never
   * block or revert the in-memory change.
   */
  function persistSelection(selectedProjectId: string | null): void {
    gateway
      .setSelection(selectedProjectId)
      .then((result) => {
        if (!result.ok) toastError(`Could not save selected project: ${result.error}`);
      })
      .catch((error: unknown) => {
        toastError(`Could not save selected project: ${errorMessage(error)}`);
      });
  }

  return create<ProjectsState>()((set, get) => ({
    projects: [],
    selectedProjectId: null,

    hydrate(projects, selectedProjectId) {
      set({ projects, selectedProjectId });
    },

    async addProject({ path, defaultName }) {
      const result = await writeThrough(
        "add project",
        (): Promise<ProjectCreateResult> => gateway.create({ path, name: defaultName }),
      );
      if (!result) return;

      // Seed the board's ticket/label slices before anything else touches
      // them — bootstrap seeds every project's slice wholesale (see
      // lib/boot.ts / data-ipc.ts's buildBootstrapPayload), but a project
      // created mid-session bypasses that entirely, and every ticket mutation
      // reconciles through a guard that refuses to write into a missing slice.
      // Without this, the new project's first ticket would land in SQLite but
      // never reach the board. `seedProject` no-ops when the slice already
      // exists, so the `created: false` existing-project branch below (which
      // may already have a live slice from this same renderer) is never
      // clobbered.
      useBoardStore.getState().seedProject(result.project.id);

      // Re-read FRESH after the await, then: `created: false` means an existing
      // project at that path was selected rather than inserted; append it
      // defensively only if this renderer doesn't already have it (a fresh
      // insert never will, so the guard is a no-op there).
      const { projects } = get();
      const exists = projects.some((project) => project.id === result.project.id);
      set({
        projects: exists ? projects : [...projects, result.project],
        selectedProjectId: result.project.id,
      });
      persistSelection(result.project.id);
    },

    async updateBaseBranch(id, baseBranch) {
      return queueProjectUpdate(id, async () => {
        const result = await writeThrough(
          "save project base branch",
          (): Promise<ProjectUpdateResult> => gateway.update({ id, baseBranch }),
        );
        if (!result) return false;
        set({
          projects: get().projects.map((project) =>
            project.id === result.project.id ? result.project : project,
          ),
        });
        return true;
      });
    },

    async updateSetupCommand(id, setupCommand) {
      return queueProjectUpdate(id, async () => {
        // The gateway's `update` always requires baseBranch (it's a full
        // pinned fields write) — re-send the project's current value so this
        // save can't clobber it. Reading it here (this call's turn in the
        // per-id queue) rather than before queuing means any earlier-queued
        // `updateBaseBranch` for this project has already landed in state, so
        // this always re-sends the latest known value, not a stale one. An
        // unknown id has nothing to re-send; no-op.
        const current = get().projects.find((project) => project.id === id);
        if (!current) return false;

        const result = await writeThrough(
          "save project setup command",
          (): Promise<ProjectUpdateResult> =>
            gateway.update({ id, baseBranch: current.baseBranch ?? null, setupCommand }),
        );
        if (!result) return false;
        set({
          projects: get().projects.map((project) =>
            project.id === result.project.id ? result.project : project,
          ),
        });
        return true;
      });
    },

    async removeProject(id) {
      // No-op (and no IPC) for an unknown id — checked against the pre-await
      // snapshot; the fresh re-read below handles what actually changed.
      if (!get().projects.some((project) => project.id === id)) return;

      const result = await writeThrough(
        "remove project",
        (): Promise<ProjectMutationResult> => gateway.remove(id),
      );
      if (!result) return;

      // Removal, per-workspace-UI cleanup, and session teardown are one
      // invariant, enforced here so no removal path (dialog today, context
      // menu / CLI later) can forget the forget. Each kill* helper kills every
      // live PTY and disposes its engine explicitly — teardown does NOT depend
      // on a terminal view being mounted — then drops the session record.
      // Ticket sessions are keyed by ticketId; killProjectTicketSessions finds
      // them from the SESSIONS store (not the board's live ticket list), so an
      // archived ticket's sessions are torn down too, not just live ones.
      killProjectTicketSessions(id);
      useWorkspaceStore.getState().forget(id);
      useBoardStore.getState().forget(id);
      killProjectSessions(id);

      // Re-read FRESH: a concurrent add/reorder may have changed `projects`
      // while the remove IPC was in flight; computing the next list from the
      // pre-await snapshot would clobber that concurrent change (drop a
      // just-added project from the rail though SQLite still has it).
      const { projects, selectedProjectId } = get();
      const removedIndex = projects.findIndex((project) => project.id === id);
      const nextProjects = projects.filter((project) => project.id !== id);
      if (selectedProjectId !== id) {
        set({ projects: nextProjects });
        return;
      }

      const nextSelectedId =
        nextProjects.length === 0
          ? null
          : nextProjects[Math.min(Math.max(removedIndex, 0), nextProjects.length - 1)]!.id;
      set({ projects: nextProjects, selectedProjectId: nextSelectedId });
      persistSelection(nextSelectedId);
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

    async commitReorder(previousOrder) {
      const { projects } = get();
      if (sameOrder(projects, previousOrder)) return; // nothing moved since the drag started

      const result = await writeThrough(
        "save project order",
        (): Promise<ProjectMutationResult> =>
          gateway.reorder(projects.map((project) => project.id)),
      );
      if (result) return; // persisted — the optimistic order stands

      // Failure: restore the PREVIOUS order, but reconcile membership against
      // FRESH state — a project added (or removed) while the reorder IPC was in
      // flight must survive the revert. Restore order, not membership: drop
      // previous entries no longer present, then append any newcomer.
      const current = get().projects;
      const currentIds = new Set(current.map((project) => project.id));
      const previousIds = new Set(previousOrder.map((project) => project.id));
      set({
        projects: [
          ...previousOrder.filter((project) => currentIds.has(project.id)),
          ...current.filter((project) => !previousIds.has(project.id)),
        ],
      });
    },

    select(id) {
      const exists = get().projects.some((project) => project.id === id);
      if (!exists) return;
      set({ selectedProjectId: id });
      persistSelection(id);
    },

    selectByIndex(index) {
      const project = get().projects[index];
      if (project) get().select(project.id);
    },
  }));
}

/** App-wide singleton; components import this directly. */
export const useProjectsStore = createProjectsStore();
