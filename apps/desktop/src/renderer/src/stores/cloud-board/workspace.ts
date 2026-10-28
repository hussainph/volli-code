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

import { cloudSession, type CloudSession } from "@renderer/lib/cloud-client";
import { NOT_CONNECTED } from "@renderer/lib/cloud-board-api";

import type { CloudSelection } from "../projects";
import { useCloudLinkInputs } from "../cloud-link";
import { CLOUD_READ_ONLY, cloudFailure, type Watched } from "./source";
import type { BoardSnapshot } from "./snapshot";
import { projectRows, type CloudProjectRow } from "./projection";

/** What the rail's head and foot read in a cloud launch. */
export interface CloudWorkspaceState {
  /** The Workspace on screen, once known. */
  readonly workspace: { readonly id: string; readonly name: string } | null;
  /** How many projects this Mac's own store holds (the footer's count). */
  readonly localProjects: number;
  /** True only after projects.list answered for the Workspace on screen. */
  readonly projectsReady: boolean;
}

export const useCloudWorkspaceStore = create<CloudWorkspaceState>()(() => ({
  workspace: null,
  localProjects: 0,
  projectsReady: false,
}));

/** A `workspaces.listMine` row: the fields the follower reads. */
interface WorkspaceRow {
  readonly workspaceId: string;
  readonly name: string;
}

const selections = new Set<(session: CloudSession, row: WorkspaceRow) => void>();
let selectionRequest = 0;

/** Opens an accepted Workspace; hydration persists the selection with its projects. */
export async function selectCloudWorkspace(id: string, session = cloudSession()): Promise<void> {
  if (session === null) throw new Error(NOT_CONNECTED);
  if (
    !session.client.connectionState().isWebSocketConnected ||
    useCloudLinkInputs.getState().input.snapshotAt !== null ||
    !useCloudLinkInputs.getState().input.online
  )
    throw new Error(CLOUD_READ_ONLY);
  const request = ++selectionRequest;
  try {
    // Resolve after acceptance, rather than waiting for listMine's subscription to catch up.
    const row = await session.client.query(session.api.workspaces.get, { workspaceId: id });
    if (request !== selectionRequest) return;
    if (
      !session.client.connectionState().isWebSocketConnected ||
      useCloudLinkInputs.getState().input.snapshotAt !== null ||
      !useCloudLinkInputs.getState().input.online
    )
      throw new Error(CLOUD_READ_ONLY);
    for (const select of selections) select(session, row);
  } catch (error) {
    throw new Error(cloudFailure(error).message, { cause: error });
  }
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
      showCloudSnapshot(
        workspaceId: string,
        projects: Project[],
        selectedProjectId: string | null,
      ): void;
    };
  };
  board: {
    seedProject(projectId: string): void;
    forget(projectId: string, options?: { preserveDrafts: boolean }): void;
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
    /** Follows a board the snapshot painted: its live board paints over it. */
    follow(projectId: string): void;
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
  let projectWatch: Watched<CloudProjectRow[]> | null = null;
  let memberships: readonly WorkspaceRow[] | undefined;
  let pendingMembership: string | null = null;
  let checkingMembership: string | null = null;
  let failing = false;
  // The offline snapshot (D3): whether a live list has answered yet, whether
  // the wait for one ran out, the Workspace the snapshot on screen shows
  // (null: none on screen), and the live Workspace chosen meanwhile.
  let liveAnswered = false;
  let timedOut = false;
  let snapshotWorkspace: string | null = null;
  let snapshotName: string | null = null;
  let liveWorkspace: { id: string; name: string } | null = null;
  let current: CloudSession | null = null;
  let offlineTimer: unknown = null;

  const stopAll = () => {
    projectWatch = null;
    for (const stop of stops.splice(0)) stop();
  };

  function forgetAll(preserveDrafts = false): void {
    for (const project of deps.projects.getState().projects) {
      if (preserveDrafts) deps.board.forget(project.id, { preserveDrafts: true });
      else deps.board.forget(project.id);
    }
    deps.workspace.setState({ projectsReady: false });
  }

  function dropSnapshot(): void {
    if (snapshotWorkspace === null) return;
    snapshotWorkspace = null;
    deps.offline!.shown(null);
  }

  /** A live answer arrived: the wait for one is over. */
  function settle(): void {
    liveAnswered = true;
    if (offlineTimer !== null) {
      deps.offline!.clearTimeout(offlineTimer);
      offlineTimer = null;
    }
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
    if (closed) {
      liveWorkspace = null;
      deps.workspace.setState({ workspace: null });
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
    if (id !== workspaceId || watch !== projectWatch) return;
    let rows: CloudProjectRow[] | undefined;
    try {
      rows = watch.localQueryResult();
    } catch (error) {
      // listMine owns membership loss, including its single Workspace notice.
      if (cloudFailure(error).code !== "not_a_member") fail("the Workspace’s projects", error);
      else if (pendingMembership === id && current !== null) confirmMembership(current, id);
      return;
    }
    if (rows === undefined || id !== workspaceId) return;
    failing = false;
    settle();
    const next = projectRows(rows);
    const state = deps.projects.getState();
    const nextIds = new Set(next.map((project) => project.id));
    // The live board replaces the snapshot's, unannounced: a project it
    // still lists keeps its cards on screen until its live board paints.
    const fromSnapshot = snapshotWorkspace !== null;
    if (fromSnapshot) {
      dropSnapshot();
      // Its own Workspace answered first (`openWorkspace`): name it again.
      deps.workspace.setState({ workspace: liveWorkspace });
      for (const project of state.projects) {
        if (nextIds.has(project.id)) deps.offline!.follow(project.id);
      }
    }
    for (const project of state.projects) {
      if (nextIds.has(project.id)) continue;
      deps.board.forget(project.id);
      // The first answer in a different Workspace replaces the old project list;
      // those projects are not lost. Only a later answer in this Workspace can lose one.
      if (answered && !fromSnapshot) deps.notice(`${project.name} isn’t available any more`);
    }
    for (const project of next) deps.board.seedProject(project.id);
    const wanted =
      !answered && deps.persisted?.workspaceId === id ? deps.persisted.projectId : null;
    answered = true;
    state.hydrateCloud(id, next, resolveSelection(next, state.selectedProjectId, wanted));
    deps.workspace.setState({ projectsReady: true });
  }

  function openWorkspace(session: CloudSession, row: WorkspaceRow, explicit = false): void {
    if (session !== current) return;
    const switching = workspaceId !== null && row.workspaceId !== workspaceId;
    liveWorkspace = { id: row.workspaceId, name: row.name };
    if (row.workspaceId === workspaceId) {
      if (snapshotWorkspace === null) deps.workspace.setState({ workspace: liveWorkspace });
      return;
    }
    // A different Workspace never inherits the snapshot's projects or drafts.
    const otherSnapshot = snapshotWorkspace !== null && snapshotWorkspace !== row.workspaceId;
    for (const stop of stops.splice(1)) stop();
    if (otherSnapshot) {
      forgetAll(true);
      deps.projects.getState().clearCloud();
      dropSnapshot();
    }
    if (snapshotWorkspace === null) {
      forgetAll(true);
      // Clear the old rail, selected ticket and Session views before the new
      // Workspace's first (possibly slow) projects answer; persist the intent.
      if (switching || explicit || otherSnapshot)
        deps.projects.getState().hydrateCloud(row.workspaceId, [], null);
    }
    workspaceId = row.workspaceId;
    if (snapshotWorkspace === null) deps.workspace.setState({ workspace: liveWorkspace });
    answered = false;
    const watch = session.client.watchQuery(session.api.projects.list, {
      workspaceId: row.workspaceId,
    }) as Watched<CloudProjectRow[]>;
    projectWatch = watch;
    const id = row.workspaceId;
    stops.push(watch.onUpdate(() => readProjects(id, watch)));
    readProjects(id, watch);
  }

  function readWorkspaces(session: CloudSession, watch: Watched<WorkspaceRow[]>): void {
    if (session !== current) return;
    let rows: WorkspaceRow[] | undefined;
    try {
      rows = watch.localQueryResult();
    } catch (error) {
      fail("your Workspaces", error);
      return;
    }
    if (rows === undefined) return;
    failing = false;
    memberships = rows;
    if (pendingMembership !== null) {
      if (rows.some((row) => row.workspaceId === pendingMembership)) pendingMembership = null;
      else if (workspaceId === pendingMembership) {
        // An explicit selection was verified by get after invite acceptance;
        // an older listMine answer cannot undo it. Confirm an actual revocation.
        confirmMembership(session, pendingMembership);
        return;
      }
    }
    applyWorkspaces(session, rows);
  }

  function confirmMembership(session: CloudSession, id: string): void {
    if (checkingMembership === id) return;
    checkingMembership = id;
    void session.client
      .query(session.api.workspaces.get, { workspaceId: id })
      .catch((error: unknown) => {
        if (session !== current || workspaceId !== id) return;
        const code = cloudFailure(error).code;
        if (code === "not_a_member" || code === "not_found") {
          pendingMembership = null;
          applyWorkspaces(session, memberships ?? []);
        } else fail("the Workspace", error);
      })
      .finally(() => {
        if (checkingMembership === id) checkingMembership = null;
      });
  }

  function applyWorkspaces(session: CloudSession, rows: readonly WorkspaceRow[]): void {
    const previous = snapshotWorkspace ?? workspaceId;
    if (previous !== null && !rows.some((row) => row.workspaceId === previous)) {
      const name = snapshotWorkspace === null ? liveWorkspace?.name : snapshotName;
      deps.notice(`You're no longer a member of ${name ?? "this Workspace"}`);
      // Never keep a removed Workspace's cached data while the fallback loads.
      forgetAll();
      deps.projects.getState().clearCloud();
      deps.workspace.setState({ workspace: null });
      workspaceId = null;
      liveWorkspace = null;
      answered = false;
      for (const stop of stops.splice(1)) stop();
      dropSnapshot();
      settle();
    }
    const wanted = workspaceId ?? deps.persisted?.workspaceId ?? null;
    const row = rows.find((candidate) => candidate.workspaceId === wanted) ?? rows[0];
    if (row !== undefined) {
      openWorkspace(session, row);
      return;
    }
    // No Workspace at all: clear even a previously live Workspace after Leave.
    settle();
    if (workspaceId !== null || snapshotWorkspace !== null) {
      forgetAll();
      deps.projects.getState().clearCloud();
      deps.workspace.setState({ workspace: null });
      workspaceId = null;
      for (const stop of stops.splice(1)) stop();
      dropSnapshot();
    }
  }

  /** Puts the last-seen board on screen, read-only, if no live list has answered meanwhile. */
  async function showSnapshot(): Promise<void> {
    const offline = deps.offline!;
    if (liveAnswered || current === null) return;
    const snapshot = await offline.snapshot();
    if (snapshot === null || liveAnswered || current === null) return;
    if (workspaceId !== null && workspaceId !== snapshot.workspace.id) return;
    // A delayed disk read must not reintroduce data after listMine revoked it.
    if (
      memberships !== undefined &&
      !memberships.some((row) => row.workspaceId === snapshot.workspace.id)
    )
      return;
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
    deps.projects
      .getState()
      .showCloudSnapshot(snapshot.workspace.id, projects, resolveSelection(projects, null, wanted));
    snapshotWorkspace = snapshot.workspace.id;
    snapshotName = snapshot.workspace.name;
    offline.shown(snapshot.savedAt);
  }

  function trySnapshot(): void {
    showSnapshot().catch((error: unknown) => {
      deps.failed(`Couldn’t show the last-seen board: ${cloudFailure(error).message}`);
    });
  }

  if (deps.offline !== undefined) {
    offlineTimer = deps.offline.setTimeout(() => {
      offlineTimer = null;
      timedOut = true;
      trySnapshot();
    }, deps.offline.afterMs);
  }

  const select = (session: CloudSession, row: WorkspaceRow) => {
    if (session !== current) return;
    pendingMembership = memberships?.some((candidate) => candidate.workspaceId === row.workspaceId)
      ? null
      : row.workspaceId;
    openWorkspace(session, row, true);
  };
  selections.add(select);

  const stopFollowing = deps.follow((session) => {
    current = session;
    memberships = undefined;
    pendingMembership = null;
    checkingMembership = null;
    clear(session === null);
    if (session === null) return;
    // A client that arrived after the wait ran out still shows the snapshot.
    if (timedOut && snapshotWorkspace === null) trySnapshot();
    const watch = session.client.watchQuery(session.api.workspaces.listMine, {}) as Watched<
      WorkspaceRow[]
    >;
    stops = [watch.onUpdate(() => readWorkspaces(session, watch))];
    readWorkspaces(session, watch);
  });

  return () => {
    current = null;
    if (offlineTimer !== null) deps.offline!.clearTimeout(offlineTimer);
    offlineTimer = null;
    selections.delete(select);
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
    !session.client.connectionState().isWebSocketConnected ||
    // The offline snapshot is on screen: nothing is written until the live board is.
    useCloudLinkInputs.getState().input.snapshotAt !== null
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
