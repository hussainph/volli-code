import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  assembleDeviceCredential,
  bytesToBase64Url,
  deviceCredentialSigningInput,
  type DeviceCredentialClaims,
  type HostCredentialPresentation,
} from "@volli/host-protocol";

import {
  createEnrolledDeviceVerifier,
  dataDirDeviceStore,
  DEFAULT_LOCK_TIMING,
  describeDevice,
  DeviceStoreError,
  enrollDevice,
  enrolledDevicesPath,
  parseDevicePublicKey,
  readEnrolledDevices,
  revokeDevice,
  rootDeviceStore,
  withDeviceStoreLock,
} from "./enrolled-devices";

const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const WORKSPACE = "2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const NOW_S = 1_800_000_000;

let dataDir: string;
const own = () => dataDirDeviceStore(dataDir);
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hostd-devices-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function keyPair(curve = "P-256") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: curve });
  return { privateKey, spki: bytesToBase64Url(publicKey.export({ format: "der", type: "spki" })) };
}

const mint = () => ({ now: () => new Date(NOW_S * 1000), newId: randomUUID });

function credential(
  privateKey: KeyObject,
  claims: Partial<DeviceCredentialClaims> & { deviceId: string },
): string {
  const input = deviceCredentialSigningInput({
    hostId: HOST,
    workspaceId: WORKSPACE,
    iat: NOW_S,
    exp: NOW_S + 60,
    jti: randomUUID().replaceAll("-", ""),
    ...claims,
  });
  return assembleDeviceCredential(
    input,
    sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }),
  );
}

function presented(text: string, workspaceId = WORKSPACE): HostCredentialPresentation {
  return {
    credential: text,
    workspaceId,
    nonce: "n".repeat(43),
    client: { kind: "desktop", version: "test" },
  };
}

describe("a device's public key", () => {
  it("must be P-256 SPKI in base64url, and has an ssh-style fingerprint", () => {
    const { spki } = keyPair();
    const parsed = parseDevicePublicKey(spki);
    expect(typeof parsed !== "string" && parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u);
    expect(parseDevicePublicKey("not base64!")).toBe("The public key is not base64url.");
    expect(parseDevicePublicKey("AAAA")).toBe("The public key is not a SubjectPublicKeyInfo.");
    expect(parseDevicePublicKey(keyPair("P-384").spki)).toBe("The public key must be ECDSA P-256.");
    const ed = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    expect(parseDevicePublicKey(bytesToBase64Url(ed))).toBe("The public key must be ECDSA P-256.");
  });
});

describe("the enrolled-devices store", () => {
  it("enrolls a key once, privately, and answers the same device for it again", () => {
    const { spki } = keyPair();
    expect(readEnrolledDevices(own())).toEqual([]);
    const first = enrollDevice(
      own(),
      { publicKey: spki, name: "  Alice's Mac  ", via: "ssh" },
      mint(),
    );
    expect(first.created).toBe(true);
    expect(first.device).toMatchObject({
      name: "Alice's Mac",
      publicKey: spki,
      enrolledAt: new Date(NOW_S * 1000).toISOString(),
      via: "ssh",
      revokedAt: null,
    });
    expect(statSync(enrolledDevicesPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(enrollDevice(own(), { publicKey: spki, name: "again", via: "ssh" }, mint())).toEqual({
      device: first.device,
      created: false,
    });
    expect(describeDevice(first.device)).not.toHaveProperty("publicKey");
  });

  it("makes a revoked key a new device, so what the old one did stays attributed", () => {
    const { spki } = keyPair();
    const first = enrollDevice(own(), { publicKey: spki, name: "", via: "ssh" }, mint());
    expect(first.device.name).toBe("Device");
    const file = enrolledDevicesPath(dataDir);
    const store = JSON.parse(readFileSync(file, "utf8")) as {
      devices: { revokedAt: string | null }[];
    };
    store.devices[0]!.revokedAt = "2026-10-07T00:00:00.000Z";
    writeFileSync(file, JSON.stringify(store));
    const second = enrollDevice(own(), { publicKey: spki, name: "x", via: "ssh" }, mint());
    expect(second.created).toBe(true);
    expect(second.device.deviceId).not.toBe(first.device.deviceId);
  });

  it("refuses a bad key, and never overwrites a file that is not its own", () => {
    expect(() => enrollDevice(own(), { publicKey: "AAAA", name: "x", via: "ssh" }, mint())).toThrow(
      "The public key is not a SubjectPublicKeyInfo.",
    );
    const file = enrolledDevicesPath(dataDir);
    for (const text of [
      "{",
      "null",
      '{"v":2,"devices":[]}',
      '{"v":1,"devices":[{"deviceId":"x"}]}',
      '{"v":1,"devices":[null]}',
    ]) {
      writeFileSync(file, text);
      expect(readEnrolledDevices(own())).toBe("unreadable");
    }
    expect(() =>
      enrollDevice(own(), { publicKey: keyPair().spki, name: "x", via: "ssh" }, mint()),
    ).toThrow(/is not an enrolled-devices file; not overwriting it/u);
    rmSync(file);
    mkdirSync(file);
    expect(readEnrolledDevices(own())).toBe("unreadable");
  });
});

describe("the enrolled-device verifier", () => {
  function enrolled() {
    const { privateKey, spki } = keyPair();
    const { device } = enrollDevice(own(), { publicKey: spki, name: "Mac", via: "ssh" }, mint());
    return { privateKey, deviceId: device.deviceId };
  }
  let clock = NOW_S * 1000;
  const verifier = (max?: number) =>
    createEnrolledDeviceVerifier({
      store: own(),
      hostId: HOST,
      now: () => clock,
      ...(max === undefined ? {} : { maxRememberedJtis: max }),
    });
  beforeEach(() => {
    clock = NOW_S * 1000;
  });

  it("admits a signed credential once, as the device, in the hello's Workspace", async () => {
    const { privateKey, deviceId } = enrolled();
    const verify = verifier();
    const text = credential(privateKey, { deviceId });
    const grant = await verify.verify(presented(text));
    expect(grant?.actor).toEqual({ kind: "device", deviceId, workspaceId: WORKSPACE });
    expect(grant?.current()).toBe(true);
    expect(await verify.verify(presented(text))).toBeNull();
  });

  it("refuses what is not this host's, this Workspace's, now, enrolled or signed by the key", async () => {
    const { privateKey, deviceId } = enrolled();
    const stranger = keyPair().privateKey;
    const verify = verifier();
    for (const text of [
      "device-token",
      credential(privateKey, { deviceId, hostId: randomUUID() }),
      credential(privateKey, { deviceId, iat: NOW_S + 120, exp: NOW_S + 180 }),
      credential(privateKey, { deviceId, iat: NOW_S - 300, exp: NOW_S - 61 }),
      credential(privateKey, { deviceId: randomUUID() }),
      credential(stranger, { deviceId }),
    ]) {
      expect(await verify.verify(presented(text))).toBeNull();
    }
    expect(
      await verify.verify(presented(credential(privateKey, { deviceId }), randomUUID())),
    ).toBeNull();
  });

  it("forgets a jti once it would have expired, and refuses rather than forget early", async () => {
    const { privateKey, deviceId } = enrolled();
    const verify = verifier(1);
    expect(await verify.verify(presented(credential(privateKey, { deviceId })))).not.toBeNull();
    expect(await verify.verify(presented(credential(privateKey, { deviceId })))).toBeNull();
    clock += 200_000;
    const later = Math.floor(clock / 1000);
    expect(
      await verify.verify(
        presented(credential(privateKey, { deviceId, iat: later, exp: later + 60 })),
      ),
    ).not.toBeNull();
  });

  it("ends a grant when its device is revoked, and admits no one from a store it cannot read", async () => {
    const { privateKey, deviceId } = enrolled();
    const verify = verifier();
    const grant = await verify.verify(presented(credential(privateKey, { deviceId })));
    const file = enrolledDevicesPath(dataDir);
    const store = JSON.parse(readFileSync(file, "utf8")) as {
      devices: { revokedAt: string | null; publicKey: string }[];
    };
    // A second, damaged entry is skipped rather than failing the store.
    store.devices.push({
      ...store.devices[0]!,
      publicKey: "AAAA",
      deviceId: randomUUID(),
    } as never);
    store.devices[0]!.revokedAt = "2026-10-07T00:00:00.000Z";
    writeFileSync(file, JSON.stringify(store, null, 4));
    expect(grant?.current()).toBe(false);
    writeFileSync(file, "{");
    expect(await verify.verify(presented(credential(privateKey, { deviceId })))).toBeNull();
    rmSync(file);
    expect(await verify.verify(presented(credential(privateKey, { deviceId })))).toBeNull();
  });

  it("re-reads the store only when it changed", async () => {
    const { privateKey, deviceId } = enrolled();
    const verify = verifier();
    const grant = await verify.verify(presented(credential(privateKey, { deviceId })));
    expect(grant?.current()).toBe(true);
    expect(grant?.current()).toBe(true);
  });

  it("defaults to the wall clock", async () => {
    const { privateKey, deviceId } = enrolled();
    const now = Math.floor(Date.now() / 1000);
    const verify = createEnrolledDeviceVerifier({ store: own(), hostId: HOST });
    expect(
      await verify.verify(presented(credential(privateKey, { deviceId, iat: now, exp: now + 60 }))),
    ).not.toBeNull();
  });
});

describe("the restart-replay rule", () => {
  it("admits nothing issued before the verifier started, so a restart forgets no replay", async () => {
    const { privateKey, spki } = keyPair();
    const { device } = enrollDevice(own(), { publicKey: spki, name: "Mac", via: "ssh" }, mint());
    let clock = NOW_S * 1000;
    const before = createEnrolledDeviceVerifier({ store: own(), hostId: HOST, now: () => clock });
    const text = credential(privateKey, { deviceId: device.deviceId });
    expect(await before.verify(presented(text))).not.toBeNull();
    // hostd restarts a second later: its jti memory is gone, the credential is still live.
    clock += 1000;
    const after = createEnrolledDeviceVerifier({ store: own(), hostId: HOST, now: () => clock });
    expect(await after.verify(presented(text))).toBeNull();
    const fresh = credential(privateKey, {
      deviceId: device.deviceId,
      iat: NOW_S + 1,
      exp: NOW_S + 61,
    });
    expect(await after.verify(presented(fresh))).not.toBeNull();
  });
});

// S-B1: a system install's devices are root's, never the service account's.
describe("a system install's root-owned store", () => {
  const ME = process.getuid!();
  let etc: string;
  beforeEach(() => {
    etc = join(dataDir, "etc");
    mkdirSync(etc, { mode: 0o755 });
    chmodSync(etc, 0o755);
  });
  const root = (owner = ME) => rootDeviceStore(join(etc, "volli-hostd-devices"), owner);

  it("is written 0644 whatever the umask, and admits its devices", async () => {
    const { privateKey, spki } = keyPair();
    const previous = process.umask(0o077);
    let deviceId: string;
    try {
      deviceId = enrollDevice(root(), { publicKey: spki, name: "Mac", via: "ssh" }, mint()).device
        .deviceId;
    } finally {
      process.umask(previous);
    }
    expect(statSync(root().path).mode & 0o777).toBe(0o644);
    const verify = createEnrolledDeviceVerifier({
      store: root(),
      hostId: HOST,
      now: () => NOW_S * 1000,
    });
    const grant = await verify.verify(presented(credential(privateKey, { deviceId })));
    expect(grant?.actor).toMatchObject({ kind: "device", deviceId });
  });

  it("is believed only while no one but its owner could write it", async () => {
    const { privateKey, spki } = keyPair();
    const { deviceId } = enrollDevice(
      root(),
      { publicKey: spki, name: "Mac", via: "ssh" },
      mint(),
    ).device;
    const problems: string[] = [];
    const verify = createEnrolledDeviceVerifier({
      store: root(),
      hostId: HOST,
      now: () => NOW_S * 1000,
      onStoreProblem: (problem) => problems.push(problem),
    });
    const grant = await verify.verify(presented(credential(privateKey, { deviceId })));
    expect(grant?.current()).toBe(true);
    // The service account (in its group, or as anyone) could add itself: refused at once.
    chmodSync(root().path, 0o664);
    expect(grant?.current()).toBe(false);
    expect(await verify.verify(presented(credential(privateKey, { deviceId })))).toBeNull();
    expect(problems).toEqual(["untrusted"]);
    expect(readEnrolledDevices(root())).toBe("untrusted");
    expect(() =>
      enrollDevice(root(), { publicKey: keyPair().spki, name: "x", via: "ssh" }, mint()),
    ).toThrow(expect.objectContaining({ code: "untrusted" }));
    chmodSync(root().path, 0o644);
    expect(grant?.current()).toBe(true);
    // Owned by anyone but the trusted owner (root): not believed either.
    expect(readEnrolledDevices(root(ME + 1))).toBe("untrusted");
    // Nor in a directory others could write.
    chmodSync(etc, 0o777);
    expect(readEnrolledDevices(root())).toBe("untrusted");
    // Root's, but not ours to parse: nothing admitted, nothing overwritten.
    chmodSync(etc, 0o755);
    writeFileSync(root().path, "{");
    expect(readEnrolledDevices(root())).toBe("unreadable");
  });
});

describe("store updates", () => {
  it("propagates a lock-open error other than contention", () => {
    const missingParent = dataDirDeviceStore(join(dataDir, "missing"));
    expect(() => withDeviceStoreLock(missingParent, () => undefined)).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("revokes a device, keeping its entry, and refuses one never enrolled", async () => {
    const { privateKey, spki } = keyPair();
    const { deviceId } = enrollDevice(
      own(),
      { publicKey: spki, name: "Mac", via: "ssh" },
      mint(),
    ).device;
    const verify = createEnrolledDeviceVerifier({
      store: own(),
      hostId: HOST,
      now: () => NOW_S * 1000,
    });
    const grant = await verify.verify(presented(credential(privateKey, { deviceId })));
    const later = () => new Date((NOW_S + 5) * 1000);
    const other = enrollDevice(
      own(),
      { publicKey: keyPair().spki, name: "b", via: "ssh" },
      mint(),
    ).device;
    expect(revokeDevice(own(), deviceId, later)).toMatchObject({
      changed: true,
      device: { deviceId, revokedAt: new Date((NOW_S + 5) * 1000).toISOString() },
    });
    expect(grant?.current()).toBe(false);
    expect(revokeDevice(own(), deviceId, later).changed).toBe(false);
    expect(readEnrolledDevices(own())).toEqual([
      expect.objectContaining({ deviceId, revokedAt: expect.any(String) }),
      other,
    ]);
    expect(() => revokeDevice(own(), randomUUID(), later)).toThrow(
      expect.objectContaining({ code: "unknown-device" }),
    );
  });

  const fast = { timeoutMs: 50, staleMs: 60_000, now: Date.now, sleep: () => undefined };

  it("waits for another update's lock, and answers busy rather than overwrite it", () => {
    const lock = `${own().path}.lock`;
    writeFileSync(lock, `${process.pid}\n`);
    const started = Date.now();
    expect(() =>
      enrollDevice(own(), { publicKey: keyPair().spki, name: "x", via: "ssh" }, mint(), {
        ...DEFAULT_LOCK_TIMING,
        timeoutMs: 60,
      }),
    ).toThrow(DeviceStoreError);
    // It slept between looks rather than spinning.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(readEnrolledDevices(own())).toEqual([]);
    rmSync(lock);
    enrollDevice(own(), { publicKey: keyPair().spki, name: "x", via: "ssh" }, mint(), fast);
    expect(readEnrolledDevices(own())).toHaveLength(1);
  });

  it("breaks a lock whose process is gone, and releases its own even on a throw", () => {
    const lock = `${own().path}.lock`;
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
    writeFileSync(lock, `${gone}\n`);
    enrollDevice(own(), { publicKey: keyPair().spki, name: "x", via: "ssh" }, mint(), fast);
    expect(() => statSync(lock)).toThrow();
    expect(() =>
      withDeviceStoreLock(own(), () => {
        throw new Error("mid-update");
      }),
    ).toThrow("mid-update");
    expect(() => statSync(lock)).toThrow();
  });

  it("tries again when the lock is released while it looks at it, and judges an odd one by age", () => {
    const lock = `${own().path}.lock`;
    writeFileSync(lock, `${process.pid}\n`);
    let calls = 0;
    const releasing = {
      ...fast,
      now: () => {
        calls += 1;
        // The holder finishes just as the lock's age is read.
        if (calls === 2) rmSync(lock, { force: true });
        return Date.now();
      },
    };
    enrollDevice(own(), { publicKey: keyPair().spki, name: "x", via: "ssh" }, mint(), releasing);
    expect(readEnrolledDevices(own())).toHaveLength(1);
    // A lock naming no process is abandoned only once it is old.
    writeFileSync(lock, "not a pid\n");
    expect(() =>
      enrollDevice(own(), { publicKey: keyPair().spki, name: "y", via: "ssh" }, mint(), fast),
    ).toThrow(expect.objectContaining({ code: "busy" }));
    enrollDevice(own(), { publicKey: keyPair().spki, name: "y", via: "ssh" }, mint(), {
      ...fast,
      staleMs: -1,
    });
    expect(readEnrolledDevices(own())).toHaveLength(2);
  });

  it("lets no second update in while one holds the store, so neither drops the other's entry", () => {
    // What a second enrolling process meets mid-update: the lock, not a stale snapshot.
    const first = keyPair().spki;
    const second = keyPair().spki;
    withDeviceStoreLock(own(), () => {
      expect(() =>
        enrollDevice(own(), { publicKey: second, name: "b", via: "ssh" }, mint(), fast),
      ).toThrow(expect.objectContaining({ code: "busy" }));
    });
    enrollDevice(own(), { publicKey: first, name: "a", via: "ssh" }, mint());
    enrollDevice(own(), { publicKey: second, name: "b", via: "ssh" }, mint());
    expect(readEnrolledDevices(own())).toHaveLength(2);
  });
});
