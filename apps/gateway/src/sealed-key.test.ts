import { describe, expect, test } from "vite-plus/test";

import { createDevSealingKey } from "../scripts/dev-credentials.ts";
import { toBase64Url } from "./bytes.ts";
import { SealingKeyring, sealProviderKey } from "./sealed-key.ts";

const CONN = "0e9a7c51-3d2b-4f86-8a14-7b5c6d2e9f03";
const OTHER = "1c5e8a2d-6b9f-4d37-8e1a-3f7c0b4d9e62";

async function sealed(key = "sk-real") {
  const sealing = await createDevSealingKey("k1");
  const sk = await sealProviderKey({
    publicKey: sealing.publicKey,
    connectionId: CONN,
    keyVersion: 2,
    key,
  });
  return { sealing, sk, keyring: SealingKeyring.parse(sealing.keyring)! };
}

describe("sealed provider keys", () => {
  test("open what was sealed for the same connection and version", async () => {
    const { sk, keyring } = await sealed("sk-ant-api03-ünïcode");
    expect(sk).toMatch(/^v1\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await keyring.open(sk, CONN, 2)).toEqual({ ok: true, key: "sk-ant-api03-ünïcode" });
  });

  test("a key moved to another connection or version does not open", async () => {
    const { sk, keyring } = await sealed();
    expect(await keyring.open(sk, OTHER, 2)).toEqual({
      ok: false,
      code: "volli_gateway_misconfigured",
    });
    expect(await keyring.open(sk, CONN, 3)).toEqual({
      ok: false,
      code: "volli_gateway_misconfigured",
    });
  });

  test("a key sealed under a retired kid asks for a fresh grant", async () => {
    const { sk } = await sealed();
    const other = SealingKeyring.parse((await createDevSealingKey("k2")).keyring)!;
    expect(await other.open(sk, CONN, 2)).toEqual({ ok: false, code: "volli_grant_stale" });
  });

  test("the previous key still opens mid-rotation", async () => {
    const { sealing, sk } = await sealed();
    const next = await createDevSealingKey("k2");
    const both = SealingKeyring.parse(
      JSON.stringify({ ...JSON.parse(next.keyring), ...JSON.parse(sealing.keyring) }),
    )!;
    expect(await both.open(sk, CONN, 2)).toEqual({ ok: true, key: "sk-real" });
  });

  test.each([
    ["too few parts", "v1.k1.abc"],
    ["another version", "v2.k1.AAAA.AAAA"],
    ["an enc of the wrong length", `v1.k1.${toBase64Url(new Uint8Array(31))}.AAAA`],
    ["a non-base64url ciphertext", `v1.k1.${toBase64Url(new Uint8Array(32))}.!!`],
  ])("a malformed sealed key (%s) is an invalid grant", async (_label, value) => {
    const { keyring } = await sealed();
    expect(await keyring.open(value, CONN, 2)).toEqual({ ok: false, code: "volli_grant_invalid" });
  });

  test("sealing refuses a malformed public key", async () => {
    await expect(
      sealProviderKey({
        publicKey: { kid: "bad kid", x: toBase64Url(new Uint8Array(32)) },
        connectionId: CONN,
        keyVersion: 1,
        key: "k",
      }),
    ).rejects.toThrow("Not a gateway sealing public key");
    await expect(
      sealProviderKey({
        publicKey: { kid: "k1", x: "AAAA" },
        connectionId: CONN,
        keyVersion: 1,
        key: "k",
      }),
    ).rejects.toThrow("Not a gateway sealing public key");
  });
});

describe("SealingKeyring.parse", () => {
  const x = toBase64Url(new Uint8Array(32).fill(9));
  test.each([
    ["absent", undefined],
    ["empty", ""],
    ["not JSON", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["empty object", "{}"],
    ["a bad kid", JSON.stringify({ "a.b": { kty: "OKP", crv: "X25519", d: x, x } })],
    ["another curve", JSON.stringify({ k: { kty: "OKP", crv: "Ed25519", d: x, x } })],
    ["a short d", JSON.stringify({ k: { kty: "OKP", crv: "X25519", d: "AAAA", x } })],
    ["no x", JSON.stringify({ k: { kty: "OKP", crv: "X25519", d: x } })],
    ["a non-object key", JSON.stringify({ k: "x" })],
  ])("refuses a keyring that is %s", (_label, value) => {
    expect(SealingKeyring.parse(value)).toBeNull();
  });

  test("a key WebCrypto refuses fails at open, not at parse", async () => {
    const { sk } = await sealed();
    // A well-shaped JWK whose x does not match d: Node refuses the pair on import.
    const keyring = SealingKeyring.parse(
      JSON.stringify({
        k1: { kty: "OKP", crv: "X25519", d: toBase64Url(new Uint8Array(32).fill(1)), x },
      }),
    );
    expect(keyring).not.toBeNull();
    expect(await keyring!.open(sk, CONN, 2)).toEqual({
      ok: false,
      code: "volli_gateway_misconfigured",
    });
  });
});
