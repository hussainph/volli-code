/**
 * The remote half of the host-connection store (VC-700 PR 2): the hosts this
 * Mac added over SSH, as desktop main's registry streams them over the
 * desktop-only tier (`hosts.subscribe`), turned into VC-576's
 * {@link HostConnectionSource}.
 *
 * Main holds the registry, the SSH tunnels and the client host links
 * (`@volli/host-install`'s `createRemoteHosts`); it sends a host's link as
 * the facts {@link hostLinkView} reads, and this source words them, so a
 * remote host's link reads exactly as any other source's would. Between two
 * snapshots time still passes: a dropped link reads `reconnecting` for
 * {@link HOST_OFFLINE_AFTER_MS}, then `offline`, so the source re-words its
 * hosts when that grace ends even though main sent nothing new.
 *
 * Actions are the person's intent, sent once: none queues for a host that is
 * away (Ruling 1). One that fails (a v1 refusal of Update host, a host
 * forgotten meanwhile) says so in a toast.
 */
import type { HostLinkState } from "@volli/host-protocol/client-link";
import type { RemoteHost, RemoteHostLinkState, RemoteHostsSnapshot } from "@volli/shared";
import { toast } from "sonner";

import {
  HOST_OFFLINE_AFTER_MS,
  hostLinkView,
  type HostConnectionSource,
  type HostId,
  type HostRecord,
  type HostSourceSnapshot,
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
}

/** The source, and its end: it stops the subscription and any pending re-word. */
export interface RemoteHostSource extends HostConnectionSource {
  close(): void;
}

const EMPTY: HostSourceSnapshot = Object.freeze({ hosts: [], projects: {} });

/**
 * A wire link state as the client host link's own: `hostLinkView` reads only
 * the status and, per status, `retryAt` and `error.reason`. A `ready` link's
 * welcome stays in main; nothing here reads it.
 */
function asLinkState(state: RemoteHostLinkState): HostLinkState {
  return state as unknown as HostLinkState;
}

/** One remote host as VC-576's record. */
export function remoteHostRecord(host: RemoteHost, now: number): HostRecord {
  return {
    id: host.id,
    name: host.name,
    local: false,
    os: host.os,
    version: host.version,
    link: hostLinkView(asLinkState(host.link.state), {
      everReady: host.link.everReady,
      droppedAt: host.link.droppedAt,
      now,
      availableUpdate: host.availableUpdate,
      hostIsNewer: host.hostIsNewer,
    }),
    liveSessions: host.liveSessions,
    // Updating a host over SSH, and its sign-ins, come with later tickets.
    update: null,
    expiredSignIns: [],
  };
}

/** When the soonest `reconnecting` host turns `offline`, or `null` when none will. */
function nextGraceEnd(hosts: readonly RemoteHost[], now: number): number | null {
  let soonest: number | null = null;
  for (const { link } of hosts) {
    if (link.state.status !== "unreachable" || !link.everReady || link.droppedAt === null) continue;
    const end = link.droppedAt + HOST_OFFLINE_AFTER_MS;
    if (end > now && (soonest === null || end < soonest)) soonest = end;
  }
  return soonest;
}

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
  const listeners = new Set<() => void>();
  let wire: RemoteHostsSnapshot | null = null;
  let snapshot: HostSourceSnapshot = EMPTY;
  let cancelTimer: (() => void) | null = null;
  let closed = false;

  function publish(): void {
    cancelTimer?.();
    cancelTimer = null;
    const at = now();
    snapshot =
      wire === null
        ? EMPTY
        : {
            hosts: wire.hosts.map((host) => remoteHostRecord(host, at)),
            projects: { ...wire.projects },
          };
    const graceEnd = wire === null ? null : nextGraceEnd(wire.hosts, at);
    if (graceEnd !== null) cancelTimer = setTimer(publish, graceEnd - at);
    for (const listener of listeners) listener();
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
    signIn: (hostId, providerId) => act(client.signIn(hostId, providerId)),
    close() {
      closed = true;
      cancelTimer?.();
      cancelTimer = null;
      unsubscribe();
    },
  };
}
