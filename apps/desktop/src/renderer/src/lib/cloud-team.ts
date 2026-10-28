/** One window's member directory and Session ownership. Bound only in cloud launches.
 * Last live answers survive a socket outage, never a Workspace/client change.
 */
import { create } from "zustand";
import { cloudSession, followCloudSession, type CloudSession } from "./cloud-client";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
import { useCloudLinkInputs } from "@renderer/stores/cloud-link";
import { cloudFailure, CLOUD_READ_ONLY } from "@renderer/stores/cloud-board/source";
import type { Watched } from "@renderer/stores/cloud-board/source";
import {
  personLabel,
  teamSessionModel,
  type Directory,
  type TeamSession,
} from "./cloud-team-model";

interface TeamState extends Directory {
  readonly shareAll: boolean;
  readonly byProject: Readonly<Record<string, Readonly<Record<string, TeamSession>>>>;
  readonly sessions: Readonly<Record<string, TeamSession>>;
}
const EMPTY: TeamState = {
  viewerUserId: null,
  people: [],
  shareAll: false,
  byProject: {},
  sessions: {},
};
export const useCloudTeamStore = create<TeamState>(() => EMPTY);

export function noteProjectTeam(
  projectId: string,
  rows: readonly (TeamSession & { id: string })[],
): void {
  useCloudTeamStore.setState((state) => {
    const byProject = {
      ...state.byProject,
      [projectId]: Object.fromEntries(
        rows.map((row) => [
          row.id,
          {
            ownerUserId: row.ownerUserId,
            visibility: row.visibility,
            role: row.role,
            turnActive: row.turnActive,
          },
        ]),
      ),
    };
    return {
      byProject,
      sessions: Object.assign({}, ...Object.values(byProject)) as Record<string, TeamSession>,
    };
  });
}

export function useSessionTeam(sessionId: string | null) {
  const state = useCloudTeamStore();
  return teamSessionModel(
    state,
    sessionId === null ? null : (state.sessions[sessionId] ?? null),
    state.shareAll,
  );
}

export function usePersonLabel(userId: string | undefined): string | null {
  const state = useCloudTeamStore();
  return userId === undefined ? null : personLabel(state, userId);
}

/** Workspace and client changes synchronously drop old attribution and permissions. */
export function bindCloudTeam(follow = followCloudSession): () => void {
  let current: CloudSession | null = null;
  let scope: string | null = null;
  let stops: (() => void)[] = [];
  const clear = () => {
    for (const stop of stops.splice(0)) stop();
    useCloudTeamStore.setState(EMPTY);
  };
  const sync = () => {
    const id = useCloudWorkspaceStore.getState().workspace?.id ?? null;
    if (scope === id) return;
    scope = id;
    clear();
    if (current === null || id === null) return;
    const read = <T>(watch: Watched<T>, paint: (value: T) => void) => {
      let active = true;
      const update = () => {
        if (!active) return;
        try {
          const value = watch.localQueryResult();
          if (value !== undefined) paint(value);
        } catch (error) {
          // An authorization failure must not retain stale ownership/name facts.
          useCloudTeamStore.setState({ viewerUserId: null, people: [], shareAll: false });
          console.warn("[volli] member directory:", cloudFailure(error).message);
        }
      };
      const stop = watch.onUpdate(update);
      stops.push(() => {
        active = false;
        stop();
      });
      update();
    };
    read(current.client.watchQuery(current.api.members.people, { workspaceId: id }), (value) =>
      useCloudTeamStore.setState(value),
    );
    read(current.client.watchQuery(current.api.workspaces.policy, { workspaceId: id }), (value) =>
      useCloudTeamStore.setState({ shareAll: value.shareAll }),
    );
  };
  const stopWorkspace = useCloudWorkspaceStore.subscribe(sync);
  const stopFollow = follow((session) => {
    current = session;
    scope = null;
    clear();
    sync();
  });
  return () => {
    stopWorkspace();
    stopFollow();
    clear();
  };
}

/** Explicit one-way share. The backend rechecks ownership and cascades descendants. */
export async function shareWithWorkspace(sessionId: string): Promise<void> {
  const session = cloudSession();
  const input = useCloudLinkInputs.getState().input;
  if (
    session === null ||
    !session.client.connectionState().isWebSocketConnected ||
    !input.online ||
    input.snapshotAt !== null
  )
    throw new Error(CLOUD_READ_ONLY);
  try {
    await session.client.mutation(session.api.sessionVisibility.share, { sessionId });
  } catch (error) {
    throw new Error(cloudFailure(error).message, { cause: error });
  }
}
