/**
 * Devices enrolled with this host, and the credential verifier that admits
 * them (VC-700): the first accepting verifier behind VC-663's port.
 *
 * **The store** is `<dataDir>/enrolled-devices.json`, mode 0600, owned by the
 * account hostd runs as. It holds public keys, never a secret: each device's
 * P-256 SPKI (base64url), its SHA-256 fingerprint, the label the person gave
 * it, and how it was enrolled. Host-level like `devices` (VC-550): it never
 * leaves the box in a backup. VC-575 owns the durable devices table and may
 * fold this file into it; the verifier port is the seam, so nothing else
 * changes when it does.
 *
 * **Enrollment** (`volli-hostd enroll`, enroll.ts) adds a key; it is the SSH
 * path. Pairing by code (VC-575) and an account-issued key (a hosted control
 * plane) are other writers of the same fact: guardrail 1.
 *
 * **Verification** takes a `vdc1` device credential (`@volli/host-protocol`,
 * device-credential.ts) and admits it when, all at once:
 * - it names this host and the hello's Workspace;
 * - its device is enrolled and not revoked;
 * - it is inside its own short life (≤ 5 min, 60 s skew allowed);
 * - its `jti` was never seen (remembered until it would have expired);
 * - its signature is good under the enrolled key.
 *
 * The grant stays current while the device stays enrolled: revocation (the
 * entry gone or `revokedAt` set) closes its connections at the door's next
 * check. The file is re-read only when its size or mtime moved.
 */
import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import {
  base64UrlToBytes,
  isUuidV4,
  parseDeviceCredential,
  type HostCredentialGrant,
  type HostCredentialVerifier,
} from "@volli/host-protocol";

export const ENROLLED_DEVICES_FILE = "enrolled-devices.json";

/** How a device came to be trusted. Only `ssh` writes today. */
export type EnrollmentPath = "ssh";

export interface EnrolledDevice {
  readonly deviceId: string;
  readonly name: string;
  /** P-256 SubjectPublicKeyInfo, DER, base64url. */
  readonly publicKey: string;
  /** `SHA256:` and the unpadded base64 of SHA-256(SPKI DER), as ssh prints one. */
  readonly fingerprint: string;
  readonly enrolledAt: string;
  readonly via: EnrollmentPath;
  readonly revokedAt: string | null;
}

interface EnrolledDevicesFile {
  readonly v: 1;
  readonly devices: readonly EnrolledDevice[];
}

/** Longest label kept; a longer one is cut, never refused. */
const MAX_NAME_LENGTH = 120;
/** Clock skew allowed between a device and this host. */
const SKEW_S = 60;
const MAX_REMEMBERED_JTIS = 10_000;

export function enrolledDevicesPath(dataDir: string): string {
  return join(dataDir, ENROLLED_DEVICES_FILE);
}

/** A P-256 public key from its base64url SPKI, or why not. */
export function parseDevicePublicKey(
  spki: string,
): { key: KeyObject; fingerprint: string } | string {
  const der = base64UrlToBytes(spki);
  if (der === null) return "The public key is not base64url.";
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
  } catch {
    return "The public key is not a SubjectPublicKeyInfo.";
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    return "The public key must be ECDSA P-256.";
  }
  return { key, fingerprint: spkiFingerprint(der) };
}

export function spkiFingerprint(der: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(der).digest("base64").replace(/=+$/u, "")}`;
}

function isEnrolledDevice(value: unknown): value is EnrolledDevice {
  if (typeof value !== "object" || value === null) return false;
  const device = value as Record<string, unknown>;
  return (
    isUuidV4(device.deviceId) &&
    typeof device.name === "string" &&
    typeof device.publicKey === "string" &&
    typeof device.fingerprint === "string" &&
    typeof device.enrolledAt === "string" &&
    device.via === "ssh" &&
    (device.revokedAt === null || typeof device.revokedAt === "string")
  );
}

/**
 * Every enrolled device, revoked ones included; `[]` when none was ever
 * enrolled; `"unreadable"` for a file that is not one of ours (then nothing
 * is admitted, and enrollment refuses to overwrite it).
 */
export function readEnrolledDevices(dataDir: string): readonly EnrolledDevice[] | "unreadable" {
  let text: string;
  try {
    text = readFileSync(enrolledDevicesPath(dataDir), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : "unreadable";
  }
  try {
    const parsed = JSON.parse(text) as Partial<EnrolledDevicesFile> | null;
    return parsed?.v === 1 &&
      Array.isArray(parsed.devices) &&
      parsed.devices.every(isEnrolledDevice)
      ? parsed.devices
      : "unreadable";
  } catch {
    return "unreadable";
  }
}

function writeEnrolledDevices(dataDir: string, devices: readonly EnrolledDevice[]): void {
  const path = enrolledDevicesPath(dataDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(
        fd,
        `${JSON.stringify({ v: 1, devices } satisfies EnrolledDevicesFile, null, 2)}\n`,
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export interface EnrollRequest {
  readonly publicKey: string;
  readonly name: string;
  readonly via: EnrollmentPath;
}

export interface EnrollOutcome {
  readonly device: EnrolledDevice;
  /** `false` when this key was already enrolled: enrolling is idempotent. */
  readonly created: boolean;
}

/**
 * Enrolls a key, or answers the device it already is. A revoked key stays
 * revoked: enrolling it again is a new device with a new id, so attribution
 * of what the old one did survives. Throws a sentence on a bad key or an
 * unreadable store.
 */
export function enrollDevice(
  dataDir: string,
  request: EnrollRequest,
  mint: { now: () => Date; newId: () => string },
): EnrollOutcome {
  const parsed = parseDevicePublicKey(request.publicKey);
  if (typeof parsed === "string") throw new Error(parsed);
  const devices = readEnrolledDevices(dataDir);
  if (devices === "unreadable") {
    throw new Error(
      `${enrolledDevicesPath(dataDir)} is not an enrolled-devices file; not overwriting it.`,
    );
  }
  const existing = devices.find(
    (device) => device.fingerprint === parsed.fingerprint && device.revokedAt === null,
  );
  if (existing !== undefined) return { device: existing, created: false };
  const device: EnrolledDevice = {
    deviceId: mint.newId(),
    name: request.name.trim().slice(0, MAX_NAME_LENGTH) || "Device",
    publicKey: request.publicKey,
    fingerprint: parsed.fingerprint,
    enrolledAt: mint.now().toISOString(),
    via: request.via,
    revokedAt: null,
  };
  writeEnrolledDevices(dataDir, [...devices, device]);
  return { device, created: true };
}

export interface EnrolledDeviceVerifierOptions {
  readonly dataDir: string;
  readonly hostId: string;
  readonly now?: () => number;
  /** Past this many live `jti`s, new credentials are refused rather than unremembered. */
  readonly maxRememberedJtis?: number;
}

/** The verifier hostd composes for its WebSocket listener (VC-663's port). */
export function createEnrolledDeviceVerifier(
  options: EnrolledDeviceVerifierOptions,
): HostCredentialVerifier {
  const now = options.now ?? Date.now;
  const maxJtis = options.maxRememberedJtis ?? MAX_REMEMBERED_JTIS;
  const path = enrolledDevicesPath(options.dataDir);
  let cache: { stamp: string; keys: Map<string, KeyObject> } | null = null;
  /** Live enrolled keys by device id, re-read when the file's size or mtime moved. */
  const liveKeys = (): Map<string, KeyObject> => {
    let stamp: string;
    try {
      const stat = statSync(path);
      stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    } catch {
      stamp = "absent";
    }
    if (cache?.stamp === stamp) return cache.keys;
    const keys = new Map<string, KeyObject>();
    const devices = readEnrolledDevices(options.dataDir);
    for (const device of devices === "unreadable" ? [] : devices) {
      const parsed = device.revokedAt === null ? parseDevicePublicKey(device.publicKey) : null;
      if (parsed !== null && typeof parsed !== "string") keys.set(device.deviceId, parsed.key);
    }
    cache = { stamp, keys };
    return keys;
  };
  const seen = new Map<string, number>();

  return {
    verify(presentation): HostCredentialGrant | null {
      const parsed = parseDeviceCredential(presentation.credential);
      if (parsed === null) return null;
      const { claims } = parsed;
      const nowS = Math.floor(now() / 1000);
      if (claims.hostId !== options.hostId || claims.workspaceId !== presentation.workspaceId) {
        return null;
      }
      if (claims.iat > nowS + SKEW_S || claims.exp < nowS - SKEW_S) return null;
      const key = liveKeys().get(claims.deviceId);
      if (key === undefined) return null;
      for (const [jti, expires] of seen) if (expires < nowS - SKEW_S) seen.delete(jti);
      if (seen.has(claims.jti) || seen.size >= maxJtis) return null;
      const good = verify(
        "sha256",
        Buffer.from(parsed.signingInput),
        { key, dsaEncoding: "ieee-p1363" },
        parsed.signature,
      );
      if (!good) return null;
      seen.set(claims.jti, claims.exp);
      const { deviceId } = claims;
      return {
        actor: { kind: "device", deviceId, workspaceId: presentation.workspaceId },
        current: () => liveKeys().has(deviceId),
      };
    },
  };
}

/** What `status --json` shows of a device: never the key itself. */
export function describeDevice(device: EnrolledDevice) {
  const { deviceId, name, fingerprint, enrolledAt, via, revokedAt } = device;
  return { deviceId, name, fingerprint, enrolledAt, via, revokedAt };
}
