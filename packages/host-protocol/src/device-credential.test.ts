import { generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  assembleDeviceCredential,
  base64UrlToBytes,
  bytesToBase64Url,
  DEVICE_CREDENTIAL_MAX_LIFETIME_S,
  deviceCredentialSigningInput,
  isDeviceCredentialClaims,
  parseDeviceCredential,
  type DeviceCredentialClaims,
} from "./index";

const CLAIMS: DeviceCredentialClaims = {
  hostId: "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
  deviceId: "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
  workspaceId: "2f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
  iat: 1_800_000_000,
  exp: 1_800_000_060,
  jti: "AAAAAAAAAAAAAAAAAAAAAA",
};

function signed(claims: DeviceCredentialClaims = CLAIMS) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const input = deviceCredentialSigningInput(claims);
  const signature = sign("sha256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return { credential: assembleDeviceCredential(input, signature), publicKey };
}

const body = (value: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));

describe("the device credential frame", () => {
  it("round-trips claims and a signature the host can check", () => {
    const { credential, publicKey } = signed();
    expect(credential.startsWith("vdc1.")).toBe(true);
    const parsed = parseDeviceCredential(credential)!;
    expect(parsed.claims).toEqual(CLAIMS);
    expect(
      verify(
        "sha256",
        Buffer.from(parsed.signingInput),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        parsed.signature,
      ),
    ).toBe(true);
  });

  it("drops fields it does not know, and keeps the signed bytes whole", () => {
    const encoded = bytesToBase64Url(
      new TextEncoder().encode(JSON.stringify({ ...CLAIMS, extra: 1 })),
    );
    const parsed = parseDeviceCredential(
      `vdc1.${encoded}.${bytesToBase64Url(new Uint8Array(64))}`,
    )!;
    expect(parsed.claims).toEqual(CLAIMS);
    expect(parsed.signingInput).toBe(`vdc1.${encoded}`);
  });

  it("refuses anything that is not a well-formed vdc1 credential", () => {
    const sig = bytesToBase64Url(new Uint8Array(64));
    for (const credential of [
      "",
      "vdc1.a",
      `vdc2.${body(CLAIMS)}.${sig}`,
      `vdc1.${body(CLAIMS)}.${bytesToBase64Url(new Uint8Array(63))}`,
      `vdc1.${body(CLAIMS)}.not+base64`,
      `vdc1.a.${sig}`,
      `vdc1.${bytesToBase64Url(new Uint8Array([0xff, 0xfe]))}.${sig}`,
      `vdc1.${bytesToBase64Url(new TextEncoder().encode("{"))}.${sig}`,
      `vdc1.${body({ ...CLAIMS, jti: "short" })}.${sig}`,
      `vdc1.${body({ ...CLAIMS, exp: CLAIMS.iat })}.${sig}`,
    ]) {
      expect(parseDeviceCredential(credential)).toBeNull();
    }
  });

  it("bounds a credential's life and names every claim", () => {
    expect(isDeviceCredentialClaims(CLAIMS)).toBe(true);
    for (const value of [
      null,
      [],
      "claims",
      { ...CLAIMS, hostId: "host" },
      { ...CLAIMS, deviceId: "local" },
      { ...CLAIMS, workspaceId: 1 },
      { ...CLAIMS, jti: 1 },
      { ...CLAIMS, iat: 0, exp: 10 },
      { ...CLAIMS, iat: 1.5 },
      { ...CLAIMS, exp: "later" },
      { ...CLAIMS, exp: CLAIMS.iat + DEVICE_CREDENTIAL_MAX_LIFETIME_S + 1 },
    ]) {
      expect(isDeviceCredentialClaims(value)).toBe(false);
    }
  });

  it("encodes base64url without padding, and refuses a length no encoder makes", () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0x00, 0x10]);
    expect(bytesToBase64Url(bytes)).toBe("-_8AEA");
    expect(base64UrlToBytes("-_8AEA")).toEqual(bytes);
    expect(base64UrlToBytes("abcde")).toBeNull();
    expect(base64UrlToBytes("a=")).toBeNull();
  });
});
