import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  describeDevice,
  enrollDevice,
  enrolledDevicesPath,
  parseDevicePublicKey,
  readEnrolledDevices,
} from "./enrolled-devices";

const HOST = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const WORKSPACE = "2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const NOW_S = 1_800_000_000;

let dataDir: string;
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
    expect(readEnrolledDevices(dataDir)).toEqual([]);
    const first = enrollDevice(
      dataDir,
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
    expect(enrollDevice(dataDir, { publicKey: spki, name: "again", via: "ssh" }, mint())).toEqual({
      device: first.device,
      created: false,
    });
    expect(describeDevice(first.device)).not.toHaveProperty("publicKey");
  });

  it("makes a revoked key a new device, so what the old one did stays attributed", () => {
    const { spki } = keyPair();
    const first = enrollDevice(dataDir, { publicKey: spki, name: "", via: "ssh" }, mint());
    expect(first.device.name).toBe("Device");
    const file = enrolledDevicesPath(dataDir);
    const store = JSON.parse(readFileSync(file, "utf8")) as {
      devices: { revokedAt: string | null }[];
    };
    store.devices[0]!.revokedAt = "2026-10-07T00:00:00.000Z";
    writeFileSync(file, JSON.stringify(store));
    const second = enrollDevice(dataDir, { publicKey: spki, name: "x", via: "ssh" }, mint());
    expect(second.created).toBe(true);
    expect(second.device.deviceId).not.toBe(first.device.deviceId);
  });

  it("refuses a bad key, and never overwrites a file that is not its own", () => {
    expect(() =>
      enrollDevice(dataDir, { publicKey: "AAAA", name: "x", via: "ssh" }, mint()),
    ).toThrow("The public key is not a SubjectPublicKeyInfo.");
    const file = enrolledDevicesPath(dataDir);
    for (const text of [
      "{",
      "null",
      '{"v":2,"devices":[]}',
      '{"v":1,"devices":[{"deviceId":"x"}]}',
      '{"v":1,"devices":[null]}',
    ]) {
      writeFileSync(file, text);
      expect(readEnrolledDevices(dataDir)).toBe("unreadable");
    }
    expect(() =>
      enrollDevice(dataDir, { publicKey: keyPair().spki, name: "x", via: "ssh" }, mint()),
    ).toThrow(/is not an enrolled-devices file; not overwriting it/u);
    rmSync(file);
    mkdirSync(file);
    expect(readEnrolledDevices(dataDir)).toBe("unreadable");
  });
});

describe("the enrolled-device verifier", () => {
  function enrolled() {
    const { privateKey, spki } = keyPair();
    const { device } = enrollDevice(dataDir, { publicKey: spki, name: "Mac", via: "ssh" }, mint());
    return { privateKey, deviceId: device.deviceId };
  }
  let clock = NOW_S * 1000;
  const verifier = (max?: number) =>
    createEnrolledDeviceVerifier({
      dataDir,
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
    const verify = createEnrolledDeviceVerifier({ dataDir, hostId: HOST });
    expect(
      await verify.verify(presented(credential(privateKey, { deviceId, iat: now, exp: now + 60 }))),
    ).not.toBeNull();
  });
});
