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
 * drag end/cancel, so a single drag doesn't spam `project.reorder`.
 *
 * **Remote projects (VC-711).** A project a remote host serves is not in
 * this Mac's database: its row arrives from its Workspace's board snapshot
 * (`adoptProject`, for an id the host-connection store claims for a remote
 * host) and lives here, in memory, beside the local bootstrap's rows. A
 * wholesale `hydrate` from the local bootstrap keeps them; they leave when
 * their claim does (`dropRemoteProject`). This Mac's own writes (add, remove,
 * relink, the persisted rail order) never name one: they are this Mac's
 * database's, and a remote id would mean nothing there.
 */
import {
  errorMessage,
  type Project,
  type ProjectRelinkAftermath,
  type ProjectRelinkRefusal,
} from "@volli/shared";
import type {
  AppStateSetResult,
  ProjectCreateResult,
  ProjectFolderResult,
  ProjectMutationResult,
  ProjectRelinkResult,
  ProjectUpdateResult,
} from "../../../ipc/contract";
import { create } from "zustand";

import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";
import {
  killProjectSessions,
  killProjectTicketSessions,
} from "@renderer/terminal/session-lifecycle";

import { useBoardStore } from "./board";
import { isRemoteProject, useHostConnectionStore } from "./host-connection";
import { writeThrough } from "./mutate";
import { setProjectRowSink, useThemeStore } from "./theme";
import { useWorkspaceStore } from "./workspace";
import { boardApi } from "@renderer/lib/board-protocol";

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
    /** `undefined` leaves it untouched; the per-project skills index consent otherwise. */
    skillsAutoDisclosure?: boolean;
  }): Promise<ProjectUpdateResult>;
  remove(id: string): Promise<ProjectMutationResult>;
  /** Points an existing project at the folder it moved to (VC-430). */
  relink(input: { id: string; path: string }): Promise<ProjectRelinkResult>;
  /**
   * Whether one project's registered folder is still on disk (VC-430).
   *
   * Behind the gateway rather than reached for directly, like every other
   * main-process read this store owns: the add flow has to ask it before it may
   * create anything, and a seam is what lets that rule be stated in a test.
   */
  checkFolder(projectId: string): Promise<ProjectFolderResult>;
  reorder(orderedIds: string[]): Promise<ProjectMutationResult>;
  /** Fire-and-forget persistence of the current selection under {@link PROJECTS_UI_APP_STATE_KEY}. */
  setSelection(selectedProjectId: string | null): Promise<AppStateSetResult>;
}

/**
 * Told which project the app is now looking at (`null` = no project / global
 * scope). The per-project theme override (#69) is keyed on exactly this, and
 * the theme store cannot poll for it — so the ONE place the selection changes
 * announces it, and every UI entry point (rail click, ⌘1–9, project added,
 * project removed, boot restoring the persisted choice) is covered by
 * construction rather than by remembering to call something.
 */
export type SelectedProjectListener = (projectId: string | null) => void;

const defaultSelectedProjectListener: SelectedProjectListener = (projectId) => {
  if (projectId === null) {
    void useThemeStore.getState().hydrate();
    return;
  }
  // The workspace's own canvas and appearance are columns on the row this store
  // already holds (migration 014), so they are handed OVER rather than fetched.
  // The theme store must not keep a second copy of the projects list to look
  // them up in, and a project that has just been removed has no row to read —
  // hence the null-safe fallback to inheriting.
  const project = useProjectsStore.getState().projects.find(({ id }) => id === projectId);
  void useThemeStore.getState().hydrate({
    projectId,
    canvas: project?.themeCanvas ?? null,
    appearance: project?.themeAppearance ?? null,
  });
};

const defaultGateway: ProjectsGateway = {
  create: (input) => window.api.projects.create(input),
  update: (input) => boardApi().projects.update(input),
  remove: (id) => window.api.projects.remove(id),
  relink: (input) => window.api.projects.relink(input),
  checkFolder: (projectId) => boardApi().projects.checkFolder(projectId),
  // `project.reorder`, the desktop-only tier's write that replaced
  // `volli:project-reorder` (VC-608).
  reorder: async (orderedIds) => {
    await sessionRpcClient().project.reorder.mutate({ orderedIds });
    return { ok: true };
  },
  setSelection: (selectedProjectId) =>
    window.api.appState.set(PROJECTS_UI_APP_STATE_KEY, encodeProjectsUiState(selectedProjectId)),
};

interface ProjectsState {
  projects: Project[];
  selectedProjectId: string | null;
  /** Seeds state from the boot payload — the ONE place state is set wholesale outside a mutation. */
  hydrate(projects: Project[], selectedProjectId: string | null): void;
  /**
   * Replaces one row with an authoritative copy written elsewhere.
   *
   * The theme store owns the workspace canvas/appearance writes because it owns
   * painting, but the row those columns live on is this store's — and this
   * store's copy is the only one. Every scope handed to the theme store is
   * rebuilt from it, so a row that never learns about its own write reverts the
   * workspace to the global canvas on the next selection change.
   *
   * Ignores a row for a project that is no longer here: a workspace removed
   * while its write was in flight must not come back.
   */
  adoptProject(project: Project): void;
  /**
   * A remote project's claim went (its host was forgotten, or it was closed
   * there): its row goes, and the selection falls to a neighbour. Nothing is
   * written: the project was never this Mac's.
   */
  dropRemoteProject(id: string): void;
  /**
   * Adds the chosen folder as a project — UNLESS it might be a project Volli
   * already has.
   *
   * A project whose folder was renamed still has a row, pointing at a path
   * that no longer resolves. Adding the folder it moved to is the thing a
   * person reaches for, and it is exactly the duplicate VC-430 exists to
   * prevent: a second project id, with none of the first one's tickets,
   * settings or history. Nothing on disk can prove that this folder IS that
   * project — the old path is gone, so there is no identity left to compare —
   * so the store does not guess. It stops, records the question in
   * {@link ProjectsState.folderClaim}, and lets a person answer it.
   *
   * Resolves `true` when a project was added or selected, `false` when the
   * question is now waiting to be answered.
   */
  addProject(input: { path: string; defaultName: string }): Promise<boolean>;
  /**
   * The pending "is this folder one of these projects?" question, or `null`.
   *
   * Held in the store rather than in whichever component happened to open the
   * picker, because both entry points (the rail's `+` tile and the empty
   * sidebar) raise the same question and one surface answers it.
   */
  folderClaim: ProjectFolderClaim | null;
  /** Adds the claimed folder as a NEW project after all, and clears the question. */
  resolveClaimAsNewProject(): Promise<void>;
  /** Relinks `projectId` to the claimed folder, and clears the question. */
  resolveClaimAsRelink(projectId: string): Promise<ProjectRelinkSettlement>;
  /** Drops the question unanswered; nothing is added and nothing is relinked. */
  dismissFolderClaim(): void;
  /**
   * Whether one project's registered folder is still on disk (VC-430).
   *
   * On the store rather than reached for through `window.api`, so the board's
   * recovery banner and the add flow's claim question ask one question through
   * one seam — and so a test can answer it.
   */
  checkFolder(projectId: string): Promise<ProjectFolderResult>;
  updateBaseBranch(id: string, baseBranch: string | null): Promise<boolean>;
  /** Settings → Worktrees' setup-command field; leaves `baseBranch` untouched (re-sends the current pinned value). */
  updateSetupCommand(id: string, setupCommand: string | null): Promise<boolean>;
  /**
   * Points a project at the folder it moved to (VC-430), resolving with what
   * the move left behind — or `null` when it was refused, which
   * `writeThrough` has already surfaced.
   *
   * The row is REPLACED in place, never removed and re-added: the id, the
   * rail position and the selection all survive, because a relink is the same
   * project in a new location and anything else would be the duplicate this
   * exists to avoid.
   */
  relink(id: string, path: string): Promise<ProjectRelinkSettlement>;
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

/**
 * A chosen folder, and the projects it might be the new home of (VC-430).
 *
 * `candidates` are the tracked projects whose own registered folder is not
 * there any more. They are the only projects a moved folder could belong to,
 * and the list is what turns a silent duplicate into a question.
 */
export interface ProjectFolderClaim {
  path: string;
  defaultName: string;
  candidates: readonly Project[];
}

/**
 * How a relink ended: what the move left behind, or which rule refused it.
 *
 * The REFUSAL id travels, not just its sentence, so a surface can behave
 * differently for a different refusal without matching on prose — the dialog
 * closes on `unchanged` (there is nothing left to do) and stays open on
 * `claimed` (there is another folder to choose).
 */
export type ProjectRelinkSettlement =
  | { ok: true; aftermath: ProjectRelinkAftermath }
  | { ok: false; refusal: ProjectRelinkRefusal | null };

/** Whether a remote host serves the project: the host-connection store's claim. */
export type RemoteProjectTest = (projectId: string) => boolean;

const defaultIsRemote: RemoteProjectTest = (projectId) =>
  isRemoteProject(useHostConnectionStore.getState(), projectId);

/** What a remote project's local-only write says instead of reaching this Mac's database. */
export const REMOTE_PROJECT_LOCAL_ONLY = "That isn’t available for a project on a remote host yet.";

/** Factory so tests can inject a fake gateway (and scope listener) instead of the real seams. */
export function createProjectsStore(
  gateway: ProjectsGateway = defaultGateway,
  onSelectedProjectChange: SelectedProjectListener = defaultSelectedProjectListener,
  isRemote: RemoteProjectTest = defaultIsRemote,
) {
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
  // Every stored link is `started.catch(...)` — already recovered — so chaining
  // `.then(run)` off it directly can never skip `run` on a predecessor failure.
  const pendingProjectUpdates = new Map<string, Promise<unknown>>();
  function queueProjectUpdate<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = pendingProjectUpdates.get(id) ?? Promise.resolve();
    const started = previous.then(run);
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
        if (!result.ok) toastError(`Couldn't save selected project: ${result.error}`);
      })
      .catch((error: unknown) => {
        toastError(`Couldn't save selected project: ${errorMessage(error)}`);
      });
  }

  /**
   * Announces a selection change to {@link SelectedProjectListener} — and only
   * a real CHANGE: re-selecting the project already showing would otherwise
   * cost a redundant theme round-trip on every rail click, and boot hydrating
   * `null` over `null` would race main.tsx's own global-scope read.
   */
  function announceSelection(previous: string | null, next: string | null): void {
    if (next !== previous) onSelectedProjectChange(next);
  }

  return create<ProjectsState>()((set, get) => {
    /**
     * Creates the project at `path` and selects it.
     *
     * Shared by the ordinary add and by the answer "no, this really is a new
     * project": one body, so a project born through the claim question is built
     * exactly like any other.
     */
    async function createAndSelect(path: string, defaultName: string): Promise<boolean> {
      const result = await writeThrough("add project", (): Promise<ProjectCreateResult> =>
        gateway.create({ path, name: defaultName }),
      );
      if (!result) return false;

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
      const { projects, selectedProjectId } = get();
      const exists = projects.some((project) => project.id === result.project.id);
      set({
        projects: exists ? projects : [...projects, result.project],
        selectedProjectId: result.project.id,
      });
      persistSelection(result.project.id);
      announceSelection(selectedProjectId, result.project.id);
      return true;
    }

    /**
     * The tracked projects whose own registered folder is no longer on disk.
     *
     * A check that FAILS counts as present: "we could not look" is not evidence
     * that a folder moved, and putting a project on this list would ask a person
     * to answer a question about a project that is probably fine.
     */
    async function projectsWithMissingFolders(): Promise<readonly Project[]> {
      const projects = get().projects;
      const states = await Promise.all(
        projects.map((project) =>
          gateway
            .checkFolder(project.id)
            .then((result) => (result.ok ? result.state : "present"))
            .catch(() => "present" as const),
        ),
      );
      return projects.filter((_, index) => states[index] === "missing");
    }

    return {
      projects: [],
      selectedProjectId: null,
      folderClaim: null,

      hydrate(projects, selectedProjectId) {
        const previous = get().selectedProjectId;
        // The local bootstrap knows nothing of remote rows: keep each one still
        // claimed, after this Mac's own.
        const local = new Set(projects.map(({ id }) => id));
        const remote = get().projects.filter(({ id }) => !local.has(id) && isRemote(id));
        const merged = remote.length === 0 ? projects : [...projects, ...remote];
        // A remote project selected before stays selected: the bootstrap's
        // fallback only stands in for a selection this Mac's list lost.
        const selected =
          previous !== null && remote.some(({ id }) => id === previous)
            ? previous
            : selectedProjectId;
        set({ projects: merged, selectedProjectId: selected });
        announceSelection(previous, selected);
      },

      adoptProject(project) {
        const projects = get().projects;
        if (!projects.some(({ id }) => id === project.id)) {
          // A remote Workspace's first snapshot: its row joins the rail. Any
          // other unknown row is a project removed while its write was in flight.
          if (isRemote(project.id)) set({ projects: [...projects, project] });
          return;
        }
        set({ projects: projects.map((row) => (row.id === project.id ? project : row)) });
      },

      dropRemoteProject(id) {
        const { projects, selectedProjectId } = get();
        const removedIndex = projects.findIndex((project) => project.id === id);
        if (removedIndex === -1) return;
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
        persistSelection(nextSelectedId);
        announceSelection(selectedProjectId, nextSelectedId);
      },

      async addProject({ path, defaultName }) {
        // A folder this renderer already tracks is not a claim question at all:
        // main answers the create with the existing project, which is the
        // established "you already have this one" path.
        const known = get().projects.some((project) => project.path === path);
        const candidates = known ? [] : await projectsWithMissingFolders();
        if (candidates.length > 0) {
          set({ folderClaim: { path, defaultName, candidates } });
          return false;
        }
        return createAndSelect(path, defaultName);
      },

      async resolveClaimAsNewProject() {
        const claim = get().folderClaim;
        if (claim === null) return;
        set({ folderClaim: null });
        await createAndSelect(claim.path, claim.defaultName);
      },

      async resolveClaimAsRelink(projectId) {
        const claim = get().folderClaim;
        if (claim === null) return { ok: false, refusal: null };
        set({ folderClaim: null });
        const settlement = await get().relink(projectId, claim.path);
        if (settlement.ok) get().select(projectId);
        return settlement;
      },

      dismissFolderClaim() {
        set({ folderClaim: null });
      },

      checkFolder(projectId) {
        return gateway.checkFolder(projectId);
      },

      async relink(id, path) {
        if (isRemote(id)) {
          toastError(`Couldn't relink project: ${REMOTE_PROJECT_LOCAL_ONLY}`);
          return { ok: false, refusal: null };
        }
        // The refusal id is read on the way THROUGH `writeThrough` rather than
        // from its answer: that helper's job is the toast, and it collapses every
        // failure to `null` on purpose. Catching the id here keeps the shared
        // shape intact and still lets the dialog behave differently for a folder
        // somebody else tracks than for one this project already points at.
        let refusal: ProjectRelinkRefusal | null = null;
        const result = await writeThrough(
          "relink project",
          async (): Promise<ProjectRelinkResult> => {
            const answer = await gateway.relink({ id, path });
            if (!answer.ok) refusal = answer.refusal ?? null;
            return answer;
          },
        );
        if (!result) return { ok: false, refusal };
        // Re-read FRESH after the await (writeThrough's contract): a project
        // removed while the relink was in flight must not be resurrected by its
        // own answer.
        set({
          projects: get().projects.map((project) =>
            project.id === result.project.id ? result.project : project,
          ),
        });
        return { ok: true, aftermath: result.aftermath };
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
        if (isRemote(id)) {
          toastError(`Couldn't remove project: ${REMOTE_PROJECT_LOCAL_ONLY}`);
          return;
        }

        const result = await writeThrough("remove project", (): Promise<ProjectMutationResult> =>
          gateway.remove(id),
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
        // `board.forget` owns chat teardown as well as its owner-key bookkeeping,
        // so a local removal and an authoritative board hydration that loses the
        // same project share one disposal path.
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
        announceSelection(selectedProjectId, nextSelectedId);
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

        // This Mac's database orders its own projects; a remote row's place
        // in the rail is this window's.
        const result = await writeThrough(
          "save project order",
          (): Promise<ProjectMutationResult> =>
            gateway.reorder(projects.filter(({ id }) => !isRemote(id)).map(({ id }) => id)),
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
        const { projects, selectedProjectId } = get();
        if (!projects.some((project) => project.id === id)) return;
        set({ selectedProjectId: id });
        persistSelection(id);
        announceSelection(selectedProjectId, id);
      },

      selectByIndex(index) {
        const project = get().projects[index];
        if (project) get().select(project.id);
      },
    };
  });
}

/** App-wide singleton; components import this directly. */
export const useProjectsStore = createProjectsStore();

/**
 * Close the loop on workspace theme writes.
 *
 * Registered from this side because the import between these two stores runs
 * one way — this module already imports the theme store to hand it a scope, so
 * the theme store must not import back. It writes the row and announces it; the
 * row lives here.
 */
setProjectRowSink((project) => useProjectsStore.getState().adoptProject(project));
