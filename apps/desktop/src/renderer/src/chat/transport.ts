/**
 * The desktop's {@link ChatSessionTransport} — the one module where the chat
 * core's seams meet the renderer's actual plumbing: the IPC-backed tRPC
 * client, the window's frame/timer pacing, and the platform's id mint. It
 * exists so the client core can stay framework-neutral (VC-169): everything
 * here is exactly what a second Volli client would replace, and nothing here
 * is anything the core needs to know.
 */
import { racingFlushScheduler, type ChatSessionTransport } from "@renderer/chat/client";
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
        ...(input.skills === undefined ? {} : { skills: [...input.skills] }),
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
