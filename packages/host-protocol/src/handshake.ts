import type { HostActor } from "./actor";
import { hostError, type HostError } from "./errors";
import { isEpoch, isUuidV4 } from "./identity";
import type { HostId, WorkspaceEpoch, WorkspaceId } from "./identity";

/**
 * The host protocol version (`docs/plans/host-protocol.md` § Handshake). It is
 * an integer, and only a breaking change bumps it. Additive change (a new
 * procedure, a new optional field, a new subscription) never does: it ships
 * under a feature name, and the welcome says whether this host has it.
 */
export const HOST_PROTOCOL_VERSION = 1;
/** The oldest version this build still speaks, on either side of a connection. */
export const HOST_PROTOCOL_MIN_VERSION = 1;

export interface ProtocolVersionRange {
  readonly min: number;
  readonly max: number;
}

export const HOST_PROTOCOL_VERSIONS: ProtocolVersionRange = {
  min: HOST_PROTOCOL_MIN_VERSION,
  max: HOST_PROTOCOL_VERSION,
};

/**
 * Feature names are dotted lowercase words, `<area>[.<feature>]`, such as
 * `sessions` or `terminals.stream`. Each one names an additive surface a host
 * may or may not serve.
 */
export type HostFeature = string;
const FEATURE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const MAX_FEATURES = 256;
const MAX_FEATURE_LENGTH = 128;

/** Self-description only. The host never authorizes on it; the credential decides the actor. */
export const HOST_CLIENT_KINDS = ["desktop", "web", "mobile", "cli", "worker"] as const;
export type HostClientKind = (typeof HOST_CLIENT_KINDS)[number];

/**
 * The first thing a client says, before any operation. Over the WebSocket
 * transport it rides in tRPC's `connectionParams` (see {@link encodeHostHello}),
 * so the host validates it once per connection, before any procedure can run.
 */
export interface HostHello {
  readonly protocol: ProtocolVersionRange;
  readonly client: { readonly kind: HostClientKind; readonly version: string };
  /** The one workspace this connection is for. Every operation is scoped to it. */
  readonly workspaceId: WorkspaceId;
  /**
   * The highest `(epoch, hostId)` this client has accepted for this workspace,
   * or null on first contact. The host refuses itself when it was fenced
   * (see {@link checkWorkspaceFence}). The client applies the same check to the
   * welcome, because a fenced host may be an old build that never checks.
   */
  readonly lastSeen: WorkspaceAuthority | null;
  /** What the client can use. Unknown names are ignored, never refused. */
  readonly features: readonly HostFeature[];
  /** The opaque bearer credential: a device, session or worker token. */
  readonly credential: string;
}

/** Which host held a workspace, and under which epoch (`docs/plans/host-identity.md`). */
export interface WorkspaceAuthority {
  readonly epoch: WorkspaceEpoch;
  readonly hostId: HostId;
}

/** The host's answer to a hello it accepted. */
export interface HostWelcome {
  /** The version this connection speaks: the highest both ranges share. */
  readonly protocolVersion: number;
  readonly host: { readonly id: HostId; readonly version: string };
  readonly workspace: { readonly id: WorkspaceId; readonly epoch: WorkspaceEpoch };
  /** Who the credential says this connection is. */
  readonly actor: HostActor;
  /** The features the client asked for that this host serves to this actor. */
  readonly features: readonly HostFeature[];
}

/** What a host knows about itself when it judges a hello. */
export interface HostOffer {
  readonly host: { readonly id: HostId; readonly version: string };
  readonly protocol: ProtocolVersionRange;
  readonly workspace: { readonly id: WorkspaceId; readonly epoch: WorkspaceEpoch };
  /** The features this host serves to this actor, after its verb policy. */
  readonly features: readonly HostFeature[];
}

/** The highest version both ranges share, or null when they do not meet. */
export function negotiateProtocolVersion(
  client: ProtocolVersionRange,
  host: ProtocolVersionRange,
): number | null {
  const version = Math.min(client.max, host.max);
  return version >= Math.max(client.min, host.min) ? version : null;
}

/** The requested features this host serves, in the host's order, each once. */
export function negotiateFeatures(
  requested: readonly HostFeature[],
  offered: readonly HostFeature[],
): HostFeature[] {
  const wanted = new Set(requested);
  return [...new Set(offered)].filter((feature) => wanted.has(feature));
}

/**
 * Judges a hello that already authenticated as `actor`, and returns either the
 * welcome or the one error that refuses it. Authentication itself, meaning a
 * credential becoming an actor, happens in the host before this runs. This
 * function only applies the rules both sides must agree on: a version both
 * speak, an actor bound to the requested workspace, and an epoch that has not
 * gone backwards.
 */
export function negotiateWelcome(
  hello: HostHello,
  offer: HostOffer,
  actor: HostActor,
): { ok: true; welcome: HostWelcome } | { ok: false; error: HostError } {
  const protocolVersion = negotiateProtocolVersion(hello.protocol, offer.protocol);
  if (protocolVersion === null) {
    return {
      ok: false,
      error: hostError(
        "protocol-version-unsupported",
        `This host speaks protocol ${formatRange(offer.protocol)}; the client speaks ${formatRange(hello.protocol)}`,
      ),
    };
  }
  if (hello.workspaceId !== offer.workspace.id || actor.workspaceId !== offer.workspace.id) {
    return { ok: false, error: hostError("workspace-unknown", "No such workspace on this host") };
  }
  const fence = checkWorkspaceFence(hello.lastSeen, {
    epoch: offer.workspace.epoch,
    hostId: offer.host.id,
  });
  if (fence !== null) return { ok: false, error: fence };
  return {
    ok: true,
    welcome: {
      protocolVersion,
      host: { ...offer.host },
      workspace: { ...offer.workspace },
      actor,
      features: negotiateFeatures(hello.features, offer.features),
    },
  };
}

/**
 * The workspace fence, which both ends apply (ruling 6; `host-identity.md`). It
 * passes on first contact (`lastSeen === null`), for a later epoch, and for the
 * same epoch from the same host. A lower epoch means this host was fenced by a
 * move. The same epoch from a different host means two hosts claim one
 * authority. Both are refused, and the client keeps the authority it last
 * accepted.
 */
export function checkWorkspaceFence(
  lastSeen: WorkspaceAuthority | null,
  current: WorkspaceAuthority,
): HostError | null {
  if (lastSeen === null || current.epoch > lastSeen.epoch) return null;
  if (current.epoch < lastSeen.epoch) {
    return hostError(
      "workspace-epoch-fenced",
      `This host's workspace epoch ${current.epoch} is older than ${lastSeen.epoch}; the workspace has moved`,
    );
  }
  return current.hostId === lastSeen.hostId
    ? null
    : hostError(
        "workspace-split-brain",
        `Two hosts claim workspace epoch ${current.epoch}; refusing both until one is moved`,
      );
}

/** The `connectionParams` key the hello travels under. tRPC carries string values only. */
export const HOST_HELLO_PARAM = "volli-hello";

export function encodeHostHello(hello: HostHello): Record<string, string> {
  return { [HOST_HELLO_PARAM]: JSON.stringify(hello) };
}

/** The hello a connection sent, or null when it sent none or sent one this build cannot read. */
export function readHostHello(
  params: Readonly<Record<string, string | undefined>> | null,
): HostHello | null {
  const raw = params?.[HOST_HELLO_PARAM];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isHostHello(parsed) ? parsed : null;
}

export function isProtocolVersionRange(value: unknown): value is ProtocolVersionRange {
  if (!isRecord(value)) return false;
  const { min, max } = value;
  return isPositiveSafeInteger(min) && isPositiveSafeInteger(max) && min <= max;
}

export function isHostFeature(value: unknown): value is HostFeature {
  return typeof value === "string" && value.length <= MAX_FEATURE_LENGTH && FEATURE.test(value);
}

export function isHostHello(value: unknown): value is HostHello {
  if (!isRecord(value) || !isRecord(value.client)) return false;
  return (
    isProtocolVersionRange(value.protocol) &&
    (HOST_CLIENT_KINDS as readonly unknown[]).includes(value.client.kind) &&
    typeof value.client.version === "string" &&
    isUuidV4(value.workspaceId) &&
    (value.lastSeen === null ||
      (isRecord(value.lastSeen) && isEpoch(value.lastSeen.epoch) && isUuidV4(value.lastSeen.hostId))) &&
    Array.isArray(value.features) &&
    value.features.length <= MAX_FEATURES &&
    value.features.every(isHostFeature) &&
    typeof value.credential === "string" &&
    value.credential.length > 0
  );
}

function formatRange(range: ProtocolVersionRange): string {
  return range.min === range.max ? `${range.min}` : `${range.min}–${range.max}`;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
