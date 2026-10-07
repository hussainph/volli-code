/**
 * The desktop's {@link ChatSessionTransport} — the one module where the chat
 * core's seams meet the renderer's actual plumbing: the IPC-backed tRPC
 * client, the window's frame/timer pacing, and the platform's id mint. It
 * exists so the client core can stay framework-neutral (VC-169): everything
 * here is exactly what a second Volli client would replace, and nothing here
 * is anything the core needs to know.
 */
import { racingFlushScheduler, type ChatSessionTransport } from "@volli/session-presentation";

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
}

let remoteTransports: RemoteChatTransports | null = null;

/** Registers the remote half; the returned function removes only this registration. */
export function setRemoteChatTransports(transports: RemoteChatTransports): () => void {
  remoteTransports = transports;
  return () => {
    if (remoteTransports === transports) remoteTransports = null;
  };
}

/** The transport a project's Sessions use: its host's for a remote project, IPC otherwise. */
export function chatTransportFor(projectId: string | null): ChatSessionTransport {
  return (
    (projectId === null ? null : remoteTransports?.forProject(projectId)) ?? browserChatTransport()
  );
}
