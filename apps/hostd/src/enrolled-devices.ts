/**
 * Devices enrolled with this host, and the credential verifier that admits
 * them (VC-700): the first accepting verifier behind VC-663's port.
 *
 * **The store** holds public keys, never a secret: each device's P-256 SPKI
 * (base64url), its SHA-256 fingerprint, the label the person gave it, and
 * how it was enrolled. Host-level like `devices` (VC-550): it never leaves
 * the box in a backup. Where it lives is the trust boundary:
 * - **A system install** (hostd and every Session run as `volli`) keeps it
 *   in `/etc/volli-hostd-devices`, root's, mode 0644, beside the operators
 *   file and for its reason (`operators.ts`): an enrolled device acts as the
 *   person, so whoever can write this file can mint a person, and that must
 *   never be the account every agent runs as. hostd only reads it, and
 *   believes it only while `readRootFile` does (root-owned, written by no one
 *   else, in a directory chain only root controls); `enroll --system` and
 *   `devices revoke --system` run as root.
 * - **A user install** runs as the person, so agents already share their
 *   account: the store is `<dataDir>/enrolled-devices.json`, mode 0600.
 *
 * VC-575 owns the durable devices table and may fold this file into it; the
 * verifier port is the seam, so nothing else changes when it does.
 *
 * **Enrollment** (`volli-hostd enroll`, enroll.ts) adds a key; it is the SSH
 * path. Pairing by code (VC-575) and an account-issued key (a hosted control
 * plane) are other writers of the same fact: guardrail 1. Every update takes
 * a lock beside the store, so two enrollments never lose one another's entry.
 *
 * **Verification** takes a `vdc1` device credential (`@volli/host-protocol`,
 * device-credential.ts) and admits it when, all at once:
 * - it names this host and the hello's Workspace;
 * - its device is enrolled and not revoked;
 * - it is inside its own short life (≤ 5 min, 60 s skew allowed), and was
 *   issued no earlier than this verifier started: the `jti`s it remembers
 *   die with the process, so a credential minted before a restart is never
 *   replayable after it (the client mints a fresh one; it is cheap);
 * - its `jti` was never seen (remembered until it would have expired);
 * - its signature is good under the enrolled key.
 *
 * The grant stays current while the device stays enrolled: revocation
 * (`volli-hostd devices revoke`, or the entry gone) closes its connections at
 * the door's next check. A revocation does not reach into a call already
 * past the door: VC-575's commit-boundary check (docs/plans/host-protocol.md,
 * "Enrollment over SSH").
 */
import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  base64UrlToBytes,
  isUuidV4,
  parseDeviceCredential,
  type HostConnectionCredentialGrant,
  type HostCredentialVerifier,
} from "@volli/host-protocol";

import { readRootFile } from "./operators";

export const ENROLLED_DEVICES_FILE = "enrolled-devices.json";

/**
 * A system install's store: directly in `/etc`, which root owns and nobody
 * else writes, like `/etc/volli-hostd-operators`. Not under `/etc/volli-hostd`,
 * which install gives the service account for its key.
 */
export const DEFAULT_DEVICES_FILE = "/etc/volli-hostd-devices";

/** How a device came to be trusted. Only `ssh` writes today. */
export type EnrollmentPath = "ssh";

/** Where a host's enrolled devices live, and who may have written them. */
export interface DeviceStore {
  readonly path: string;
  /**
   * A system install's root-owned file: believed only while owned by this
   * uid (root in production) and writable by no one else, and written 0644.
   * `null`: a data directory's own file, written 0600 by its owner.
   */
  readonly trustedOwnerUid: number | null;
}

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

/** A data directory's own store file. */
export function enrolledDevicesPath(dataDir: string): string {
  return join(dataDir, ENROLLED_DEVICES_FILE);
}

/** A user install's store (or any data directory's): its own 0600 file. */
export function dataDirDeviceStore(dataDir: string): DeviceStore {
  return { path: enrolledDevicesPath(dataDir), trustedOwnerUid: null };
}

/** A system install's store: root's file, outside the data directory. */
export function rootDeviceStore(path = DEFAULT_DEVICES_FILE, trustedOwnerUid = 0): DeviceStore {
  return { path, trustedOwnerUid };
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

/** Why a store answered no devices: not ours to parse, or not root's to believe. */
export type DeviceStoreProblem = "unreadable" | "untrusted";

export type DeviceStoreRead =
  | {
      readonly ok: true;
      readonly devices: readonly EnrolledDevice[];
      /** Changes whenever the file is rewritten or replaced. */
      readonly stamp: string;
    }
  | { readonly ok: false; readonly problem: DeviceStoreProblem; readonly reason: string };

function parseStore(text: string): readonly EnrolledDevice[] | null {
  try {
    const parsed = JSON.parse(text) as Partial<EnrolledDevicesFile> | null;
    return parsed?.v === 1 &&
      Array.isArray(parsed.devices) &&
      parsed.devices.every(isEnrolledDevice)
      ? parsed.devices
      : null;
  } catch {
    return null;
  }
}

/**
 * Every enrolled device, revoked ones included; none when none was ever
 * enrolled; a problem for a file that is not one of ours, or (a system
 * install's) one root's rules do not trust. Then nothing is admitted, and
 * no update overwrites it.
 */
export function readDeviceStore(store: DeviceStore): DeviceStoreRead {
  const notOurs = (): DeviceStoreRead => ({
    ok: false,
    problem: "unreadable",
    reason: `${store.path} is not an enrolled-devices file`,
  });
  if (store.trustedOwnerUid !== null) {
    const read = readRootFile(store.path, store.trustedOwnerUid, store.path, "enroll a device");
    if (read.state === "unsafe") return { ok: false, problem: "untrusted", reason: read.reason };
    if (read.state === "absent") return { ok: true, devices: [], stamp: "absent" };
    const devices = parseStore(read.text);
    return devices === null ? notOurs() : { ok: true, devices, stamp: read.stamp };
  }
  let stamp: string;
  let text: string;
  try {
    // One descriptor, judged and read: the stamp is of the bytes read.
    const fd = openSync(store.path, "r");
    try {
      const stat = fstatSync(fd);
      stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { ok: true, devices: [], stamp: "absent" }
      : notOurs();
  }
  const devices = parseStore(text);
  return devices === null ? notOurs() : { ok: true, devices, stamp };
}

/** The devices, or the problem's name: what `status --json` and the tests read. */
export function readEnrolledDevices(
  store: DeviceStore,
): readonly EnrolledDevice[] | DeviceStoreProblem {
  const read = readDeviceStore(store);
  return read.ok ? read.devices : read.problem;
}

/** Why an update to a store did not happen: each is a typed refusal of the command. */
export class DeviceStoreError extends Error {
  constructor(
    readonly code: DeviceStoreProblem | "busy" | "unknown-device" | "bad-key",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Replaces the store in one rename, durably: the file, then its directory.
 * Its mode is set on the descriptor, so a narrow umask (sudo's, say) cannot
 * leave a system store hostd may not read.
 */
function writeDeviceStore(store: DeviceStore, devices: readonly EnrolledDevice[]): void {
  const temporary = `${store.path}.${process.pid}.${randomUUID()}.tmp`;
  const mode = store.trustedOwnerUid === null ? 0o600 : 0o644;
  try {
    const fd = openSync(temporary, "wx", mode);
    try {
      fchmodSync(fd, mode);
      writeSync(
        fd,
        `${JSON.stringify({ v: 1, devices } satisfies EnrolledDevicesFile, null, 2)}\n`,
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, store.path);
    syncDirectory(dirname(store.path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Makes a rename in `directory` durable. */
function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface StoreLockTiming {
  /** How long to wait for another update before answering `busy`. */
  readonly timeoutMs: number;
  /** Past this age a lock whose owner cannot be asked is taken as abandoned. */
  readonly staleMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => void;
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export const DEFAULT_LOCK_TIMING: StoreLockTiming = {
  timeoutMs: 10_000,
  staleMs: 60_000,
  now: Date.now,
  sleep: sleepSync,
};

/** Whether the process a lock names is gone, so its lock is abandoned. */
function ownerGone(lock: string, timing: StoreLockTiming): boolean {
  let text: string;
  let age: number;
  try {
    text = readFileSync(lock, "utf8");
    age = timing.now() - statSync(lock).mtimeMs;
  } catch {
    // Released between our attempt and this look: try again.
    return false;
  }
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return age > timing.staleMs;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM: alive, another account's. Only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Runs `update` holding `<store>.lock`, a file made exclusively and holding
 * this pid: two enrollments at once (or an enrollment and a revocation)
 * apply one after the other instead of one rename dropping the other's
 * entry. A lock whose process is gone is broken; one held past `timeoutMs`
 * answers `busy`.
 */
export function withDeviceStoreLock<T>(
  store: DeviceStore,
  update: () => T,
  timing: StoreLockTiming = DEFAULT_LOCK_TIMING,
): T {
  const lock = `${store.path}.lock`;
  const deadline = timing.now() + timing.timeoutMs;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (fd !== null) {
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      try {
        return update();
      } finally {
        rmSync(lock, { force: true });
      }
    }
    if (ownerGone(lock, timing)) {
      rmSync(lock, { force: true });
      continue;
    }
    if (timing.now() >= deadline) {
      throw new DeviceStoreError(
        "busy",
        `Another command is updating ${store.path} (${lock}); try again.`,
      );
    }
    timing.sleep(25);
  }
}

function devicesOrThrow(store: DeviceStore): readonly EnrolledDevice[] {
  const read = readDeviceStore(store);
  if (read.ok) return read.devices;
  throw new DeviceStoreError(
    read.problem,
    read.problem === "untrusted"
      ? `Refusing the enrolled-devices store: ${read.reason}. Run: sudo chown root:root ${store.path} && sudo chmod 644 ${store.path}`
      : `${read.reason}; not overwriting it.`,
  );
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
 * of what the old one did survives. Throws a `DeviceStoreError` on a bad
 * key, a store it will not overwrite, or one held too long by another update.
 */
export function enrollDevice(
  store: DeviceStore,
  request: EnrollRequest,
  mint: { now: () => Date; newId: () => string },
  timing?: StoreLockTiming,
): EnrollOutcome {
  const parsed = parseDevicePublicKey(request.publicKey);
  if (typeof parsed === "string") throw new DeviceStoreError("bad-key", parsed);
  return withDeviceStoreLock(
    store,
    () => {
      const devices = devicesOrThrow(store);
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
      writeDeviceStore(store, [...devices, device]);
      return { device, created: true };
    },
    timing,
  );
}

export interface RevokeOutcome {
  readonly device: EnrolledDevice;
  /** `false` when it was already revoked. */
  readonly changed: boolean;
}

/**
 * Revokes a device: its entry stays, with `revokedAt`, so what it did stays
 * attributed; its connections close at the door's next check, and its
 * credentials are refused from now on.
 */
export function revokeDevice(
  store: DeviceStore,
  deviceId: string,
  now: () => Date,
  timing?: StoreLockTiming,
): RevokeOutcome {
  return withDeviceStoreLock(
    store,
    () => {
      const devices = devicesOrThrow(store);
      const device = devices.find((entry) => entry.deviceId === deviceId);
      if (device === undefined) {
        throw new DeviceStoreError("unknown-device", `No device ${deviceId} is enrolled here.`);
      }
      if (device.revokedAt !== null) return { device, changed: false };
      const revoked: EnrolledDevice = { ...device, revokedAt: now().toISOString() };
      writeDeviceStore(
        store,
        devices.map((entry) => (entry === device ? revoked : entry)),
      );
      return { device: revoked, changed: true };
    },
    timing,
  );
}

export interface EnrolledDeviceVerifierOptions {
  readonly store: DeviceStore;
  readonly hostId: string;
  readonly now?: () => number;
  /** Past this many live `jti`s, new credentials are refused rather than unremembered. */
  readonly maxRememberedJtis?: number;
  /** Told once per change of the store that it admits no one, and why (never a key). */
  readonly onStoreProblem?: (problem: DeviceStoreProblem, reason: string) => void;
}

/** The verifier hostd composes for its WebSocket listener (VC-663's port). */
export function createEnrolledDeviceVerifier(
  options: EnrolledDeviceVerifierOptions,
): HostCredentialVerifier {
  const now = options.now ?? Date.now;
  const maxJtis = options.maxRememberedJtis ?? MAX_REMEMBERED_JTIS;
  /** The `jti`s below are this process's; nothing issued before it began is admitted. */
  const startedS = Math.floor(now() / 1000);
  let cache: { stamp: string; keys: Map<string, KeyObject> } | null = null;
  let reported: string | null = null;
  /** Live enrolled keys by device id, re-parsed when the file changed. */
  const liveKeys = (): Map<string, KeyObject> => {
    const read = readDeviceStore(options.store);
    if (!read.ok) {
      if (reported !== read.reason) {
        reported = read.reason;
        options.onStoreProblem?.(read.problem, read.reason);
      }
      cache = null;
      return new Map();
    }
    reported = null;
    if (cache?.stamp === read.stamp) return cache.keys;
    const keys = new Map<string, KeyObject>();
    for (const device of read.devices) {
      const parsed = device.revokedAt === null ? parseDevicePublicKey(device.publicKey) : null;
      if (parsed !== null && typeof parsed !== "string") keys.set(device.deviceId, parsed.key);
    }
    cache = { stamp: read.stamp, keys };
    return keys;
  };
  const seen = new Map<string, number>();

  return {
    verify(presentation): HostConnectionCredentialGrant | null {
      const parsed = parseDeviceCredential(presentation.credential);
      if (parsed === null) return null;
      const { claims } = parsed;
      const nowS = Math.floor(now() / 1000);
      if (claims.hostId !== options.hostId) return null;
      if ("scope" in presentation) {
        if (presentation.scope !== "host" || !("scope" in claims) || claims.scope !== "host")
          return null;
      } else if ("scope" in claims || claims.workspaceId !== presentation.workspaceId) {
        return null;
      }
      if (claims.iat > nowS + SKEW_S || claims.exp < nowS - SKEW_S) return null;
      // Restart replay: a credential from before this process could have
      // been admitted by the one before it, whose `jti`s are gone.
      if (claims.iat < startedS) return null;
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
        actor:
          "scope" in presentation
            ? { kind: "device", deviceId, scope: "host" }
            : { kind: "device", deviceId, workspaceId: presentation.workspaceId },
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
