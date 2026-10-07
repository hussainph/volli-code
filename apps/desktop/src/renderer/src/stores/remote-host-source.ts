/**
 * The remote half of the host-connection store (VC-700 PR 2): the hosts this
 * Mac added over SSH, as desktop main's registry streams them over the
 * desktop-only tier (`hosts.subscribe`), turned into VC-576's
 * {@link HostConnectionSource}.
 *
 * One link per project. Main sends each remote project's own Workspace
 * connection state (VC-670; the tunnel's until its link exists), and this
 * source feeds each into its own {@link createHostLinkTracker}, which keeps
 * `everReady`/`droppedAt` and says when the wording changes on its own (a
 * drop reads `reconnecting`, then `offline` once its grace ends). One timer,
 * at the soonest such moment, re-words them. A host has no link of its own:
 * the store aggregates it from its projects'.
 *
 * Unchanged records and link views keep their identity across snapshots, so
 * `useSyncExternalStore` readers re-render only for what moved. Actions are
 * the person's intent, sent once (Ruling 1); one that fails says so in a
 * toast.
 */
import type { HostLinkState } from "@volli/host-protocol/client-link";
import type { RemoteHost, RemoteHostLinkState, RemoteHostsSnapshot } from "@volli/shared";
import { toast } from "sonner";

import {
  useHostSignInSheet,
  type HostSignInSheetTarget,
} from "../components/hosts/sign-ins/remote-host-sign-in-source";
import { sessionRpcClient } from "../lib/session-rpc-ipc-link";
import { isExperimentOn, useExperimentsStore } from "./experiments";
import {
  createHostLinkTracker,
  useHostConnectionStore,
  type HostConnectionSource,
  type HostId,
  type HostLinkTracker,
  type HostLinkView,
  type HostSourceRecord,
  type HostSourceSnapshot,
  type ProjectLink,
} from "./host-connection";

/** What the source needs of the desktop tier: one subscription and four actions. */
export interface RemoteHostsClient {
  subscribe(handlers: {
    onData(snapshot: RemoteHostsSnapshot): void;
    onError(error: unknown): void;
  }): () => void;
  retry(hostId: HostId): Promise<unknown>;
  updateHost(hostId: HostId, when: "now" | "when-idle"): Promise<unknown>;
  cancelScheduledUpdate(hostId: HostId): Promise<unknown>;
  signIn(hostId: HostId, providerId: string): Promise<unknown>;
}

export interface RemoteHostSourceOptions {
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => () => void;
  /** Where a failed action is said; a toast by default. */
  readonly onActionError?: (message: string) => void;
  /**
   * After main's preflight for "Sign in" (VC-702): the window opens the
   * host's sign-ins and starts that provider's. The sheet by default.
   */
  readonly onSignIn?: (target: HostSignInSheetTarget) => void;
}

/** The source, and its end: it stops the subscription and any pending re-word. */
export interface RemoteHostSource extends HostConnectionSource {
  close(): void;
}

const EMPTY: HostSourceSnapshot = Object.freeze({ hosts: [], projects: {} });

/**
 * A wire link state as the client host link's own: the tracker reads only
 * the status and, per status, `retryAt` and `error.reason`. A `ready` link's
 * welcome stays in main; nothing here reads it.
 */
function asLinkState(state: RemoteHostLinkState): HostLinkState {
  return state as unknown as HostLinkState;
}

/** One remote host as VC-576's record: no link, which is its projects'. */
export function remoteHostRecord(host: RemoteHost): HostSourceRecord {
  return {
    id: host.id,
    name: host.name,
    local: false,
    os: host.os,
    version: host.version,
    liveSessions: host.liveSessions,
    // Updating a host over SSH, and its sign-ins, come with later tickets.
    update: null,
    expiredSignIns: [],
  };
}

const sameRecord = (a: HostSourceRecord, b: HostSourceRecord): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.os === b.os &&
  a.version === b.version &&
  a.liveSessions === b.liveSessions;

const sameView = (a: HostLinkView, b: HostLinkView): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const defaultTimer = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export function createRemoteHostSource(
  client: RemoteHostsClient,
  options: RemoteHostSourceOptions = {},
): RemoteHostSource {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? defaultTimer;
  const onActionError = options.onActionError ?? ((message: string) => void toast.error(message));
  const onSignIn = options.onSignIn ?? useHostSignInSheet.getState().open;
  const listeners = new Set<() => void>();
  /** One tracker per project, kept while main keeps naming the project. */
  const trackers = new Map<string, HostLinkTracker>();
  let wire: RemoteHostsSnapshot | null = null;
  let snapshot: HostSourceSnapshot = EMPTY;
  let cancelTimer: (() => void) | null = null;
  let closed = false;

  /** Words every project's link now; arms one timer for the soonest change. */
  function publish(): void {
    cancelTimer?.();
    cancelTimer = null;
    if (wire === null) {
      trackers.clear();
      if (snapshot !== EMPTY) {
        snapshot = EMPTY;
        for (const listener of listeners) listener();
      }
      return;
    }
    const at = now();
    const factsOf = new Map(wire.hosts.map((host) => [host.id, host]));
    let soonest: number | null = null;
    const projects: Record<string, ProjectLink> = {};
    for (const [projectId, { hostId, link }] of Object.entries(wire.projects)) {
      let tracker = trackers.get(projectId);
      if (tracker === undefined) {
        tracker = createHostLinkTracker();
        trackers.set(projectId, tracker);
      }
      const host = factsOf.get(hostId);
      // A project whose host main has not named (yet): no version facts to add.
      const worded = tracker.view(
        asLinkState(link),
        at,
        host === undefined
          ? {}
          : { availableUpdate: host.availableUpdate, hostIsNewer: host.hostIsNewer },
      );
      if (worded.recheckAt !== null && (soonest === null || worded.recheckAt < soonest)) {
        soonest = worded.recheckAt;
      }
      const before = snapshot.projects[projectId];
      projects[projectId] =
        before !== undefined && before.hostId === hostId && sameView(before.link, worded.link)
          ? before
          : { hostId, link: worded.link };
    }
    for (const projectId of trackers.keys()) {
      if (!(projectId in wire.projects)) trackers.delete(projectId);
    }
    const hosts = wire.hosts.map((host) => {
      const record = remoteHostRecord(host);
      const before = snapshot.hosts.find((entry) => entry.id === host.id);
      return before !== undefined && sameRecord(before, record) ? before : record;
    });
    const changed =
      hosts.length !== snapshot.hosts.length ||
      hosts.some((host, index) => host !== snapshot.hosts[index]) ||
      Object.keys(projects).length !== Object.keys(snapshot.projects).length ||
      Object.entries(projects).some(([id, project]) => snapshot.projects[id] !== project);
    if (changed) snapshot = { hosts, projects };
    if (soonest !== null) cancelTimer = setTimer(publish, Math.max(0, soonest - at));
    if (changed) for (const listener of listeners) listener();
  }

  const unsubscribe = client.subscribe({
    onData(next) {
      if (closed) return;
      wire = next;
      publish();
    },
    onError() {
      // Flag off, or main has no registry this launch: no remote hosts.
      if (closed) return;
      wire = null;
      publish();
    },
  });

  const act = (work: Promise<unknown>): void => {
    work.catch((error: unknown) =>
      onActionError(error instanceof Error ? error.message : "That didn’t work."),
    );
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry: (hostId) => act(client.retry(hostId)),
    updateHost: (hostId, when) => act(client.updateHost(hostId, when)),
    cancelScheduledUpdate: (hostId) => act(client.cancelScheduledUpdate(hostId)),
    signIn: (hostId, providerId) =>
      act(
        client.signIn(hostId, providerId).then(() => {
          const hostName = snapshot.hosts.find((host) => host.id === hostId)?.name ?? "the host";
          onSignIn({ hostId, hostName, providerId });
        }),
      ),
    close() {
      closed = true;
      cancelTimer?.();
      cancelTimer = null;
      unsubscribe();
    },
  };
}

/** What the tier client offers this source: `hosts.*`, as tRPC types it. */
export interface RemoteHostsRpc {
  readonly hosts: {
    readonly subscribe: {
      subscribe(
        input: undefined,
        handlers: { onData(data: RemoteHostsSnapshot): void; onError(error: unknown): void },
      ): { unsubscribe(): void };
    };
    readonly retry: { mutate(input: { hostId: string }): Promise<unknown> };
    readonly updateHost: {
      mutate(input: { hostId: string; when: "now" | "when-idle" }): Promise<unknown>;
    };
    readonly cancelScheduledUpdate: { mutate(input: { hostId: string }): Promise<unknown> };
    readonly signIn: { mutate(input: { hostId: string; providerId: string }): Promise<unknown> };
  };
}

/** The desktop-only tier (`hosts.*`) as {@link RemoteHostsClient}. */
export function remoteHostsClient(rpc: RemoteHostsRpc): RemoteHostsClient {
  return {
    subscribe(handlers) {
      const subscription = rpc.hosts.subscribe.subscribe(undefined, {
        onData: (data) => handlers.onData(data),
        onError: (error) => handlers.onError(error),
      });
      return () => subscription.unsubscribe();
    },
    retry: (hostId) => rpc.hosts.retry.mutate({ hostId }),
    updateHost: (hostId, when) => rpc.hosts.updateHost.mutate({ hostId, when }),
    cancelScheduledUpdate: (hostId) => rpc.hosts.cancelScheduledUpdate.mutate({ hostId }),
    signIn: (hostId, providerId) => rpc.hosts.signIn.mutate({ hostId, providerId }),
  };
}

/** The stores {@link attachRemoteHostsWhileCloud} reads and writes, and its source. */
export interface RemoteHostsBinding {
  readonly experiments: {
    getState(): { readonly snapshot: Parameters<typeof isExperimentOn>[0] };
    subscribe(listener: () => void): () => void;
  };
  readonly hosts: { getState(): { attach(source: HostConnectionSource): () => void } };
  readonly createSource: () => RemoteHostSource;
}

/**
 * Remote hosts feed the host-connection store beside This Mac only while
 * `cloud` is on, as This Mac does (`attachThisMacWhileCloud`): off, there is
 * no subscription to main at all. Turning the flag off detaches the source
 * and ends its subscription. The returned function stops the binding.
 */
export function attachRemoteHostsWhileCloud({
  experiments = useExperimentsStore,
  hosts = useHostConnectionStore,
  createSource = () => createRemoteHostSource(remoteHostsClient(sessionRpcClient())),
}: Partial<RemoteHostsBinding> = {}): () => void {
  let attached: { source: RemoteHostSource; detach: () => void } | null = null;
  const stop = () => {
    attached?.detach();
    attached?.source.close();
    attached = null;
  };
  const sync = () => {
    const on = isExperimentOn(experiments.getState().snapshot, "cloud");
    if (on && attached === null) {
      const source = createSource();
      attached = { source, detach: hosts.getState().attach(source) };
    } else if (!on) {
      stop();
    }
  };
  const unsubscribe = experiments.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    stop();
  };
}
