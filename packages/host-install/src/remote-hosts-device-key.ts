/**
 * This Mac's device key for one remote host (VC-700): a P-256 key pair made
 * for each add flow, whose public half hostd enrolls over SSH and whose
 * private half signs a fresh `vdc1` credential for every handshake.
 *
 * The private half is a PKCS#8 PEM that only the caller's key store holds
 * (desktop main seals it in its credential inventory). It never enters a
 * view, a snapshot, the registry or a log line; only the public identity
 * (SPKI and its fingerprint) does.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import {
  assembleDeviceCredential,
  bytesToBase64Url,
  deviceCredentialSigningInput,
  type DeviceCredentialClaims,
} from "@volli/host-protocol";

import type { DeviceIdentity } from "./provision";

/** How long a minted credential lives: hostd accepts at most 300 s. */
export const DEVICE_CREDENTIAL_LIFETIME_S = 120;

/**
 * `SHA256:` and the unpadded base64 of the SPKI DER's SHA-256: what hostd's
 * `spkiFingerprint` computes (`apps/hostd/src/enrolled-devices.ts`), so the
 * probe recognizes this key among the box's enrolled devices.
 */
export function spkiFingerprint(der: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(der).digest("base64").replace(/=+$/u, "")}`;
}

export interface GeneratedDeviceKey {
  /** The private half. The caller hands it straight to its key store. */
  readonly privateKeyPem: string;
  /** What enrollment sends: the public half and its fingerprint. */
  readonly identity: DeviceIdentity;
}

/** A new P-256 device key, named `name` on the host. */
export function generateDeviceKey(name: string): GeneratedDeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    identity: { publicKey: bytesToBase64Url(der), fingerprint: spkiFingerprint(der), name },
  };
}

export interface MintCredentialInput {
  readonly privateKeyPem: string;
  readonly hostId: string;
  readonly deviceId: string;
  readonly workspaceId: string;
  /** Epoch ms. */
  readonly now: number;
}

/**
 * A `vdc1` credential for one handshake: issued now, expiring
 * {@link DEVICE_CREDENTIAL_LIFETIME_S} later, a random 128-bit `jti`, signed
 * ECDSA P-256 SHA-256 in IEEE P1363 form.
 */
export function mintDeviceCredential(input: MintCredentialInput): string {
  const iat = Math.floor(input.now / 1000);
  const claims: DeviceCredentialClaims = {
    hostId: input.hostId,
    deviceId: input.deviceId,
    workspaceId: input.workspaceId,
    iat,
    exp: iat + DEVICE_CREDENTIAL_LIFETIME_S,
    jti: bytesToBase64Url(randomBytes(16)),
  };
  const signingInput = deviceCredentialSigningInput(claims);
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
    key: input.privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return assembleDeviceCredential(signingInput, new Uint8Array(signature));
}
