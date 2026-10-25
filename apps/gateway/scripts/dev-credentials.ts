/**
 * Local stand-ins for the backend's half of the gateway: an ES256 issuer that
 * mints grants, and a gateway sealing key pair that provider keys are sealed
 * to. `dev-grant.ts` uses them to run the Worker under `wrangler dev`, and the
 * tests use the same code, so what the CLI mints is what the tests prove the
 * Worker accepts.
 *
 * Nothing here is used by the deployed Worker. The real issuer is the Volli
 * backend's (the same one that mints runner tokens), and the real sealer is
 * the client a person pastes a key into.
 *
 * WebCrypto only, and `.ts` imports with no runtime import of `@volli/shared`
 * (type imports are erased), so Node runs this file directly with its type
 * stripper.
 */
import type { GatewayApi } from "@volli/shared/cloud";

import { toBase64Url, utf8 } from "../src/bytes.ts";
import type { X25519PrivateJwk } from "../src/hpke.ts";
import { sealProviderKey, type SealingPublicKey } from "../src/sealed-key.ts";

/** `GATEWAY_AUDIENCE` from `@volli/shared/cloud`; the tests pin that the two agree. */
const AUDIENCE = "volli-gateway";

export interface DevIssuer {
  issuer: string;
  kid: string;
  /** The value for the Worker's `GATEWAY_JWKS`. */
  jwks: string;
  privateJwk: JsonWebKey;
}

export interface DevSealingKey {
  publicKey: SealingPublicKey;
  /** The value for the Worker's `GATEWAY_SEALING_KEYS`. */
  keyring: string;
}

export async function createDevIssuer(
  issuer = "https://issuer.volli.invalid",
  kid = "dev-1",
): Promise<DevIssuer> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    issuer,
    kid,
    jwks: JSON.stringify({ keys: [{ kty, crv, x, y, kid, alg: "ES256", use: "sig" }] }),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

export async function createDevSealingKey(kid = "seal-dev-1"): Promise<DevSealingKey> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const { d, x } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const jwk: X25519PrivateJwk = { kty: "OKP", crv: "X25519", d: d!, x: x! };
  return { publicKey: { kid, x: x! }, keyring: JSON.stringify({ [kid]: jwk }) };
}

const encodeSegment = (value: unknown) => toBase64Url(utf8(JSON.stringify(value)));

/** Signs `claims` as an ES256 JWS. `header` overrides are for tests of malformed grants. */
export async function signJws(
  issuer: DevIssuer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    issuer.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signingInput = `${encodeSegment({ alg: "ES256", typ: "JWT", kid: issuer.kid, ...header })}.${encodeSegment(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

export interface DevRoute {
  providerId: string;
  connectionId: string;
  keyVersion?: number;
  upstream: string;
  api: GatewayApi;
  /** The real provider key, sealed into the grant. */
  key: string;
  headers?: Record<string, string>;
}

export interface DevGrantInput {
  issuer: DevIssuer;
  sealingKey: DevSealingKey;
  routes: DevRoute[];
  sessionId?: string;
  workspaceId?: string;
  projectId?: string;
  runnerId?: string;
  userId?: string;
  /** Seconds since the epoch. */
  issuedAt?: number;
  lifetimeSeconds?: number;
  /** Claim overrides, applied last. */
  claims?: Record<string, unknown>;
}

/** Mints a grant the way the backend will: per Session, one sealed key per route. */
export async function mintDevGrant(
  input: DevGrantInput,
): Promise<{ token: string; claims: Record<string, unknown> }> {
  const iat = input.issuedAt ?? Math.floor(Date.now() / 1000);
  const routes: Record<string, unknown> = {};
  for (const route of input.routes) {
    const kv = route.keyVersion ?? 1;
    routes[route.providerId] = {
      conn: route.connectionId,
      kv,
      up: route.upstream,
      api: route.api,
      sk: await sealProviderKey({
        publicKey: input.sealingKey.publicKey,
        connectionId: route.connectionId,
        keyVersion: kv,
        key: route.key,
      }),
      ...(route.headers ? { hdr: route.headers } : {}),
    };
  }
  const claims = {
    iss: input.issuer.issuer,
    aud: AUDIENCE,
    sub: `session:${input.sessionId ?? crypto.randomUUID()}`,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + (input.lifetimeSeconds ?? 600),
    act: {
      runner: input.runnerId ?? crypto.randomUUID(),
      user: input.userId ?? crypto.randomUUID(),
    },
    ws: input.workspaceId ?? crypto.randomUUID(),
    ...(input.projectId ? { prj: input.projectId } : {}),
    routes,
    ...input.claims,
  };
  return { token: await signJws(input.issuer, claims), claims };
}
