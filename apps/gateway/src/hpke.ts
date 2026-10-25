/**
 * HPKE base mode (RFC 9180) with DHKEM(X25519, HKDF-SHA256) and HKDF-SHA256,
 * single-shot, on WebCrypto alone so the same code runs on workerd, in Node
 * and in a browser.
 *
 * Only what the sealed-key format needs: one message per encapsulation
 * (sequence number 0), no PSK, no auth mode, no exporter. AES-128-GCM is here
 * only so the RFC's own test vector (A.1.1) can pin the implementation; keys
 * are sealed with AES-256-GCM.
 */
import { concatBytes, utf8 } from "./bytes.ts";

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const HASH_LENGTH = 32;
const NONCE_LENGTH = 12;

export const AEAD = {
  "aes-128-gcm": { id: 0x0001, keyLength: 16 },
  "aes-256-gcm": { id: 0x0002, keyLength: 32 },
} as const;

export type AeadName = keyof typeof AEAD;

function i2osp(value: number, length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = value & 0xff;
    value >>>= 8;
  }
  return out;
}

const KEM_SUITE = concatBytes(utf8("KEM"), i2osp(KEM_ID, 2));

function hpkeSuite(aead: AeadName): Uint8Array<ArrayBuffer> {
  return concatBytes(utf8("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD[aead].id, 2));
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  // WebCrypto refuses a zero-length HMAC key. HMAC zero-pads every key to the
  // block size, so HASH_LENGTH zero bytes is the same key as the empty salt.
  const raw = key.length === 0 ? new Uint8Array(HASH_LENGTH) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, data as Uint8Array<ArrayBuffer>),
  );
}

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) {
  return hmac(salt, concatBytes(utf8("HPKE-v1"), suite, utf8(label), ikm));
}

async function labeledExpand(
  suite: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const labeledInfo = concatBytes(i2osp(length, 2), utf8("HPKE-v1"), suite, utf8(label), info);
  // HKDF-Expand; every length used here fits in one or two blocks.
  const out = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array(0);
  for (let block = 1, offset = 0; offset < length; block += 1) {
    previous = await hmac(prk, concatBytes(previous, labeledInfo, new Uint8Array([block])));
    out.set(previous.subarray(0, length - offset), offset);
    offset += previous.length;
  }
  return out;
}

/** An X25519 private key in JWK form (`d` and `x`, unpadded base64url). */
export interface X25519PrivateJwk {
  kty: "OKP";
  crv: "X25519";
  d: string;
  x: string;
}

export function importX25519Private(jwk: X25519PrivateJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "X25519" }, false, ["deriveBits"]);
}

function importX25519Public(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    raw as Uint8Array<ArrayBuffer>,
    { name: "X25519" },
    false,
    [],
  );
}

async function dh(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: await importX25519Public(publicKey) },
      privateKey,
      256,
    ),
  );
  // RFC 9180 §7.1.4: an all-zero X25519 output means a low-order public key.
  // Node's WebCrypto already refuses one inside deriveBits; this holds on any
  // runtime that does not.
  /* v8 ignore next -- Node throws first, so only another runtime reaches it. */
  if (shared.every((byte) => byte === 0))
    throw new Error("X25519 produced the all-zero shared secret");
  return shared;
}

async function sharedSecret(dhOutput: Uint8Array, enc: Uint8Array, recipientPublic: Uint8Array) {
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dhOutput);
  return labeledExpand(
    KEM_SUITE,
    prk,
    "shared_secret",
    concatBytes(enc, recipientPublic),
    HASH_LENGTH,
  );
}

async function keySchedule(aead: AeadName, secretInput: Uint8Array, info: Uint8Array) {
  const suite = hpkeSuite(aead);
  const empty = new Uint8Array(0);
  const pskIdHash = await labeledExtract(suite, empty, "psk_id_hash", empty);
  const infoHash = await labeledExtract(suite, empty, "info_hash", info);
  const context = concatBytes(new Uint8Array([0x00]), pskIdHash, infoHash);
  const secret = await labeledExtract(suite, secretInput, "secret", empty);
  const keyBytes = await labeledExpand(suite, secret, "key", context, AEAD[aead].keyLength);
  const nonce = await labeledExpand(suite, secret, "base_nonce", context, NONCE_LENGTH);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { key, nonce };
}

export interface HpkeOpenInput {
  aead: AeadName;
  recipientPrivateKey: CryptoKey;
  /** The recipient's serialized public key (`pkRm`), the JWK's `x`. */
  recipientPublicKey: Uint8Array;
  enc: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
}

/** Decrypts one single-shot message. Throws when it does not authenticate. */
export async function hpkeOpen(input: HpkeOpenInput): Promise<Uint8Array<ArrayBuffer>> {
  const dhOutput = await dh(input.recipientPrivateKey, input.enc);
  const secret = await sharedSecret(dhOutput, input.enc, input.recipientPublicKey);
  const { key, nonce } = await keySchedule(input.aead, secret, input.info);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: input.aad as Uint8Array<ArrayBuffer> },
    key,
    input.ciphertext as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(plaintext);
}

export interface HpkeSealInput {
  aead: AeadName;
  recipientPublicKey: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
  /** A fixed ephemeral key pair, for test vectors only. Fresh by default. */
  ephemeral?: { privateKey: CryptoKey; publicKey: Uint8Array };
}

/** Encrypts one single-shot message to `recipientPublicKey`. */
export async function hpkeSeal(
  input: HpkeSealInput,
): Promise<{ enc: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> }> {
  const ephemeral = input.ephemeral ?? (await generateEphemeral());
  const dhOutput = await dh(ephemeral.privateKey, input.recipientPublicKey);
  const enc = new Uint8Array(ephemeral.publicKey);
  const secret = await sharedSecret(dhOutput, enc, input.recipientPublicKey);
  const { key, nonce } = await keySchedule(input.aead, secret, input.info);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: input.aad as Uint8Array<ArrayBuffer> },
    key,
    input.plaintext as Uint8Array<ArrayBuffer>,
  );
  return { enc, ciphertext: new Uint8Array(ciphertext) };
}

async function generateEphemeral(): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}
