/**
 * The desktop's {@link ChatSessionTransport} — the one module where the chat
 * core's seams meet the renderer's actual plumbing: the IPC-backed tRPC
 * client, the window's frame/timer pacing, and the platform's id mint. It
 * exists so the client core can stay framework-neutral (VC-169): everything
 * here is exactly what a second Volli client would replace, and nothing here
 * is anything the core needs to know.
 */
import { racingFlushScheduler, type ChatSessionTransport } from "@volli/session-presentation";

import { hostNotConnected, remoteOwnerOf } from "@renderer/lib/remote-owners";
import { closedRemoteTransport, type RemoteSessionClient } from "@renderer/lib/remote-session-wire";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

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

/**
 * The transport a project's Sessions use: its host's for a remote project,
 * IPC for This Mac's. A project this window has known on a remote host whose
 * Workspace is not bound now (forgotten, unreachable, `cloud` off) fails
 * closed in the host's name; it never falls to This Mac's IPC (VC-713, B1).
 */
export function chatTransportFor(projectId: string | null): ChatSessionTransport {
  const owner = remoteOwnerOf(projectId);
  if (owner === null) return browserChatTransport();
  return remoteTransports?.forProject(projectId!) ?? closedRemoteTransport(owner.hostName, window);
}

/** `session.command` as the router types it: its input and its answer. */
export type SessionCommandDoor = (
  input: Parameters<RemoteSessionClient["session"]["command"]["mutate"]>[0],
) => ReturnType<RemoteSessionClient["session"]["command"]["mutate"]>;

/**
 * `session.command` for one Session, by its project (VC-713, B2): its host's
 * for a remote Session, IPC for This Mac's, and a refusal in the host's name
 * for a remote one whose Workspace is not bound now. For the doors outside the
 * chat core that command a Session by id (the Island's subagent Stop).
 */
export function sessionCommandFor(projectId: string | null): SessionCommandDoor {
  const owner = remoteOwnerOf(projectId);
  if (owner === null) return (input) => sessionRpcClient().session.command.mutate(input);
  const client = remoteTransports?.clientFor(projectId!) ?? null;
  if (client === null) {
    return () => Promise.reject(new Error(hostNotConnected(owner.hostName)));
  }
  return (input) => client.session.command.mutate(input);
}
