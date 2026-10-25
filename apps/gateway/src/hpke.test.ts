import { describe, expect, test } from "vite-plus/test";

import { toBase64Url } from "./bytes.ts";
import { hpkeOpen, hpkeSeal, importX25519Private } from "./hpke.ts";

const hex = (value: string) =>
  new Uint8Array(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
const jwk = (d: string, x: string) =>
  ({ kty: "OKP", crv: "X25519", d: toBase64Url(hex(d)), x: toBase64Url(hex(x)) }) as const;

// RFC 9180 Appendix A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
const VECTOR = {
  info: hex("4f6465206f6e2061204772656369616e2055726e"),
  skEm: "52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736",
  pkEm: "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431",
  skRm: "4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8",
  pkRm: "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d",
  pt: hex("4265617574792069732074727574682c20747275746820626561757479"),
  aad: hex("436f756e742d30"),
  ct: hex(
    "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a",
  ),
};

describe("RFC 9180 A.1.1", () => {
  test("seal with the vector's ephemeral key reproduces its enc and first ciphertext", async () => {
    const sealed = await hpkeSeal({
      aead: "aes-128-gcm",
      recipientPublicKey: hex(VECTOR.pkRm),
      info: VECTOR.info,
      aad: VECTOR.aad,
      plaintext: VECTOR.pt,
      ephemeral: {
        privateKey: await importX25519Private(jwk(VECTOR.skEm, VECTOR.pkEm)),
        publicKey: hex(VECTOR.pkEm),
      },
    });
    expect(sealed.enc).toEqual(hex(VECTOR.pkEm));
    expect(sealed.ciphertext).toEqual(VECTOR.ct);
  });

  test("open recovers the vector's plaintext", async () => {
    const plaintext = await hpkeOpen({
      aead: "aes-128-gcm",
      recipientPrivateKey: await importX25519Private(jwk(VECTOR.skRm, VECTOR.pkRm)),
      recipientPublicKey: hex(VECTOR.pkRm),
      enc: hex(VECTOR.pkEm),
      info: VECTOR.info,
      aad: VECTOR.aad,
      ciphertext: VECTOR.ct,
    });
    expect(plaintext).toEqual(VECTOR.pt);
  });

  test("open refuses other associated data", async () => {
    await expect(
      hpkeOpen({
        aead: "aes-128-gcm",
        recipientPrivateKey: await importX25519Private(jwk(VECTOR.skRm, VECTOR.pkRm)),
        recipientPublicKey: hex(VECTOR.pkRm),
        enc: hex(VECTOR.pkEm),
        info: VECTOR.info,
        aad: hex("436f756e742d31"),
        ciphertext: VECTOR.ct,
      }),
    ).rejects.toThrow();
  });
});

test("AES-256-GCM round-trips with a fresh ephemeral key", async () => {
  const recipient = await importX25519Private(jwk(VECTOR.skRm, VECTOR.pkRm));
  const plaintext = new TextEncoder().encode("sk-ant-api03-secret");
  const sealed = await hpkeSeal({
    aead: "aes-256-gcm",
    recipientPublicKey: hex(VECTOR.pkRm),
    info: VECTOR.info,
    aad: VECTOR.aad,
    plaintext,
  });
  expect(sealed.enc).not.toEqual(hex(VECTOR.pkEm));
  const opened = await hpkeOpen({
    aead: "aes-256-gcm",
    recipientPrivateKey: recipient,
    recipientPublicKey: hex(VECTOR.pkRm),
    enc: sealed.enc,
    info: VECTOR.info,
    aad: VECTOR.aad,
    ciphertext: sealed.ciphertext,
  });
  expect(opened).toEqual(plaintext);
});

test("a low-order public key is refused (RFC 9180 §7.1.4)", async () => {
  await expect(
    hpkeOpen({
      aead: "aes-256-gcm",
      recipientPrivateKey: await importX25519Private(jwk(VECTOR.skRm, VECTOR.pkRm)),
      recipientPublicKey: hex(VECTOR.pkRm),
      enc: new Uint8Array(32),
      info: VECTOR.info,
      aad: VECTOR.aad,
      ciphertext: VECTOR.ct,
    }),
  ).rejects.toThrow();
});
