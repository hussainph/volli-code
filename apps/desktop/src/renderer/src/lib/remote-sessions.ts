/**
 * Sessions on a remote host, from this window (VC-713): chat, the listing,
 * and the re-reads that stand in for events until hostd pushes them.
 *
 * Every remote project's Sessions go over that project's Workspace link,
 * reached through main's relay (`relayHostLink`, VC-711), as a typed Session
 * router client (`hostLinkTrpcLink`). Per remote Workspace this binds:
 *
 * - **Chat.** A {@link ChatSessionTransport} over that client with the
 *   `"host-link"` stream recovery: `sessions.create` and `attach`,
 *   `session.command` (send, answer, stop), `cancelInteraction` and the queue
 *   all go to the host. A Session is created with no model of this Mac's, so
 *   the host's default applies, and with the renderer-minted
 *   `requestedSessionId` a Draft carries. Its stream opens only while it is
 *   on screen ({@link createRemoteSessionStreams}, AM1).
 * - **Listing.** `session.listing` / `session.listingForTicket`, the same rows
 *   `volli:session-list` serves, for the rail, Home and the ticket panel.
 * - **Attention on reopen.** {@link startRemoteListingRefresh}: the listing is
 *   re-read on reconnect, focus, a wake and a 30 s poll of the project on
 *   screen, so a Session waiting on the person shows when the lid opens.
 *
 * It all runs only while `cloud` is on ({@link bindRemoteSessionsWhileCloud});
 * off, nothing is registered and every Session is This Mac's, over IPC,
 * exactly as before. Each Workspace's streams and timers are owned here and
 * end when its project stops being remote, when `cloud` turns off, or when
 * the binding stops.
 */
import type { ChatSessionTransport } from "@volli/session-presentation";
import * as React from "react";

import { setRemoteChatTransports } from "@renderer/chat/transport";
import { useBoardStore } from "@renderer/stores/board";
import { isExperimentOn, useExperimentsStore } from "@renderer/stores/experiments";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  hostOfProject,
  projectLinkOf,
  useHostConnectionStore,
  type HostConnectionState,
  type HostLinkView,
} from "@renderer/stores/host-connection";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import {
  useRemoteSessionAvailabilityStore,
  type RemoteSessionAvailabilityState,
} from "@renderer/stores/remote-session-availability";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

import type { SessionsResult } from "../../../ipc/contract";
import { isLinkReady, relayHostLink } from "./relay-host-link";
import { rememberRemoteProject } from "./remote-owners";
import { startRemoteListingRefresh, type RemoteListingRefresh } from "./remote-listing-refresh";
import { createRemoteSessionStreams, type RemoteSessionStreams } from "./remote-session-streams";
import {
  remoteChatTransport,
  remoteListingReader,
  remoteSessionClient,
  sessionsUnavailableOn,
  type RemoteSessionClient,
  type SessionListingReader,
} from "./remote-session-wire";
import { setRemoteSessionListing } from "./session-listing-reader";

export {
  listingRowsFromWire,
  remoteChatTransport,
  remoteListingReader,
  remoteSessionClient,
  type RemoteSessionClient,
  type RemoteSessionRouter,
} from "./remote-session-wire";

/** One remote Workspace's Session plumbing, owned by the binding. */
export interface RemoteWorkspace {
  readonly projectId: string;
  /** The Workspace's typed Session client: the doors outside the chat core use it (B2). */
  readonly client: Pick<RemoteSessionClient, "session">;
  readonly transport: ChatSessionTransport;
  readonly listing: SessionListingReader;
  readonly streams: RemoteSessionStreams;
  dispose(): void;
}

/** What a Workspace is built from: its project, its host's name, and who hears a missing grant. */
export interface RemoteWorkspaceInput {
  readonly projectId: string;
  readonly hostName: string;
  /** The host refused the listing as an operation it never granted this link (B3). */
  readonly notGranted: () => void;
}

export interface RemoteSessionsDeps {
  readonly hosts: {
    getState(): Pick<HostConnectionState, "hosts" | "projects">;
    subscribe(listener: () => void): () => void;
  };
  /** Which remote projects are on screen (rail, Home or ticket panel). */
  readonly visibleProjects: () => readonly string[];
  /** Re-reads a remote project's listings: its rows, and its open tickets'. */
  readonly refreshListings: (projectId: string) => Promise<void>;
  readonly workspace: (input: RemoteWorkspaceInput) => RemoteWorkspace;
  /**
   * Re-homes the resident chat clients of these projects onto whatever
   * transport each project resolves to now (B4): the binding's Workspace when
   * it is bound, else the closed one in the host's name.
   */
  readonly rebindSessions: (projectIds: readonly string[]) => void;
  /** Where a host that grants no Session features is named (B3). */
  readonly availability: Pick<RemoteSessionAvailabilityState, "setUnavailable">;
  readonly window: Pick<Window, "addEventListener" | "removeEventListener"> & {
    readonly document: Pick<
      Document,
      "visibilityState" | "addEventListener" | "removeEventListener"
    >;
  };
  readonly clock: {
    now(): number;
    setTimeout(run: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

/** The bound remote Sessions: a Workspace's streams, for the hook that says what is on screen. */
export interface RemoteSessions {
  /** Says a Session of a remote project is on screen; returns the release. */
  show(projectId: string, sessionId: string): () => void;
  /** The listing schedule, for a caller that wants every remote listing read now. */
  readonly refresh: RemoteListingRefresh;
  stop(): void;
}

/** A listing a host never granted: answered empty at once, never asked of it again (B3). */
const quietListing = async (): Promise<SessionsResult> => ({ ok: true, sessions: [] });
const NOT_GRANTED_LISTING: SessionListingReader = {
  list: quietListing,
  listForTicket: quietListing,
};

/** The remote projects the host-connection store names: claimed by a host that is not This Mac. */
function remoteProjectIds(state: Pick<HostConnectionState, "hosts" | "projects">): string[] {
  return Object.keys(state.projects).filter((projectId) => !hostOfProject(state, projectId).local);
}

/*
 * Which binding owns remote Sessions now, as a number a mounted view can
 * depend on: it moves whenever a binding starts or stops, or a project's
 * Workspace is built or let go, so a visible chat asks the CURRENT owner for
 * its stream slot (B4).
 */
let generation = 0;
const generationListeners = new Set<() => void>();
function nextGeneration(): void {
  generation += 1;
  for (const listener of generationListeners) listener();
}
function subscribeGeneration(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}
const currentGeneration = (): number => generation;

export function bindRemoteSessions(deps: RemoteSessionsDeps): RemoteSessions {
  const workspaces = new Map<string, RemoteWorkspace>();
  /** A project whose host refused the listing as never granted, and the link it refused under. */
  const refusedUnder = new Map<string, HostLinkView>();
  let stopped = false;

  const linkOf = (projectId: string): HostLinkView =>
    projectLinkOf(deps.hosts.getState(), projectId);
  const hostNameOf = (projectId: string): string =>
    hostOfProject(deps.hosts.getState(), projectId).name;
  /** Not granted under the link the project holds now: a new welcome may grant it. */
  const notGrantedNow = (projectId: string): boolean =>
    refusedUnder.has(projectId) && refusedUnder.get(projectId) === linkOf(projectId);

  /** Records who owns each project a remote host claims now (B1), and answers the set. */
  const claimedNow = (): Set<string> => {
    const state = deps.hosts.getState();
    const now = new Set(remoteProjectIds(state));
    for (const projectId of now) {
      const host = hostOfProject(state, projectId);
      rememberRemoteProject(projectId, { hostId: host.id, hostName: host.name });
    }
    return now;
  };
  let claimed = claimedNow();

  const workspaceOf = (projectId: string): RemoteWorkspace | null => {
    if (stopped || !claimed.has(projectId)) return null;
    let workspace = workspaces.get(projectId);
    if (workspace === undefined) {
      workspace = deps.workspace({
        projectId,
        hostName: hostNameOf(projectId),
        notGranted: () => {
          if (stopped || !claimed.has(projectId)) return;
          refusedUnder.set(projectId, linkOf(projectId));
          deps.availability.setUnavailable(projectId, sessionsUnavailableOn(hostNameOf(projectId)));
        },
      });
      workspaces.set(projectId, workspace);
    }
    return workspace;
  };

  /** A project's listing, asked of its host only while the host may grant it. */
  const listingOf = (projectId: string): SessionListingReader | null => {
    const workspace = workspaceOf(projectId);
    if (workspace === null) return null;
    return notGrantedNow(projectId) ? NOT_GRANTED_LISTING : workspace.listing;
  };

  const unregisterTransports = setRemoteChatTransports({
    forProject: (projectId) => workspaceOf(projectId)?.transport ?? null,
    clientFor: (projectId) => workspaceOf(projectId)?.client ?? null,
  });
  const unregisterListing = setRemoteSessionListing({ forProject: listingOf });

  // Polled, focused and reconnected reads only for a link that is ready AND
  // may grant the listing: an older host is not asked again until its link
  // changes (B3).
  const ready = (projectId: string): boolean =>
    isLinkReady(linkOf(projectId)) && !notGrantedNow(projectId);
  const refresh = startRemoteListingRefresh({
    workspaces: () => [...claimed],
    visible: deps.visibleProjects,
    ready,
    windowVisible: () => deps.window.document.visibilityState === "visible",
    refresh: deps.refreshListings,
    onReconnect(listener) {
      // A Workspace's link back to ready: the moment its listing can be read.
      let wasReady = new Set([...claimed].filter(ready));
      return deps.hosts.subscribe(() => {
        const now = new Set([...claimed].filter(ready));
        for (const projectId of now) if (!wasReady.has(projectId)) listener(projectId);
        wasReady = now;
      });
    },
    onFocus(listener) {
      const visible = (): void => {
        if (deps.window.document.visibilityState === "visible") listener();
      };
      deps.window.addEventListener("focus", listener);
      deps.window.document.addEventListener("visibilitychange", visible);
      return () => {
        deps.window.removeEventListener("focus", listener);
        deps.window.document.removeEventListener("visibilitychange", visible);
      };
    },
    clock: deps.clock,
  });

  /**
   * Every host change: remember who owns each claimed project (B1), let go
   * of a project no longer claimed (its streams, its pending re-reads, its
   * named state) and re-home its resident chats onto the closed transport, re-
   * home a project claimed again onto its new Workspace (B4), and forget a
   * refusal once the link it was made under has changed (B3).
   */
  const reconcile = (): void => {
    const now = claimedNow();
    const moved: string[] = [];
    for (const projectId of now) if (!claimed.has(projectId)) moved.push(projectId);
    for (const projectId of claimed) {
      if (now.has(projectId)) continue;
      moved.push(projectId);
      workspaces.get(projectId)?.dispose();
      workspaces.delete(projectId);
      refusedUnder.delete(projectId);
      deps.availability.setUnavailable(projectId, null);
    }
    for (const [projectId, link] of refusedUnder) {
      if (now.has(projectId) && link === linkOf(projectId)) continue;
      refusedUnder.delete(projectId);
      deps.availability.setUnavailable(projectId, null);
    }
    claimed = now;
    refresh.prune();
    if (moved.length > 0) {
      nextGeneration();
      deps.rebindSessions(moved);
    }
  };
  const stopReconciling = deps.hosts.subscribe(reconcile);
  // Resident chats of the projects claimed now move onto this binding (a
  // binding that came before left them on the closed transport).
  nextGeneration();
  if (claimed.size > 0) deps.rebindSessions([...claimed]);

  // The window going (closed, reloaded, navigated) ends everything this owns
  // at once, rather than leaving its timers to the page's teardown.
  const stopOnPageHide = (): void => end(false);
  deps.window.addEventListener("pagehide", stopOnPageHide);

  function end(rehome: boolean): void {
    if (stopped) return;
    stopped = true;
    deps.window.removeEventListener("pagehide", stopOnPageHide);
    refresh.stop();
    stopReconciling();
    unregisterTransports();
    unregisterListing();
    for (const workspace of workspaces.values()) workspace.dispose();
    workspaces.clear();
    for (const projectId of refusedUnder.keys()) deps.availability.setUnavailable(projectId, null);
    refusedUnder.clear();
    const owned = [...claimed];
    claimed = new Set();
    nextGeneration();
    // Resident chats move to the closed transport rather than keep a stream
    // allocator that is gone; a binding that follows re-homes them again.
    if (rehome && owned.length > 0) deps.rebindSessions(owned);
  }

  return {
    show(projectId, sessionId) {
      const workspace = workspaceOf(projectId);
      return workspace === null ? () => {} : workspace.streams.show(sessionId);
    },
    refresh,
    stop: () => end(true),
  };
}

/** One remote Workspace over main's relay, as production builds it. */
export function relayedWorkspace(input: RemoteWorkspaceInput): RemoteWorkspace {
  const client = remoteSessionClient(relayHostLink(input.projectId), input.hostName);
  const streams = createRemoteSessionStreams({
    clock: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  });
  return {
    projectId: input.projectId,
    client,
    transport: remoteChatTransport(client, streams, window),
    listing: remoteListingReader(client, input.notGranted),
    streams,
    dispose: () => streams.dispose(),
  };
}

/** Production's dependencies: the window's stores, its document, its timers. */
export function windowRemoteSessionsDeps(): RemoteSessionsDeps {
  return {
    hosts: useHostConnectionStore,
    visibleProjects: () => {
      const selected = useProjectsStore.getState().selectedProjectId;
      return selected === null ? [] : [selected];
    },
    refreshListings: async (projectId) => {
      const tickets = Object.keys(useTicketSessionRecordsStore.getState().byTicket).filter(
        (ticketId) =>
          useBoardStore
            .getState()
            .ticketsByProject[projectId]?.some((ticket) => ticket.id === ticketId) === true,
      );
      await Promise.all([
        useProjectSessionsStore.getState().refresh(projectId, { quiet: true }),
        ...tickets.map((ticketId) =>
          useTicketSessionRecordsStore.getState().refresh(ticketId, { quiet: true }),
        ),
      ]);
    },
    workspace: relayedWorkspace,
    rebindSessions: (projectIds) => useChatSessionsStore.getState().rebindChatSessions(projectIds),
    availability: useRemoteSessionAvailabilityStore.getState(),
    window,
    clock: {
      now: () => Date.now(),
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  };
}

let bound: RemoteSessions | null = null;

/** The bound remote Sessions while `cloud` is on, else null. */
export function remoteSessions(): RemoteSessions | null {
  return bound;
}

/**
 * Binds remote Sessions while `cloud` is on, and unbinds them when it turns
 * off: off, nothing is registered, so the flag-off app is exactly as before.
 * The returned function stops the binding.
 */
export function bindRemoteSessionsWhileCloud(
  experiments: {
    getState(): { readonly snapshot: Parameters<typeof isExperimentOn>[0] };
    subscribe(listener: () => void): () => void;
  } = useExperimentsStore,
  deps: () => RemoteSessionsDeps = windowRemoteSessionsDeps,
): () => void {
  const sync = (): void => {
    const on = isExperimentOn(experiments.getState().snapshot, "cloud");
    if (on && bound === null) bound = bindRemoteSessions(deps());
    else if (!on && bound !== null) {
      bound.stop();
      bound = null;
    }
  };
  const unsubscribe = experiments.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    bound?.stop();
    bound = null;
  };
}

/**
 * Says a Session is on screen while the calling view is mounted, so its
 * stream may open (AM1). A no-op for This Mac's Sessions and with `cloud` off.
 */
export function useRemoteSessionOnScreen(projectId: string | null, sessionId: string): void {
  // The current owner, not the one this view mounted under (B4): a rebind
  // moves the generation, and the slot is asked of the new binding.
  const owner = React.useSyncExternalStore(
    subscribeGeneration,
    currentGeneration,
    currentGeneration,
  );
  React.useEffect(() => {
    if (projectId === null) return undefined;
    return remoteSessions()?.show(projectId, sessionId);
  }, [projectId, sessionId, owner]);
}
