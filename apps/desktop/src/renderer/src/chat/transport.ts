/**
 * The desktop's {@link ChatSessionTransport} — the one module where the chat
 * core's seams meet the renderer's actual plumbing: the IPC-backed tRPC
 * client, the window's frame/timer pacing, and the platform's id mint. It
 * exists so the client core can stay framework-neutral (VC-169): everything
 * here is exactly what a second Volli client would replace, and nothing here
 * is anything the core needs to know.
 */
import { racingFlushScheduler, type ChatSessionTransport } from "@volli/session-presentation";
import type { SourceIconsWatchInput, SourceIconsSnapshot } from "@volli/shared";

import { hostNotConnected, remoteOwnerOf } from "@renderer/lib/remote-owners";
import { closedRemoteTransport, type RemoteSessionClient } from "@renderer/lib/remote-session-wire";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { cloudSession } from "@renderer/lib/cloud-client";
import { cloudChatTransport } from "@renderer/lib/cloud-session-transport";
import { CLOUD_SESSION_READ_ONLY } from "@renderer/lib/cloud-session-read-only";
import { launchStore } from "@renderer/stores/launch";

/** The app's transport. Built per call; the RPC client underneath is a singleton. */
export function browserChatTransport(): ChatSessionTransport {
  const rpc = sessionRpcClient();
  return {
    rpc,
    scheduler: racingFlushScheduler(window),
    newCommandId: () => crypto.randomUUID(),
    // One procedure per verb: the nullable ticketId IS the Role on create,
    // and an attach needs no Role at all — the server owns the Session's
    // durable state, so nothing here re-derives what it already knows.
    createSession: (input) =>
      rpc.sessions.create.mutate({
        operationId: input.operationId,
        projectId: input.projectId,
        ticketId: input.ticketId,
        title: input.title,
        ...(input.requestedSessionId === undefined
          ? {}
          : { requestedSessionId: input.requestedSessionId }),
        ...(input.skills === undefined ? {} : { skills: [...input.skills] }),
        ...(input.autoSelect === undefined ? {} : { autoSelect: input.autoSelect }),
        // A picked model reaches the wire as the OVERRIDE it is: the server
        // merges it onto the app default for the Role and refuses one Model
        // Access cannot honor, exactly as it does for `volli session start
        // --model`. Splitting the selection here rather than in the store keeps
        // the shape difference at the one boundary that has it.
        ...(input.model === undefined
          ? {}
          : {
              modelOverride: {
                model: { providerId: input.model.providerId, modelId: input.model.modelId },
                reasoningLevel: input.model.reasoningLevel,
              },
            }),
      }),
    attachSession: (input) =>
      rpc.sessions.attach.mutate({
        operationId: input.operationId,
        sessionId: input.sessionId,
      }),
  };
}

/**
 * This Mac's own create and attach, for a cloud launch's chats: a chat started
 * here is runner-originated (this Mac's runner mints it and its first accept
 * registers it with Volli Cloud), so it is minted through the same two
 * semantic doors as a local launch's. Main runs them against the cloud product
 * store and refuses what this Mac's runner may not start. Nothing else of the
 * IPC transport is handed over: every read and every command of an existing
 * Session stays Volli Cloud's.
 */
function thisMacStarts(): Pick<ChatSessionTransport, "createSession" | "attachSession"> {
  return {
    createSession: (input) => browserChatTransport().createSession(input),
    attachSession: (input) => browserChatTransport().attachSession(input),
  };
}

/**
 * The transports for Sessions on a remote host (VC-713): one per Workspace,
 * over its link, with the `"host-link"` stream recovery. Registered by
 * whoever owns the Workspace links (the relay binding, behind `cloud`); with
 * nothing registered, which is the flag off, every Session is This Mac's.
 */
export interface RemoteChatTransports {
  forProject(projectId: string): ChatSessionTransport | null;
  /** The Workspace's typed Session client, for a door outside the chat core (the Island's Stop). */
  clientFor(projectId: string): Pick<RemoteSessionClient, "session"> | null;
}

let remoteTransports: RemoteChatTransports | null = null;

/** Registers the remote half; the returned function removes only this registration. */
export function setRemoteChatTransports(transports: RemoteChatTransports): () => void {
  remoteTransports = transports;
  return () => {
    if (remoteTransports === transports) remoteTransports = null;
  };
}

/** Preserve the router's input/answer, not tRPC's client-only error promise tag. */
export type SessionCommandDoor = (
  input: Parameters<RemoteSessionClient["session"]["command"]["mutate"]>[0],
) => Promise<Awaited<ReturnType<RemoteSessionClient["session"]["command"]["mutate"]>>>;

type SessionPictureDoor = (
  input: Parameters<RemoteSessionClient["session"]["picture"]["query"]>[0],
) => Promise<Awaited<ReturnType<RemoteSessionClient["session"]["picture"]["query"]>>>;

/** The transcript context's cache-only source-icon subscription seam. */
export interface TranscriptSourceIconsTransport {
  watch(
    input: SourceIconsWatchInput,
    onSnapshot: (snapshot: SourceIconsSnapshot) => void,
  ): () => void;
}

/**
 * One project's Session door: every way the renderer reaches that project's
 * Sessions, behind the one routing decision {@link sessionDoorFor} makes.
 * Each capability is built when asked, so asking for one never opens another
 * path's link.
 */
export interface SessionDoor {
  /** The chat core's transport. */
  transport(): ChatSessionTransport;
  /** `session.command` for the doors outside the chat core that command a Session by id (the Island's Stop). */
  command(): SessionCommandDoor;
  /** Saved images: the Session's host's, never This Mac's by fallback. */
  picture(): SessionPictureDoor;
  /** Local decoration only: `null` for a remote or cloud Session, never routed to This Mac. */
  sourceIcons(): TranscriptSourceIconsTransport | null;
}

type SessionRoute =
  | { readonly kind: "cloud" }
  | { readonly kind: "this-mac" }
  | { readonly kind: "remote"; readonly projectId: string; readonly hostName: string };

/**
 * The one routing decision: Volli Cloud for a cloud launch, else the remote
 * host a project was ever seen on (VC-713, B1), else This Mac. A project known
 * remote stays its host's even while its Workspace is not bound here.
 */
function sessionRouteOf(projectId: string | null): SessionRoute {
  if (launchStore() === "cloud") return { kind: "cloud" };
  const owner = remoteOwnerOf(projectId);
  if (owner === null) return { kind: "this-mac" };
  // Only a project id has a remote owner.
  return { kind: "remote", projectId: projectId!, hostName: owner.hostName };
}

/**
 * A project's Session door. The route, host name included, is fixed when this
 * runs, so ask for a door at the point of use and never hold one across time:
 * a held door keeps a stale route. A remote Workspace is looked up when a
 * capability is asked for.
 */
export function sessionDoorFor(projectId: string | null): SessionDoor {
  const route = sessionRouteOf(projectId);
  switch (route.kind) {
    case "cloud":
      return cloudDoor;
    case "this-mac":
      return thisMacDoor(projectId);
    case "remote":
      return remoteDoor(route.projectId, route.hostName);
  }
}

const cloudDoor: SessionDoor = {
  transport: () => cloudChatTransport(cloudSession(), thisMacStarts()),
  command: () => () => Promise.reject(new Error(CLOUD_SESSION_READ_ONLY)),
  picture: () => () => Promise.reject(new Error("Saved pictures are not available yet in cloud")),
  sourceIcons: () => null,
};

/** A remote host's Session; one whose Workspace is not bound now fails closed in the host's name. */
function remoteDoor(projectId: string, hostName: string): SessionDoor {
  const client = () => remoteTransports?.clientFor(projectId) ?? null;
  const notConnected = () => Promise.reject(new Error(hostNotConnected(hostName)));
  return {
    transport: () =>
      remoteTransports?.forProject(projectId) ?? closedRemoteTransport(hostName, window),
    command: () => {
      const bound = client();
      return bound === null ? notConnected : (input) => bound.session.command.mutate(input);
    },
    picture: () => {
      const bound = client();
      return bound === null ? notConnected : (input) => bound.session.picture.query(input);
    },
    sourceIcons: () => null,
  };
}

function thisMacDoor(projectId: string | null): SessionDoor {
  return {
    transport: () => browserChatTransport(),
    command: () => (input) => sessionRpcClient().session.command.mutate(input),
    picture: () => (input) => sessionRpcClient().session.picture.query(input),
    sourceIcons: () => thisMacSourceIcons(projectId),
  };
}

function thisMacSourceIcons(projectId: string | null): TranscriptSourceIconsTransport {
  // Re-asked at each step: a project that leaves This Mac mid-watch stops here.
  const local = () => sessionRouteOf(projectId).kind === "this-mac";
  return {
    watch(input, onSnapshot) {
      let cancelled = false;
      let subscription: { unsubscribe(): void } | undefined;
      const origins = [...input.origins];
      const missing = (): void => {
        if (!cancelled)
          onSnapshot({
            icons: origins.map((origin) => ({ origin, pictureId: null, registrableDomain: null })),
          });
      };
      // Setup may cross asynchronous bridge initialization. Cancellation owns
      // both halves: late frames are ignored and a late handle is closed once.
      void Promise.resolve()
        .then(() => {
          if (cancelled || !local()) return undefined;
          return sessionRpcClient().sourceIcons.watch.subscribe(
            { sessionId: input.sessionId, origins },
            {
              onData: (snapshot) => {
                if (!cancelled && local()) onSnapshot(snapshot);
              },
              onError: missing,
            },
          );
        })
        .then((opened) => {
          if (opened === undefined) return;
          if (cancelled) opened.unsubscribe();
          else subscription = opened;
        })
        .catch(missing);
      return () => {
        if (cancelled) return;
        cancelled = true;
        subscription?.unsubscribe();
        subscription = undefined;
      };
    },
  };
}
