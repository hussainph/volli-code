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
 * - **Offline at launch (D3).** When no live list has answered within
 *   `offline.afterMs`, the last-seen board on disk is shown read-only
 *   (`snapshot.ts`); the first live answer replaces it, with no relaunch and
 *   no "isn't available" lines for what the snapshot held.
 * - **The end.** When the client closes (the sign-in ended), every board and
 *   project goes: there is no half-cloud board.
 */
import type { Label, Project, Ticket } from "@volli/shared";
import { newId } from "@volli/shared/cloud";
import { create } from "zustand";

import type { CloudSession } from "@renderer/lib/cloud-client";

import type { CloudSelection } from "../projects";
import { CLOUD_READ_ONLY, cloudFailure, type Watched } from "./source";
import type { BoardSnapshot } from "./snapshot";
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

/** Everything the follower reaches. */
export interface CloudWorkspaceDeps {
  follow(listener: (session: CloudSession | null) => void): () => void;
  projects: {
    getState(): {
      readonly projects: readonly Project[];
      readonly selectedProjectId: string | null;
      hydrateCloud(
        workspaceId: string,
        projects: Project[],
        selectedProjectId: string | null,
      ): void;
      clearCloud(): void;
      showCloudSnapshot(projects: Project[], selectedProjectId: string | null): void;
    };
  };
  board: {
    seedProject(projectId: string): void;
    forget(projectId: string): void;
    paintBoard(
      projectId: string,
      tickets: Ticket[],
      labels: Label[],
      unloadedBodies: ReadonlySet<string>,
    ): void;
  };
  workspace: { setState(state: Partial<CloudWorkspaceState>): void };
  /** The selection the last cloud launch left, or `null`. */
  persisted: CloudSelection | null;
  failed(message: string): void;
  notice(message: string): void;
  /** The last-seen board, for a launch no live list answers in time (D3). */
  offline?: {
    readonly afterMs: number;
    snapshot(): Promise<BoardSnapshot | null>;
    /** The snapshot on screen since (its `savedAt`), or the live board again (`null`). */
    shown(savedAt: number | null): void;
    setTimeout(run: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
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
  // The offline snapshot (D3): whether a live list has answered yet, and the
  // Workspace the snapshot on screen shows (null: none on screen).
  let liveAnswered = false;
  let snapshotWorkspace: string | null = null;
  let current: CloudSession | null = null;

  const stopAll = () => {
    for (const stop of stops.splice(0)) stop();
  };

  function forgetAll(): void {
    for (const project of deps.projects.getState().projects) deps.board.forget(project.id);
  }

  function dropSnapshot(): void {
    if (snapshotWorkspace === null) return;
    snapshotWorkspace = null;
    deps.offline!.shown(null);
  }

  /** A new client keeps the offline snapshot on screen; a closed one takes everything. */
  function clear(closed: boolean): void {
    stopAll();
    if (snapshotWorkspace === null || closed) {
      forgetAll();
      // Never persisted: the next cloud launch returns to the selection it had.
      if (workspaceId !== null || snapshotWorkspace !== null) deps.projects.getState().clearCloud();
      dropSnapshot();
    }
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
    liveAnswered = true;
    // The live board replaces the snapshot's, unannounced: each board is
    // dropped so its source follows it afresh.
    const fromSnapshot = snapshotWorkspace !== null;
    if (fromSnapshot) {
      forgetAll();
      dropSnapshot();
    }
    const next = projectRows(rows);
    const state = deps.projects.getState();
    const nextIds = new Set(next.map((project) => project.id));
    for (const project of state.projects) {
      if (nextIds.has(project.id)) continue;
      deps.board.forget(project.id);
      if (!fromSnapshot) deps.notice(`${project.name} isn’t available any more`);
    }
    for (const project of next) deps.board.seedProject(project.id);
    const wanted =
      !answered && deps.persisted?.workspaceId === id ? deps.persisted.projectId : null;
    answered = true;
    state.hydrateCloud(id, next, resolveSelection(next, state.selectedProjectId, wanted));
  }

  function openWorkspace(session: CloudSession, row: WorkspaceRow): void {
    deps.workspace.setState({ workspace: { id: row.workspaceId, name: row.name } });
    if (row.workspaceId === workspaceId) return;
    // Another Workspace (the last one left): its projects replace these. The
    // offline snapshot stays on screen until a live list answers.
    for (const stop of stops.splice(1)) stop();
    if (snapshotWorkspace === null) forgetAll();
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

  /** Puts the last-seen board on screen, read-only, if no live list has answered meanwhile. */
  async function showSnapshot(): Promise<void> {
    const offline = deps.offline!;
    const snapshot = await offline.snapshot();
    if (snapshot === null || liveAnswered || current === null) return;
    deps.workspace.setState({ workspace: snapshot.workspace });
    const projects = [...snapshot.projects];
    const wanted =
      deps.persisted?.workspaceId === snapshot.workspace.id ? deps.persisted.projectId : null;
    for (const project of projects) {
      const board = snapshot.boards[project.id] ?? { tickets: [], labels: [] };
      deps.board.paintBoard(
        project.id,
        [...board.tickets],
        [...board.labels],
        // No body was kept: each is read when its ticket opens.
        new Set(board.tickets.map((ticket) => ticket.id)),
      );
    }
    deps.projects.getState().showCloudSnapshot(projects, resolveSelection(projects, null, wanted));
    snapshotWorkspace = snapshot.workspace.id;
    offline.shown(snapshot.savedAt);
  }

  const offlineTimer =
    deps.offline === undefined
      ? null
      : deps.offline.setTimeout(() => void showSnapshot(), deps.offline.afterMs);

  const stopFollowing = deps.follow((session) => {
    current = session;
    clear(session === null);
    if (session === null) return;
    const watch = session.client.watchQuery(session.api.workspaces.listMine, {}) as Watched<
      WorkspaceRow[]
    >;
    stops = [watch.onUpdate(() => readWorkspaces(session, watch))];
    readWorkspaces(session, watch);
  });

  return () => {
    current = null;
    if (offlineTimer !== null) deps.offline!.clearTimeout(offlineTimer);
    stopFollowing();
    stopAll();
  };
}

/**
 * A new project in the Workspace on screen (VC-889, D4: a `blank` project,
 * before it has a repository): the client mints its id, and the rail shows
 * it once `projects.list` answers with it (no optimistic row: a project the
 * backend has not made yet has no board to open). Refused, and never issued,
 * while the socket is down. Answers its id, or the sentence to say.
 */
export async function createCloudProject(
  input: { readonly name: string; readonly ticketPrefix?: string },
  session: CloudSession | null,
  workspaceId: string | null,
): Promise<{ ok: true; projectId: string } | { ok: false; error: string }> {
  if (
    session === null ||
    workspaceId === null ||
    !session.client.connectionState().isWebSocketConnected
  ) {
    return { ok: false, error: CLOUD_READ_ONLY };
  }
  const projectId = newId("project");
  const { client, api } = session;
  try {
    await client.mutation(api.projects.create, {
      commandId: newId("command"),
      workspaceId,
      projectId,
      name: input.name,
      ...(input.ticketPrefix === undefined ? {} : { ticketPrefix: input.ticketPrefix }),
      origin: "blank",
    });
  } catch (error) {
    return { ok: false, error: cloudFailure(error).message };
  }
  return { ok: true, projectId };
}
