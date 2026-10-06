/**
 * The host-connection sources this ticket ships (VC-576): This Mac, and a fake
 * for tests and the lab. VC-700's registry adds the remote one.
 */
import {
  THIS_MAC_HOST,
  THIS_MAC_HOST_ID,
  type HostConnectionSource,
  type HostId,
  type HostRecord,
  type HostSourceSnapshot,
} from "./host-connection";
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

  /** A new snapshot only when the project list itself changed. */
  function read(): boolean {
    const next = projects.getState().projects.map((project) => project.id);
    if (next.length === ids.length && next.every((id, index) => id === ids[index])) return false;
    ids = next;
    snapshot = {
      hosts: [THIS_MAC_HOST],
      projects: Object.fromEntries(next.map((id) => [id, THIS_MAC_HOST_ID])),
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
  /** Changes one host's record in place. */
  setHost(hostId: HostId, patch: Partial<Omit<HostRecord, "id">>): void;
}

/**
 * A scripted source: it holds whatever it is given and records what is asked
 * of it. A test or a lab scratch moves it through states with `setHost`, and
 * reacts to actions through `onCall` (the lab's offline countdown does).
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
      if (host !== undefined) hosts[index] = { ...host, ...patch };
      snapshot = { ...snapshot, hosts };
      emit();
    },
    retry: (hostId) => record({ kind: "retry", hostId }),
    updateHost: (hostId, when) => record({ kind: "updateHost", hostId, when }),
    cancelScheduledUpdate: (hostId) => record({ kind: "cancelScheduledUpdate", hostId }),
    signIn: (hostId, providerId) => record({ kind: "signIn", hostId, providerId }),
  };
  return source;
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
    link: { status: "open" },
    liveSessions: null,
    update: null,
    expiredSignIns: [],
    ...overrides,
  };
}
