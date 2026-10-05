/**
 * The typed inventory's envelope, `host-credentials.enc` (VC-642;
 * `docs/plans/sealed-credential-store.md` §3):
 *
 *     "VHC1" | backend (1) | key id (16) | nonce (12) | tag (16) | ciphertext
 *
 * AES-256-GCM under the key the id names, with the 21-byte header as
 * associated data, so a header edited to name another key or backend fails
 * authentication rather than being believed. A fresh random 96-bit nonce per
 * seal. The legacy envelopes (`VSF1`, headless key file; `VSC1`, desktop
 * keychain) are never reinterpreted as this one: they are read only by
 * `fileSecretKey` and desktop's keychain codec.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { CredentialKey, CredentialKeyBackend } from "../ports/credential-keyring";
import { CREDENTIAL_KEY_ID_BYTES } from "./credential-key-id";

const MAGIC = Buffer.from("VHC1");
/** Durable format: a backend's byte never changes meaning. */
const BACKEND_BYTES: Readonly<Record<CredentialKeyBackend, number>> = { file: 1, keychain: 2 };
const HEADER_BYTES = MAGIC.length + 1 + CREDENTIAL_KEY_ID_BYTES;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EnvelopeHeader {
  readonly backend: CredentialKeyBackend;
  readonly keyId: string;
}

/** Seals `plaintext` under `key`, naming its backend and id in the header. */
export function sealEnvelope(
  backend: CredentialKeyBackend,
  key: CredentialKey,
  plaintext: string,
): Buffer {
  const header = Buffer.concat([
    MAGIC,
    Buffer.from([BACKEND_BYTES[backend]]),
    Buffer.from(key.id, "hex"),
  ]);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
  cipher.setAAD(header);
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([header, nonce, cipher.getAuthTag(), sealed]);
}

/** The header of a sealed inventory: which backend and key sealed it. Not authenticated yet. */
export function envelopeHeader(bytes: Buffer): EnvelopeHeader {
  if (
    bytes.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES ||
    !bytes.subarray(0, 4).equals(MAGIC)
  ) {
    throw new Error("Not a sealed credential inventory.");
  }
  const code = bytes[MAGIC.length];
  const backend = (Object.keys(BACKEND_BYTES) as CredentialKeyBackend[]).find(
    (name) => BACKEND_BYTES[name] === code,
  );
  if (backend === undefined) throw new Error("Not a sealed credential inventory.");
  return {
    backend,
    keyId: bytes.subarray(MAGIC.length + 1, HEADER_BYTES).toString("hex"),
  };
}

/** Authenticates and opens a sealed inventory with the key its header names. */
export function openEnvelope(bytes: Buffer, key: Buffer): string {
  const tagAt = HEADER_BYTES + NONCE_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(HEADER_BYTES, tagAt));
  decipher.setAAD(bytes.subarray(0, HEADER_BYTES));
  decipher.setAuthTag(bytes.subarray(tagAt, tagAt + TAG_BYTES));
  return Buffer.concat([
    decipher.update(bytes.subarray(tagAt + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}
