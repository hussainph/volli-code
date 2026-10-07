import { createHash, createPublicKey, verify } from "node:crypto";

import { base64UrlToBytes, parseDeviceCredential } from "@volli/host-protocol";
import { describe, expect, it } from "vite-plus/test";

import {
  DEVICE_CREDENTIAL_LIFETIME_S,
  generateDeviceKey,
  mintDeviceCredential,
  spkiFingerprint,
} from "./remote-hosts-device-key";

const HOST_ID = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const DEVICE_ID = "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const WORKSPACE_ID = "2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";

describe("a device key", () => {
  it("is a P-256 pair whose public half and fingerprint are hostd's", () => {
    const key = generateDeviceKey("Alice's Mac");
    expect(key.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/u);
    const der = base64UrlToBytes(key.identity.publicKey)!;
    const publicKey = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
    expect(publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    // hostd's `spkiFingerprint`: SHA256: and unpadded base64 of the DER's digest.
    const digest = createHash("sha256").update(der).digest("base64").replace(/=+$/u, "");
    expect(key.identity.fingerprint).toBe(`SHA256:${digest}`);
    expect(spkiFingerprint(der)).toBe(key.identity.fingerprint);
    expect(key.identity.name).toBe("Alice's Mac");
    // The private half belongs to the public one.
    expect(
      createPublicKey(key.privateKeyPem).export({ type: "spki", format: "der" }).equals(der),
    ).toBe(true);
  });

  it("is new every time", () => {
    expect(generateDeviceKey("a").identity.publicKey).not.toBe(
      generateDeviceKey("a").identity.publicKey,
    );
  });
});

describe("a minted credential", () => {
  it("signs a fresh host-scoped statement without Workspace fields", () => {
    const key = generateDeviceKey("host device");
    const parsed = parseDeviceCredential(
      mintDeviceCredential({
        privateKeyPem: key.privateKeyPem,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        scope: "host",
        now: Date.now(),
      }),
    )!;
    expect(parsed.claims).toMatchObject({ scope: "host", hostId: HOST_ID, deviceId: DEVICE_ID });
    expect(parsed.claims).not.toHaveProperty("workspaceId");
    expect(
      verify(
        "sha256",
        Buffer.from(parsed.signingInput),
        {
          key: createPublicKey(key.privateKeyPem),
          dsaEncoding: "ieee-p1363",
        },
        parsed.signature,
      ),
    ).toBe(true);
  });

  it("is a vdc1 the host verifies: its claims, a short life, a fresh jti, a P1363 signature", () => {
    const key = generateDeviceKey("Mac");
    const now = Date.UTC(2026, 0, 1, 12, 0, 0, 750);
    const input = {
      privateKeyPem: key.privateKeyPem,
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
      now,
    };
    const credential = mintDeviceCredential(input);
    const parsed = parseDeviceCredential(credential)!;
    expect(parsed).not.toBeNull();
    const iat = Math.floor(now / 1000);
    expect(parsed.claims).toMatchObject({
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      workspaceId: WORKSPACE_ID,
      iat,
      exp: iat + DEVICE_CREDENTIAL_LIFETIME_S,
    });
    expect(parsed.claims.exp - parsed.claims.iat).toBeLessThanOrEqual(300);
    const publicKey = createPublicKey({
      key: Buffer.from(base64UrlToBytes(key.identity.publicKey)!),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(parsed.signingInput, "ascii"),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        parsed.signature,
      ),
    ).toBe(true);
    expect(parseDeviceCredential(mintDeviceCredential(input))!.claims.jti).not.toBe(
      parsed.claims.jti,
    );
  });
});
