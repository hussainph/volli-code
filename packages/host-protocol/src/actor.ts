import { isIdentifier, isUuidV4 } from "./identity";
import type { DeviceId, SessionId, WorkerId, WorkspaceId } from "./identity";

/** Credential-derived actor, bound to one workspace (VC-163); never claimed in hello. */
export type HostActor =
  | { readonly kind: "device"; readonly deviceId: DeviceId; readonly workspaceId: WorkspaceId }
  | { readonly kind: "session"; readonly sessionId: SessionId; readonly workspaceId: WorkspaceId }
  | { readonly kind: "worker"; readonly workerId: WorkerId; readonly workspaceId: WorkspaceId };

export type HostActorKind = HostActor["kind"];
export const HOST_ACTOR_KINDS = [
  "device",
  "session",
  "worker",
] as const satisfies readonly HostActorKind[];

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
