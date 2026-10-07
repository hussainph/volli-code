/**
 * Which machine each project runs on, and whether this Mac can reach it
 * (VC-576). The title bar's host chip and switcher, the connection Island,
 * the chip's badge and the "Running on <host>" labels all read this store and
 * nothing else.
 *
 * FED BY SOURCES, NEVER BY ITSELF. A {@link HostConnectionSource} answers for
 * the hosts it knows: which hosts, which projects each one serves, and how
 * each PROJECT's link reads (a client keeps one link per Workspace, each fenced
 * on its own). The store merges every attached source into one list and routes
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
import { REMOTE_HOST_TOO_MANY_PROJECTS, type RemoteHostLinkState } from "@volli/shared";

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
 * - `too-many-projects`: this Mac opens at most `REMOTE_HOST_LINK_CAP` links
 *   to one host, and this project is past it (VC-700). Never the host's
 *   fault, so a host's own link never reads it. Manage hosts.
 */
export type HostIncompatibility =
  | "host-too-old"
  | "host-too-new"
  | "database-too-new"
  | "refused"
  | "fenced"
  | "too-many-projects";

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
  | {
      readonly status: "offline";
      readonly since: number;
      readonly retryAt: number | null;
      readonly detail?: string;
    }
  /** Served, but the host is older than this app and a compatible update is available. */
  | { readonly status: "version-skewed"; readonly availableVersion: string }
  /** Answered, and cannot serve this app. Read-only until its one recovery. */
  | {
      readonly status: "incompatible";
      readonly reason: HostIncompatibility;
      /** The host version this app needs (`host-too-old`), when the source knows it. */
      readonly requiredVersion?: string;
      /** The refusal's named reason (or code), not a guess about enrollment. */
      readonly refusalCode?: string;
      /** Only the refused project's recovery may forget it. */
      readonly workspaceId?: string;
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
  /**
   * The HOST's engine-owned health, independent of its projects. A project's
   * own write access never reads this — see {@link ProjectLink}.
   */
  readonly link: HostLinkView;
  /** Sessions running on the host right now, `null` when the source cannot say. */
  readonly liveSessions: number | null;
  readonly update: HostUpdate | null;
  readonly expiredSignIns: readonly HostSignIn[];
}

/**
 * A source names host health separately from per-project access. Missing
 * remote health is unknown, never inferred from the project's links.
 */
export type HostSourceRecord = Omit<HostRecord, "link"> & { readonly link?: HostLinkView };

/**
 * Which host serves one project, and how THAT project's link reads. Project A
 * can be fenced, or still handshaking, while project B on the same box is
 * open; the Island and read-only follow the current project's link alone.
 */
export interface ProjectLink {
  readonly hostId: HostId;
  readonly link: HostLinkView;
  /**
   * The features the project's own Workspace link granted while it is ready
   * (VC-712: `host.logs` puts the host in the log viewer). Absent when the
   * source does not say, and for This Mac's projects. A source keeps the same
   * array while it does not change.
   */
  readonly granted?: readonly string[];
}

/** One source's answer: its hosts, and each project it serves with that project's link. */
export interface HostSourceSnapshot {
  readonly hosts: readonly HostSourceRecord[];
  /** Project id → one of this snapshot's hosts, and the project's own link. */
  readonly projects: Readonly<Record<string, ProjectLink>>;
  /** A failed source read, kept visible until its next successful snapshot. */
  readonly error?: string | null;
}

/**
 * What VC-700's host registry (and anything after it) implements to put hosts
 * on screen. `getSnapshot`/`subscribe` are `useSyncExternalStore`'s shape: a
 * new snapshot object on every change, the same object otherwise; keep each
 * unchanged `HostSourceRecord` and `HostLinkView` the same object across
 * snapshots, so a surface reading one host or project does not redraw for
 * another's change. The actions are the person's explicit intent and are
 * only ever called for a host this source's snapshot holds; none of them may
 * queue work for a host that is away (Ruling 1). They return nothing: a
 * source reports its own failures (a toast, or the link state it lands in).
 */
export interface HostConnectionSource {
  getSnapshot(): HostSourceSnapshot;
  subscribe(listener: () => void): () => void;
  /** Retry now: reconnect the host's links at once (`HostLink.reconnect`). */
  retry(hostId: HostId): void;
  /** Explicit recovery for the source's subscription, when it has failed. */
  retrySubscription?(): void;
  /** Update the host's Volli now, or once its running Sessions finish. */
  updateHost(hostId: HostId, when: "now" | "when-idle"): void;
  /** Withdraws an update scheduled `when-idle`. */
  cancelScheduledUpdate(hostId: HostId): void;
  /** Starts the sign-in recovery for one expired provider (VC-702 owns the flow). */
  signIn(hostId: HostId, providerId: string): void;
}

/** The link This Mac's projects always have: the in-process host is the process itself. */
export const OPEN_LINK: HostLinkView = Object.freeze({ status: "open" });
const UNKNOWN_HOST_LINK: HostLinkView = Object.freeze({ status: "connecting" });

/** The record the store answers for This Mac when no source has said anything. */
export const THIS_MAC_HOST: HostRecord = Object.freeze({
  id: THIS_MAC_HOST_ID,
  name: "This Mac",
  local: true,
  os: "macos",
  version: null,
  link: OPEN_LINK,
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
  /** Every host, This Mac first, then each source's hosts in its own order. Each `link` is source-owned host health. */
  readonly hosts: readonly HostRecord[];
  /** Project id → its host and its own link, merged across sources. A project nobody claims is on This Mac, open. */
  readonly projects: Readonly<Record<string, ProjectLink>>;
  readonly entryPoints: HostEntryPoints;
  readonly sourceError: string | null;
  retrySources(): void;
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
  /**
   * The merged record last built for each source record, so a host whose
   * aggregate did not change keeps its object and its readers do not redraw.
   */
  const records = new WeakMap<HostSourceRecord, HostRecord>();

  function record(host: HostSourceRecord, link: HostLinkView): HostRecord {
    const known = records.get(host);
    if (known?.link === link) return known;
    // A source record that already carries this very link (This Mac's frozen
    // record does) is its own merged record.
    const next: HostRecord =
      (host as Partial<HostRecord>).link === link ? (host as HostRecord) : { ...host, link };
    records.set(host, next);
    return next;
  }

  return create<HostConnectionState>()((set, get) => {
    function merge(): void {
      const sourceHosts: HostSourceRecord[] = [];
      const projects: Record<string, ProjectLink> = {};
      const nextOwners = new Map<HostId, HostConnectionSource>();
      let sourceError: string | null = null;
      for (const source of sources) {
        const snapshot = source.getSnapshot();
        sourceError ??= snapshot.error ?? null;
        for (const host of snapshot.hosts) {
          // Two sources naming one host: the first attached keeps it. A host
          // id is the host's own UUID, so this is a registry bug upstream,
          // never two machines.
          if (nextOwners.has(host.id)) continue;
          nextOwners.set(host.id, source);
          sourceHosts.push(host);
        }
        for (const [projectId, claim] of Object.entries(snapshot.projects)) {
          if (nextOwners.get(claim.hostId) !== source) continue;
          const claimed = projects[projectId];
          // A remote claim outranks This Mac's: This Mac answers for every
          // project the projects store lists, including one a remote host
          // serves. Between two remote claims the first stands; which one is
          // the authority is the Workspace fence's call, not this merge's.
          if (claimed === undefined || claimed.hostId === THIS_MAC_HOST_ID) {
            projects[projectId] = claim;
          }
        }
      }
      const linksByHost = new Map<HostId, HostLinkView[]>();
      for (const claim of Object.values(projects)) {
        const links = linksByHost.get(claim.hostId);
        if (links === undefined) linksByHost.set(claim.hostId, [claim.link]);
        else links.push(claim.link);
      }
      const hosts = sourceHosts.map((host) =>
        record(
          host,
          host.link ??
            (host.local ? aggregateLink(linksByHost.get(host.id) ?? []) : UNKNOWN_HOST_LINK),
        ),
      );
      hosts.sort((a, b) => Number(b.local) - Number(a.local));
      owners = nextOwners;
      const previous = get();
      set({
        hosts: sameItems(previous.hosts, hosts) ? previous.hosts : hosts,
        projects: sameClaims(previous.projects, projects) ? previous.projects : projects,
        sourceError,
      });
    }

    function route(hostId: HostId): HostConnectionSource | undefined {
      return owners.get(hostId);
    }

    return {
      hosts: [],
      projects: {},
      entryPoints: { addHost: null, manageHosts: null },
      sourceError: null,
      retrySources() {
        for (const source of sources) source.retrySubscription?.();
      },
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

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameClaims(
  a: Readonly<Record<string, ProjectLink>>,
  b: Readonly<Record<string, ProjectLink>>,
): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        a[key]!.hostId === b[key]?.hostId &&
        a[key]!.link === b[key]?.link &&
        a[key]!.granted === b[key]?.granted,
    )
  );
}

/** The app's one host-connection store. */
export const useHostConnectionStore = createHostConnectionStore();

/* ── Reading it ─────────────────────────────────────────────────────────── */

type HostReadable = Pick<HostConnectionState, "hosts" | "projects">;

/** The id of the host a project runs on. No project, or one nobody claims, is This Mac. */
export function hostIdOfProject(state: HostReadable, projectId: string | null): HostId {
  return projectId === null
    ? THIS_MAC_HOST_ID
    : (state.projects[projectId]?.hostId ?? THIS_MAC_HOST_ID);
}

/**
 * Whether a remote host serves the project (VC-711): its board goes over that
 * Workspace's link, and this Mac's local-only surfaces (files, terminals,
 * worktrees, automations, MCP, attachments) stand down for it rather than ask
 * this Mac's `window.api` about an id it does not hold.
 */
export function isRemoteProject(state: HostReadable, projectId: string | null): boolean {
  return hostIdOfProject(state, projectId) !== THIS_MAC_HOST_ID;
}

/** The host a project runs on, with the host's own health (the chip's). */
export function hostOfProject(state: HostReadable, projectId: string | null): HostRecord {
  const hostId = hostIdOfProject(state, projectId);
  return (
    state.hosts.find((host) => host.id === hostId) ??
    state.hosts.find((host) => host.local) ??
    THIS_MAC_HOST
  );
}

/**
 * The project's OWN link: what its Island says and whether it can be written
 * to. No project, one nobody claims, or one whose host is gone reads open
 * (This Mac's).
 */
export function projectLinkOf(state: HostReadable, projectId: string | null): HostLinkView {
  if (projectId === null) return OPEN_LINK;
  const claim = state.projects[projectId];
  if (claim === undefined || !state.hosts.some((host) => host.id === claim.hostId)) {
    return OPEN_LINK;
  }
  return claim.link;
}

/** Whether a project's create and write controls work: its own link is not blocking. */
export function canWriteProject(state: HostReadable, projectId: string | null): boolean {
  return !isBlocking(projectLinkOf(state, projectId));
}

/** How many projects each host serves. */
export function projectCounts(state: HostReadable): ReadonlyMap<HostId, number> {
  const counts = new Map<HostId, number>();
  for (const { hostId } of Object.values(state.projects)) {
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether a link cannot serve: its project reads from memory and its create
 * and write controls stand down. Reconnecting and connecting are not — a blip
 * must never take the board away — and neither is an update in flight.
 */
export function isBlocking(link: HostLinkView): boolean {
  return link.status === "offline" || link.status === "incompatible";
}

/**
 * Worst first: a host that cannot serve a project outranks one that cannot be
 * reached, which outranks one on its way back. Among incompatibilities the
 * failures (red) outrank the version mismatches (amber).
 */
const INCOMPATIBILITY_RANK: Readonly<Record<HostIncompatibility, number>> = {
  "database-too-new": 0,
  refused: 1,
  fenced: 2,
  "host-too-new": 3,
  "host-too-old": 4,
  "too-many-projects": 5,
};
const STATUS_RANK: Readonly<Record<HostLinkStatus, number>> = {
  incompatible: 0,
  offline: 1,
  reconnecting: 2,
  connecting: 3,
  "version-skewed": 4,
  open: 5,
};

function linkRank(link: HostLinkView): [number, number] {
  // This Mac's own limit, not the host's state: a host's link never reads it.
  if (link.status === "incompatible" && link.reason === "too-many-projects") {
    return [STATUS_RANK.open + 1, 0];
  }
  if (link.status === "incompatible") return [0, INCOMPATIBILITY_RANK[link.reason]];
  // The longest outage first: it is the one a person has waited on.
  if (link.status === "offline") return [STATUS_RANK.offline, link.since];
  return [STATUS_RANK[link.status], 0];
}

/**
 * A host's link from its projects' links: the worst of them, as the very
 * object a project holds (so an unchanged host keeps its record). A host
 * serving no project reads open: there is no link of it to judge.
 */
export function aggregateLink(links: readonly HostLinkView[]): HostLinkView {
  let worst: HostLinkView = OPEN_LINK;
  let worstRank = linkRank(worst);
  for (const link of links) {
    const rank = linkRank(link);
    if (rank[0] < worstRank[0] || (rank[0] === worstRank[0] && rank[1] < worstRank[1])) {
      worst = link;
      worstRank = rank;
    }
  }
  return worst;
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
  /**
   * When the current outage began (epoch ms): the moment the link last left
   * `ready`, or, for a link never ready, when its first attempt failed.
   * `null` while it serves, or while a never-ready link is on its first
   * attempt. {@link createHostLinkTracker} keeps it.
   */
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
 * shows, for ONE project's link. A source maps on every `subscribeState`
 * change AND at {@link hostLinkViewChangesAt}: an outage turns offline five
 * seconds in even when the link is quiet in a backoff or a handshake.
 *
 * An outage is one stretch, whatever the retries do inside it: reconnecting
 * for {@link HOST_OFFLINE_AFTER_MS}, then offline — through every later
 * `connecting` attempt (its countdown reads "Retrying") — until `ready`.
 * `database-too-new` never comes from the link: the host reports it (VC-602),
 * and the source sets it directly.
 */
export function hostLinkView(
  state: HostLinkState | RemoteHostLinkState,
  context: HostLinkContext,
): HostLinkView {
  switch (state.status) {
    case "ready":
      return context.availableUpdate
        ? { status: "version-skewed", availableVersion: context.availableUpdate }
        : { status: "open" };
    case "connecting": {
      if (context.droppedAt === null) {
        return context.everReady ? { status: "reconnecting" } : { status: "connecting" };
      }
      if (withinGrace(context, context.droppedAt)) return { status: "reconnecting" };
      // An attempt is in flight now: the countdown has reached it.
      return { status: "offline", since: context.droppedAt, retryAt: context.now };
    }
    case "unreachable": {
      const since = context.droppedAt ?? context.now;
      if (withinGrace(context, since)) return { status: "reconnecting" };
      return {
        status: "offline",
        since,
        retryAt: state.retryAt,
        ...(state.error.message ? { detail: state.error.message } : {}),
      };
    }
    case "refused":
      // Desktop main's own refusal, past its link cap: a reason no host sends.
      if ((state.error.reason as string | undefined) === REMOTE_HOST_TOO_MANY_PROJECTS) {
        return { status: "incompatible", reason: "too-many-projects" };
      }
      if (state.error.reason !== "protocol-version-unsupported") {
        return {
          status: "incompatible",
          reason: "refused",
          refusalCode: state.error.reason || state.error.code,
        };
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

/** A link that served before gets the grace; one that never served is offline at its first failure. */
function withinGrace(context: HostLinkContext, since: number): boolean {
  return context.everReady && context.now - since < HOST_OFFLINE_AFTER_MS;
}

/**
 * When {@link hostLinkView}'s answer for this state changes with no new link
 * state (epoch ms), or `null` when only the link can change it: the end of a
 * reconnecting grace. A source arms one timer for it and re-maps then.
 */
export function hostLinkViewChangesAt(
  state: HostLinkState | RemoteHostLinkState,
  context: HostLinkContext,
): number | null {
  if (state.status !== "connecting" && state.status !== "unreachable") return null;
  if (!context.everReady || context.droppedAt === null) return null;
  const at = context.droppedAt + HOST_OFFLINE_AFTER_MS;
  return at > context.now ? at : null;
}

/** One project link's outage bookkeeping, for a source that maps its states. */
export interface HostLinkTracker {
  /**
   * Feeds the link's state (every `subscribeState` change, and the timer
   * {@link HostLinkTracker.view} asks for); answers its view and when to ask again.
   */
  view(
    state: HostLinkState | RemoteHostLinkState,
    now: number,
    facts?: Pick<HostLinkContext, "availableUpdate" | "hostIsNewer" | "requiredVersion">,
  ): { readonly link: HostLinkView; readonly recheckAt: number | null };
}

/**
 * Keeps {@link HostLinkContext}'s `everReady` and `droppedAt` from a link's
 * state stream, so a source only feeds states and arms the timer it is told:
 * `ready` ends an outage; leaving `ready`, or a never-ready link's first
 * failure, starts one; retries inside it do not restart it.
 */
export function createHostLinkTracker(): HostLinkTracker {
  let everReady = false;
  let droppedAt: number | null = null;
  let last: HostLinkView | null = null;
  return {
    view(state, now, facts = {}) {
      if (state.status === "ready") {
        everReady = true;
        droppedAt = null;
      } else if (droppedAt === null && (everReady || state.status !== "connecting")) {
        droppedAt = now;
      }
      const context: HostLinkContext = { ...facts, everReady, droppedAt, now };
      const link = hostLinkView(state, context);
      // The same view keeps its object, so the store's readers do not redraw.
      if (last === null || JSON.stringify(last) !== JSON.stringify(link)) last = link;
      return { link: last, recheckAt: hostLinkViewChangesAt(state, context) };
    },
  };
}
