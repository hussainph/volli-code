import type { HostActor } from "./actor";
import { hostError, type HostError } from "./errors";
import { isEpoch, isUuidV4 } from "./identity";
import type { HostId, WorkspaceEpoch, WorkspaceId } from "./identity";

/** Breaking wire version; additive surfaces use feature names (see host-protocol.md). */
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

/** Additive lowercase dotted feature names; absence means unsupported. */
export type HostFeature = string;
const FEATURE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const MAX_FEATURES = 256;
const MAX_FEATURE_LENGTH = 128;
/** Bounds on what a verifier and a log ever see of a hello's free strings. */
const MAX_CREDENTIAL_LENGTH = 8192;
const MAX_CLIENT_VERSION_LENGTH = 128;

/** Self-description only. The host never authorizes on it; the credential decides the actor. */
export const HOST_CLIENT_KINDS = ["desktop", "web", "mobile", "cli", "worker"] as const;
export type HostClientKind = (typeof HOST_CLIENT_KINDS)[number];

/** First client message, encoded in tRPC connectionParams before area calls. */
export interface HostHello {
  readonly protocol: ProtocolVersionRange;
  readonly client: { readonly kind: HostClientKind; readonly version: string };
  readonly workspaceId: WorkspaceId;
  readonly lastSeen: WorkspaceAuthority | null;
  readonly features: readonly HostFeature[];
  readonly credential: string;
  /**
   * Fresh per handshake, never reused: the challenge the host signs its
   * welcome over, so a recorded welcome cannot be replayed to this client
   * (HI § Keys). Required in v1 (VC-663, D6); VC-575 signs and verifies.
   */
  readonly nonce: HostNonce;
}

/** Base64url, at least 128 random bits. {@link createHostNonce} mints 256. */
export type HostNonce = string;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u;
const NONCE_BYTES = 32;

/** Which host held a workspace, and under which epoch (`docs/plans/host-identity.md`). */
export interface WorkspaceAuthority {
  readonly epoch: WorkspaceEpoch;
  readonly hostId: HostId;
}

/** The host's answer to a hello it accepted. */
export interface HostWelcome {
  readonly protocolVersion: number;
  readonly host: { readonly id: HostId; readonly version: string };
  readonly workspace: { readonly id: WorkspaceId; readonly epoch: WorkspaceEpoch };
  readonly actor: HostActor;
  readonly features: readonly HostFeature[];
  /**
   * Reserved in v1 (VC-663): the host key's signature over this welcome and
   * the hello's nonce. Every v1 host sends `null` until VC-575 signs it; a
   * client checks it through `validateWelcome`'s `verifyProof` hook.
   */
  readonly proof: HostWelcomeProof | null;
}

/**
 * The welcome proof's shape, reserved for VC-575: a named signature scheme
 * and its encoded value. Opaque to this package; nothing reads either field
 * until VC-575 fills the hook.
 */
export interface HostWelcomeProof {
  readonly scheme: string;
  readonly value: string;
}

/** What a host knows about itself when it judges a hello. */
export interface HostOffer {
  readonly host: { readonly id: HostId; readonly version: string };
  readonly protocol: ProtocolVersionRange;
  readonly workspace: { readonly id: WorkspaceId; readonly epoch: WorkspaceEpoch };
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
 * Authenticated hello negotiation: version, workspace scope and authority fence.
 * `ok` at a higher epoch is not authority-validated; VC-591/VC-564 own promotion validation.
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
      proof: null,
    },
  };
}

/** Both peers reject lower epochs and equal epochs from different hosts (VC-550). */
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

/** What a client knows before it says hello; the builder fills the rest. */
export interface HostHelloInput {
  readonly client: HostHello["client"];
  readonly workspaceId: WorkspaceId;
  readonly credential: string;
  readonly features: readonly HostFeature[];
  readonly lastSeen: WorkspaceAuthority | null;
  /** Defaults to every version this build speaks. */
  readonly protocol?: ProtocolVersionRange;
}

/**
 * A hello for ONE handshake, with a fresh nonce: a client builds a new one on
 * every connect and reconnect, and keeps it to validate the welcome against.
 */
export function buildHostHello(input: HostHelloInput): HostHello {
  return {
    protocol: input.protocol ?? HOST_PROTOCOL_VERSIONS,
    client: { kind: input.client.kind, version: input.client.version },
    workspaceId: input.workspaceId,
    lastSeen: input.lastSeen,
    features: [...input.features],
    credential: input.credential,
    nonce: createHostNonce(),
  };
}

/** 256 bits from the platform CSPRNG, base64url. Web Crypto: Node, browsers and mobile alike. */
export function createHostNonce(): HostNonce {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function isHostNonce(value: unknown): value is HostNonce {
  return typeof value === "string" && NONCE.test(value);
}

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
    value.client.version.length <= MAX_CLIENT_VERSION_LENGTH &&
    isUuidV4(value.workspaceId) &&
    (value.lastSeen === null ||
      (isRecord(value.lastSeen) &&
        isEpoch(value.lastSeen.epoch) &&
        isUuidV4(value.lastSeen.hostId))) &&
    Array.isArray(value.features) &&
    value.features.length <= MAX_FEATURES &&
    value.features.every(isHostFeature) &&
    typeof value.credential === "string" &&
    value.credential.length > 0 &&
    value.credential.length <= MAX_CREDENTIAL_LENGTH &&
    isHostNonce(value.nonce)
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
