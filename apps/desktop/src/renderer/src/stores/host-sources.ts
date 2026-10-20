/**
 * The host-connection sources this ticket ships (VC-576): This Mac, and a fake
 * for tests and the lab. VC-700's registry adds the remote one.
 */
import {
  OPEN_LINK,
  THIS_MAC_HOST,
  THIS_MAC_HOST_ID,
  type HostConnectionSource,
  type HostId,
  type HostLinkView,
  type HostRecord,
  type HostSourceSnapshot,
  type ProjectLink,
  useHostConnectionStore,
  type HostConnectionState,
} from "./host-connection";
import { isExperimentOn, useExperimentsStore, type ExperimentsState } from "./experiments";
import { useProjectsStore } from "./projects";

/** The slice of the projects store This Mac reads: the project list, and its changes. */
export interface ProjectListSource {
  getState(): { readonly projects: readonly { readonly id: string }[] };
  subscribe(listener: () => void): () => void;
}

/**
 * This Mac: the in-process host (Electron main, VC-577). Its link is the
 * process itself, so it is always open while this window is alive, and it
 * serves every project the projects store lists — a project a remote host
 * claims is re-assigned by the store's merge, not here. It has nothing to
 * retry, update or sign in to: those are the app's own, and live elsewhere.
 */
export function createThisMacSource(
  projects: ProjectListSource = useProjectsStore,
): HostConnectionSource {
  let ids: readonly string[] = [];
  let snapshot: HostSourceSnapshot = { hosts: [THIS_MAC_HOST], projects: {} };
  const claim: ProjectLink = Object.freeze({ hostId: THIS_MAC_HOST_ID, link: OPEN_LINK });

  /** A new snapshot only when the project list itself changed. */
  function read(): boolean {
    const next = projects.getState().projects.map((project) => project.id);
    if (next.length === ids.length && next.every((id, index) => id === ids[index])) return false;
    ids = next;
    snapshot = {
      hosts: [THIS_MAC_HOST],
      projects: Object.fromEntries(next.map((id) => [id, claim])),
    };
    return true;
  }
  read();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      return projects.subscribe(() => {
        if (read()) listener();
      });
    },
    retry() {},
    updateHost() {},
    cancelScheduledUpdate() {},
    signIn() {},
  };
}

/** The two stores {@link attachThisMacWhileCloud} reads and writes. */
export interface ThisMacBinding {
  readonly experiments: {
    getState(): Pick<ExperimentsState, "snapshot">;
    subscribe(listener: () => void): () => void;
  };
  readonly hosts: { getState(): Pick<HostConnectionState, "attach"> };
  readonly createSource: () => HostConnectionSource;
}

/**
 * This Mac feeds the host-connection store only while `cloud` is on: with it
 * off nothing is attached, so no project list is mapped and no host-store
 * reader ever wakes (the flag-off app pays nothing). The only standing cost is
 * this one listener on the experiments store, which changes when a flag does.
 * Turning the flag off detaches the source again. The returned function stops
 * the binding and detaches.
 */
export function attachThisMacWhileCloud({
  experiments = useExperimentsStore,
  hosts = useHostConnectionStore,
  createSource = createThisMacSource,
}: Partial<ThisMacBinding> = {}): () => void {
  let detach: (() => void) | null = null;
  const sync = () => {
    const on = isExperimentOn(experiments.getState().snapshot, "cloud");
    if (on && detach === null) {
      detach = hosts.getState().attach(createSource());
    } else if (!on && detach !== null) {
      detach();
      detach = null;
    }
  };
  const unsubscribe = experiments.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    detach?.();
    detach = null;
  };
}

/** One action the fake recorded, in call order. */
export type FakeHostCall =
  | { readonly kind: "retry"; readonly hostId: HostId }
  | { readonly kind: "updateHost"; readonly hostId: HostId; readonly when: "now" | "when-idle" }
  | { readonly kind: "cancelScheduledUpdate"; readonly hostId: HostId }
  | { readonly kind: "signIn"; readonly hostId: HostId; readonly providerId: string };

export interface FakeHostSource extends HostConnectionSource {
  /** Every action asked of it, oldest first. */
  readonly calls: readonly FakeHostCall[];
  /** Replaces the whole snapshot. */
  set(snapshot: HostSourceSnapshot): void;
  /**
   * Changes one host's record in place. A `link` in the patch becomes the link
   * of every project the host serves (a whole box going away), and the record's
   * own fixture link.
   */
  setHost(hostId: HostId, patch: Partial<Omit<HostRecord, "id">>): void;
  /** Changes one project's own link (one Workspace fenced, the rest serving). */
  setProjectLink(projectId: string, link: HostLinkView): void;
}

/**
 * A scripted source: it holds whatever it is given and records what is asked
 * of it. A test or a lab scratch moves it through states with `setHost` and
 * `setProjectLink`, and reacts to actions through `onCall` (the lab's offline
 * countdown does).
 */
export function createFakeHostSource(
  initial: HostSourceSnapshot,
  onCall?: (call: FakeHostCall, source: FakeHostSource) => void,
): FakeHostSource {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const calls: FakeHostCall[] = [];
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const record = (call: FakeHostCall) => {
    calls.push(call);
    onCall?.(call, source);
  };

  const source: FakeHostSource = {
    calls,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      snapshot = next;
      emit();
    },
    setHost(hostId, patch) {
      const hosts = [...snapshot.hosts];
      const index = hosts.findIndex((host) => host.id === hostId);
      const host = hosts[index];
      if (host === undefined) return;
      hosts[index] = { ...host, ...patch };
      const link = patch.link;
      const projects =
        link === undefined
          ? snapshot.projects
          : Object.fromEntries(
              Object.entries(snapshot.projects).map(([projectId, claim]) => [
                projectId,
                claim.hostId === hostId ? { hostId, link } : claim,
              ]),
            );
      snapshot = { hosts, projects };
      emit();
    },
    setProjectLink(projectId, link) {
      const claim = snapshot.projects[projectId];
      if (claim === undefined) return;
      snapshot = {
        ...snapshot,
        projects: { ...snapshot.projects, [projectId]: { hostId: claim.hostId, link } },
      };
      emit();
    },
    retry: (hostId) => record({ kind: "retry", hostId }),
    updateHost: (hostId, when) => record({ kind: "updateHost", hostId, when }),
    cancelScheduledUpdate: (hostId) => record({ kind: "cancelScheduledUpdate", hostId }),
    signIn: (hostId, providerId) => record({ kind: "signIn", hostId, providerId }),
  };
  return source;
}

/**
 * A fixture snapshot from hosts that each carry one link (a fixture's
 * shorthand: every project a host serves starts on its host's link) and a
 * project → host map.
 */
export function hostSnapshot(
  hosts: readonly HostRecord[],
  projects: Readonly<Record<string, HostId>>,
): HostSourceSnapshot {
  const links = new Map(hosts.map((host) => [host.id, host.link]));
  return {
    hosts,
    projects: Object.fromEntries(
      Object.entries(projects).map(([projectId, hostId]) => [
        projectId,
        { hostId, link: links.get(hostId) ?? OPEN_LINK },
      ]),
    ),
  };
}

/** A remote host record with every field filled, for fixtures: override what matters. */
export function remoteHost(
  id: HostId,
  name: string,
  overrides: Partial<Omit<HostRecord, "id" | "name">> = {},
): HostRecord {
  return {
    id,
    name,
    local: false,
    os: "linux",
    version: null,
    link: OPEN_LINK,
    liveSessions: null,
    update: null,
    expiredSignIns: [],
    ...overrides,
  };
}
