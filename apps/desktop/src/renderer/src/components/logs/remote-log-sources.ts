/**
 * Every connected remote host in the one log viewer (VC-712; exit criterion
 * 6 of "Remote dogfood v1").
 *
 * Desktop main holds each remote Workspace's link; the window reaches one
 * through the Workspace link relay (`relayHostLink`, VC-711). This watches the
 * host-connection store and keeps one log source per remote host registered
 * ({@link registerRemoteLogSource}), labelled with the host's name:
 *
 * - **Registered** when one of the host's projects has a ready link whose
 *   welcome granted `host.logs` (`ProjectLink.granted`).
 * - **Read over any ready, granted link of the host**, the least loaded
 *   first: the project the window shows carries its board and its chats, so
 *   it comes last. When the link in use closes, the source moves to the next
 *   ready one and resumes after its last line; when every one is full (the
 *   relay's stream budget, AM1), it polls the newest lines instead.
 * - **Its dot is the host's link**: live while a link serves it; connecting
 *   while the host's links come back; failed, worded, while it cannot be
 *   reached or cannot serve.
 * - **Unregistered** when the host is forgotten, or loses its links: none
 *   of its projects is left, or each one's link has closed or can no longer
 *   serve this app. A host that only dropped stays, its dot saying so.
 *
 * Nothing here runs for a host the store does not list, so with `cloud` off
 * (no remote hosts at all) nothing registers.
 */
import type { HostError } from "@volli/host-protocol";

import { isLinkReady, relayHostLink, type RelayHostLinkOptions } from "../../lib/relay-host-link";
import {
  useHostConnectionStore,
  type HostConnectionState,
  type HostLinkView,
  type HostRecord,
  type ProjectLink,
} from "../../stores/host-connection";

import {
  hostLinkLogSource,
  registerRemoteLogSource,
  type HostLinkLogSourceTiming,
  type LogSource,
  type LogSourceLink,
  type LogSourceLinkChoice,
  type LogSourceLinks,
  type LogSourceStatus,
} from "./log-sources";

/** The feature whose operations (`logs.tail`, `logs.follow`) a host's log source reads. */
export const HOST_LOGS_FEATURE = "host.logs";

type HostState = Pick<HostConnectionState, "hosts" | "projects">;

export interface RemoteLogSourcesOptions {
  /** The host-connection store, by default the app's. */
  readonly hosts?: {
    getState(): HostState;
    subscribe(listener: () => void): () => void;
  };
  /** The project the window shows, whose link carries the most (it goes last); none by default. */
  readonly shown?: () => string | null;
  /** One Workspace's link as a log source reads it: the relay, by default. */
  readonly link?: (workspaceId: string) => LogSourceLink;
  readonly register?: (source: LogSource) => () => void;
  readonly timing?: HostLinkLogSourceTiming;
}

/**
 * A Workspace's relayed link as a log source reads it. Each stream gets its
 * own relay handle, so the relay's "this stream waits for a slot" reaches the
 * one stream it is about (`onLimited`), and the source can read elsewhere
 * instead of waiting. Nothing is cast: the relay's slice of the client.
 */
export function relayLogLink(
  workspaceId: string,
  options: Omit<RelayHostLinkOptions, "onStreamLimited"> = {},
): LogSourceLink {
  const calls = relayHostLink(workspaceId, options);
  return {
    query: (path, input) => calls.query(path, input),
    subscribe(path, input, handlers) {
      const own = relayHostLink(workspaceId, {
        ...options,
        onStreamLimited: ({ error }: { error: HostError }) => handlers.onLimited?.(error),
      });
      return own.subscribe(path, input, {
        onData: (data) => handlers.onData(data),
        onResnapshot: (error) => handlers.onResnapshot(error),
        onError: (error) => handlers.onError(error),
        onStarted: () => handlers.onStarted?.(),
        onComplete: () => handlers.onComplete?.(),
      });
    },
  };
}

/** Whether a project's link has closed for good, or cannot serve this app: it is no link. */
function isGone(link: HostLinkView): boolean {
  return link.status === "incompatible" || (link.status === "offline" && link.retryAt === null);
}

/** The host's link, worded for its log source's dot while no link of it is ready. */
export function waitingStatus(host: HostRecord | undefined): {
  readonly status: LogSourceStatus;
  readonly detail?: string;
} {
  const name = host?.name ?? "This host";
  switch (host?.link.status) {
    case "connecting":
    case "reconnecting":
      return { status: "connecting", detail: `Reconnecting to ${name}…` };
    case "offline":
      return { status: "failed", detail: `${name} can’t be reached right now.` };
    case "incompatible":
      return { status: "failed", detail: `${name} can’t serve this app.` };
    default:
      return {
        status: "connecting",
        detail: `Waiting for a link to ${name} that carries its log…`,
      };
  }
}

/** Whether a project's link serves its host's log now: ready, and its welcome granted `host.logs`. */
function servesLogs(claim: ProjectLink): boolean {
  return isLinkReady(claim.link) && claim.granted?.includes(HOST_LOGS_FEATURE) === true;
}

/**
 * The source, with each reading of it kept in `readings` until it stops, so
 * whoever registered it can stop them all (unregistering alone does not stop
 * a reading already running). Stopping one twice is stopping it once.
 */
function owned(source: LogSource, readings: Set<() => void>): LogSource {
  return {
    id: source.id,
    label: source.label,
    start(handlers) {
      const stopReading = source.start(handlers);
      const stop = (): void => {
        if (!readings.delete(stop)) return;
        stopReading();
      };
      readings.add(stop);
      return stop;
    },
  };
}

/**
 * Keeps every connected remote host's log source registered while it is
 * attached; the returned function unregisters them all, stops every reading
 * of them still running, and stops watching.
 */
export function attachRemoteLogSources(options: RemoteLogSourcesOptions = {}): () => void {
  const hosts = options.hosts ?? useHostConnectionStore;
  const shown = options.shown ?? (() => null);
  const linkOf = options.link ?? ((workspaceId: string) => relayLogLink(workspaceId));
  const register = options.register ?? registerRemoteLogSource;

  interface Registered {
    readonly label: string;
    /** Takes it out of the viewer and stops every reading of it still running. */
    readonly unregister: () => void;
  }
  const registered = new Map<string, Registered>();
  /** One link per Workspace, kept while its project is listed: a source compares them by key. */
  const links = new Map<string, LogSourceLink>();
  const listeners = new Set<() => void>();

  const hostOf = (hostId: string): HostRecord | undefined =>
    hosts.getState().hosts.find((host) => host.id === hostId);

  /** The host's ready links that grant `host.logs`: the shown project's last, then by id. */
  function readyOf(hostId: string): readonly LogSourceLinkChoice[] {
    const current = shown();
    return Object.entries(hosts.getState().projects)
      .filter(([, claim]) => claim.hostId === hostId && servesLogs(claim))
      .map(([workspaceId]) => workspaceId)
      .toSorted((a, b) => Number(a === current) - Number(b === current) || (a < b ? -1 : 1))
      .map((workspaceId) => {
        let link = links.get(workspaceId);
        if (link === undefined) {
          link = linkOf(workspaceId);
          links.set(workspaceId, link);
        }
        return { key: workspaceId, link };
      });
  }

  function linksOf(hostId: string): LogSourceLinks {
    return {
      ready: () => readyOf(hostId),
      waiting: () => waitingStatus(hostOf(hostId)),
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
  }

  function sync(): void {
    const state = hosts.getState();
    for (const workspaceId of links.keys()) {
      if (!(workspaceId in state.projects)) links.delete(workspaceId);
    }
    for (const host of state.hosts) {
      if (host.local) continue;
      const claims = Object.values(state.projects).filter((claim) => claim.hostId === host.id);
      const held = registered.get(host.id);
      // No link of the host can carry its log now or once it is back: no
      // project left, each one's link gone, or ready without `host.logs` (a
      // host that reconnected as one with no log to offer). A link still on
      // its way back keeps the source (`every` of none is true).
      const noLog = claims.every(
        (claim) => isGone(claim.link) || (isLinkReady(claim.link) && !servesLogs(claim)),
      );
      if (held !== undefined && noLog) {
        registered.delete(host.id);
        held.unregister();
        continue;
      }
      // Renamed: the same source under its new name.
      if (held !== undefined && held.label !== host.name) {
        registered.delete(host.id);
        held.unregister();
      }
      if (registered.has(host.id) || readyOf(host.id).length === 0) continue;
      const readings = new Set<() => void>();
      const source = owned(
        hostLinkLogSource(
          { id: host.id, label: host.name, links: linksOf(host.id) },
          options.timing,
        ),
        readings,
      );
      const unregister = register(source);
      registered.set(host.id, {
        label: host.name,
        unregister: () => {
          unregister();
          for (const stop of Array.from(readings)) stop();
        },
      });
    }
    // Forgotten hosts.
    for (const [hostId, held] of registered) {
      if (state.hosts.some((host) => host.id === hostId)) continue;
      registered.delete(hostId);
      held.unregister();
    }
    for (const listener of Array.from(listeners)) listener();
  }

  const unsubscribe = hosts.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    for (const held of Array.from(registered.values())) held.unregister();
    registered.clear();
    links.clear();
    listeners.clear();
  };
}

/** The page's lifetime as a binding reads it: the window's `pagehide` and `pageshow`. */
export interface PageLifetime {
  addEventListener(type: "pagehide" | "pageshow", listener: (event: Event) => void): void;
  removeEventListener(type: "pagehide" | "pageshow", listener: (event: Event) => void): void;
}

/**
 * {@link attachRemoteLogSources} for as long as the page lives (VC-712): its
 * disposer is this owner's. On `pagehide` every source is unregistered and
 * every reading of one stops (streams, polls, retries), and nothing late lands
 * after; a page restored from the back-forward cache (`pageshow`, persisted)
 * attaches again. The returned function ends it for good.
 */
export function attachRemoteLogSourcesForPage(
  options: RemoteLogSourcesOptions & { readonly page?: PageLifetime } = {},
): () => void {
  const { page = window, ...attach } = options;
  let detach: (() => void) | null = attachRemoteLogSources(attach);
  const hide = (): void => {
    detach?.();
    detach = null;
  };
  const show = (event: Event): void => {
    const restored = "persisted" in event && event.persisted === true;
    if (restored && detach === null) detach = attachRemoteLogSources(attach);
  };
  page.addEventListener("pagehide", hide);
  page.addEventListener("pageshow", show);
  return () => {
    page.removeEventListener("pagehide", hide);
    page.removeEventListener("pageshow", show);
    hide();
  };
}
