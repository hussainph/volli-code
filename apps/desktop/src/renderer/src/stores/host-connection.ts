/**
 * Which machine each project runs on, and whether this Mac can reach it
 * (VC-576). The title bar's host chip and switcher, the connection Island,
 * the chip's badge and the "Running on <host>" labels all read this store and
 * nothing else.
 *
 * FED BY SOURCES, NEVER BY ITSELF. A {@link HostConnectionSource} answers for
 * the hosts it knows: which hosts, which projects each one serves, and how its
 * link reads. The store merges every attached source into one list and routes
 * an action (Retry now, Update host, Sign in) back to the source that owns the
 * host. Today two exist: This Mac (`host-sources.ts`, the in-process host,
 * always open) and a fake for tests and the lab. VC-700's host registry plugs
 * its remote source in through the same {@link HostConnectionState.attach};
 * a control plane could feed a fleet the same way, so nothing here assumes one
 * desktop, one remote or one host per window (hosted guardrail).
 *
 * NO WORKSPACE DATA, AND NOTHING DURABLE (D-C1, guardrail 5). A host record is
 * a connection state and a name, never a project's contents; what a person
 * keeps reading while a host is away is whatever the other stores already hold
 * in memory. The offline last-known view is deferred past v1.
 *
 * The words people see come from `components/hosts/host-surface-model.ts`:
 * "This Mac" and the host's own name, never Workspace, venue or Worker (T20).
 */
import { create } from "zustand";
import type { HostLinkState } from "@volli/host-protocol/client-link";

/** A host's id: the host's own UUID for a remote one, {@link THIS_MAC_HOST_ID} for this Mac. */
export type HostId = string;

/** The in-process host (Electron main; VC-577). Reserved: no remote host is ever given it. */
export const THIS_MAC_HOST_ID = "this-mac";

export type HostOs = "macos" | "linux";

/**
 * Why a host that answered cannot serve this app. Each is read-only with one
 * recovery (VC-615 flow 6):
 *
 * - `host-too-old`: the host speaks a protocol this app no longer does. Update host.
 * - `host-too-new`: the host runs a Volli newer than this app. Update Volli.
 * - `database-too-new`: the host refuses to open a database a newer Volli wrote
 *   (VC-602). Update host.
 * - `refused`: the host no longer accepts this Mac's credential. Manage hosts.
 * - `fenced`: the project's authority moved, or two hosts claim it
 *   (`workspace-epoch-fenced` / `workspace-split-brain`). Manage hosts.
 */
export type HostIncompatibility =
  | "host-too-old"
  | "host-too-new"
  | "database-too-new"
  | "refused"
  | "fenced";

/**
 * A host's link as the UI reads it — a projection of the client host link's
 * state (VC-670) plus the version facts the welcome and the host registry know.
 * {@link hostLinkView} is the one mapping from `HostLinkState`.
 */
export type HostLinkView =
  /** The first attempt is in flight; nothing has been served yet. */
  | { readonly status: "connecting" }
  /** Served, and nothing to say. */
  | { readonly status: "open" }
  /** Served before, dropped, and getting back. Silent for a grace period. */
  | { readonly status: "reconnecting" }
  /** Down past the grace period. `retryAt` (epoch ms) is the next automatic attempt. */
  | { readonly status: "offline"; readonly since: number; readonly retryAt: number | null }
  /** Served, but the host is older than this app and a compatible update is available. */
  | { readonly status: "version-skewed"; readonly availableVersion: string }
  /** Answered, and cannot serve this app. Read-only until its one recovery. */
  | {
      readonly status: "incompatible";
      readonly reason: HostIncompatibility;
      /** The host version this app needs (`host-too-old`), when the source knows it. */
      readonly requiredVersion?: string;
    };

export type HostLinkStatus = HostLinkView["status"];

/** A host update this Mac started or scheduled (`version-skewed`'s, or a blocking state's recovery). */
export type HostUpdate =
  /** Waits for the host's running Sessions to finish. */
  | { readonly status: "scheduled" }
  /** Downloading and restarting. `progress` is 0..1. */
  | { readonly status: "running"; readonly progress: number; readonly targetVersion: string };

/** A sign-in on the host that expired (VC-702 fills this; empty until then). */
export interface HostSignIn {
  readonly providerId: string;
  /** "Claude". */
  readonly name: string;
}

export interface HostRecord {
  readonly id: HostId;
  /** "This Mac", or the host's own name ("hetzner-1"). */
  readonly name: string;
  readonly local: boolean;
  /** `null` until the host says what it is. */
  readonly os: HostOs | null;
  /** The host's Volli version, `null` when unknown (and always for This Mac). */
  readonly version: string | null;
  readonly link: HostLinkView;
  /** Sessions running on the host right now, `null` when the source cannot say. */
  readonly liveSessions: number | null;
  readonly update: HostUpdate | null;
  readonly expiredSignIns: readonly HostSignIn[];
}

/** One source's answer: its hosts, and which of its hosts serves each project it knows. */
export interface HostSourceSnapshot {
  readonly hosts: readonly HostRecord[];
  /** Project id → the id of one of this snapshot's hosts. */
  readonly projects: Readonly<Record<string, HostId>>;
}

/**
 * What VC-700's host registry (and anything after it) implements to put hosts
 * on screen. `getSnapshot`/`subscribe` are `useSyncExternalStore`'s shape: a
 * new snapshot object on every change, the same object otherwise. The actions
 * are the person's explicit intent and are only ever called for a host this
 * source's snapshot holds; none of them may queue work for a host that is
 * away (Ruling 1).
 */
export interface HostConnectionSource {
  getSnapshot(): HostSourceSnapshot;
  subscribe(listener: () => void): () => void;
  /** Retry now: reconnect at once (`HostLink.reconnect`). */
  retry(hostId: HostId): void;
  /** Update the host's Volli now, or once its running Sessions finish. */
  updateHost(hostId: HostId, when: "now" | "when-idle"): void;
  /** Withdraws an update scheduled `when-idle`. */
  cancelScheduledUpdate(hostId: HostId): void;
  /** Starts the sign-in recovery for one expired provider (VC-702 owns the flow). */
  signIn(hostId: HostId, providerId: string): void;
}

/** The record the store answers for This Mac when no source has said anything. */
export const THIS_MAC_HOST: HostRecord = Object.freeze({
  id: THIS_MAC_HOST_ID,
  name: "This Mac",
  local: true,
  os: "macos",
  version: null,
  link: Object.freeze({ status: "open" }),
  liveSessions: null,
  update: null,
  expiredSignIns: Object.freeze([]),
});

/**
 * Where "Add a host…" and "Manage hosts…" go. VC-700 PR 3 registers its
 * Add-a-host sheet and Settings → Hosts here; until then the switcher's own
 * fallback answers.
 */
export interface HostEntryPoints {
  readonly addHost: (() => void) | null;
  readonly manageHosts: (() => void) | null;
}

export interface HostConnectionState {
  /** Every host, This Mac first, then each source's hosts in its own order. */
  readonly hosts: readonly HostRecord[];
  /** Project id → host id, merged across sources. A project nobody claims is on This Mac. */
  readonly projectHosts: Readonly<Record<string, HostId>>;
  readonly entryPoints: HostEntryPoints;
  /** Adds a source; the returned function detaches it. */
  attach(source: HostConnectionSource): () => void;
  setEntryPoints(entryPoints: Partial<HostEntryPoints>): void;
  retry(hostId: HostId): void;
  updateHost(hostId: HostId, when: "now" | "when-idle"): void;
  cancelScheduledUpdate(hostId: HostId): void;
  signIn(hostId: HostId, providerId: string): void;
}

/** Factory so tests get isolated instances (the store module's own convention). */
export function createHostConnectionStore() {
  const sources: HostConnectionSource[] = [];
  /** Which source answers for each host, so an action reaches its owner. */
  let owners = new Map<HostId, HostConnectionSource>();

  return create<HostConnectionState>()((set, get) => {
    function merge(): void {
      const hosts: HostRecord[] = [];
      const projectHosts: Record<string, HostId> = {};
      const nextOwners = new Map<HostId, HostConnectionSource>();
      for (const source of sources) {
        const snapshot = source.getSnapshot();
        for (const host of snapshot.hosts) {
          // Two sources naming one host: the first attached keeps it. A host
          // id is the host's own UUID, so this is a registry bug upstream,
          // never two machines.
          if (nextOwners.has(host.id)) continue;
          nextOwners.set(host.id, source);
          hosts.push(host);
        }
        for (const [projectId, hostId] of Object.entries(snapshot.projects)) {
          if (nextOwners.get(hostId) !== source) continue;
          const claimed = projectHosts[projectId];
          // A remote claim outranks This Mac's: This Mac answers for every
          // project the projects store lists, including one a remote host
          // serves. Between two remote claims the first stands; which one is
          // the authority is the Workspace fence's call, not this merge's.
          if (claimed === undefined || claimed === THIS_MAC_HOST_ID) {
            projectHosts[projectId] = hostId;
          }
        }
      }
      hosts.sort((a, b) => Number(b.local) - Number(a.local));
      owners = nextOwners;
      set({ hosts, projectHosts });
    }

    function route(hostId: HostId): HostConnectionSource | undefined {
      return owners.get(hostId);
    }

    return {
      hosts: [],
      projectHosts: {},
      entryPoints: { addHost: null, manageHosts: null },
      attach(source) {
        sources.push(source);
        const unsubscribe = source.subscribe(merge);
        merge();
        let attached = true;
        return () => {
          if (!attached) return;
          attached = false;
          unsubscribe();
          sources.splice(sources.indexOf(source), 1);
          merge();
        };
      },
      setEntryPoints(entryPoints) {
        set({ entryPoints: { ...get().entryPoints, ...entryPoints } });
      },
      retry(hostId) {
        route(hostId)?.retry(hostId);
      },
      updateHost(hostId, when) {
        route(hostId)?.updateHost(hostId, when);
      },
      cancelScheduledUpdate(hostId) {
        route(hostId)?.cancelScheduledUpdate(hostId);
      },
      signIn(hostId, providerId) {
        route(hostId)?.signIn(hostId, providerId);
      },
    };
  });
}

/** The app's one host-connection store. */
export const useHostConnectionStore = createHostConnectionStore();

/* ── Reading it ─────────────────────────────────────────────────────────── */

type HostReadable = Pick<HostConnectionState, "hosts" | "projectHosts">;

/** The host a project runs on. No project, or one nobody claims, is This Mac. */
export function hostOfProject(state: HostReadable, projectId: string | null): HostRecord {
  const hostId =
    projectId === null ? THIS_MAC_HOST_ID : (state.projectHosts[projectId] ?? THIS_MAC_HOST_ID);
  return (
    state.hosts.find((host) => host.id === hostId) ??
    state.hosts.find((host) => host.local) ??
    THIS_MAC_HOST
  );
}

/** How many projects each host serves. */
export function projectCounts(state: HostReadable): ReadonlyMap<HostId, number> {
  const counts = new Map<HostId, number>();
  for (const hostId of Object.values(state.projectHosts)) {
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether the host cannot serve: its project reads from memory and its board's
 * create and write controls stand down. Reconnecting and connecting are not —
 * a blip must never take the board away — and neither is an update in flight.
 */
export function isBlocking(link: HostLinkView): boolean {
  return link.status === "offline" || link.status === "incompatible";
}

/* ── From the client host link ──────────────────────────────────────────── */

/**
 * How long a dropped link reads as reconnecting before it reads offline. The
 * link's own backoff makes three or four attempts in this time (0.25 s to
 * 4 s apart), so a host that restarts or a network that blips comes back
 * before anyone is told it is gone.
 */
export const HOST_OFFLINE_AFTER_MS = 5_000;

/** What {@link hostLinkView} needs beyond the link's own state. */
export interface HostLinkContext {
  /** Whether this link has ever been `ready` since the source opened it. */
  readonly everReady: boolean;
  /** When the link last left `ready` (epoch ms), `null` if it has not. */
  readonly droppedAt: number | null;
  readonly now: number;
  /**
   * A compatible update the host could take (the registry compares the
   * welcome's `host.version` with this app's), `null` when it is current.
   */
  readonly availableUpdate?: string | null;
  /**
   * The host is newer than this app. A refused protocol version says the two
   * do not meet, never which side is behind; the source knows from the
   * host's reported version.
   */
  readonly hostIsNewer?: boolean;
  /** The host version this app needs, for `host-too-old`'s line. */
  readonly requiredVersion?: string;
}

/**
 * The one mapping from a client host link's state (VC-670) to what the UI
 * shows. A remote source calls it on every `subscribeState` change.
 * `database-too-new` never comes from the link: the host reports it (VC-602),
 * and the source sets it directly.
 */
export function hostLinkView(state: HostLinkState, context: HostLinkContext): HostLinkView {
  switch (state.status) {
    case "ready":
      return context.availableUpdate
        ? { status: "version-skewed", availableVersion: context.availableUpdate }
        : { status: "open" };
    case "connecting":
      return context.everReady ? { status: "reconnecting" } : { status: "connecting" };
    case "unreachable": {
      const since = context.droppedAt ?? context.now;
      if (context.everReady && context.now - since < HOST_OFFLINE_AFTER_MS) {
        return { status: "reconnecting" };
      }
      return { status: "offline", since, retryAt: state.retryAt };
    }
    case "refused":
      if (state.error.reason !== "protocol-version-unsupported") {
        return { status: "incompatible", reason: "refused" };
      }
      return context.hostIsNewer
        ? { status: "incompatible", reason: "host-too-new" }
        : context.requiredVersion === undefined
          ? { status: "incompatible", reason: "host-too-old" }
          : {
              status: "incompatible",
              reason: "host-too-old",
              requiredVersion: context.requiredVersion,
            };
    case "fenced":
      return { status: "incompatible", reason: "fenced" };
    case "closed":
      return { status: "offline", since: context.droppedAt ?? context.now, retryAt: null };
  }
}
