/**
 * The current Volli Cloud Workspace and its projects (VC-889): in a cloud
 * launch, the only source of the projects the rail lists.
 *
 * - **Which Workspace.** The one the person last looked at in a cloud launch,
 *   if they are still a Member of it; otherwise the first of
 *   `workspaces.listMine` (their personal Workspace leads).
 * - **Its projects.** A live `projects.list` watch hydrates the projects
 *   store, seeds a board for each project that arrives (which opens its
 *   roster) and forgets the board of each that leaves, saying so once.
 * - **The selection.** The persisted cloud selection waits for the first
 *   answer, then falls back to the first project; later answers keep the
 *   selection while its project stays.
 * - **The end.** When the client closes (the sign-in ended), every board and
 *   project goes: there is no half-cloud board.
 */
import type { Project } from "@volli/shared";
import { create } from "zustand";

import type { CloudSession } from "@renderer/lib/cloud-client";

import type { CloudSelection } from "../projects";
import { cloudFailure } from "./source";
import { projectRows, type CloudProjectRow } from "./projection";

/** What the rail's head and foot read in a cloud launch. */
export interface CloudWorkspaceState {
  /** The Workspace on screen, once known. */
  readonly workspace: { readonly id: string; readonly name: string } | null;
  /** How many projects this Mac's own store holds (the footer's count). */
  readonly localProjects: number;
}

export const useCloudWorkspaceStore = create<CloudWorkspaceState>()(() => ({
  workspace: null,
  localProjects: 0,
}));

/** A `workspaces.listMine` row: the fields the follower reads. */
interface WorkspaceRow {
  readonly workspaceId: string;
  readonly name: string;
}

interface Watched<T> {
  onUpdate(callback: () => void): () => void;
  localQueryResult(): T | undefined;
}

/** Everything the follower reaches. */
export interface CloudWorkspaceDeps {
  follow(listener: (session: CloudSession | null) => void): () => void;
  projects: {
    getState(): {
      readonly projects: readonly Project[];
      readonly selectedProjectId: string | null;
      hydrateCloud(workspaceId: string, projects: Project[], selectedProjectId: string | null): void;
    };
  };
  board: { seedProject(projectId: string): void; forget(projectId: string): void };
  workspace: { setState(state: Partial<CloudWorkspaceState>): void };
  /** The selection the last cloud launch left, or `null`. */
  persisted: CloudSelection | null;
  failed(message: string): void;
  notice(message: string): void;
}

/** The selection after an answer: the current one while it stays, else the persisted one, else the first. */
function resolveSelection(
  projects: readonly Project[],
  current: string | null,
  wanted: string | null,
): string | null {
  const has = (id: string | null) => id !== null && projects.some((project) => project.id === id);
  if (has(current)) return current;
  if (has(wanted)) return wanted;
  return projects[0]?.id ?? null;
}

/**
 * Follows the current Workspace and its projects for as long as the client
 * runs; the returned function stops following.
 */
export function followCloudWorkspace(deps: CloudWorkspaceDeps): () => void {
  let stops: (() => void)[] = [];
  let workspaceId: string | null = null;
  let answered = false;
  let failing = false;

  const stopAll = () => {
    for (const stop of stops.splice(0)) stop();
  };

  function clear(): void {
    stopAll();
    const { projects } = deps.projects.getState();
    for (const project of projects) deps.board.forget(project.id);
    if (workspaceId !== null) deps.projects.getState().hydrateCloud(workspaceId, [], null);
    workspaceId = null;
    answered = false;
  }

  function fail(what: string, error: unknown): void {
    if (failing) return;
    failing = true;
    deps.failed(`Couldn’t read ${what}: ${cloudFailure(error).message}`);
  }

  function readProjects(id: string, watch: Watched<CloudProjectRow[]>): void {
    let rows: CloudProjectRow[] | undefined;
    try {
      rows = watch.localQueryResult();
    } catch (error) {
      fail("the Workspace’s projects", error);
      return;
    }
    if (rows === undefined || id !== workspaceId) return;
    failing = false;
    const next = projectRows(rows);
    const state = deps.projects.getState();
    const nextIds = new Set(next.map((project) => project.id));
    for (const project of state.projects) {
      if (nextIds.has(project.id)) continue;
      deps.board.forget(project.id);
      deps.notice(`${project.name} isn’t available any more`);
    }
    for (const project of next) deps.board.seedProject(project.id);
    const wanted = !answered && deps.persisted?.workspaceId === id ? deps.persisted.projectId : null;
    answered = true;
    state.hydrateCloud(id, next, resolveSelection(next, state.selectedProjectId, wanted));
  }

  function openWorkspace(session: CloudSession, row: WorkspaceRow): void {
    deps.workspace.setState({ workspace: { id: row.workspaceId, name: row.name } });
    if (row.workspaceId === workspaceId) return;
    // Another Workspace (the last one left): its projects replace these.
    for (const stop of stops.splice(1)) stop();
    for (const project of deps.projects.getState().projects) deps.board.forget(project.id);
    workspaceId = row.workspaceId;
    answered = false;
    const watch = session.client.watchQuery(session.api.projects.list, {
      workspaceId: row.workspaceId,
    }) as Watched<CloudProjectRow[]>;
    const id = row.workspaceId;
    stops.push(watch.onUpdate(() => readProjects(id, watch)));
    readProjects(id, watch);
  }

  function readWorkspaces(session: CloudSession, watch: Watched<WorkspaceRow[]>): void {
    let rows: WorkspaceRow[] | undefined;
    try {
      rows = watch.localQueryResult();
    } catch (error) {
      fail("your Workspaces", error);
      return;
    }
    if (rows === undefined) return;
    failing = false;
    const wanted = workspaceId ?? deps.persisted?.workspaceId ?? null;
    const row = rows.find((candidate) => candidate.workspaceId === wanted) ?? rows[0];
    if (row !== undefined) openWorkspace(session, row);
  }

  const stopFollowing = deps.follow((session) => {
    clear();
    if (session === null) return;
    const watch = session.client.watchQuery(session.api.workspaces.listMine, {}) as Watched<
      WorkspaceRow[]
    >;
    stops = [watch.onUpdate(() => readWorkspaces(session, watch))];
    readWorkspaces(session, watch);
  });

  return () => {
    stopFollowing();
    stopAll();
  };
}
