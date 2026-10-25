/**
 * The sealed provider key a grant route carries in `sk`.
 *
 *   v1.<kid>.<enc>.<ciphertext>          (enc and ciphertext unpadded base64url)
 *
 * The key is sealed with HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256),
 * HKDF-SHA256, AES-256-GCM, to the gateway sealing key named by `kid`. The
 * client that receives a pasted key seals it, so the backend stores and
 * forwards only ciphertext and no backend query can ever return key material.
 * The runner carries the ciphertext inside the grant and cannot open it.
 *
 * The AAD binds the ciphertext to its connection and key version: moving a
 * sealed key to another connection, or replaying an older version as a newer
 * one, fails to open.
 */
import type { GatewayErrorCode } from "@volli/shared/cloud";

import { fromBase64Url, toBase64Url, utf8 } from "./bytes.ts";
import { hpkeOpen, hpkeSeal, importX25519Private, type X25519PrivateJwk } from "./hpke.ts";

const VERSION = "v1";
const INFO = utf8("volli-gateway sealed provider key v1");
const KID = /^[A-Za-z0-9_-]{1,64}$/;

/** The associated data a sealed key is bound to. */
function sealedKeyAad(connectionId: string, keyVersion: number): Uint8Array<ArrayBuffer> {
  return utf8(`conn:${connectionId}\nkv:${keyVersion}`);
}

/** A gateway sealing public key, as the gateway publishes it. */
export interface SealingPublicKey {
  kid: string;
  /** The X25519 public key, unpadded base64url (a JWK's `x`). */
  x: string;
}

/**
 * Seals a provider key to the gateway. The production sealer is the client a
 * person pastes a key into; here it serves `scripts/dev-grant.ts` and tests.
 */
export async function sealProviderKey(input: {
  publicKey: SealingPublicKey;
  connectionId: string;
  keyVersion: number;
  key: string;
}): Promise<string> {
  const recipient = fromBase64Url(input.publicKey.x);
  if (!KID.test(input.publicKey.kid) || recipient?.length !== 32) {
    throw new Error("Not a gateway sealing public key");
  }
  const { enc, ciphertext } = await hpkeSeal({
    aead: "aes-256-gcm",
    recipientPublicKey: recipient,
    info: INFO,
    aad: sealedKeyAad(input.connectionId, input.keyVersion),
    plaintext: utf8(input.key),
  });
  return [VERSION, input.publicKey.kid, toBase64Url(enc), toBase64Url(ciphertext)].join(".");
}

export type OpenResult = { ok: true; key: string } | { ok: false; code: GatewayErrorCode };

function isPrivateJwk(value: unknown): value is X25519PrivateJwk {
  if (typeof value !== "object" || value === null) return false;
  const { kty, crv, d, x } = value as Record<string, unknown>;
  return (
    kty === "OKP" &&
    crv === "X25519" &&
    typeof d === "string" &&
    fromBase64Url(d)?.length === 32 &&
    typeof x === "string" &&
    fromBase64Url(x)?.length === 32
  );
}

/**
 * The gateway's sealing private keys by `kid`: the current one and, during a
 * rotation, the previous one. Parsed from the `GATEWAY_SEALING_KEYS` secret,
 * a JSON object of `kid` to X25519 private JWK.
 *
 * It holds the JWKs and imports the one a grant names on each open, rather
 * than caching an import promise: on workerd a promise begun in one request
 * must not be awaited by another, and an X25519 import costs microseconds.
 */
export class SealingKeyring {
  private readonly keys: Map<string, X25519PrivateJwk>;

  private constructor(keys: Map<string, X25519PrivateJwk>) {
    this.keys = keys;
  }

  /** The keyring in `json`, or `null` when it is missing, empty or malformed. */
  static parse(json: string | undefined): SealingKeyring | null {
    if (!json) return null;
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const keys = new Map<string, X25519PrivateJwk>();
    for (const [kid, jwk] of Object.entries(value)) {
      if (!KID.test(kid) || !isPrivateJwk(jwk)) return null;
      const { kty, crv, d, x } = jwk;
      keys.set(kid, { kty, crv, d, x });
    }
    return keys.size === 0 ? null : new SealingKeyring(keys);
  }

  /**
   * Opens a route's sealed key. A `kid` this deployment does not hold means the
   * grant predates a completed rotation: the runner refreshes it. A key that
   * does not open was not sealed for this connection and version: the
   * connection's key must be entered again. A keyring key WebCrypto refuses is
   * the gateway's own misconfiguration.
   */
  async open(sealed: string, connectionId: string, keyVersion: number): Promise<OpenResult> {
    const parts = sealed.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION)
      return { ok: false, code: "volli_grant_invalid" };
    const [, kid, encText, ciphertextText] = parts as [string, string, string, string];
    const enc = fromBase64Url(encText);
    const ciphertext = fromBase64Url(ciphertextText);
    if (enc?.length !== 32 || !ciphertext) return { ok: false, code: "volli_grant_invalid" };
    const jwk = this.keys.get(kid);
    if (!jwk) return { ok: false, code: "volli_grant_stale" };
    let privateKey: CryptoKey;
    try {
      privateKey = await importX25519Private(jwk);
    } catch {
      return { ok: false, code: "volli_gateway_misconfigured" };
    }
    try {
      const plaintext = await hpkeOpen({
        aead: "aes-256-gcm",
        recipientPrivateKey: privateKey,
        recipientPublicKey: fromBase64Url(jwk.x)!,
        enc,
        info: INFO,
        aad: sealedKeyAad(connectionId, keyVersion),
        ciphertext,
      });
      return { ok: true, key: new TextDecoder("utf-8", { fatal: true }).decode(plaintext) };
    } catch {
      return { ok: false, code: "volli_connection_key_unreadable" };
    }
  }
}
