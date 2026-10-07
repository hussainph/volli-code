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
 * at the soonest such moment, re-words them. A host's own reachability comes
 * from the engine, not those projects. Subscription loss keeps remote claims
 * read-only, shows a visible error and resubscribes with bounded backoff.
 *
 * Unchanged records and link views keep their identity across snapshots, so
 * `useSyncExternalStore` readers re-render only for what moved. Actions are
 * the person's intent, sent once (Ruling 1); one that fails says so in a
 * toast.
 */
import { remoteHostDiagnostic, type RemoteHost, type RemoteHostsSnapshot } from "@volli/shared";
import { toast } from "sonner";

import {
  useHostSignInSheet,
  type HostSignInSheetTarget,
} from "../components/hosts/sign-ins/remote-host-sign-in-source";
import { sessionRpcClient } from "../lib/session-rpc-ipc-link";
import { isExperimentOn, useExperimentsStore } from "./experiments";
import { useRemoteHostsStore } from "./remote-hosts";
import {
  createHostLinkTracker,
  hostLinkView,
  hostLinkViewChangesAt,
  useHostConnectionStore,
  type HostConnectionSource,
  type HostId,
  type HostLinkTracker,
  type HostLinkView,
  type HostSourceRecord,
  type HostSourceSnapshot,
  type ProjectLink,
} from "./host-connection";

/** What the source needs of the desktop tier: one subscription and two actions. */
export interface RemoteHostsClient {
  subscribe(handlers: {
    onData(snapshot: RemoteHostsSnapshot): void;
    onError(error: unknown): void;
  }): () => void;
  retry(hostId: HostId): Promise<unknown>;
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
  /**
   * The registry's hosts on every snapshot, kept on stream failure with its
   * error as read-only, and cleared on close: Settings → Hosts' reading.
   */
  readonly onHosts?: (hosts: readonly RemoteHost[], readOnly: string | null) => void;
}

/** The source, and its end: it stops the subscription and any pending re-word. */
export interface RemoteHostSource extends HostConnectionSource {
  close(): void;
}

const EMPTY: HostSourceSnapshot = Object.freeze({ hosts: [], projects: {} });

/** One remote host's facts, including known expired sign-ins; health is worded below. */
export function remoteHostRecord(host: RemoteHost): HostSourceRecord {
  return {
    id: host.id,
    name: host.name,
    local: false,
    os: host.os,
    version: host.version,
    liveSessions: host.liveSessions,
    // No update operation is running: re-add is the SSH update path.
    update: null,
    expiredSignIns: (host.signInExpiry ?? [])
      .filter((signIn) => signIn.expired)
      .map(({ providerId, name }) => ({ providerId, name })),
  };
}

/** Two lists of the same strings, in the same order. */
const sameStrings = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  a.length === b.length &&
  a.every((item, index) => item === b[index]);

const sameRecord = (a: HostSourceRecord, b: HostSourceRecord): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.os === b.os &&
  a.version === b.version &&
  a.liveSessions === b.liveSessions &&
  JSON.stringify(a.expiredSignIns) === JSON.stringify(b.expiredSignIns) &&
  JSON.stringify(a.link) === JSON.stringify(b.link);

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
  const onHosts = options.onHosts ?? (() => {});
  const listeners = new Set<() => void>();
  /** One tracker per project, kept while main keeps naming the project. */
  const trackers = new Map<string, HostLinkTracker>();
  let wire: RemoteHostsSnapshot = { v: 1, hosts: [], projects: {}, readOnly: null };
  let snapshot: HostSourceSnapshot = EMPTY;
  let cancelTimer: (() => void) | null = null;
  let closed = false;
  let subscriptionError: string | null = null;
  let failedAt = 0;
  let cancelRetry: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let subscriptionGeneration = 0;
  let failures = 0;

  /** Words every project's link now; arms one timer for the soonest change. */
  function publish(): void {
    cancelTimer?.();
    cancelTimer = null;
    const at = now();
    const factsOf = new Map(wire.hosts.map((host) => [host.id, host]));
    let soonest: number | null = null;
    const projects: Record<string, ProjectLink> = {};
    for (const [projectId, { hostId, link, granted: wired }] of Object.entries(wire.projects)) {
      let tracker = trackers.get(projectId);
      if (tracker === undefined) {
        tracker = createHostLinkTracker();
        trackers.set(projectId, tracker);
      }
      const host = factsOf.get(hostId);
      // A project whose host main has not named (yet): no version facts to add.
      const worded = tracker.view(
        link,
        at,
        host === undefined
          ? {}
          : { availableUpdate: host.availableUpdate, hostIsNewer: host.hostIsNewer },
      );
      if (worded.recheckAt !== null && (soonest === null || worded.recheckAt < soonest)) {
        soonest = worded.recheckAt;
      }
      const before = snapshot.projects[projectId];
      // What the project's ready link granted (VC-712): the same array while it reads the same.
      const granted =
        wired !== undefined && sameStrings(before?.granted, wired) ? before!.granted : wired;
      const view: HostLinkView =
        subscriptionError !== null
          ? { status: "offline", since: failedAt, retryAt: null, detail: subscriptionError }
          : worded.link.status === "incompatible" && worded.link.refusalCode === "workspace-unknown"
            ? { ...worded.link, workspaceId: projectId }
            : worded.link;
      projects[projectId] =
        before !== undefined &&
        before.hostId === hostId &&
        sameView(before.link, view) &&
        before.granted === granted
          ? before
          : { hostId, link: view, ...(granted === undefined ? {} : { granted }) };
    }
    for (const projectId of trackers.keys()) {
      if (!(projectId in wire.projects)) trackers.delete(projectId);
    }
    const hosts = wire.hosts.map((host) => {
      const health = host.reachability;
      const context = {
        everReady: health?.everReady ?? false,
        droppedAt: health?.droppedAt ?? null,
        now: at,
        availableUpdate: host.availableUpdate,
        hostIsNewer: host.hostIsNewer,
      };
      let link: HostLinkView =
        subscriptionError !== null
          ? { status: "offline", since: failedAt, retryAt: null, detail: subscriptionError }
          : health === undefined
            ? { status: "connecting" }
            : hostLinkView(health.state, context);
      if (subscriptionError === null && link.status === "offline" && host.lastSshFailure) {
        link = { ...link, detail: remoteHostDiagnostic(host.lastSshFailure.line) };
      }
      if (health !== undefined && subscriptionError === null) {
        const recheckAt = hostLinkViewChangesAt(health.state, context);
        if (recheckAt !== null && (soonest === null || recheckAt < soonest)) soonest = recheckAt;
      }
      const record: HostSourceRecord = { ...remoteHostRecord(host), link };
      const before = snapshot.hosts.find((entry) => entry.id === host.id);
      return before !== undefined && sameRecord(before, record) ? before : record;
    });
    const changed =
      subscriptionError !== (snapshot.error ?? null) ||
      hosts.length !== snapshot.hosts.length ||
      hosts.some((host, index) => host !== snapshot.hosts[index]) ||
      Object.keys(projects).length !== Object.keys(snapshot.projects).length ||
      Object.entries(projects).some(([id, project]) => snapshot.projects[id] !== project);
    if (changed)
      snapshot = {
        hosts,
        projects,
        ...(subscriptionError === null ? {} : { error: subscriptionError }),
      };
    if (soonest !== null) cancelTimer = setTimer(publish, Math.max(0, soonest - at));
    if (changed) for (const listener of listeners) listener();
  }

  function connect(): void {
    if (closed) return;
    cancelRetry?.();
    cancelRetry = null;
    const mine = ++subscriptionGeneration;
    unsubscribe?.();
    unsubscribe = null;
    const current = () => !closed && mine === subscriptionGeneration;
    const fail = (error: unknown): void => {
      if (!current()) return;
      // Keep claims: losing the stream must not route remote ids to This Mac.
      failedAt = now();
      subscriptionError = remoteHostDiagnostic(
        `Couldn’t read host state: ${error instanceof Error && error.message ? error.message : "connection failed"}`,
      );
      publish();
      onHosts(wire.hosts, subscriptionError);
      subscriptionGeneration += 1;
      unsubscribe?.();
      unsubscribe = null;
      failures += 1;
      cancelRetry = setTimer(connect, Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)));
    };
    try {
      const stop = client.subscribe({
        onData(next) {
          if (!current()) return;
          failures = 0;
          subscriptionError = null;
          wire = next;
          publish();
          onHosts(next.hosts, next.readOnly);
        },
        onError: fail,
      });
      // A transport may fail synchronously while subscribe is being set up.
      if (current()) unsubscribe = stop;
      else stop();
    } catch (error) {
      fail(error);
    }
  }
  connect();

  const act = (work: Promise<unknown>): void => {
    work.catch((error: unknown) =>
      onActionError(error instanceof Error ? error.message : "That didn’t work."),
    );
  };

  // Compatibility actions use the real SSH update path, not the retired RPCs.
  const reAddHost = (hostId: HostId): void => {
    if (closed) return;
    const host = wire.hosts.find((entry) => entry.id === hostId);
    if (host !== undefined) useRemoteHostsStore.getState().openAddHost(host.target);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry: (hostId) => {
      if (subscriptionError !== null) connect();
      else act(client.retry(hostId));
    },
    retrySubscription: connect,
    updateHost: reAddHost,
    cancelScheduledUpdate: reAddHost,
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
      subscriptionGeneration += 1;
      cancelRetry?.();
      cancelRetry = null;
      unsubscribe?.();
      unsubscribe = null;
      onHosts([], null);
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
  createSource = () =>
    createRemoteHostSource(remoteHostsClient(sessionRpcClient()), {
      onHosts: (list, readOnly) => useRemoteHostsStore.getState().setHosts(list, readOnly),
    }),
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
