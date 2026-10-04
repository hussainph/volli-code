import { isIdentifier, isUuidV4 } from "./identity";
import type { DeviceId, SessionId, WorkerId, WorkspaceId } from "./identity";

/**
 * Who is on the other end of a connection (`docs/plans/host-protocol.md` § Auth).
 *
 * - `device`: a paired client a person holds, such as the desktop app, a phone
 *   or the person's own CLI.
 * - `session`: an agent Session acting through its tools, today's agent socket.
 * - `worker`: an execution process that holds checkout leases.
 *
 * The host derives the actor from the credential and reports it in the welcome.
 * A client never states its own actor: the hello has no field that could
 * claim one (socket honesty, VC-163). Every actor is bound to exactly one
 * workspace, the one its connection was opened for.
 */
export type HostActor =
  | { readonly kind: "device"; readonly deviceId: DeviceId; readonly workspaceId: WorkspaceId }
  | { readonly kind: "session"; readonly sessionId: SessionId; readonly workspaceId: WorkspaceId }
  | { readonly kind: "worker"; readonly workerId: WorkerId; readonly workspaceId: WorkspaceId };

export type HostActorKind = HostActor["kind"];
export const HOST_ACTOR_KINDS = ["device", "session", "worker"] as const satisfies readonly HostActorKind[];

export function isHostActor(value: unknown): value is HostActor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  if (!isUuidV4(actor.workspaceId)) return false;
  switch (actor.kind) {
    case "device":
      return isUuidV4(actor.deviceId);
    case "session":
      return isIdentifier(actor.sessionId);
    case "worker":
      return isUuidV4(actor.workerId);
    default:
      return false;
  }
}
