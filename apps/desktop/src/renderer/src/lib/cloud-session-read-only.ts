/**
 * Which Session writes a launch may make, and the refusal when it may not.
 *
 * Two families, on purpose:
 *
 * - **Generic Session writes** ({@link useCanWriteSession},
 *   {@link guardSessionWrite}): rename, read marks, terminals, the peek's
 *   doors. They reach this Mac's IPC, so a cloud launch refuses every one of
 *   them with {@link CLOUD_SESSION_READ_ONLY}. Board writes are unaffected.
 * - **Sends** ({@link useCanSendSession}, {@link guardSessionSend}): a chat's
 *   composer and a new chat. In a cloud launch these go to Volli Cloud (a
 *   message or answer as a `sessions.command` for the Session's runner) or to
 *   this Mac's runner-originated start, so they follow the cloud link's
 *   read-only state instead, plus a check that the window's client is
 *   connected at the moment of the press. A local launch reads both families
 *   the same.
 */
import { toast } from "sonner";

import { cloudSession } from "@renderer/lib/cloud-client";
import { launchStore } from "@renderer/stores/launch";
import { guardWrite, useCanWrite } from "@renderer/components/hosts/use-hosts";

import { CLOUD_SESSION_UNAVAILABLE as CLOUD_SESSION_READ_ONLY } from "./cloud-session-view";

export { CLOUD_SESSION_UNAVAILABLE as CLOUD_SESSION_READ_ONLY } from "./cloud-session-view";

/** What a send says when the window's Volli Cloud client is not connected right now. */
export const CLOUD_SEND_NOT_CONNECTED = "Volli Cloud is not connected";

export function useCanWriteSession(projectId: string | null): boolean {
  const hostWritable = useCanWrite(projectId);
  return launchStore() !== "cloud" && hostWritable;
}

export function guardSessionWrite(projectId: string | null): boolean {
  if (launchStore() !== "cloud") return guardWrite(projectId);
  toast(CLOUD_SESSION_READ_ONLY, { id: "cloud-session-read-only" });
  return false;
}

/** Whether a chat's composer and a new chat can send: the project's link, cloud or not. */
export function useCanSendSession(projectId: string | null): boolean {
  return useCanWrite(projectId);
}

/** The client connection, read at the press: Convex's own state, never a cached one. */
function cloudConnected(): boolean {
  return cloudSession()?.client.connectionState().isWebSocketConnected === true;
}

/**
 * Whether a send may go now, saying why not when it may not: the link's
 * read-only reason, or a cloud client that is not connected this instant.
 */
export function guardSessionSend(projectId: string | null): boolean {
  if (!guardWrite(projectId)) return false;
  if (launchStore() !== "cloud" || cloudConnected()) return true;
  toast(CLOUD_SEND_NOT_CONNECTED, { id: "cloud-session-not-connected" });
  return false;
}
