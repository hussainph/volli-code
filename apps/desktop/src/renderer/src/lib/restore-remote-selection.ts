/** One boot-owned restore, one deadline. Persisted intent never creates a host claim. */
import type { HostConnectionState } from "../stores/host-connection";
import type { RemoteSelection } from "../stores/projects";

export const REMOTE_SELECTION_RESTORE_MS = 15_000;

type Hosts = Pick<HostConnectionState, "hosts" | "projects">;
interface SelectionState {
  readonly projects: readonly { id: string }[];
  readonly pendingRemoteSelection: RemoteSelection | null;
  settleRemoteRestore(selection: RemoteSelection, restored: boolean): void;
}
interface Readable<T> {
  getState(): T;
  subscribe(listener: () => void): () => void;
}

/** Stops immediately on a pick, success, fallback or owner disposal; late snapshots cannot select. */
export function restoreRemoteSelection({
  selection,
  hosts,
  projects,
  failed,
  deadlineMs = REMOTE_SELECTION_RESTORE_MS,
}: {
  selection: RemoteSelection;
  hosts: Readable<Hosts>;
  projects: Readable<SelectionState>;
  failed(message: string): void;
  deadlineMs?: number;
}): () => void {
  let active = true;
  let sawHost = false;
  let sawClaim = false;
  let name = selection.hostName;
  const stops: (() => void)[] = [];
  const stop = () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    for (const unsubscribe of stops) unsubscribe();
  };
  const fallback = () => {
    if (!active) return;
    stop();
    if (projects.getState().pendingRemoteSelection !== selection) return;
    projects.getState().settleRemoteRestore(selection, false);
    failed(`Couldn't reopen the project on ${name}. Showing This Mac.`);
  };
  const reconcile = () => {
    if (!active) return;
    const state = projects.getState();
    if (state.pendingRemoteSelection !== selection) {
      stop();
      return;
    }
    const snapshot = hosts.getState();
    const host = snapshot.hosts.find(({ id }) => id === selection.hostId);
    const claim = snapshot.projects[selection.projectId];
    if ((sawHost && host === undefined) || (sawClaim && claim?.hostId !== selection.hostId)) {
      fallback();
      return;
    }
    if (host !== undefined) {
      sawHost = true;
      name = host.name;
    }
    if (claim?.hostId === selection.hostId) {
      sawClaim = true;
      // A claim is not a row: the remote board snapshot must arrive too.
      if (state.projects.some(({ id }) => id === selection.projectId)) {
        stop();
        state.settleRemoteRestore(selection, true);
      }
    } else if (host?.link.status === "open" || host?.link.status === "version-skewed") {
      // A reachable registry no longer offers the selected project.
      fallback();
    }
  };
  const timer = setTimeout(fallback, deadlineMs);
  stops.push(hosts.subscribe(reconcile), projects.subscribe(reconcile));
  reconcile();
  return stop;
}
