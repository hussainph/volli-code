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
import {
  hostOfProject,
  projectLinkOf,
  useHostConnectionStore,
  type HostConnectionState,
} from "@renderer/stores/host-connection";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

import { isLinkReady, relayHostLink } from "./relay-host-link";
import { startRemoteListingRefresh, type RemoteListingRefresh } from "./remote-listing-refresh";
import { createRemoteSessionStreams, type RemoteSessionStreams } from "./remote-session-streams";
import {
  remoteChatTransport,
  remoteListingReader,
  remoteSessionClient,
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
  readonly transport: ChatSessionTransport;
  readonly listing: SessionListingReader;
  readonly streams: RemoteSessionStreams;
  dispose(): void;
}

export interface RemoteSessionsDeps {
  readonly hosts: {
    getState(): Pick<HostConnectionState, "hosts" | "projects">;
    subscribe(listener: () => void): () => void;
  };
  /** Which remote projects are on screen (rail, Home or ticket panel). */
  readonly visibleProjects: () => readonly string[];
  /** The project a ticket is on, from the board this window holds. */
  readonly projectOfTicket: (ticketId: string) => string | null;
  /** Re-reads a remote project's listings: its rows, and its open tickets'. */
  readonly refreshListings: (projectId: string) => Promise<void>;
  readonly workspace: (projectId: string) => RemoteWorkspace;
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

/** The remote projects the host-connection store names: claimed by a host that is not This Mac. */
function remoteProjectIds(state: Pick<HostConnectionState, "hosts" | "projects">): string[] {
  return Object.keys(state.projects).filter((projectId) => !hostOfProject(state, projectId).local);
}

export function bindRemoteSessions(deps: RemoteSessionsDeps): RemoteSessions {
  const workspaces = new Map<string, RemoteWorkspace>();
  const isRemote = (projectId: string): boolean =>
    remoteProjectIds(deps.hosts.getState()).includes(projectId);
  const workspaceOf = (projectId: string): RemoteWorkspace | null => {
    if (!isRemote(projectId)) return null;
    let workspace = workspaces.get(projectId);
    if (workspace === undefined) {
      workspace = deps.workspace(projectId);
      workspaces.set(projectId, workspace);
    }
    return workspace;
  };

  // A project that stops being remote (forgotten, or its host gone) lets go
  // of its streams and timers at once.
  const prune = (): void => {
    const remote = new Set(remoteProjectIds(deps.hosts.getState()));
    for (const [projectId, workspace] of workspaces) {
      if (remote.has(projectId)) continue;
      workspaces.delete(projectId);
      workspace.dispose();
    }
  };
  const stopPruning = deps.hosts.subscribe(prune);

  const unregisterTransports = setRemoteChatTransports({
    forProject: (projectId) => workspaceOf(projectId)?.transport ?? null,
  });
  const unregisterListing = setRemoteSessionListing({
    forProject: (projectId) => workspaceOf(projectId)?.listing ?? null,
    forTicket: (ticketId) => {
      const projectId = deps.projectOfTicket(ticketId);
      return projectId === null ? null : (workspaceOf(projectId)?.listing ?? null);
    },
  });

  const ready = (projectId: string): boolean =>
    isLinkReady(projectLinkOf(deps.hosts.getState(), projectId));
  const refresh = startRemoteListingRefresh({
    workspaces: () => remoteProjectIds(deps.hosts.getState()),
    visible: deps.visibleProjects,
    ready,
    windowVisible: () => deps.window.document.visibilityState === "visible",
    refresh: deps.refreshListings,
    onReconnect(listener) {
      // A Workspace's link back to ready: the moment its listing can be read.
      let wasReady = new Set(remoteProjectIds(deps.hosts.getState()).filter(ready));
      return deps.hosts.subscribe(() => {
        const now = new Set(remoteProjectIds(deps.hosts.getState()).filter(ready));
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

  let stopped = false;
  return {
    show(projectId, sessionId) {
      const workspace = stopped ? null : workspaceOf(projectId);
      return workspace === null ? () => {} : workspace.streams.show(sessionId);
    },
    refresh,
    stop() {
      if (stopped) return;
      stopped = true;
      refresh.stop();
      stopPruning();
      unregisterTransports();
      unregisterListing();
      for (const workspace of workspaces.values()) workspace.dispose();
      workspaces.clear();
    },
  };
}

/** One remote Workspace over main's relay, as production builds it. */
export function relayedWorkspace(projectId: string): RemoteWorkspace {
  const client = remoteSessionClient(relayHostLink(projectId));
  const streams = createRemoteSessionStreams({
    clock: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  });
  return {
    projectId,
    transport: remoteChatTransport(client, streams, window),
    listing: remoteListingReader(client),
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
    projectOfTicket: (ticketId) => {
      for (const [projectId, tickets] of Object.entries(
        useBoardStore.getState().ticketsByProject,
      )) {
        if (tickets.some((ticket) => ticket.id === ticketId)) return projectId;
      }
      return null;
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
  React.useEffect(() => {
    if (projectId === null) return undefined;
    return remoteSessions()?.show(projectId, sessionId);
  }, [projectId, sessionId]);
}
