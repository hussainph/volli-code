/**
 * The device credential (VC-700): what a device enrolled with a host presents
 * as a hello's `credential`, so the host's verifier port (VC-663) can turn it
 * into a device actor.
 *
 * A device proves its key, never a bearer secret (HI § Keys, F5). It signs a
 * short-lived statement naming the host, itself and either the one Workspace
 * this connection is for or explicit host scope, with a fresh `jti` the host
 * remembers until `exp`, so a
 * recorded credential cannot be replayed:
 *
 *     vdc1.<base64url(JSON claims)>.<base64url(ECDSA P-256 SHA-256, IEEE P1363)>
 *
 * The signature covers the ASCII of `vdc1.<claims>`, as a JWS does. P1363 is
 * the encoding WebCrypto signs in, so a desktop, a phone and a browser can
 * hold the key non-exportably and sign without conversion.
 *
 * Pure: no Node, no WebCrypto here. The device signs and the host verifies,
 * each with its own platform's crypto; this module only frames the bytes.
 * Enrollment (how the host learned the key) is the verifier's business:
 * SSH enrollment (VC-700) is one path, pairing (VC-575) and an account-issued
 * key from a control plane are others, and none changes this frame.
 */
import { isUuidV4 } from "./identity";
import type { DeviceId, HostId, WorkspaceId } from "./identity";

export const DEVICE_CREDENTIAL_SCHEME = "vdc1";
/** The longest a credential may live: it is minted per handshake. */
export const DEVICE_CREDENTIAL_MAX_LIFETIME_S = 300;
/** A P-256 signature in IEEE P1363 form: r ‖ s, 32 bytes each. */
export const DEVICE_CREDENTIAL_SIGNATURE_BYTES = 64;

const JTI = /^[A-Za-z0-9_-]{22,64}$/u;
const SEGMENT = /^[A-Za-z0-9_-]+$/u;

export interface DeviceCredentialClaims {
  readonly hostId: HostId;
  readonly deviceId: DeviceId;
  readonly workspaceId: WorkspaceId;
  /** Seconds since the epoch. */
  readonly iat: number;
  readonly exp: number;
  /** At least 128 random bits, base64url: the host refuses one it has seen. */
  readonly jti: string;
}

export interface HostScopeDeviceCredentialClaims {
  readonly scope: "host";
  readonly hostId: HostId;
  readonly deviceId: DeviceId;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export type DeviceConnectionCredentialClaims =
  | DeviceCredentialClaims
  | HostScopeDeviceCredentialClaims;

export interface ParsedDeviceCredential {
  readonly claims: DeviceConnectionCredentialClaims;
  /** The exact bytes the signature covers, as ASCII. */
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** The bytes, or `null` for anything that is not unpadded base64url. */
export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!SEGMENT.test(value) || value.length % 4 === 1) return null;
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** `vdc1.<claims>`: what the device signs. */
export function deviceCredentialSigningInput(claims: DeviceConnectionCredentialClaims): string {
  const json = JSON.stringify(
    "scope" in claims
      ? {
          scope: "host",
          hostId: claims.hostId,
          deviceId: claims.deviceId,
          iat: claims.iat,
          exp: claims.exp,
          jti: claims.jti,
        }
      : {
          hostId: claims.hostId,
          deviceId: claims.deviceId,
          workspaceId: claims.workspaceId,
          iat: claims.iat,
          exp: claims.exp,
          jti: claims.jti,
        },
  );
  return `${DEVICE_CREDENTIAL_SCHEME}.${bytesToBase64Url(new TextEncoder().encode(json))}`;
}

export function assembleDeviceCredential(signingInput: string, signature: Uint8Array): string {
  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

/** Whether these claims are well formed, before any signature is checked. */
export function isDeviceCredentialClaims(value: unknown): value is DeviceCredentialClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return !("scope" in claims) && isUuidV4(claims.workspaceId) && isClaimFields(claims);
}

export function isHostScopeDeviceCredentialClaims(
  value: unknown,
): value is HostScopeDeviceCredentialClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return claims.scope === "host" && !("workspaceId" in claims) && isClaimFields(claims);
}

function isClaimFields(claims: Record<string, unknown>): boolean {
  const { iat, exp } = claims;
  return (
    isUuidV4(claims.hostId) &&
    isUuidV4(claims.deviceId) &&
    typeof claims.jti === "string" &&
    JTI.test(claims.jti) &&
    Number.isSafeInteger(iat) &&
    Number.isSafeInteger(exp) &&
    (iat as number) > 0 &&
    (exp as number) > (iat as number) &&
    (exp as number) - (iat as number) <= DEVICE_CREDENTIAL_MAX_LIFETIME_S
  );
}

/**
 * The credential's parts, or `null` for anything that is not a well-formed
 * `vdc1` credential. Says nothing about whether the signature is good: the
 * verifier checks it against the key it enrolled for `claims.deviceId`.
 */
export function parseDeviceCredential(credential: string): ParsedDeviceCredential | null {
  const parts = credential.split(".");
  if (parts.length !== 3 || parts[0] !== DEVICE_CREDENTIAL_SCHEME) return null;
  const body = base64UrlToBytes(parts[1]!);
  const signature = base64UrlToBytes(parts[2]!);
  if (body === null || signature?.length !== DEVICE_CREDENTIAL_SIGNATURE_BYTES) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!isHostScopeDeviceCredentialClaims(claims) && !isDeviceCredentialClaims(claims)) return null;
  const { hostId, deviceId, iat, exp, jti } = claims;
  return {
    claims:
      "scope" in claims
        ? { scope: "host", hostId, deviceId, iat, exp, jti }
        : { hostId, deviceId, workspaceId: claims.workspaceId, iat, exp, jti },
    signingInput: `${parts[0]}.${parts[1]}`,
    signature,
  };
}
