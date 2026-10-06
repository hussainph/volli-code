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

/**
 * The device id reserved for the desktop's own window (VC-564 D7). No verifier
 * may mint it from a network handshake: {@link isHostActor} refuses it.
 */
export const LOCAL_DEVICE_ID = "local";

/**
 * The desktop's own window, over in-process IPC: the person at this host, so
 * device-as-user, with no credential to verify and every Workspace on the host
 * authorized. It is not a {@link HostActor}, because it is bound to no one
 * Workspace and arrives over no handshake.
 */
export interface LocalDeviceActor {
  readonly kind: "device";
  readonly deviceId: typeof LOCAL_DEVICE_ID;
}

export const LOCAL_DEVICE_ACTOR: LocalDeviceActor = Object.freeze({
  kind: "device",
  deviceId: LOCAL_DEVICE_ID,
});

/** Who a router call comes from: one Workspace's network actor, or the in-process desktop. */
export type CallerActor = HostActor | LocalDeviceActor;

/** Whether the caller is the in-process desktop, authorized for every Workspace. */
export function isLocalDeviceActor(actor: CallerActor): actor is LocalDeviceActor {
  return !("workspaceId" in actor);
}

export function isHostActor(value: unknown): value is HostActor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  if (!isUuidV4(actor.workspaceId)) return false;
  switch (actor.kind) {
    case "device":
      // Spelled out although "local" is no UUID: the reservation must survive
      // any later loosening of the device id grammar.
      return actor.deviceId !== LOCAL_DEVICE_ID && isUuidV4(actor.deviceId);
    case "session":
      return isIdentifier(actor.sessionId);
    case "worker":
      return isUuidV4(actor.workerId);
    default:
      return false;
  }
}
