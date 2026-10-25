/**
 * Envelope encryption for team secrets.
 *
 * A secret's value is sealed (AES-256-GCM) under a **data key**: one per
 * Workspace (`w:{workspaceId}`, for Workspace- and project-level secrets) and
 * one per person (`u:{userId}`, for personal ones). Each data key is stored
 * only wrapped, in `secretKeys`, under a **root key** the deployment holds and
 * names by `kid`. A sealed value's `kid` is its data key's id; the data key's
 * `rootKid` names the root key. Rotating the root key re-wraps data keys
 * (`secretKeys.rewrap`) and never touches a value.
 *
 * Both layers bind what they seal to where it belongs (AES-GCM additional
 * data): a data key to its owner, a value to its secret's id, scope and name.
 * A ciphertext copied onto another row, or a data key onto another owner,
 * fails to open rather than decrypting as something else.
 *
 * Only actions seal and open: a root key provider may need the network (a
 * KMS), which queries and mutations cannot reach.
 *
 * The root key sits behind {@link RootKeyProvider}. The provider here reads
 * the keys from the deployment variable `VOLLI_SECRETS_ROOT_KEYS`; the
 * production checklist (`convex/README.md`, "Secrets root key") says how to
 * create, hold and rotate them, and where a KMS provider plugs in.
 */

import { ConvexError } from "convex/values";

/** Every sealed layer starts with this byte, so a later format can be told apart. */
const FORMAT_V1 = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** What sealing adds to a value: the format byte, the IV and the GCM tag. */
const SEAL_OVERHEAD = 1 + IV_BYTES + 16;

/** The variable the dev/test provider reads: `kid:base64key[,kid:base64key…]`, current first. */
export const ROOT_KEYS_VARIABLE = "VOLLI_SECRETS_ROOT_KEYS";

const KID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type SealingErrorCode = "secrets_unavailable" | "secret_unreadable";

function sealingError(code: SealingErrorCode, message: string) {
  return new ConvexError({ code, message });
}

/** Wraps and unwraps data keys under the deployment's root key. */
export interface RootKeyProvider {
  /** The `kid` new data keys are wrapped under. */
  readonly currentKid: string;
  wrap(dataKey: Uint8Array, context: string): Promise<{ rootKid: string; wrapped: ArrayBuffer }>;
  unwrap(rootKid: string, wrapped: ArrayBuffer, context: string): Promise<Uint8Array>;
}

function readVariable(name: string): string | undefined {
  try {
    return process.env[name];
  } catch {
    return undefined;
  }
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function seal(key: CryptoKey, plaintext: Uint8Array, context: string): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      key,
      toArrayBuffer(plaintext),
    ),
  );
  const out = new Uint8Array(1 + IV_BYTES + body.byteLength);
  out[0] = FORMAT_V1;
  out.set(iv, 1);
  out.set(body, 1 + IV_BYTES);
  return out.buffer;
}

/** `null` when the bytes are not this format or do not authenticate. */
async function open(
  key: CryptoKey,
  sealed: ArrayBuffer,
  context: string,
): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(sealed);
  if (bytes.byteLength < SEAL_OVERHEAD || bytes[0] !== FORMAT_V1) return null;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.slice(1, 1 + IV_BYTES),
          additionalData: encoder.encode(context),
        },
        key,
        bytes.slice(1 + IV_BYTES),
      ),
    );
  } catch {
    return null;
  }
}

/**
 * Parses `kid:base64key[,…]`. Each key is 32 random bytes. Throws a message
 * that names the problem and never a key.
 */
function parseRootKeys(text: string): { currentKid: string; keys: Map<string, Uint8Array> } {
  const keys = new Map<string, Uint8Array>();
  let currentKid: string | null = null;
  for (const part of text.split(",")) {
    const entry = part.trim();
    const colon = entry.indexOf(":");
    const kid = colon < 0 ? "" : entry.slice(0, colon);
    if (!KID.test(kid)) throw new Error(`${ROOT_KEYS_VARIABLE}: each entry is kid:base64key.`);
    if (keys.has(kid)) throw new Error(`${ROOT_KEYS_VARIABLE}: kid ${kid} appears twice.`);
    let key: Uint8Array;
    try {
      key = fromBase64(entry.slice(colon + 1));
    } catch {
      throw new Error(`${ROOT_KEYS_VARIABLE}: the key for ${kid} is not base64.`);
    }
    if (key.byteLength !== KEY_BYTES) {
      throw new Error(`${ROOT_KEYS_VARIABLE}: the key for ${kid} is not ${KEY_BYTES} bytes.`);
    }
    keys.set(kid, key);
    currentKid ??= kid;
  }
  return { currentKid: currentKid!, keys };
}

/** A provider over keys held in memory: the deployment variable's, or a test's. */
function staticRootKeyProvider(text: string): RootKeyProvider {
  const { currentKid, keys } = parseRootKeys(text);
  const key = (kid: string): Promise<CryptoKey> => {
    const raw = keys.get(kid);
    if (raw === undefined) {
      throw sealingError(
        "secret_unreadable",
        `Root key ${kid} is not configured on this deployment.`,
      );
    }
    return aesKey(raw);
  };
  return {
    currentKid,
    async wrap(dataKey, context) {
      return { rootKid: currentKid, wrapped: await seal(await key(currentKid), dataKey, context) };
    },
    async unwrap(rootKid, wrapped, context) {
      const raw = await open(await key(rootKid), wrapped, context);
      if (raw === null || raw.byteLength !== KEY_BYTES) {
        throw sealingError("secret_unreadable", "A data key did not open under its root key.");
      }
      return raw;
    },
  };
}

/**
 * The deployment's root key provider, or `secrets_unavailable` when none is
 * configured. Env vars still work without one; sealed secrets do not.
 */
export function rootKeyProvider(): RootKeyProvider {
  const text = readVariable(ROOT_KEYS_VARIABLE);
  if (text === undefined || text.trim() === "") {
    throw sealingError(
      "secrets_unavailable",
      "Secrets are not available on this deployment yet: no root key is configured.",
    );
  }
  try {
    return staticRootKeyProvider(text);
  } catch (error) {
    // The message names the variable and the problem, never a key.
    throw sealingError("secrets_unavailable", (error as Error).message);
  }
}

// ── data keys and values ───────────────────────────────────────────────────

/** The additional data a data key is wrapped with: its id and owner. Frozen. */
export function dataKeyContext(keyId: string, owner: string): string {
  return `volli:secret-key:v1:${keyId}:${owner}`;
}

/** The additional data a value is sealed with: its secret's id, scope key and name. Frozen. */
export function valueContext(secretId: string, scopeKey: string, name: string): string {
  return `volli:secret:v1:${secretId}:${scopeKey}:${name}`;
}

/** The UTF-8 length of the value a sealed ciphertext holds, without opening it. */
export function sealedValueBytes(ciphertext: ArrayBuffer): number {
  return ciphertext.byteLength - SEAL_OVERHEAD;
}

export function newDataKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

export async function sealValue(
  dataKey: Uint8Array,
  value: string,
  context: string,
): Promise<ArrayBuffer> {
  return seal(await aesKey(dataKey), encoder.encode(value), context);
}

export async function openValue(
  dataKey: Uint8Array,
  ciphertext: ArrayBuffer,
  context: string,
): Promise<string> {
  const bytes = await open(await aesKey(dataKey), ciphertext, context);
  if (bytes === null) {
    throw sealingError("secret_unreadable", "A sealed secret did not open under its data key.");
  }
  return decoder.decode(bytes);
}
