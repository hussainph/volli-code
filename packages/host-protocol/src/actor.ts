import { isIdentifier, isUuidV4 } from "./identity";
import type { DeviceId, SessionId, WorkerId, WorkspaceId } from "./identity";

/** Credential-derived actor, bound to one workspace (VC-163); never claimed in hello. */
export type HostActor =
  | { readonly kind: "device"; readonly deviceId: DeviceId; readonly workspaceId: WorkspaceId }
  | { readonly kind: "session"; readonly sessionId: SessionId; readonly workspaceId: WorkspaceId }
  | { readonly kind: "worker"; readonly workerId: WorkerId; readonly workspaceId: WorkspaceId };

/** A paired device addressing the host itself, before choosing any Workspace. */
export interface HostScopeActor {
  readonly kind: "device";
  readonly deviceId: DeviceId;
  readonly scope: "host";
}

export type HostConnectionActor = HostActor | HostScopeActor;

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
 * The brand only {@link LOCAL_DEVICE_ACTOR} carries. Type-only and never
 * exported, so no module but this one can name it: an object spelled like the
 * local device is not one.
 */
declare const LOCAL_DEVICE_BRAND: unique symbol;

/**
 * The desktop's own window, over in-process IPC: the person at this host, so
 * device-as-user, with no credential to verify and every Workspace on the host
 * authorized. It is not a {@link HostActor}, because it is bound to no one
 * Workspace and arrives over no handshake.
 *
 * There is exactly one: {@link LOCAL_DEVICE_ACTOR}. It is recognized by
 * identity, never by shape, so a caller that builds a lookalike (a fresh
 * `{kind:"device", deviceId:"local"}`, or one with extra fields) is not the
 * desktop and gets none of its exemptions.
 */
export interface LocalDeviceActor {
  readonly kind: "device";
  readonly deviceId: typeof LOCAL_DEVICE_ID;
  readonly [LOCAL_DEVICE_BRAND]: true;
}

/** The one in-process desktop actor, frozen. Build every local context from this object. */
export const LOCAL_DEVICE_ACTOR: LocalDeviceActor = Object.freeze({
  kind: "device",
  deviceId: LOCAL_DEVICE_ID,
}) as LocalDeviceActor;

/** Who a router call comes from: a scoped network actor, or the in-process desktop. */
export type CallerActor = HostConnectionActor | LocalDeviceActor;

/** Whether the caller is the in-process desktop, authorized for every Workspace. */
export function isLocalDeviceActor(actor: CallerActor): actor is LocalDeviceActor {
  // By identity, never by shape: a lookalike must never inherit the
  // desktop's reach (VC-564 re-check B3).
  return actor === LOCAL_DEVICE_ACTOR;
}

export function isHostScopeActor(value: unknown): value is HostScopeActor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  return (
    actor.scope === "host" &&
    actor.kind === "device" &&
    actor.deviceId !== LOCAL_DEVICE_ID &&
    isUuidV4(actor.deviceId) &&
    !("workspaceId" in actor) &&
    !("sessionId" in actor) &&
    !("workerId" in actor)
  );
}

export function isHostConnectionActor(value: unknown): value is HostConnectionActor {
  return isHostScopeActor(value) || isHostActor(value);
}

export function isHostActor(value: unknown): value is HostActor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  if ("scope" in actor || !isUuidV4(actor.workspaceId)) return false;
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
